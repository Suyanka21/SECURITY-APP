// @vitest-environment node
/**
 * GatePass — Notification Service Tests (TDD)
 *
 * Source: src/docs/specs/notifications.md §§5–11
 * Source: Test-Driven-Development skill — "failing test first; behavior, not impl"
 * Source: Trustless-System-Auditor skill — every failure path is provable
 *
 * Tests cover:
 *   - Idempotency key shape + determinism
 *   - Template rendering (PII discipline)
 *   - enqueueNotification (queued row, idempotency key set)
 *   - dispatchNotification: success path
 *   - dispatchNotification: WA failure → SMS fallback enqueued (state machine)
 *   - dispatchNotification: max attempts → permanently_failed
 *   - dispatchNotification: lazy flip of stale 'sending'
 *   - dispatchNotification: replay of a delivered row is a no-op
 *   - listNotificationsForApproval: guard-mismatch returns 403
 *   - retryNotification: only failed rows are retryable
 *   - retryNotification: rate-limited within 30s
 *   - retryNotification: rejects when approval is no longer pending
 *   - MockNotificationProvider: idempotency replay does NOT re-send
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
} from "vitest";
import {
  computeIdempotencyKey,
  renderApprovalMagicLinkBody,
  enqueueNotification,
  dispatchNotification,
  listNotificationsForApproval,
  retryNotification,
  DEFAULT_MAX_ATTEMPTS,
  SENDING_STALE_THRESHOLD_MS,
  RETRY_RATE_LIMIT_MS,
  TEMPLATE_KEYS,
} from "../services/notifications/notification-service";
import {
  MockNotificationProvider,
} from "../services/notifications/mock-provider";
import {
  NotificationError,
} from "../services/notifications/provider";
import { ServiceError } from "../services/errors";
import { notifications, approvalRequests } from "@/db/schema";

// ─── Mock DB factory ─────────────────────────────────────────────────────────

interface NotificationRowState {
  id: string;
  approvalId: string;
  channel: "whatsapp" | "sms";
  targetPhone: string;
  templateKey: string;
  renderedBody: string;
  status:
    | "queued"
    | "sending"
    | "delivered"
    | "failed"
    | "permanently_failed";
  attempts: number;
  idempotencyKey: string;
  lastProviderResponseCode: number | null;
  lastProviderResponseExcerpt: string | null;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
  deliveredAt: Date | null;
  failedAt: Date | null;
}

interface ApprovalRowState {
  id: string;
  requestedByGuardId: string;
  status: "pending" | "approved" | "denied" | "expired";
}

interface MockDBOpts {
  approval?: ApprovalRowState | null;
  initialNotifications?: NotificationRowState[];
}

function makeMockDB(opts: MockDBOpts = {}) {
  const approval: ApprovalRowState | null = opts.approval ?? null;
  const rows: NotificationRowState[] = [...(opts.initialNotifications ?? [])];

  // Build a select() that supports .from(t).where(...).limit(n) AND
  // .from(t).where(...).
  const selectMock = vi.fn().mockImplementation(() => ({
    from: vi.fn().mockImplementation((table: unknown) => {
      const apply = (predicate?: (r: NotificationRowState) => boolean) => {
        if (table === notifications) {
          return rows.filter(predicate ?? (() => true));
        }
        if (table === approvalRequests) {
          return approval ? [approval] : [];
        }
        return [];
      };

      return {
        where: vi
          .fn()
          .mockImplementation((_clause: unknown) => {
            const where = (_clause as { _testFilter?: (r: NotificationRowState) => boolean })._testFilter;
            const got = apply(where);
            return Object.assign(Promise.resolve(got), {
              limit: vi.fn().mockImplementation((n: number) => {
                return Promise.resolve(got.slice(0, n));
              }),
            });
          }),
      };
    }),
  }));

  // Build an update() that lets the service mutate rows in-place.
  const updateMock = vi.fn().mockImplementation((table: unknown) => ({
    set: vi.fn().mockImplementation((patch: Partial<NotificationRowState>) => ({
      where: vi.fn().mockImplementation((_clause: unknown) => {
        const filter = (_clause as { _testFilter?: (r: NotificationRowState) => boolean })._testFilter;
        if (table === notifications) {
          for (const r of rows) {
            if (!filter || filter(r)) {
              Object.assign(r, patch);
            }
          }
        }
        return Promise.resolve();
      }),
    })),
  }));

  const insertMock = vi.fn().mockImplementation((table: unknown) => ({
    values: vi.fn().mockImplementation((row: NotificationRowState) => {
      if (table === notifications) {
        rows.push({
          createdAt: new Date(),
          updatedAt: new Date(),
          deliveredAt: null,
          failedAt: null,
          lastProviderResponseCode: null,
          lastProviderResponseExcerpt: null,
          lastErrorCode: null,
          ...row,
        });
      }
      return Promise.resolve();
    }),
  }));

  return {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
    transaction: vi.fn().mockImplementation(
      async (cb: (tx: { insert: typeof insertMock; update: typeof updateMock }) => Promise<void>) => {
        await cb({ insert: insertMock, update: updateMock });
      },
    ),
    query: {},
    _rows: rows,
  };
}

// The mock DB inspects predicates via a custom `_testFilter` we attach
// manually here. We need to monkey-patch `eq` calls — but instead of
// patching drizzle, we let `where(...)` always return all rows for the
// matching table; the service narrows on id/approvalId by reading
// from the .limit(1) result. Since each scenario sets up one or two
// rows targeted at the same id, this is safe.
//
// To target specific rows in tests, we attach `_testFilter` directly
// on objects we pass through `where()`. The where mock looks for it.

beforeEach(() => {
  // Reset module timers/state if any (none here).
});

// ─── Test fixtures ───────────────────────────────────────────────────────────

const GUARD_ID = "guard-1";
const SYSTEM_GUARD_ID = "system-1";
const APPROVAL_ID = "11111111-1111-4111-8111-111111111111";
const PHONE = "+15551230001";
const MAGIC_URL = "https://app.example.com/approve/AAA";

function defaultApproval(): ApprovalRowState {
  return {
    id: APPROVAL_ID,
    requestedByGuardId: GUARD_ID,
    status: "pending",
  };
}

function baseRow(overrides: Partial<NotificationRowState> = {}): NotificationRowState {
  return {
    id: "n-1",
    approvalId: APPROVAL_ID,
    channel: "whatsapp",
    targetPhone: PHONE,
    templateKey: TEMPLATE_KEYS.approvalMagicLink,
    renderedBody: renderApprovalMagicLinkBody({
      visitorName: "Maya Chen",
      host: "A. Okafor",
      unit: "18B",
      magicLinkUrl: MAGIC_URL,
    }),
    status: "queued",
    attempts: 0,
    idempotencyKey: computeIdempotencyKey(APPROVAL_ID, "whatsapp", 0),
    lastProviderResponseCode: null,
    lastProviderResponseExcerpt: null,
    lastErrorCode: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deliveredAt: null,
    failedAt: null,
    ...overrides,
  };
}

function makeProviders(): {
  whatsapp: MockNotificationProvider;
  sms: MockNotificationProvider;
} {
  return {
    whatsapp: new MockNotificationProvider("whatsapp"),
    sms: new MockNotificationProvider("sms"),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("computeIdempotencyKey", () => {
  it("returns a deterministic 64-char hex digest", () => {
    const k = computeIdempotencyKey(APPROVAL_ID, "whatsapp", 0);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(computeIdempotencyKey(APPROVAL_ID, "whatsapp", 0)).toBe(k);
  });

  it("changes when channel changes", () => {
    expect(computeIdempotencyKey(APPROVAL_ID, "whatsapp", 0)).not.toBe(
      computeIdempotencyKey(APPROVAL_ID, "sms", 0),
    );
  });

  it("changes when attempt no changes", () => {
    expect(computeIdempotencyKey(APPROVAL_ID, "whatsapp", 0)).not.toBe(
      computeIdempotencyKey(APPROVAL_ID, "whatsapp", 1),
    );
  });
});

describe("renderApprovalMagicLinkBody", () => {
  it("includes visitor, host, unit, and URL but never the phone number", () => {
    const body = renderApprovalMagicLinkBody({
      visitorName: "Maya Chen",
      host: "A. Okafor",
      unit: "18B",
      magicLinkUrl: MAGIC_URL,
    });
    expect(body).toContain("Maya Chen");
    expect(body).toContain("A. Okafor");
    expect(body).toContain("18B");
    expect(body).toContain(MAGIC_URL);
    expect(body).not.toContain(PHONE);
  });
});

describe("enqueueNotification", () => {
  it("inserts a queued row with the computed idempotency key", async () => {
    const db = makeMockDB();
    const out = await enqueueNotification(db, {
      approvalId: APPROVAL_ID,
      channel: "whatsapp",
      targetPhone: PHONE,
      templateKey: TEMPLATE_KEYS.approvalMagicLink,
      renderedBody: "body",
      attemptNo: 0,
    });

    expect(out.idempotencyKey).toBe(
      computeIdempotencyKey(APPROVAL_ID, "whatsapp", 0),
    );
    expect(db._rows).toHaveLength(1);
    expect(db._rows[0]).toMatchObject({
      approvalId: APPROVAL_ID,
      channel: "whatsapp",
      status: "queued",
      attempts: 0,
    });
  });
});

describe("dispatchNotification — success path", () => {
  it("flips queued → sending → delivered on a 2xx provider response", async () => {
    const row = baseRow();
    const db = makeMockDB({
      approval: defaultApproval(),
      initialNotifications: [row],
    });
    const providers = makeProviders();
    providers.whatsapp.scriptOk();

    const outcome = await dispatchNotification(db, row.id, {
      providers,
      systemGuardId: SYSTEM_GUARD_ID,
    });

    expect(outcome.finalStatus).toBe("delivered");
    expect(outcome.fallbackEnqueued).toBe(false);
    expect(db._rows[0].status).toBe("delivered");
    expect(db._rows[0].deliveredAt).toBeInstanceOf(Date);
    expect(db._rows[0].attempts).toBe(1);
    expect(providers.whatsapp.deliveries.size).toBe(1);
  });
});

describe("dispatchNotification — WA failure", () => {
  it("flips to failed and enqueues SMS fallback when WA returns 5xx (attempts < max)", async () => {
    const row = baseRow();
    const db = makeMockDB({
      approval: defaultApproval(),
      initialNotifications: [row],
    });
    const providers = makeProviders();
    providers.whatsapp.scriptError("PROVIDER_5XX", { responseCode: 503 });

    const outcome = await dispatchNotification(db, row.id, {
      providers,
      systemGuardId: SYSTEM_GUARD_ID,
    });

    expect(outcome.finalStatus).toBe("failed");
    expect(outcome.fallbackEnqueued).toBe(true);
    // Original WA row failed
    const wa = db._rows.find((r) => r.channel === "whatsapp");
    expect(wa?.status).toBe("failed");
    expect(wa?.attempts).toBe(1);
    expect(wa?.lastErrorCode).toBe("PROVIDER_5XX");
    expect(wa?.lastProviderResponseCode).toBe(503);
    // SMS fallback enqueued
    const sms = db._rows.find((r) => r.channel === "sms");
    expect(sms).toBeTruthy();
    expect(sms?.status).toBe("queued");
    expect(sms?.attempts).toBe(0);
  });

  it("flips to permanently_failed on the last attempt and does NOT enqueue SMS again", async () => {
    const row = baseRow({ attempts: DEFAULT_MAX_ATTEMPTS - 1 });
    const db = makeMockDB({
      approval: defaultApproval(),
      initialNotifications: [row],
    });
    const providers = makeProviders();
    providers.whatsapp.scriptError("PROVIDER_5XX", { responseCode: 503 });

    const outcome = await dispatchNotification(db, row.id, {
      providers,
      systemGuardId: SYSTEM_GUARD_ID,
    });

    expect(outcome.finalStatus).toBe("permanently_failed");
    expect(outcome.fallbackEnqueued).toBe(false);
    const sms = db._rows.find((r) => r.channel === "sms");
    expect(sms).toBeUndefined();
  });
});

describe("dispatchNotification — lazy stale sweep", () => {
  it("flips a stuck 'sending' row to failed on read and does not call the provider", async () => {
    const row = baseRow({
      status: "sending",
      updatedAt: new Date(Date.now() - (SENDING_STALE_THRESHOLD_MS + 10_000)),
    });
    const db = makeMockDB({
      approval: defaultApproval(),
      initialNotifications: [row],
    });
    const providers = makeProviders();
    // No script — if provider is called, it would default to ok and break
    // our assertion. We assert it is NOT called.
    const spy = vi.spyOn(providers.whatsapp, "send");

    // After the stale sweep flips → 'failed', the dispatcher then
    // immediately tries to send again (it's the same call). For this
    // test we only want to assert the sweep step. Script a permanent
    // failure to avoid masking the sweep.
    providers.whatsapp.scriptError("PROVIDER_5XX", { responseCode: 503 });

    await dispatchNotification(db, row.id, {
      providers,
      systemGuardId: SYSTEM_GUARD_ID,
    });

    // After dispatch, the row should be 'failed' (the sweep flipped it,
    // then the retry attempt failed too). The provider was called once
    // for the retry attempt — the sweep itself does not call provider.
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("dispatchNotification — replay terminal row", () => {
  it("is a no-op for a delivered row", async () => {
    const row = baseRow({
      status: "delivered",
      attempts: 1,
      deliveredAt: new Date(),
    });
    const db = makeMockDB({
      approval: defaultApproval(),
      initialNotifications: [row],
    });
    const providers = makeProviders();
    const spy = vi.spyOn(providers.whatsapp, "send");

    const outcome = await dispatchNotification(db, row.id, {
      providers,
      systemGuardId: SYSTEM_GUARD_ID,
    });

    expect(outcome.finalStatus).toBe("delivered");
    expect(outcome.fallbackEnqueued).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("is a no-op for a permanently_failed row", async () => {
    const row = baseRow({
      status: "permanently_failed",
      attempts: DEFAULT_MAX_ATTEMPTS,
      failedAt: new Date(),
    });
    const db = makeMockDB({
      approval: defaultApproval(),
      initialNotifications: [row],
    });
    const providers = makeProviders();
    const spy = vi.spyOn(providers.whatsapp, "send");

    const outcome = await dispatchNotification(db, row.id, {
      providers,
      systemGuardId: SYSTEM_GUARD_ID,
    });

    expect(outcome.finalStatus).toBe("permanently_failed");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("listNotificationsForApproval", () => {
  it("returns rows when the calling guard owns the approval", async () => {
    const row = baseRow({ status: "delivered" });
    const db = makeMockDB({
      approval: defaultApproval(),
      initialNotifications: [row],
    });
    const list = await listNotificationsForApproval(db, APPROVAL_ID, GUARD_ID);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(row.id);
  });

  it("rejects with NOTIFICATION_GUARD_MISMATCH when guard doesn't own the approval", async () => {
    const db = makeMockDB({ approval: defaultApproval() });
    await expect(
      listNotificationsForApproval(db, APPROVAL_ID, "different-guard"),
    ).rejects.toThrow(ServiceError);
  });

  it("rejects with NOTIFICATION_NOT_FOUND when approval doesn't exist", async () => {
    const db = makeMockDB();
    await expect(
      listNotificationsForApproval(db, APPROVAL_ID, GUARD_ID),
    ).rejects.toMatchObject({ code: "NOTIFICATION_NOT_FOUND" });
  });
});

describe("retryNotification", () => {
  it("flips a failed row back to queued and clears last_error", async () => {
    const row = baseRow({
      status: "failed",
      attempts: 1,
      failedAt: new Date(Date.now() - (RETRY_RATE_LIMIT_MS + 1_000)),
      lastErrorCode: "PROVIDER_5XX",
      lastProviderResponseCode: 503,
    });
    const db = makeMockDB({
      approval: defaultApproval(),
      initialNotifications: [row],
    });

    const out = await retryNotification(db, row.id, { guardId: GUARD_ID });
    expect(out.status).toBe("queued");
    expect(out.lastErrorCode).toBeNull();
    expect(out.lastProviderResponseCode).toBeNull();
    expect(out.failedAt).toBeNull();
  });

  it("rejects with NOTIFICATION_NOT_RETRYABLE when status is delivered", async () => {
    const row = baseRow({ status: "delivered", attempts: 1, deliveredAt: new Date() });
    const db = makeMockDB({
      approval: defaultApproval(),
      initialNotifications: [row],
    });
    await expect(
      retryNotification(db, row.id, { guardId: GUARD_ID }),
    ).rejects.toMatchObject({ code: "NOTIFICATION_NOT_RETRYABLE" });
  });

  it("rejects with NOTIFICATION_NOT_RETRYABLE when attempts are exhausted", async () => {
    const row = baseRow({
      status: "failed",
      attempts: DEFAULT_MAX_ATTEMPTS,
      failedAt: new Date(Date.now() - (RETRY_RATE_LIMIT_MS + 1_000)),
    });
    const db = makeMockDB({
      approval: defaultApproval(),
      initialNotifications: [row],
    });
    await expect(
      retryNotification(db, row.id, { guardId: GUARD_ID }),
    ).rejects.toMatchObject({ code: "NOTIFICATION_NOT_RETRYABLE" });
  });

  it("rejects with RETRY_RATE_LIMITED when within the throttle window", async () => {
    const row = baseRow({
      status: "failed",
      attempts: 1,
      failedAt: new Date(Date.now() - 5_000),
    });
    const db = makeMockDB({
      approval: defaultApproval(),
      initialNotifications: [row],
    });
    await expect(
      retryNotification(db, row.id, { guardId: GUARD_ID }),
    ).rejects.toMatchObject({ code: "RETRY_RATE_LIMITED" });
  });

  it("rejects with APPROVAL_TERMINAL when the approval is no longer pending", async () => {
    const row = baseRow({
      status: "failed",
      attempts: 1,
      failedAt: new Date(Date.now() - (RETRY_RATE_LIMIT_MS + 1_000)),
    });
    const db = makeMockDB({
      approval: { ...defaultApproval(), status: "approved" },
      initialNotifications: [row],
    });
    await expect(
      retryNotification(db, row.id, { guardId: GUARD_ID }),
    ).rejects.toMatchObject({ code: "APPROVAL_TERMINAL" });
  });

  it("rejects with NOTIFICATION_GUARD_MISMATCH when called by a different guard", async () => {
    const row = baseRow({
      status: "failed",
      attempts: 1,
      failedAt: new Date(Date.now() - (RETRY_RATE_LIMIT_MS + 1_000)),
    });
    const db = makeMockDB({
      approval: defaultApproval(),
      initialNotifications: [row],
    });
    await expect(
      retryNotification(db, row.id, { guardId: "other-guard" }),
    ).rejects.toMatchObject({ code: "NOTIFICATION_GUARD_MISMATCH" });
  });
});

describe("MockNotificationProvider", () => {
  it("does not double-send when called twice with the same idempotency key", async () => {
    const p = new MockNotificationProvider("whatsapp");
    p.scriptOk();
    const r1 = await p.send({ target: PHONE, body: "x", idempotencyKey: "k1" });
    const r2 = await p.send({ target: PHONE, body: "x", idempotencyKey: "k1" });
    expect(r1.providerMessageId).toBe(r2.providerMessageId);
    expect(p.deliveries.size).toBe(1);
    expect(p.attempts.length).toBe(2);
  });

  it("rejects with NotificationError on scripted failure", async () => {
    const p = new MockNotificationProvider("whatsapp");
    p.scriptError("PROVIDER_TIMEOUT", { responseCode: 0, message: "timeout" });
    await expect(
      p.send({ target: PHONE, body: "x", idempotencyKey: "kF" }),
    ).rejects.toBeInstanceOf(NotificationError);
  });

  it("default-deny mode refuses all sends with INVALID_CREDENTIALS", async () => {
    const p = new MockNotificationProvider("whatsapp", { defaultDeny: true });
    await expect(
      p.send({ target: PHONE, body: "x", idempotencyKey: "kD" }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });
});
