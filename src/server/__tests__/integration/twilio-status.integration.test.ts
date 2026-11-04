/**
 * GatePass — Twilio delivery-status webhook and SMS fallback against a REAL
 * Postgres over REAL HTTP (twilio-provider.md §3 option B, G2, T8).
 *
 * Twilio itself is faked: the real TwilioSmsProvider / TwilioWhatsAppProvider
 * classes run against an injected fetch, and callbacks are signed with the
 * same algorithm Twilio uses. No call leaves this machine.
 *
 * PREREQUISITES: DATABASE_URL set, schema migrated.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { and, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import * as schema from "@/db/schema";
import { approvalRequests, auditEvents, guards, notificationCallbacks, notifications } from "@/db/schema";
import { createApp } from "../../app";
import { clearAuditDB, clearAuditLog, setAuditDB } from "../../services/audit-logger";
import { MockNotificationProvider } from "../../services/notifications/mock-provider";
import {
  buildNotificationProvidersFromEnv,
  resetNotificationProviders,
  setNotificationProviders,
  type NotificationProviderRegistry,
} from "../../services/notifications/registry";
import {
  dispatchNotification,
  enqueueNotification,
  renderApprovalMagicLinkBody,
  TEMPLATE_KEYS,
} from "../../services/notifications/notification-service";
import { TwilioWhatsAppProvider } from "../../services/notifications/twilio-provider";
import { computeTwilioSignature } from "../../services/notifications/twilio-signature";

const ORIGIN = "https://gatepass-test.example";
const AUTH_TOKEN = "integration-twilio-auth-token";
const CALLBACK_URL = `${ORIGIN}/api/notifications/twilio-status`;
const PHONE = "+254700000777";
const saved = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  APP_PUBLIC_ORIGIN: process.env.APP_PUBLIC_ORIGIN,
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
};

let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let server: Server;
let baseUrl: string;
let guardId: string;
const approvalIds: string[] = [];
const sids: string[] = [];

/** A fake Twilio Messages API: hands out fresh SIDs, counts calls per channel. */
function fakeTwilio() {
  const calls: { to: string; body: URLSearchParams }[] = [];
  let next = 0;
  let gate: Promise<void> | null = null;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = new URLSearchParams(String(init.body));
    calls.push({ to: body.get("To") ?? "", body });
    if (gate) await gate;
    next += 1;
    const sid = `SM${randomUUID().replace(/-/g, "")}`;
    sids.push(sid);
    return new Response(JSON.stringify({ sid, status: "accepted", to: body.get("To") }), { status: 201 });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    calls,
    count: () => next,
    hold() {
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      return () => {
        gate = null;
        release();
      };
    },
  };
}

function smsOnlyProviders(twilio: ReturnType<typeof fakeTwilio>): NotificationProviderRegistry {
  return buildNotificationProvidersFromEnv(
    {
      NOTIFICATIONS_SMS_PROVIDER: "twilio",
      NOTIFICATIONS_WHATSAPP_PROVIDER: "disabled",
      TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
      TWILIO_API_KEY_SID: `SK${"b".repeat(32)}`,
      TWILIO_API_KEY_SECRET: "fake",
      TWILIO_SMS_MESSAGING_SERVICE_SID: `MG${"c".repeat(32)}`,
      APP_PUBLIC_ORIGIN: ORIGIN,
    },
    { fetch: twilio.fetchImpl },
  );
}

async function newApproval(): Promise<string> {
  const [row] = await db
    .insert(approvalRequests)
    .values({
      offlineId: randomUUID(),
      visitorName: "Test Visitor",
      host: "Test Host",
      unit: `TW-${Date.now()}-${approvalIds.length}`,
      method: "walk-in",
      requestedByGuardId: guardId,
      expiresAt: new Date(Date.now() + 300_000),
      traceId: randomUUID(),
    })
    .returning({ id: approvalRequests.id });
  approvalIds.push(row.id);
  return row.id;
}

async function queue(approvalId: string, channel: "sms" | "whatsapp"): Promise<string> {
  const { id } = await enqueueNotification(db, {
    approvalId,
    channel,
    targetPhone: PHONE,
    templateKey: TEMPLATE_KEYS.approvalMagicLink,
    renderedBody: renderApprovalMagicLinkBody({
      visitorName: "Test Visitor",
      host: "Test Host",
      unit: "TW1",
      magicLinkUrl: "https://gatepass-test.example/approve/TOKEN",
    }),
    attemptNo: 0,
  });
  return id;
}

async function row(id: string) {
  const [r] = await db.select().from(notifications).where(eq(notifications.id, id));
  return r;
}

async function callback(params: Record<string, string>, signature?: string | null) {
  const sig = signature === undefined ? computeTwilioSignature(CALLBACK_URL, params, AUTH_TOKEN) : signature;
  return fetch(`${baseUrl}/api/notifications/twilio-status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(sig ? { "X-Twilio-Signature": sig } : {}),
    },
    body: new URLSearchParams(params).toString(),
  });
}

function status(sid: string, s: string, extra: Record<string, string> = {}) {
  return { MessageSid: sid, MessageStatus: s, AccountSid: `AC${"a".repeat(32)}`, To: PHONE, ...extra };
}

async function auditCount(eventType: "notification_delivered" | "notification_failed", entityId: string) {
  const rows = await db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(and(eq(auditEvents.eventType, eventType), eq(auditEvents.guardId, guardId), sql`${auditEvents.payload}->>'notificationId' = ${entityId}`));
  return rows.length;
}

beforeAll(async () => {
  delete process.env.SUPABASE_URL;
  process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
  process.env.APP_PUBLIC_ORIGIN = ORIGIN;
  process.env.TWILIO_ACCOUNT_SID = `AC${"a".repeat(32)}`;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for integration tests.");
  if (!process.env.PIN_PEPPER) process.env.PIN_PEPPER = "integration-test-pepper-not-for-production";
  pool = new Pool({ connectionString: databaseUrl, max: 10 });
  db = drizzle(pool, { schema });
  setAuditDB(db);
  const [g] = await db
    .insert(guards)
    .values({ id: randomUUID(), badgeNumber: `TW-GUARD-${Date.now()}`, name: "TW Guard", role: "guard", isActive: true })
    .returning({ id: guards.id });
  guardId = g.id;
});

beforeEach(async () => {
  server = createServer(createApp(db));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  resetNotificationProviders();
  clearAuditLog();
  if (sids.length) await db.delete(notificationCallbacks).where(inArray(notificationCallbacks.messageSid, sids));
  if (approvalIds.length) {
    await db.delete(notifications).where(inArray(notifications.approvalId, approvalIds));
    await db.delete(approvalRequests).where(inArray(approvalRequests.id, approvalIds));
  }
  await db.delete(auditEvents).where(eq(auditEvents.guardId, guardId));
  approvalIds.length = 0;
  sids.length = 0;
});

afterAll(async () => {
  await db.delete(guards).where(eq(guards.id, guardId));
  clearAuditDB();
  await pool.end();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("Twilio status webhook", () => {
  it("201 → 'sent' with the SID; a signed 'delivered' callback → 'delivered'; a repeat and a late 'failed' change nothing", async () => {
    const twilio = fakeTwilio();
    const providers = smsOnlyProviders(twilio);
    setNotificationProviders(providers);
    const id = await queue(await newApproval(), "sms");

    const outcome = await dispatchNotification(db, id, { providers, systemGuardId: guardId });
    expect(outcome.finalStatus).toBe("sent");
    const sent = await row(id);
    expect(sent.status).toBe("sent");
    expect(sent.providerMessageId).toMatch(/^SM[0-9a-f]{32}$/);
    expect(sent.lastProviderResponseExcerpt).not.toContain("700000777");
    const form = twilio.calls[0].body;
    expect(form.get("StatusCallback")).toBe(CALLBACK_URL);

    const sid = sent.providerMessageId!;
    expect((await callback(status(sid, "sent"))).status).toBe(200);
    expect((await row(id)).status).toBe("sent");
    expect((await callback(status(sid, "delivered"))).status).toBe(200);
    const delivered = await row(id);
    expect(delivered.status).toBe("delivered");
    expect(delivered.deliveredAt).not.toBeNull();
    expect(await auditCount("notification_delivered", id)).toBe(1);

    expect((await callback(status(sid, "delivered"))).status).toBe(200);
    expect((await callback(status(sid, "failed", { ErrorCode: "30003" }))).status).toBe(200);
    expect((await row(id)).status).toBe("delivered");
    expect(await auditCount("notification_delivered", id)).toBe(1);
    const stored = await db.select().from(notificationCallbacks).where(eq(notificationCallbacks.messageSid, sid));
    expect(stored.map((c) => c.status).sort()).toEqual(["delivered", "failed"]);

    // Dispatching a 'sent' row again never sends a second message.
    await dispatchNotification(db, id, { providers, systemGuardId: guardId });
    expect(twilio.count()).toBe(1);
  });

  it("a missing or wrong signature is refused with 403 and nothing is stored", async () => {
    const sid = `SM${randomUUID().replace(/-/g, "")}`;
    sids.push(sid);
    expect((await callback(status(sid, "delivered"), null)).status).toBe(403);
    expect((await callback(status(sid, "delivered"), "bm9wZQ==")).status).toBe(403);
    const forged = computeTwilioSignature(CALLBACK_URL, status(sid, "delivered"), "someone-elses-token");
    expect((await callback(status(sid, "delivered"), forged)).status).toBe(403);
    // Validly signed, but for another (sub)account that shares the token.
    expect((await callback(status(sid, "delivered", { AccountSid: `AC${"b".repeat(32)}` }))).status).toBe(403);
    expect(await db.select().from(notificationCallbacks).where(eq(notificationCallbacks.messageSid, sid))).toHaveLength(0);
  });

  it("a callback that arrives before the SID is saved is stored and applied when the SID is saved", async () => {
    const twilio = fakeTwilio();
    const providers = smsOnlyProviders(twilio);
    const id = await queue(await newApproval(), "sms");

    // Hold Twilio's answer so the callback lands while the send is in flight.
    const release = twilio.hold();
    const dispatching = dispatchNotification(db, id, { providers, systemGuardId: guardId });
    while (twilio.calls.length === 0) await new Promise((r) => setTimeout(r, 5));
    // The fake hands out its SID on release; predict nothing — read it after.
    release();
    const outcome = await dispatching;
    const sid = (await row(id)).providerMessageId!;
    expect(outcome.finalStatus).toBe("sent");

    // Now replay the real ordering problem with a known SID: callback first.
    const id2 = await queue(await newApproval(), "sms");
    const earlySid = `SM${randomUUID().replace(/-/g, "")}`;
    sids.push(earlySid);
    expect((await callback(status(earlySid, "delivered"))).status).toBe(200);
    expect((await row(id2)).status).toBe("queued");
    const fixedSid: typeof fetch = (async () =>
      new Response(JSON.stringify({ sid: earlySid, status: "accepted" }), { status: 201 })) as unknown as typeof fetch;
    const providers2 = smsOnlyProviders({ ...fakeTwilio(), fetchImpl: fixedSid });
    const outcome2 = await dispatchNotification(db, id2, { providers: providers2, systemGuardId: guardId });
    expect(outcome2.finalStatus).toBe("delivered");
    expect((await row(id2)).status).toBe("delivered");
    expect(await auditCount("notification_delivered", id2)).toBe(1);
    expect(sid).not.toBe(earlySid);
  });

  it("callback and SID save racing each other: the row always ends 'delivered', whichever commits first", async () => {
    for (let i = 0; i < 6; i++) {
      const id = await queue(await newApproval(), "sms");
      const sid = `SM${randomUUID().replace(/-/g, "")}`;
      sids.push(sid);
      const fetchImpl = (async () =>
        new Response(JSON.stringify({ sid, status: "accepted" }), { status: 201 })) as unknown as typeof fetch;
      const providers = smsOnlyProviders({ ...fakeTwilio(), fetchImpl });
      const send = () => dispatchNotification(db, id, { providers, systemGuardId: guardId });
      const cb = () => callback(status(sid, "delivered"));
      if (i % 2 === 0) await Promise.all([send(), cb()]);
      else await Promise.all([cb(), send()]);
      expect((await row(id)).status).toBe("delivered");
      expect(await auditCount("notification_delivered", id)).toBe(1);
    }
  });

  it("Twilio accepted but the 'sent' audit write fails: an early 'undelivered' is still applied and the SMS fallback goes out", async () => {
    // Real Postgres failure injection on the notification_sent audit insert for one SID.
    const sid = `SMdead${randomUUID().replace(/-/g, "").slice(0, 28)}`;
    sids.push(sid);
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION gp_test_fail_sent_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.event_type::text = 'notification_sent' AND NEW.payload::text LIKE '%SMdead%' THEN
          RAISE EXCEPTION 'injected notification_sent audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await db.execute(sql`DROP TRIGGER IF EXISTS gp_test_fail_sent_audit ON audit_events`);
    await db.execute(sql`
      CREATE TRIGGER gp_test_fail_sent_audit BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION gp_test_fail_sent_audit();
    `);
    try {
      const twilio = fakeTwilio();
      const providers = smsOnlyProviders(twilio);
      const fixedSid: typeof fetch = (async () =>
        new Response(JSON.stringify({ sid, status: "accepted" }), { status: 201 })) as unknown as typeof fetch;
      providers.whatsapp = new TwilioWhatsAppProvider(
        {
          accountSid: `AC${"a".repeat(32)}`,
          apiKeySid: `SK${"b".repeat(32)}`,
          apiKeySecret: "fake",
          statusCallbackUrl: CALLBACK_URL,
          from: "whatsapp:+254700000001",
          contentSid: `HX${"d".repeat(32)}`,
        },
        { fetch: fixedSid },
      );
      setNotificationProviders(providers);
      const approvalId = await newApproval();
      const waId = await queue(approvalId, "whatsapp");
      expect((await callback(status(sid, "undelivered", { ErrorCode: "63016" }))).status).toBe(200);

      const outcome = await dispatchNotification(db, waId, { providers, systemGuardId: guardId });
      expect(outcome.finalStatus).toBe("failed");
      expect(outcome.fallbackEnqueued).toBe(true);
      const wa = await row(waId);
      expect(wa.status).toBe("failed");
      expect(wa.providerMessageId).toBe(sid);
      const rows = await db.select().from(notifications).where(eq(notifications.approvalId, approvalId));
      expect(rows.filter((r) => r.channel === "sms")).toHaveLength(1);
      expect(twilio.calls.filter((c) => c.to === PHONE)).toHaveLength(1);
    } finally {
      await db.execute(sql`DROP TRIGGER IF EXISTS gp_test_fail_sent_audit ON audit_events`);
      await db.execute(sql`DROP FUNCTION IF EXISTS gp_test_fail_sent_audit()`);
    }
  });

  it("WhatsApp 'undelivered' → WhatsApp row failed and the SMS fallback is sent exactly once", async () => {
    const twilio = fakeTwilio();
    const providers = smsOnlyProviders(twilio);
    providers.whatsapp = new TwilioWhatsAppProvider(
      {
        accountSid: `AC${"a".repeat(32)}`,
        apiKeySid: `SK${"b".repeat(32)}`,
        apiKeySecret: "fake",
        statusCallbackUrl: CALLBACK_URL,
        from: "whatsapp:+254700000001",
        contentSid: `HX${"d".repeat(32)}`,
      },
      { fetch: twilio.fetchImpl },
    );
    setNotificationProviders(providers);
    const approvalId = await newApproval();
    const waId = await queue(approvalId, "whatsapp");
    await dispatchNotification(db, waId, { providers, systemGuardId: guardId });
    expect(twilio.calls[0].body.get("ContentSid")).toBe(`HX${"d".repeat(32)}`);
    const waSid = (await row(waId)).providerMessageId!;

    expect((await callback(status(waSid, "undelivered", { ErrorCode: "63016" }))).status).toBe(200);
    expect((await callback(status(waSid, "undelivered", { ErrorCode: "63016" }))).status).toBe(200);
    expect((await callback(status(waSid, "failed"))).status).toBe(200);

    const wa = await row(waId);
    expect(wa.status).toBe("failed");
    expect(wa.lastErrorCode).toBe("DELIVERY_UNDELIVERED");
    const rows = await db.select().from(notifications).where(eq(notifications.approvalId, approvalId));
    const sms = rows.filter((r) => r.channel === "sms");
    expect(sms).toHaveLength(1);
    expect(sms[0].status).toBe("sent");
    expect(twilio.calls.filter((c) => c.to === PHONE)).toHaveLength(1);
    expect(twilio.count()).toBe(2);
    expect(await auditCount("notification_failed", waId)).toBe(1);
  });

  it("WhatsApp refused at send time → the SMS fallback is dispatched straight away (G2)", async () => {
    const twilio = fakeTwilio();
    const providers = smsOnlyProviders(twilio);
    const wa = new MockNotificationProvider("whatsapp");
    wa.scriptError("PROVIDER_5XX", { responseCode: 503 });
    providers.whatsapp = wa;
    const approvalId = await newApproval();
    const waId = await queue(approvalId, "whatsapp");
    const outcome = await dispatchNotification(db, waId, { providers, systemGuardId: guardId });
    expect(outcome.fallbackEnqueued).toBe(true);
    const rows = await db.select().from(notifications).where(eq(notifications.approvalId, approvalId));
    const sms = rows.find((r) => r.channel === "sms");
    expect(sms?.status).toBe("sent");
    expect(twilio.count()).toBe(1);
  });
});
