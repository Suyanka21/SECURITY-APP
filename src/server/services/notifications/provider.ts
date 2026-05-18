/**
 * GatePass — NotificationProvider interface + error types
 *
 * Source: src/docs/specs/notifications.md §6 (provider interface).
 * Source: Source-Driven-Development — the concrete WhatsApp Cloud /
 *         SMS implementations live in separate files and MUST cite
 *         current vendor docs at wire-up time. This file is a
 *         provider-agnostic contract only.
 * Source: API-and-Interface-Design — every observable behavior is
 *         intentional; this interface is what the dispatcher couples
 *         to.
 *
 * Implementations MUST be idempotent on `idempotencyKey` — i.e.,
 * calling send() twice with the same key MUST NOT produce two
 * messages reaching the user. Providers that do not support
 * idempotency natively (e.g. SMS providers without an idempotency
 * header) MUST implement an in-process or DB-backed dedup before
 * placing the outbound call.
 */

export type NotificationChannel = "whatsapp" | "sms";

export interface NotificationSendInput {
  /** Recipient phone in E.164 form. Validated by the API boundary. */
  target: string;
  /** Rendered template body. The provider does NOT modify this. */
  body: string;
  /**
   * sha256(approval_id || channel || attempt_no) — the dispatcher's
   * idempotency contract. Forwarded to the provider's idempotency
   * header where supported (e.g. WhatsApp Cloud API `Idempotency-Key`).
   */
  idempotencyKey: string;
}

export interface NotificationSendResult {
  /** Provider's message ID (e.g. WA `messages[0].id`). Opaque. */
  providerMessageId: string;
  /** HTTP status code from the provider's response. */
  responseCode: number;
  /** Provider response body, truncated to ≤ 200 chars (PII rule §3). */
  responseExcerpt: string;
}

/**
 * Stable union of failure modes. The dispatcher branches on `code` to
 * decide whether to retry, fall back to the other channel, or give up.
 *
 * Source: spec §6.
 */
export type NotificationErrorCode =
  | "PROVIDER_5XX"
  | "PROVIDER_4XX"
  | "PROVIDER_TIMEOUT"
  | "TRANSPORT_ERROR"
  | "INVALID_CREDENTIALS"
  | "RATE_LIMITED";

export class NotificationError extends Error {
  constructor(
    public readonly code: NotificationErrorCode,
    message: string,
    public readonly responseCode: number,
    public readonly responseExcerpt: string,
  ) {
    super(message);
    this.name = "NotificationError";
  }
}

export interface NotificationProvider {
  readonly channel: NotificationChannel;

  /**
   * Sends one message. Resolves with the provider's response on 2xx.
   * Rejects with a NotificationError on every other outcome
   * (non-2xx, transport error, timeout, rate-limit). The dispatcher
   * catches and records the row state.
   */
  send(input: NotificationSendInput): Promise<NotificationSendResult>;
}

// ─── Truncation helper (PII rule §3) ─────────────────────────────────────────
// Used by every provider impl + the dispatcher when persisting
// response excerpts.

export function truncateResponseExcerpt(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= 200) return trimmed;
  return `${trimmed.slice(0, 197)}...`;
}
