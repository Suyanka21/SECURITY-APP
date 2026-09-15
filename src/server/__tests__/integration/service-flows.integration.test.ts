/**
 * GatePass — Service-layer integration tests against a REAL PostgreSQL.
 *
 * Source: GatePass-Antigravity-Handoff §6.6 — "Real database integration check"
 * Source: Test-Driven-Development skill — "Validate real DB behavior"
 *
 * The unit suite proves these flows against an in-memory DB double. This
 * file runs the SAME service functions (entry-service, sync-service,
 * pin-service, qr-service, audit-logger) through Drizzle against a live
 * Postgres so that transaction, constraint and trigger semantics are the
 * database's, not a mock's.
 *
 * FLOWS COVERED:
 * 1. Entry creation — row + audit row committed
 * 2. Override logging — override row + override_authorized audit row are
 *    ONE atomic commit; a real INSERT failure on override_events rolls back
 *    the entry, the override AND the audit row (re-tests PR #33 for real)
 * 3. Offline sync replay — batch commits, replay is idempotent (duplicate)
 * 4. Locked-pass refusal — 5 wrong PINs lock the pass; the correct PIN and
 *    the QR are both refused while locked; pass stays unused
 * 5. Audit persistence — every step above left append-only audit rows
 *
 * Failure injection uses a test-only BEFORE INSERT trigger on
 * override_events that raises for a marker reason. It is a genuine
 * Postgres error inside the caller's transaction — exactly what a
 * constraint violation or connection drop would produce — not a stub.
 *
 * RUN: npx vitest run --config vitest.integration.config.ts
 * PREREQUISITES: DATABASE_URL set, schema migrated (npx drizzle-kit push),
 *                PIN_PEPPER set (any value ≥ 16 chars works for tests).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { and, eq, sql } from "drizzle-orm";
import { createHash, randomUUID } from "crypto";
import * as schema from "@/db/schema";
import {
  guards,
  entryRecords,
  overrideEvents,
  auditEvents,
  syncEvents,
  authorizationDecisions,
} from "@/db/schema";
import { createEntry, ServiceError } from "../../services/entry-service";
import { syncEntries } from "../../services/sync-service";
import {
  validatePinRedemption,
  hashPin,
  MAX_PIN_ATTEMPTS,
} from "../../services/pin-service";
import { validateQrToken } from "../../services/qr-service";
import {
  setAuditDB,
  clearAuditDB,
  clearAuditLog,
  getAuditLog,
} from "../../services/audit-logger";
import type { DrizzleDB } from "../../services/entry-service";

// ─── Real DB ─────────────────────────────────────────────────────────────────

let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let svcDb: DrizzleDB;
let guardId: string;

const INJECT_FAIL_REASON = "INJECT-FAIL: override_events insert must fail";
const TRIGGER_FN = "gatepass_test_fail_override_insert";
const TRIGGER_NAME = "gatepass_test_fail_override_insert_trg";

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for integration tests.");
  }
  if (!process.env.PIN_PEPPER) {
    process.env.PIN_PEPPER = "integration-test-pepper-not-for-production";
  }

  pool = new Pool({ connectionString: databaseUrl, max: 5 });
  db = drizzle(pool, { schema });
  svcDb = db as unknown as DrizzleDB;
  setAuditDB(db);

  const [g] = await db
    .insert(guards)
    .values({
      id: randomUUID(),
      badgeNumber: `TEST-FLOW-${Date.now()}`,
      name: "Integration Flow Guard",
      isActive: true,
    })
    .returning({ id: guards.id });
  guardId = g.id;

  // Real failure injection: a genuine Postgres error raised inside the
  // caller's transaction when the override reason carries the marker.
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION ${sql.raw(TRIGGER_FN)}() RETURNS trigger AS $$
    BEGIN
      IF NEW.reason LIKE 'INJECT-FAIL:%' THEN
        RAISE EXCEPTION 'injected override_events insert failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await db.execute(sql`DROP TRIGGER IF EXISTS ${sql.raw(TRIGGER_NAME)} ON override_events`);
  await db.execute(sql`
    CREATE TRIGGER ${sql.raw(TRIGGER_NAME)}
    BEFORE INSERT ON override_events
    FOR EACH ROW EXECUTE FUNCTION ${sql.raw(TRIGGER_FN)}();
  `);
});

afterEach(async () => {
  clearAuditLog();
  // Order respects FKs: sync_events/override_events → entry_records; audit → guard.
  await db.delete(syncEvents).where(eq(syncEvents.guardId, guardId));
  await db.delete(overrideEvents).where(eq(overrideEvents.guardId, guardId));
  await db.delete(entryRecords).where(eq(entryRecords.guardId, guardId));
  await db
    .delete(authorizationDecisions)
    .where(sql`${authorizationDecisions.visitorName} LIKE 'FLOW-TEST %'`);
  await db.delete(auditEvents).where(eq(auditEvents.guardId, guardId));
});

afterAll(async () => {
  await db.execute(sql`DROP TRIGGER IF EXISTS ${sql.raw(TRIGGER_NAME)} ON override_events`);
  await db.execute(sql`DROP FUNCTION IF EXISTS ${sql.raw(TRIGGER_FN)}()`);
  await db.delete(guards).where(eq(guards.id, guardId));
  clearAuditDB();
  await pool.end();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function entryInput(overrides: Record<string, unknown> = {}) {
  return {
    visitorName: "Maya Chen",
    host: "John Doe",
    unit: "18B",
    plate: null,
    reason: "",
    method: "walk-in" as const,
    guardId,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function auditRows(eventType: string) {
  return db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.guardId, guardId),
        sql`${auditEvents.eventType} = ${eventType}`,
      ),
    );
}

async function issuePass(pin: string) {
  const id = randomUUID();
  const passRef = `T${randomUUID().replace(/-/g, "").slice(0, 7).toUpperCase()}`
    .replace(/[ILOU]/g, "7");
  const rawToken = `flow-token-${randomUUID()}`;
  await db.insert(authorizationDecisions).values({
    id,
    visitorName: `FLOW-TEST ${id.slice(0, 8)}`,
    host: "Resident",
    unit: "4A",
    qrTokenHash: createHash("sha256").update(rawToken).digest("hex"),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    passRef,
    pinHash: hashPin(id, pin),
  });
  return { id, passRef, rawToken };
}

// ─── 1. Entry creation ───────────────────────────────────────────────────────

describe("[real DB] entry creation", () => {
  it("commits the entry row and its entry_created audit row", async () => {
    const { response, statusCode } = await createEntry(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      entryInput() as any,
      svcDb,
    );

    expect(statusCode).toBe(201);
    const rows = await db
      .select()
      .from(entryRecords)
      .where(eq(entryRecords.id, response.entry.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].guardId).toBe(guardId);
    expect(rows[0].method).toBe("walk-in");
    expect(rows[0].traceId).toBe(response.traceId);

    const audit = await auditRows("entry_created");
    expect(audit).toHaveLength(1);
    expect(audit[0].traceId).toBe(response.traceId);
    expect(audit[0].payload).toMatchObject({ entryId: response.entry.id });
  });
});

// ─── 2. Override logging (PR #33 against a real transaction) ────────────────

describe("[real DB] override logging is atomic with its audit row", () => {
  it("success: entry + override + override_authorized audit commit together", async () => {
    const { response } = await createEntry(
      entryInput({
        method: "override",
        reason: "Resident phoned the gate to admit visitor",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
      svcDb,
    );

    const overrides = await db
      .select()
      .from(overrideEvents)
      .where(eq(overrideEvents.entryId, response.entry.id));
    expect(overrides).toHaveLength(1);

    const authorized = await auditRows("override_authorized");
    expect(authorized).toHaveLength(1);
    expect(authorized[0].payload).toMatchObject({
      overrideId: overrides[0].id,
      entryId: response.entry.id,
    });
    expect(getAuditLog().filter((e) => e.type === "override_authorized")).toHaveLength(1);
  });

  it("failure injection: a real override_events INSERT error rolls back entry, override AND audit row", async () => {
    const before = await auditRows("override_authorized");
    expect(before).toHaveLength(0);

    // Drizzle wraps the driver error ("Failed query: ...") and keeps the
    // Postgres error as `cause`; the injected message must be the root cause.
    const thrown = await createEntry(
      entryInput({
        method: "override",
        reason: INJECT_FAIL_REASON,
        visitorName: "Rolled Back",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
      svcDb,
    ).then(
      () => null,
      (err: unknown) => err as Error & { cause?: Error },
    );
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown!.message).toMatch(/insert into "override_events"/);
    expect(thrown!.cause?.message).toMatch(/injected override_events insert failure/);

    const entries = await db
      .select()
      .from(entryRecords)
      .where(eq(entryRecords.visitorName, "Rolled Back"));
    expect(entries).toHaveLength(0);

    const overrides = await db
      .select()
      .from(overrideEvents)
      .where(eq(overrideEvents.reason, INJECT_FAIL_REASON));
    expect(overrides).toHaveLength(0);

    // The invariant under test: no persisted override_authorized without a
    // committed override row — in the REAL audit table, not a double.
    expect(await auditRows("override_authorized")).toHaveLength(0);
    expect(getAuditLog().filter((e) => e.type === "override_authorized")).toHaveLength(0);
    // And no entry_created either — it is emitted after the transaction.
    expect(await auditRows("entry_created")).toHaveLength(0);
  });

  it("failure injection via sync replay: rejected override leaves no audit row, batch still reports it", async () => {
    const offlineId = randomUUID();
    const { response, statusCode } = await syncEntries(
      {
        guardId,
        entries: [
          {
            offlineId,
            visitorName: "Sync Rolled Back",
            host: "H",
            unit: "1",
            plate: null,
            reason: INJECT_FAIL_REASON,
            method: "override",
            createdAt: new Date().toISOString(),
          },
        ],
      },
      svcDb,
    );

    expect(statusCode).toBe(207);
    expect(response.rejectedCount).toBe(1);
    expect(response.results[0].status).toBe("rejected");

    const entries = await db
      .select()
      .from(entryRecords)
      .where(eq(entryRecords.offlineId, offlineId));
    expect(entries).toHaveLength(0);
    expect(await auditRows("override_authorized")).toHaveLength(0);
    // The batch summary itself is still audited (outside the failed tx).
    expect(await auditRows("batch_sync_completed")).toHaveLength(1);
  });
});

// ─── 3. Offline sync replay ──────────────────────────────────────────────────

describe("[real DB] offline sync replay", () => {
  it("commits a mixed batch, then a replay of the same batch is fully idempotent", async () => {
    const walkIn = randomUUID();
    const override = randomUUID();
    const batch = {
      guardId,
      entries: [
        {
          offlineId: walkIn,
          visitorName: "Offline Walk-in",
          host: "H1",
          unit: "2B",
          plate: "KDA 123A",
          reason: "",
          method: "walk-in" as const,
          createdAt: new Date(Date.now() - 60_000).toISOString(),
        },
        {
          offlineId: override,
          visitorName: "Offline Override",
          host: "H2",
          unit: "3C",
          plate: null,
          reason: "Network was down, resident confirmed by phone",
          method: "override" as const,
          createdAt: new Date(Date.now() - 30_000).toISOString(),
        },
      ],
    };

    const first = await syncEntries(batch, svcDb);
    expect(first.statusCode).toBe(200);
    expect(first.response.syncedCount).toBe(2);
    expect(first.response.rejectedCount).toBe(0);

    const stored = await db
      .select()
      .from(entryRecords)
      .where(eq(entryRecords.guardId, guardId));
    expect(stored).toHaveLength(2);
    expect(stored.map((r) => r.offlineId).sort()).toEqual([walkIn, override].sort());

    const overrideRows = await db
      .select()
      .from(overrideEvents)
      .where(eq(overrideEvents.guardId, guardId));
    expect(overrideRows).toHaveLength(1);

    const syncRows = await db
      .select()
      .from(syncEvents)
      .where(eq(syncEvents.guardId, guardId));
    expect(syncRows).toHaveLength(2);

    // Replay: same offlineIds → duplicates, no new rows anywhere.
    const replay = await syncEntries(batch, svcDb);
    expect(replay.statusCode).toBe(200);
    expect(replay.response.duplicateCount).toBe(2);
    expect(replay.response.syncedCount).toBe(0);
    expect(replay.response.results.map((r) => r.serverId).sort()).toEqual(
      first.response.results.map((r) => r.serverId).sort(),
    );

    const after = await db
      .select()
      .from(entryRecords)
      .where(eq(entryRecords.guardId, guardId));
    expect(after).toHaveLength(2);
    expect(await auditRows("entry_created")).toHaveLength(2);
    expect(await auditRows("override_authorized")).toHaveLength(1);
    expect(await auditRows("batch_sync_completed")).toHaveLength(2);
  });
});

// ─── 4. Locked-pass refusal ──────────────────────────────────────────────────

describe("[real DB] locked-pass refusal", () => {
  const redeem = (passRef: string, pin: string) =>
    validatePinRedemption(
      { passRef, pin, scannedAt: new Date().toISOString(), guardId },
      svcDb,
    );

  it("locks after MAX_PIN_ATTEMPTS wrong PINs; correct PIN and QR are then refused; pass stays unused", async () => {
    const { id, passRef, rawToken } = await issuePass("123456");

    for (let i = 1; i < MAX_PIN_ATTEMPTS; i += 1) {
      await expect(redeem(passRef, "000000")).rejects.toMatchObject({
        code: "PIN_INVALID",
        statusCode: 401,
      });
    }
    // Fifth wrong attempt trips the lock.
    await expect(redeem(passRef, "000000")).rejects.toMatchObject({
      code: "PIN_LOCKED",
      statusCode: 423,
    });

    const [row] = await db
      .select()
      .from(authorizationDecisions)
      .where(eq(authorizationDecisions.id, id));
    expect(row.pinFailedAttempts).toBe(MAX_PIN_ATTEMPTS);
    expect(row.pinLockedUntil).not.toBeNull();
    expect(new Date(row.pinLockedUntil!).getTime()).toBeGreaterThan(Date.now());
    expect(row.isUsed).toBe(false);

    // The CORRECT PIN cannot shortcut the lock…
    await expect(redeem(passRef, "123456")).rejects.toMatchObject({
      code: "PIN_LOCKED",
      statusCode: 423,
    });
    // …and neither can the QR for the same pass.
    await expect(
      validateQrToken(
        { qrToken: rawToken, scannedAt: new Date().toISOString(), guardId },
        svcDb,
      ),
    ).rejects.toMatchObject({ code: "QR_LOCKED" });

    const [still] = await db
      .select()
      .from(authorizationDecisions)
      .where(eq(authorizationDecisions.id, id));
    expect(still.isUsed).toBe(false);
    expect(still.usedByGuardId).toBeNull();

    // Audit persistence for the refusal chain.
    const failed = await auditRows("pin_failed");
    expect(failed.length).toBeGreaterThanOrEqual(MAX_PIN_ATTEMPTS + 1);
    expect(failed.some((e) => (e.payload as { reason?: string }).reason === "LOCKED")).toBe(true);
    expect(await auditRows("pin_locked")).toHaveLength(1);
    const qrRejected = await auditRows("qr_scan_rejected");
    expect(qrRejected.some((e) => (e.payload as { reason?: string }).reason === "QR_LOCKED")).toBe(true);
    // The raw PIN never reaches the audit table.
    for (const e of [...failed, ...qrRejected]) {
      expect(JSON.stringify(e.payload)).not.toContain("123456");
      expect(JSON.stringify(e.payload)).not.toContain(rawToken);
    }
  });

  it("an unlocked pass with the correct PIN is consumed exactly once", async () => {
    const { id, passRef } = await issuePass("654321");

    const ok = await redeem(passRef, "654321");
    expect(ok.statusCode).toBe(200);

    await expect(redeem(passRef, "654321")).rejects.toMatchObject({
      code: "PIN_REPLAYED",
      statusCode: 409,
    });

    const [row] = await db
      .select()
      .from(authorizationDecisions)
      .where(eq(authorizationDecisions.id, id));
    expect(row.isUsed).toBe(true);
    expect(row.usedByGuardId).toBe(guardId);
  });
});

// ─── 5. Audit persistence ────────────────────────────────────────────────────

describe("[real DB] audit persistence", () => {
  it("audit rows are attributed to the guard, correlated by traceId, and survive across flows", async () => {
    const a = await createEntry(entryInput({ visitorName: "Audit A" }) as never, svcDb);
    const b = await createEntry(
      entryInput({
        visitorName: "Audit B",
        method: "override",
        reason: "Second visitor, resident confirmed",
      }) as never,
      svcDb,
    );

    const all = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.guardId, guardId));
    const byTrace = (t: string) => all.filter((e) => e.traceId === t).map((e) => e.eventType).sort();

    expect(byTrace(a.response.traceId)).toEqual(["entry_created"]);
    expect(byTrace(b.response.traceId)).toEqual(["entry_created", "override_authorized"]);

    for (const e of all) {
      expect(e.guardId).toBe(guardId);
      expect(e.createdAt).toBeInstanceOf(Date);
    }
  });

  it("a ServiceError path (unknown guard) is refused before any row is written", async () => {
    const ghost = randomUUID();
    await expect(
      createEntry(entryInput({ guardId: ghost }) as never, svcDb),
    ).rejects.toBeInstanceOf(ServiceError);
    const rows = await db.select().from(entryRecords).where(eq(entryRecords.guardId, ghost));
    expect(rows).toHaveLength(0);
  });
});
