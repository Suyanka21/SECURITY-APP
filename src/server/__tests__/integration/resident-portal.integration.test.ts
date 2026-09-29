// @vitest-environment node
/**
 * GatePass — Resident Portal R1 against a REAL Postgres, over REAL HTTP.
 *
 * Source: src/docs/specs/resident-portal.md §2–§3, §8 (R1 tests).
 *
 * The full Express app from createApp() listens on an ephemeral port and is
 * driven with fetch, in legacy HS256 auth mode (SUPABASE_URL unset), so the
 * exact middleware stacks wired in app.ts are what is exercised:
 *
 *   /api/admin/units*, /api/admin/residents*  requireAuth → requireRole("admin")
 *   /api/resident/claim                       requireSupabaseUser
 *   /api/resident/me                          requireResidentAuth
 *
 * Proven here:
 *   - claim-code lifecycle: success, used-code refusal, expired-code refusal,
 *     5 wrong codes → 423 lockout, codes are never stored raw
 *   - atomicity: a genuine Postgres failure (trigger) while consuming the
 *     code leaves NO resident row, NO used code and NO resident_claimed audit
 *   - scoping: /me returns the resident's own unit; inactive resident and
 *     inactive unit → 403; unit deactivation expires that unit's open passes
 *   - cross-role: guard/admin tokens cannot use resident routes, resident
 *     tokens cannot use guard or admin routes
 *
 * PREREQUISITES: DATABASE_URL set, schema migrated (npx drizzle-kit push).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import * as jwt from "jsonwebtoken";
import * as schema from "@/db/schema";
import {
  auditEvents,
  authorizationDecisions,
  guards,
  residentClaimAttempts,
  residents,
  unitClaimCodes,
  units,
} from "@/db/schema";
import { createApp } from "../../app";
import { getJWTSecret } from "../../middleware/auth";
import {
  clearAuditDB,
  clearAuditLog,
  getAuditLog,
  setAuditDB,
} from "../../services/audit-logger";
import { MAX_CLAIM_ATTEMPTS } from "../../services/resident-service";

// ─── Environment ─────────────────────────────────────────────────────────────

const savedSupabaseUrl = process.env.SUPABASE_URL;

let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let server: Server;
let baseUrl: string;

let adminId: string;
let guardId: string;
const createdUnitIds: string[] = [];

const TRIGGER_FN = "gatepass_test_fail_claim_consume";
const TRIGGER_NAME = "gatepass_test_fail_claim_consume_trg";

beforeAll(async () => {
  delete process.env.SUPABASE_URL;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for integration tests.");
  if (!process.env.PIN_PEPPER) {
    process.env.PIN_PEPPER = "integration-test-pepper-not-for-production";
  }

  pool = new Pool({ connectionString: databaseUrl, max: 5 });
  db = drizzle(pool, { schema });
  setAuditDB(db);

  const stamp = Date.now();
  const [a] = await db
    .insert(guards)
    .values({ id: randomUUID(), badgeNumber: `RP-ADMIN-${stamp}`, name: "RP Admin", role: "admin", isActive: true })
    .returning({ id: guards.id });
  adminId = a.id;
  const [g] = await db
    .insert(guards)
    .values({ id: randomUUID(), badgeNumber: `RP-GUARD-${stamp}`, name: "RP Guard", role: "guard", isActive: true })
    .returning({ id: guards.id });
  guardId = g.id;

  // Failure injection: consuming a code for a unit whose label carries the
  // marker raises a real Postgres error inside the claim transaction.
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION ${sql.raw(TRIGGER_FN)}() RETURNS trigger AS $$
    DECLARE lbl text;
    BEGIN
      SELECT label INTO lbl FROM units WHERE id = NEW.unit_id;
      IF NEW.used_at IS NOT NULL AND lbl LIKE 'INJECT-FAIL%' THEN
        RAISE EXCEPTION 'injected claim-code consume failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await db.execute(sql`DROP TRIGGER IF EXISTS ${sql.raw(TRIGGER_NAME)} ON unit_claim_codes`);
  await db.execute(sql`
    CREATE TRIGGER ${sql.raw(TRIGGER_NAME)}
    BEFORE UPDATE ON unit_claim_codes
    FOR EACH ROW EXECUTE FUNCTION ${sql.raw(TRIGGER_FN)}();
  `);

});

// A fresh app per test so the shared strictLimiter (60/window per IP, which
// the claim route deliberately sits behind) never bleeds between tests.
beforeEach(async () => {
  server = createServer(createApp(db));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  clearAuditLog();
  if (createdUnitIds.length > 0) {
    const unitRows = await db
      .select({ id: units.id, label: units.label })
      .from(units)
      .where(inArray(units.id, createdUnitIds));
    const labels = unitRows.map((u) => u.label);
    const residentRows = await db
      .select({ id: residents.id })
      .from(residents)
      .where(inArray(residents.unitId, createdUnitIds));
    const residentIds = residentRows.map((r) => r.id);
    if (residentIds.length > 0) {
      await db.delete(auditEvents).where(inArray(auditEvents.residentId, residentIds));
    }
    await db.delete(auditEvents).where(inArray(auditEvents.guardId, [adminId, guardId]));
    await db.delete(unitClaimCodes).where(inArray(unitClaimCodes.unitId, createdUnitIds));
    await db.delete(residents).where(inArray(residents.unitId, createdUnitIds));
    if (labels.length > 0) {
      await db.delete(authorizationDecisions).where(inArray(authorizationDecisions.unit, labels));
    }
    await db.delete(units).where(inArray(units.id, createdUnitIds));
    createdUnitIds.length = 0;
  }
  await db.delete(residentClaimAttempts).where(sql`true`);
});

afterAll(async () => {
  await db.execute(sql`DROP TRIGGER IF EXISTS ${sql.raw(TRIGGER_NAME)} ON unit_claim_codes`);
  await db.execute(sql`DROP FUNCTION IF EXISTS ${sql.raw(TRIGGER_FN)}()`);
  await db.delete(auditEvents).where(inArray(auditEvents.guardId, [adminId, guardId]));
  await db.delete(guards).where(inArray(guards.id, [adminId, guardId]));
  clearAuditDB();
  await pool.end();
  if (savedSupabaseUrl !== undefined) process.env.SUPABASE_URL = savedSupabaseUrl;
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function staffToken(id: string): string {
  return jwt.sign({ sub: id }, getJWTSecret(), { algorithm: "HS256", expiresIn: "5m" });
}

/** A phone-OTP Supabase user: `sub` is a fresh auth UUID, `phone` as Supabase sets it. */
function residentToken(supabaseUserId: string, phone: string | undefined): string {
  return jwt.sign(
    phone ? { sub: supabaseUserId, phone } : { sub: supabaseUserId },
    getJWTSecret(),
    { algorithm: "HS256", expiresIn: "5m" },
  );
}

interface Api {
  status: number;
  body: Record<string, unknown> & { error?: { code: string; message: string } };
}

async function api(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<Api> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Api["body"] };
}

async function createUnit(label: string): Promise<{ id: string; label: string }> {
  const r = await api("POST", "/api/admin/units", staffToken(adminId), { label });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const unit = r.body.unit as { id: string; label: string };
  createdUnitIds.push(unit.id);
  return unit;
}

async function issueCode(unitId: string, ttlHours?: number): Promise<{ code: string; claimCodeId: string }> {
  const r = await api("POST", `/api/admin/units/${unitId}/claim-codes`, staffToken(adminId), ttlHours ? { ttlHours } : {});
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.claimCode as { code: string; claimCodeId: string };
}

let phoneCounter = 0;
function freshPhone(): string {
  phoneCounter += 1;
  return `+2547${String(Date.now() % 1_000_000).padStart(6, "0")}${String(phoneCounter % 100).padStart(2, "0")}`;
}

async function claimedResident(unitLabel: string) {
  const unit = await createUnit(unitLabel);
  const { code } = await issueCode(unit.id);
  const userId = randomUUID();
  const phone = freshPhone();
  const token = residentToken(userId, phone.slice(1));
  const r = await api("POST", "/api/resident/claim", token, { code, displayName: "Amina" });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const resident = r.body.resident as { id: string; unitId: string; unitLabel: string };
  return { unit, userId, phone, token, resident };
}

// ─── Admin: units + claim codes ──────────────────────────────────────────────

describe("admin unit management", () => {
  it("admin creates a unit; a guard token is refused (403) and anon is 401", async () => {
    const unit = await createUnit(`RP-A${Date.now() % 100000}`);
    expect(unit.label).toMatch(/^RP-A/);

    const asGuard = await api("POST", "/api/admin/units", staffToken(guardId), { label: "RP-NO" });
    expect(asGuard.status).toBe(403);
    expect(asGuard.body.error?.code).toBe("AUTH_FORBIDDEN");

    const anon = await api("POST", "/api/admin/units", null, { label: "RP-NO" });
    expect(anon.status).toBe(401);

    const audit = await db.select().from(auditEvents).where(eq(auditEvents.eventType, "unit_created"));
    expect(audit.some((e) => e.guardId === adminId && (e.payload as { unitId: string }).unitId === unit.id)).toBe(true);
  });

  it("unit labels are unique case/whitespace-insensitively (409 UNIT_LABEL_TAKEN)", async () => {
    const label = `RP-B${Date.now() % 100000}`;
    await createUnit(label);
    const dup = await api("POST", "/api/admin/units", staffToken(adminId), { label: `  ${label.toLowerCase()} ` });
    expect(dup.status).toBe(409);
    expect(dup.body.error?.code).toBe("UNIT_LABEL_TAKEN");
  });

  it("claim codes are stored hashed only, admin-only to issue, and ttl is capped at 7 days", async () => {
    const unit = await createUnit(`RP-C${Date.now() % 100000}`);
    const { code, claimCodeId } = await issueCode(unit.id);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);

    const [row] = await db.select().from(unitClaimCodes).where(eq(unitClaimCodes.id, claimCodeId));
    expect(row.codeHash).not.toContain(code.replace("-", ""));
    expect(row.codeHash).toHaveLength(64);
    expect(row.usedAt).toBeNull();

    const asGuard = await api("POST", `/api/admin/units/${unit.id}/claim-codes`, staffToken(guardId), {});
    expect(asGuard.status).toBe(403);

    const tooLong = await api("POST", `/api/admin/units/${unit.id}/claim-codes`, staffToken(adminId), { ttlHours: 24 * 30 });
    expect(tooLong.status).toBe(422);

    // The audit payload never carries the raw code.
    const audit = await db.select().from(auditEvents).where(eq(auditEvents.eventType, "unit_claim_code_issued"));
    for (const e of audit) expect(JSON.stringify(e.payload)).not.toContain(code.replace("-", ""));
  });
});

// ─── Resident: claim lifecycle ───────────────────────────────────────────────

describe("resident claim", () => {
  it("valid code → resident row bound to exactly that unit, code consumed, resident_claimed audited", async () => {
    const { unit, userId, phone, token, resident } = await claimedResident(`RP-D${Date.now() % 100000}`);
    expect(resident.unitId).toBe(unit.id);
    expect(resident.unitLabel).toBe(unit.label);

    const [row] = await db.select().from(residents).where(eq(residents.supabaseUserId, userId));
    expect(row.unitId).toBe(unit.id);
    expect(row.phoneE164).toBe(phone);
    expect(row.isActive).toBe(true);

    const [code] = await db.select().from(unitClaimCodes).where(eq(unitClaimCodes.unitId, unit.id));
    expect(code.usedAt).not.toBeNull();
    expect(code.usedByResidentId).toBe(row.id);

    const audit = await db.select().from(auditEvents).where(eq(auditEvents.residentId, row.id));
    expect(audit.map((e) => e.eventType)).toEqual(["resident_claimed"]);
    expect(audit[0].guardId).toBeNull();
    expect(getAuditLog().filter((e) => e.type === "resident_claimed" && e.residentId === row.id)).toHaveLength(1);

    const me = await api("GET", "/api/resident/me", token);
    expect(me.status).toBe(200);
    expect(me.body.resident).toMatchObject({ id: row.id, unitId: unit.id, unitLabel: unit.label, phoneE164: phone });
  });

  it("a used code is refused for a second user (generic CLAIM_CODE_INVALID)", async () => {
    const unit = await createUnit(`RP-E${Date.now() % 100000}`);
    const { code } = await issueCode(unit.id);
    const first = await api("POST", "/api/resident/claim", residentToken(randomUUID(), freshPhone().slice(1)), { code, displayName: "One" });
    expect(first.status).toBe(201);

    const second = await api("POST", "/api/resident/claim", residentToken(randomUUID(), freshPhone().slice(1)), { code, displayName: "Two" });
    expect(second.status).toBe(403);
    expect(second.body.error?.code).toBe("CLAIM_CODE_INVALID");
    expect(await db.select().from(residents).where(eq(residents.unitId, unit.id))).toHaveLength(1);
  });

  it("an expired code is refused and nothing is created", async () => {
    const unit = await createUnit(`RP-F${Date.now() % 100000}`);
    const { code, claimCodeId } = await issueCode(unit.id);
    await db
      .update(unitClaimCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(unitClaimCodes.id, claimCodeId));

    const r = await api("POST", "/api/resident/claim", residentToken(randomUUID(), freshPhone().slice(1)), { code, displayName: "Late" });
    expect(r.status).toBe(403);
    expect(r.body.error?.code).toBe("CLAIM_CODE_EXPIRED");
    expect(await db.select().from(residents).where(eq(residents.unitId, unit.id))).toHaveLength(0);
    const [row] = await db.select().from(unitClaimCodes).where(eq(unitClaimCodes.id, claimCodeId));
    expect(row.usedAt).toBeNull();
  });

  it(`${MAX_CLAIM_ATTEMPTS} wrong codes lock the caller (423) — even a correct code is then refused`, async () => {
    const unit = await createUnit(`RP-G${Date.now() % 100000}`);
    const { code } = await issueCode(unit.id);
    const token = residentToken(randomUUID(), freshPhone().slice(1));

    for (let i = 1; i < MAX_CLAIM_ATTEMPTS; i += 1) {
      const r = await api("POST", "/api/resident/claim", token, { code: "ZZZZ-ZZZ0", displayName: "Guess" });
      expect(r.status, `attempt ${i}`).toBe(403);
      expect(r.body.error?.code).toBe("CLAIM_CODE_INVALID");
    }
    const fifth = await api("POST", "/api/resident/claim", token, { code: "ZZZZ-ZZZ0", displayName: "Guess" });
    expect(fifth.status).toBe(423);
    expect(fifth.body.error?.code).toBe("CLAIM_LOCKED");

    const correct = await api("POST", "/api/resident/claim", token, { code, displayName: "Guess" });
    expect(correct.status).toBe(423);
    expect(await db.select().from(residents).where(eq(residents.unitId, unit.id))).toHaveLength(0);

    // A different caller is unaffected and can still redeem the code.
    const other = await api("POST", "/api/resident/claim", residentToken(randomUUID(), freshPhone().slice(1)), { code, displayName: "Honest" });
    expect(other.status).toBe(201);
  });

  it("a token without a verified phone cannot claim (CLAIM_PHONE_REQUIRED)", async () => {
    const unit = await createUnit(`RP-H${Date.now() % 100000}`);
    const { code } = await issueCode(unit.id);
    const r = await api("POST", "/api/resident/claim", residentToken(randomUUID(), undefined), { code, displayName: "NoPhone" });
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe("CLAIM_PHONE_REQUIRED");
  });

  it("ATOMIC: a real DB failure while consuming the code leaves no resident, no used code, no audit", async () => {
    const unit = await createUnit(`INJECT-FAIL ${Date.now() % 100000}`);
    const { code, claimCodeId } = await issueCode(unit.id);
    const userId = randomUUID();
    const before = (await db.select().from(auditEvents).where(eq(auditEvents.eventType, "resident_claimed"))).length;

    const r = await api("POST", "/api/resident/claim", residentToken(userId, freshPhone().slice(1)), { code, displayName: "Boom" });
    expect(r.status).toBe(500);

    expect(await db.select().from(residents).where(eq(residents.supabaseUserId, userId))).toHaveLength(0);
    const [row] = await db.select().from(unitClaimCodes).where(eq(unitClaimCodes.id, claimCodeId));
    expect(row.usedAt).toBeNull();
    expect(row.usedByResidentId).toBeNull();
    const after = (await db.select().from(auditEvents).where(eq(auditEvents.eventType, "resident_claimed"))).length;
    expect(after).toBe(before);
    expect(getAuditLog().filter((e) => e.type === "resident_claimed")).toHaveLength(0);
  });

  it("a phone already linked to a unit cannot be linked by a different account (409, code left unused)", async () => {
    const { phone } = await claimedResident(`RP-P${Date.now() % 100000}`);
    const other = await createUnit(`RP-P2${Date.now() % 100000}`);
    const { code, claimCodeId } = await issueCode(other.id);
    const r = await api("POST", "/api/resident/claim", residentToken(randomUUID(), phone.slice(1)), { code, displayName: "Dup" });
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe("RESIDENT_PHONE_TAKEN");
    const [row] = await db.select().from(unitClaimCodes).where(eq(unitClaimCodes.id, claimCodeId));
    expect(row.usedAt).toBeNull();
  });

  it("an already-claimed account cannot claim a second unit (409)", async () => {
    const { token } = await claimedResident(`RP-I${Date.now() % 100000}`);
    const other = await createUnit(`RP-I2${Date.now() % 100000}`);
    const { code } = await issueCode(other.id);
    const r = await api("POST", "/api/resident/claim", token, { code, displayName: "Again" });
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe("RESIDENT_ALREADY_CLAIMED");
    const [codeRow] = await db.select().from(unitClaimCodes).where(eq(unitClaimCodes.unitId, other.id));
    expect(codeRow.usedAt).toBeNull();
  });
});

// ─── Scoping + lifecycle ─────────────────────────────────────────────────────

describe("resident scoping and deactivation", () => {
  it("deactivated resident → /me 403 RESIDENT_INACTIVE; a new code re-links the SAME account to a new unit", async () => {
    const { token, resident } = await claimedResident(`RP-J${Date.now() % 100000}`);

    const deact = await api("POST", `/api/admin/residents/${resident.id}/deactivate`, staffToken(adminId));
    expect(deact.status).toBe(200);
    expect((deact.body.resident as { isActive: boolean }).isActive).toBe(false);

    const me = await api("GET", "/api/resident/me", token);
    expect(me.status).toBe(403);
    expect(me.body.error?.code).toBe("RESIDENT_INACTIVE");

    const again = await api("POST", `/api/admin/residents/${resident.id}/deactivate`, staffToken(adminId));
    expect(again.status).toBe(409);

    const newUnit = await createUnit(`RP-J2${Date.now() % 100000}`);
    const { code } = await issueCode(newUnit.id);
    const reclaim = await api("POST", "/api/resident/claim", token, { code, displayName: "Moved" });
    expect(reclaim.status, JSON.stringify(reclaim.body)).toBe(201);
    expect((reclaim.body.resident as { id: string; unitId: string }).id).toBe(resident.id);
    expect((reclaim.body.resident as { unitId: string }).unitId).toBe(newUnit.id);

    const me2 = await api("GET", "/api/resident/me", token);
    expect(me2.status).toBe(200);
    expect((me2.body.resident as { unitId: string }).unitId).toBe(newUnit.id);
  });

  it("unit deactivation → residents deactivated, open passes for that label expired, /me 403", async () => {
    const { unit, token } = await claimedResident(`RP-K${Date.now() % 100000}`);

    const now = Date.now();
    const [openPass] = await db
      .insert(authorizationDecisions)
      .values({
        visitorName: "RP Visitor",
        host: "Amina",
        unit: unit.label,
        qrTokenHash: `rp-open-${randomUUID()}`,
        issuedAt: new Date(now),
        expiresAt: new Date(now + 24 * 3600 * 1000),
        isUsed: false,
        issuedByGuardId: adminId,
      })
      .returning({ id: authorizationDecisions.id });
    const [usedPass] = await db
      .insert(authorizationDecisions)
      .values({
        visitorName: "RP Visitor Used",
        host: "Amina",
        unit: unit.label.toLowerCase(),
        qrTokenHash: `rp-used-${randomUUID()}`,
        issuedAt: new Date(now),
        expiresAt: new Date(now + 24 * 3600 * 1000),
        isUsed: true,
        usedAt: new Date(now),
        issuedByGuardId: adminId,
      })
      .returning({ id: authorizationDecisions.id, expiresAt: authorizationDecisions.expiresAt });

    const r = await api("POST", `/api/admin/units/${unit.id}/deactivate`, staffToken(adminId));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.deactivatedResidentCount).toBe(1);
    expect(r.body.expiredPassCount).toBe(1);

    const [open] = await db.select().from(authorizationDecisions).where(eq(authorizationDecisions.id, openPass.id));
    expect(open.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    const [used] = await db.select().from(authorizationDecisions).where(eq(authorizationDecisions.id, usedPass.id));
    expect(used.expiresAt.getTime()).toBe(usedPass.expiresAt.getTime());

    const me = await api("GET", "/api/resident/me", token);
    expect(me.status).toBe(403);

    const code = await api("POST", `/api/admin/units/${unit.id}/claim-codes`, staffToken(adminId), {});
    expect(code.status).toBe(409);
    expect(code.body.error?.code).toBe("UNIT_INACTIVE");
  });

  it("/me for a resident whose unit was deactivated directly reports UNIT_INACTIVE", async () => {
    const { unit, token } = await claimedResident(`RP-L${Date.now() % 100000}`);
    await db
      .update(units)
      .set({ isActive: false, deactivatedAt: new Date(), deactivatedByGuardId: adminId })
      .where(eq(units.id, unit.id));
    const me = await api("GET", "/api/resident/me", token);
    expect(me.status).toBe(403);
    expect(me.body.error?.code).toBe("UNIT_INACTIVE");
  });
});

// ─── Cross-role boundaries ───────────────────────────────────────────────────

describe("cross-role boundaries", () => {
  it("guard and admin tokens cannot use resident routes", async () => {
    for (const id of [guardId, adminId]) {
      const me = await api("GET", "/api/resident/me", staffToken(id));
      expect(me.status).toBe(403);
      expect(me.body.error?.code).toBe("AUTH_NO_RESIDENT_LINK");
    }
  });

  it("a resident token cannot use guard or admin routes", async () => {
    const { token } = await claimedResident(`RP-M${Date.now() % 100000}`);

    // In Supabase mode requireAuth itself refuses (403 AUTH_NO_GUARD_LINK,
    // proven in resident-auth-boundaries.test.ts). In legacy mode the guard
    // lookup happens in requireRole / the handler: 401 AUTH_FAILED. Either
    // way the resident never reaches a staff handler.
    const refused = new Set(["AUTH_NO_GUARD_LINK", "AUTH_FAILED"]);

    const me = await api("GET", "/api/auth/me", token);
    expect([401, 403]).toContain(me.status);
    expect(refused.has(me.body.error?.code ?? "")).toBe(true);

    const unitsList = await api("GET", "/api/admin/units", token);
    expect([401, 403]).toContain(unitsList.status);
    expect(refused.has(unitsList.body.error?.code ?? "")).toBe(true);

    const accounts = await api("POST", "/api/admin/accounts", token, { name: "X", badgeNumber: "B", email: "x@y.z", role: "admin" });
    expect([401, 403]).toContain(accounts.status);
    expect(refused.has(accounts.body.error?.code ?? "")).toBe(true);

    const invite = await api("POST", "/api/visitor-invitations", token, { visitorName: "X", host: "Y", unit: "Z" });
    expect([401, 403]).toContain(invite.status);
    expect(refused.has(invite.body.error?.code ?? "")).toBe(true);

    const watchlist = await api("GET", "/api/watchlist", token);
    expect([401, 403]).toContain(watchlist.status);
    expect(refused.has(watchlist.body.error?.code ?? "")).toBe(true);
  });

  it("anonymous requests to resident routes are 401", async () => {
    expect((await api("GET", "/api/resident/me", null)).status).toBe(401);
    expect((await api("POST", "/api/resident/claim", null, { code: "AAAA-AAAA", displayName: "x" })).status).toBe(401);
  });
});
