import { describe, expect, it, vi } from "vitest";
import { twilioStatusCallbackUrl,
  TwilioSmsProvider,
  TwilioWhatsAppProvider,
  TWILIO_DEDUP_TTL_MS,
} from "../services/notifications/twilio-provider";
import { NotificationError } from "../services/notifications/provider";
import {
  computeTwilioSignature,
  isValidTwilioSignature,
} from "../services/notifications/twilio-signature";
import {
  buildNotificationProvidersFromEnv,
  firstNotificationChannel,
} from "../services/notifications/registry";
import { MockNotificationProvider } from "../services/notifications/mock-provider";
import {
  parseApprovalMagicLinkBody,
  renderApprovalMagicLinkBody,
} from "../services/notifications/notification-service";

const PHONE = "+254700000123";
const BODY = "GatePass: Jane Visitor is at the gate for Host (Unit A1).\nApprove or deny: https://gp.example/approve/TOKEN123";
const SID = `SM${"0123456789abcdef".repeat(2)}`;
const CREDS = {
  accountSid: `AC${"a".repeat(32)}`,
  apiKeySid: `SK${"b".repeat(32)}`,
  apiKeySecret: "api-secret-xyz",
  statusCallbackUrl: "https://gp.example/api/notifications/twilio-status",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function sms(fetchImpl: typeof fetch, extra: { now?: () => number; timeoutMs?: number } = {}) {
  return new TwilioSmsProvider(
    { ...CREDS, messagingServiceSid: `MG${"c".repeat(32)}` },
    { fetch: fetchImpl, ...extra },
  );
}

async function sendError(p: TwilioSmsProvider, key = "k1"): Promise<NotificationError> {
  try {
    await p.send({ target: PHONE, body: BODY, idempotencyKey: key });
  } catch (err) {
    return err as NotificationError;
  }
  throw new Error("expected send to throw");
}

describe("TwilioSmsProvider", () => {
  it("201 → accepted with the SID; posts To, MessagingServiceSid, Body, StatusCallback with Basic auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(201, { sid: SID, status: "accepted", to: PHONE, body: BODY }),
    );
    const result = await sms(fetchMock as unknown as typeof fetch).send({ target: PHONE, body: BODY, idempotencyKey: "k1" });
    expect(result).toEqual({ providerMessageId: SID, responseCode: 201, responseExcerpt: "HTTP 201 status=accepted", acceptedOnly: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${CREDS.accountSid}/Messages.json`);
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from(`${CREDS.apiKeySid}:${CREDS.apiKeySecret}`).toString("base64")}`);
    const form = new URLSearchParams(init.body);
    expect(form.get("To")).toBe(PHONE);
    expect(form.get("MessagingServiceSid")).toBe(`MG${"c".repeat(32)}`);
    expect(form.get("Body")).toBe(BODY);
    expect(form.get("StatusCallback")).toBe(CREDS.statusCallbackUrl);
  });

  it.each([
    [401, "INVALID_CREDENTIALS"],
    [403, "INVALID_CREDENTIALS"],
    [429, "RATE_LIMITED"],
    [400, "PROVIDER_4XX"],
    [404, "PROVIDER_4XX"],
    [500, "PROVIDER_5XX"],
    [503, "PROVIDER_5XX"],
  ])("HTTP %i → %s, excerpt holds no number, body or link", async (status, code) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(status, { code: 21211, message: `The 'To' number ${PHONE} is not valid. ${BODY}`, more_info: "x" }),
    );
    const err = await sendError(sms(fetchMock as unknown as typeof fetch));
    expect(err).toBeInstanceOf(NotificationError);
    expect(err.code).toBe(code);
    expect(err.responseCode).toBe(status);
    expect(err.responseExcerpt).toBe(`HTTP ${status} code=21211`);
    for (const text of [err.message, err.responseExcerpt]) {
      expect(text).not.toContain("700000123");
      expect(text).not.toContain("TOKEN123");
      expect(text).not.toContain("Jane");
    }
  });

  it("a 201 without a valid SID is a failure, not a success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { status: "queued" }));
    expect((await sendError(sms(fetchMock as unknown as typeof fetch))).code).toBe("PROVIDER_5XX");
  });

  it("no answer within the timeout → PROVIDER_TIMEOUT", async () => {
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
    );
    const err = await sendError(sms(fetchMock as unknown as typeof fetch, { timeoutMs: 5 }));
    expect(err.code).toBe("PROVIDER_TIMEOUT");
  });

  it("network failure → TRANSPORT_ERROR", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError(`fetch failed for ${PHONE}`));
    const err = await sendError(sms(fetchMock as unknown as typeof fetch));
    expect(err.code).toBe("TRANSPORT_ERROR");
    expect(err.message).not.toContain("700000123");
  });

  it("the same idempotency key within 10 minutes sends once; after the window it sends again", async () => {
    let now = 1_000_000;
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(201, { sid: SID, status: "queued" }));
    const p = sms(fetchMock as unknown as typeof fetch, { now: () => now });
    const a = await p.send({ target: PHONE, body: BODY, idempotencyKey: "same" });
    const b = await p.send({ target: PHONE, body: BODY, idempotencyKey: "same" });
    expect(b).toEqual(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now += TWILIO_DEDUP_TTL_MS + 1;
    await p.send({ target: PHONE, body: BODY, idempotencyKey: "same" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a refused send is not replayed: the same key tries Twilio again", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => jsonResponse(503, { code: 20500 }))
      .mockImplementation(async () => jsonResponse(201, { sid: SID, status: "queued" }));
    const p = sms(fetchMock as unknown as typeof fetch);
    await expect(p.send({ target: PHONE, body: BODY, idempotencyKey: "k" })).rejects.toMatchObject({ code: "PROVIDER_5XX" });
    await expect(p.send({ target: PHONE, body: BODY, idempotencyKey: "k" })).resolves.toMatchObject({ providerMessageId: SID });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("TwilioWhatsAppProvider", () => {
  it("sends the approved template with numbered variables, not the free-text body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { sid: SID, status: "queued" }));
    const p = new TwilioWhatsAppProvider(
      { ...CREDS, from: "whatsapp:+254700000001", contentSid: `HX${"d".repeat(32)}` },
      { fetch: fetchMock as unknown as typeof fetch },
    );
    const vars = parseApprovalMagicLinkBody(BODY)!;
    await p.send({ target: PHONE, body: BODY, idempotencyKey: "w1", template: { key: "approval_magic_link_v1", variables: { ...vars } } });
    const form = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(form.get("To")).toBe(`whatsapp:${PHONE}`);
    expect(form.get("From")).toBe("whatsapp:+254700000001");
    expect(form.get("Body")).toBeNull();
    expect(JSON.parse(form.get("ContentVariables")!)).toEqual({
      "1": "Jane Visitor",
      "2": "Host",
      "3": "A1",
      "4": "https://gp.example/approve/TOKEN123",
    });
  });
});

describe("approval body ↔ template variables", () => {
  it("parse is the inverse of render", () => {
    const input = { visitorName: "A (B)", host: "Host Name", unit: "Block 2", magicLinkUrl: "https://x.example/approve/abc" };
    expect(parseApprovalMagicLinkBody(renderApprovalMagicLinkBody(input))).toEqual(input);
    expect(parseApprovalMagicLinkBody("something else")).toBeNull();
  });
});

describe("Twilio signature", () => {
  const url = "https://gp.example/api/notifications/twilio-status";
  const params = { MessageSid: SID, MessageStatus: "delivered", AccountSid: CREDS.accountSid };

  it("accepts the signature Twilio would compute", () => {
    const sig = computeTwilioSignature(url, params, "auth-token");
    expect(isValidTwilioSignature(sig, url, params, "auth-token")).toBe(true);
  });

  it("matches Twilio's published example", () => {
    // https://www.twilio.com/docs/usage/security#validating-requests
    const exampleParams = {
      CallSid: "CA1234567890ABCDE",
      Caller: "+12349013030",
      Digits: "1234",
      From: "+12349013030",
      To: "+18005551212",
    };
    expect(
      computeTwilioSignature("https://mycompany.com/myapp.php?foo=1&bar=2", exampleParams, "12345"),
    ).toBe("0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
  });

  it("refuses a missing, wrong, other-token or tampered signature", () => {
    const sig = computeTwilioSignature(url, params, "auth-token");
    expect(isValidTwilioSignature(undefined, url, params, "auth-token")).toBe(false);
    expect(isValidTwilioSignature("bm9wZQ==", url, params, "auth-token")).toBe(false);
    expect(isValidTwilioSignature(sig, url, params, "other-token")).toBe(false);
    expect(isValidTwilioSignature(sig, url, { ...params, MessageStatus: "failed" }, "auth-token")).toBe(false);
    expect(isValidTwilioSignature(sig, "https://evil.example/api/notifications/twilio-status", params, "auth-token")).toBe(false);
  });
});

describe("provider wiring from environment", () => {
  it("unset keeps the default-deny providers", () => {
    const r = buildNotificationProvidersFromEnv({});
    expect(r.sms).toBeInstanceOf(MockNotificationProvider);
    expect(r.whatsapp).toBeInstanceOf(MockNotificationProvider);
  });

  it("SMS-only pilot: Twilio SMS, WhatsApp disabled, first channel is SMS", () => {
    const env = { NOTIFICATIONS_SMS_PROVIDER: "twilio", NOTIFICATIONS_WHATSAPP_PROVIDER: "disabled" };
    const r = buildNotificationProvidersFromEnv(env);
    expect(r.sms).toBeInstanceOf(TwilioSmsProvider);
    expect(r.whatsapp).toBeInstanceOf(MockNotificationProvider);
    expect(firstNotificationChannel(env)).toBe("sms");
    expect(firstNotificationChannel({})).toBe("whatsapp");
  });

  it("status callback URL: APP_PUBLIC_ORIGIN, or TWILIO_STATUS_CALLBACK_ORIGIN for a separate API host", () => {
    expect(twilioStatusCallbackUrl({ APP_PUBLIC_ORIGIN: "https://app.example/" })).toBe(
      "https://app.example/api/notifications/twilio-status",
    );
    expect(
      twilioStatusCallbackUrl({ APP_PUBLIC_ORIGIN: "https://app.example", TWILIO_STATUS_CALLBACK_ORIGIN: "https://api.example" }),
    ).toBe("https://api.example/api/notifications/twilio-status");
    expect(twilioStatusCallbackUrl({})).toBeUndefined();
  });
});
