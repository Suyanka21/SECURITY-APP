/**
 * GatePass — Twilio SMS + WhatsApp providers.
 *
 * Source: src/docs/specs/twilio-provider.md §3.
 * Source: https://www.twilio.com/docs/messaging/api/message-resource
 *
 * One form-encoded POST per message, authenticated with a Standard API key.
 * A 201 only means Twilio accepted the message, so results carry
 * `acceptedOnly: true` and the row waits for the status callback.
 *
 * PII rule: `responseExcerpt` and error messages hold only the HTTP status,
 * Twilio's numeric error code and the message status. Twilio's response body
 * echoes the `To` number and the body, so it is never copied anywhere.
 */

import {
  NotificationError,
  type NotificationChannel,
  type NotificationErrorCode,
  type NotificationProvider,
  type NotificationSendInput,
  type NotificationSendResult,
} from "./provider";

export const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";
export const TWILIO_TIMEOUT_MS = 10_000;
export const TWILIO_DEDUP_TTL_MS = 10 * 60_000;
export const TWILIO_STATUS_CALLBACK_PATH = "/api/notifications/twilio-status";

/**
 * The public URL Twilio posts delivery status to, and the URL the webhook
 * signs against. TWILIO_STATUS_CALLBACK_ORIGIN is the API's public origin
 * when it differs from APP_PUBLIC_ORIGIN (separate API host).
 */
export function twilioStatusCallbackUrl(env: Record<string, string | undefined>): string | undefined {
  const origin = (env.TWILIO_STATUS_CALLBACK_ORIGIN?.trim() || env.APP_PUBLIC_ORIGIN?.trim() || "").replace(/\/+$/, "");
  return origin ? `${origin}${TWILIO_STATUS_CALLBACK_PATH}` : undefined;
}

export interface TwilioCredentials {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  /** APP_PUBLIC_ORIGIN + TWILIO_STATUS_CALLBACK_PATH; omitted → no callback. */
  statusCallbackUrl?: string;
}

export interface TwilioProviderDeps {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

interface DedupEntry {
  at: number;
  result: Promise<NotificationSendResult>;
}

abstract class TwilioProviderBase implements NotificationProvider {
  abstract readonly channel: NotificationChannel;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly sent = new Map<string, DedupEntry>();

  constructor(
    protected readonly creds: TwilioCredentials,
    deps: TwilioProviderDeps = {},
  ) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? TWILIO_TIMEOUT_MS;
  }

  protected abstract messageParams(input: NotificationSendInput): Record<string, string>;

  /**
   * Twilio documents no idempotency key, so a repeat of the same key within
   * 10 minutes returns the first outcome instead of sending again. In-process
   * only: enough for one server instance (decision D3).
   */
  send(input: NotificationSendInput): Promise<NotificationSendResult> {
    const nowMs = this.now();
    for (const [key, entry] of this.sent) {
      if (nowMs - entry.at > TWILIO_DEDUP_TTL_MS) this.sent.delete(key);
    }
    const prior = this.sent.get(input.idempotencyKey);
    if (prior) return prior.result;
    const key = input.idempotencyKey;
    const result = this.post(input);
    this.sent.set(key, { at: nowMs, result });
    // Only an accepted send is replayed; a refusal must not block the next try.
    result.catch(() => {
      if (this.sent.get(key)?.result === result) this.sent.delete(key);
    });
    return result;
  }

  private async post(input: NotificationSendInput): Promise<NotificationSendResult> {
    const params = this.messageParams(input);
    if (this.creds.statusCallbackUrl) params.StatusCallback = this.creds.statusCallbackUrl;
    const url = `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(this.creds.accountSid)}/Messages.json`;
    const auth = Buffer.from(`${this.creds.apiKeySid}:${this.creds.apiKeySecret}`).toString("base64");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(params).toString(),
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = controller.signal.aborted || (err as Error)?.name === "AbortError";
      throw aborted
        ? new NotificationError("PROVIDER_TIMEOUT", "Twilio did not respond in time", 0, "timeout")
        : new NotificationError("TRANSPORT_ERROR", "Could not reach Twilio", 0, "transport error");
    } finally {
      clearTimeout(timer);
    }

    const body = await readJson(res);
    const twilioCode = typeof body?.code === "number" ? body.code : undefined;
    const messageStatus = typeof body?.status === "string" && /^[a-z_]{1,20}$/.test(body.status)
      ? body.status
      : undefined;
    const excerpt = [`HTTP ${res.status}`, twilioCode !== undefined ? `code=${twilioCode}` : "", messageStatus ? `status=${messageStatus}` : ""]
      .filter(Boolean)
      .join(" ");

    if (res.status === 201 || res.status === 200) {
      const sid = typeof body?.sid === "string" && /^(SM|MM)[0-9a-fA-F]{32}$/.test(body.sid) ? body.sid : null;
      if (!sid) {
        throw new NotificationError("PROVIDER_5XX", "Twilio accepted the message without a valid SID", res.status, excerpt);
      }
      return { providerMessageId: sid, responseCode: res.status, responseExcerpt: excerpt, acceptedOnly: true };
    }

    const code: NotificationErrorCode =
      res.status === 401 || res.status === 403
        ? "INVALID_CREDENTIALS"
        : res.status === 429
          ? "RATE_LIMITED"
          : res.status >= 500
            ? "PROVIDER_5XX"
            : "PROVIDER_4XX";
    if (code === "INVALID_CREDENTIALS" || code === "RATE_LIMITED") {
      // One line for the technical contact; no number, no body (spec §5).
      console.error(
        `[NOTIFICATION] provider=twilio channel=${this.channel} code=${code} twilioCode=${twilioCode ?? "none"}`,
      );
    }
    throw new NotificationError(code, `Twilio refused the message (${excerpt})`, res.status, excerpt);
  }
}

async function readJson(res: Response): Promise<{ sid?: unknown; code?: unknown; status?: unknown } | null> {
  try {
    return (await res.json()) as { sid?: unknown; code?: unknown; status?: unknown };
  } catch {
    return null;
  }
}

export interface TwilioSmsConfig extends TwilioCredentials {
  messagingServiceSid: string;
}

export class TwilioSmsProvider extends TwilioProviderBase {
  readonly channel = "sms" as const;

  constructor(private readonly config: TwilioSmsConfig, deps?: TwilioProviderDeps) {
    super(config, deps);
  }

  protected messageParams(input: NotificationSendInput): Record<string, string> {
    return { To: input.target, MessagingServiceSid: this.config.messagingServiceSid, Body: input.body };
  }
}

export interface TwilioWhatsAppConfig extends TwilioCredentials {
  /** `whatsapp:+<E.164>` */
  from: string;
  /** Approved Content Template `HX…` SID. */
  contentSid: string;
}

/** Template variable order agreed with the WhatsApp template (spec §7 step 6). */
export const WHATSAPP_TEMPLATE_VARIABLE_ORDER = ["visitorName", "host", "unit", "magicLinkUrl"] as const;

export class TwilioWhatsAppProvider extends TwilioProviderBase {
  readonly channel = "whatsapp" as const;

  constructor(private readonly config: TwilioWhatsAppConfig, deps?: TwilioProviderDeps) {
    super(config, deps);
  }

  protected messageParams(input: NotificationSendInput): Record<string, string> {
    if (!input.template) {
      throw new NotificationError("PROVIDER_4XX", "WhatsApp needs an approved template", 0, "no template");
    }
    const vars = input.template.variables;
    const contentVariables: Record<string, string> = {};
    WHATSAPP_TEMPLATE_VARIABLE_ORDER.forEach((name, i) => {
      contentVariables[String(i + 1)] = vars[name] ?? "";
    });
    return {
      To: `whatsapp:${input.target}`,
      From: this.config.from,
      ContentSid: this.config.contentSid,
      ContentVariables: JSON.stringify(contentVariables),
    };
  }
}
