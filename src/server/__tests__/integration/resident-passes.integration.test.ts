/**
 * GatePass — Resident Portal R2 (capability 1: resident-issued passes)
 * against a REAL Postgres, over REAL HTTP.
 *
 * Source: src/docs/specs/resident-portal.md §4, §8 (R2 tests).
 *
 * createApp() listens on an ephemeral port in legacy HS256 mode, so the exact
 * stack wired in app.ts is exercised:
 *
 *   POST /api/resident/passes   requireResidentAuth → per-resident limiter
 *
 * Proven here:
 *   - end to end: claim → issue → public preview → guard QR scan consumes →
 *     second scan refused (QR_REPLAYED)
 *   - host/unit come from the resident row; body host/unit are ignored
 *   - TTL is capped at 48h; 11th open pass for a unit is refused; used and
 *     expired passes free capacity; concurrent issues cannot exceed the cap
 *   - audit actor is the resident (guardId null); no raw token/PIN persisted
 *   - atomicity: a genuine audit insert failure leaves no pass row
 *   - stale identity: a resident deactivated after auth is refused in-tx
 *   - cross-role: staff tokens cannot use the route; residents cannot use
 *     the staff invitation route
 *
 * PREREQUISITES: DATABASE_URL set, schema migrated (npx drizzle-kit push).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { and, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import * as jwt from "jsonwebtoken";
import * as schema from "@/db/schema";
import {
  auditEvents,
  authorizationDecisions,
  entryRecords,
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
import { hashQrToken } from "../../services/qr-service";
import {
  issueResidentPass,
  RESIDENT_MAX_OPEN_PASSES_PER_UNIT,
} from "../../services/resident-pass-service";

const savedSupabaseUrl = process.env.SUPABASE_URL;

let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let server: Server;
let baseUrl: string;

let adminId: string;
let guardId: string;
let seniorId: string;
const createdUnitIds: string[] = [];

const AUDIT_TRIGGER_FN = "gatepass_test_fail_resident_pass_audit";
const AUDIT_TRIGGER_NAME = "gatepass_test_fail_resident_pass_audit_trg";

beforeAll(async () => {
  delete process.env.SUPABASE_URL;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for integration tests.");
  if (!process.env.PIN_PEPPER) {
    process.env.PIN_PEPPER = "integration-test-pepper-not-for-production";
  }

  pool = new Pool({ connectionString: databaseUrl, max: 20 });
  db = drizzle(pool, { schema });
  setAuditDB(db);

  const stamp = Date.now();
  const staff = await db
    .insert(guards)
    .values([
      { id: randomUUID(), badgeNumber: `RX-ADMIN-${stamp}`, name: "RX Admin", role: "admin", isActive: true },
      { id: randomUUID(), badgeNumber: `RX-GUARD-${stamp}`, name: "RX Guard", role: "guard", isActive: true },
      { id: randomUUID(), badgeNumber: `RX-SENIOR-${stamp}`, name: "RX Senior", role: "senior-guard", isActive: true },
    ])
    .returning({ id: guards.id, role: guards.role });
  adminId = staff.find((s) => s.role === "admin")!.id;
  guardId = staff.find((s) => s.role === "guard")!.id;
  seniorId = staff.find((s) => s.role === "senior-guard")!.id;

  await db.execute(sql`
    CREATE OR REPLACE FUNCTION ${sql.raw(AUDIT_TRIGGER_FN)}() RETURNS trigger AS $$
    BEGIN
      IF NEW.event_type::text = 'qr_invitation_issued'
         AND NEW.payload->>'visitorName' LIKE 'AUDIT-FAIL%' THEN
        RAISE EXCEPTION 'injected audit persistence failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await db.execute(sql`DROP TRIGGER IF EXISTS ${sql.raw(AUDIT_TRIGGER_NAME)} ON audit_events`);
  await db.execute(sql`
    CREATE TRIGGER ${sql.raw(AUDIT_TRIGGER_NAME)}
    BEFORE INSERT ON audit_events
    FOR EACH ROW EXECUTE FUNCTION ${sql.raw(AUDIT_TRIGGER_FN)}();
  `);
});

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
      .select({ label: units.label })
      .from(units)
      .where(inArray(units.id, createdUnitIds));
    const labels = unitRows.map((u) => u.label);
    const residentIds = (
      await db
        .select({ id: residents.id })
        .from(residents)
        .where(inArray(residents.unitId, createdUnitIds))
    ).map((r) => r.id);
    if (residentIds.length > 0) {
      await db.delete(auditEvents).where(inArray(auditEvents.residentId, residentIds));
    }
    await db.delete(auditEvents).where(inArray(auditEvents.guardId, [adminId, guardId, seniorId]));
    if (labels.length > 0) {
      await db.delete(entryRecords).where(inArray(entryRecords.unit, labels));
      await db.delete(authorizationDecisions).where(inArray(authorizationDecisions.unit, labels));
    }
    await db.delete(unitClaimCodes).where(inArray(unitClaimCodes.unitId, createdUnitIds));
    await db.delete(residents).where(inArray(residents.unitId, createdUnitIds));
    await db.delete(units).where(inArray(units.id, createdUnitIds));
    createdUnitIds.length = 0;
  }
  await db.delete(residentClaimAttempts).where(sql`true`);
});

afterAll(async () => {
  await db.execute(sql`DROP TRIGGER IF EXISTS ${sql.raw(AUDIT_TRIGGER_NAME)} ON audit_events`);
  await db.execute(sql`DROP FUNCTION IF EXISTS ${sql.raw(AUDIT_TRIGGER_FN)}()`);
  await db.delete(auditEvents).where(inArray(auditEvents.guardId, [adminId, guardId, seniorId]));
  await db.delete(guards).where(inArray(guards.id, [adminId, guardId, seniorId]));
  clearAuditDB();
  await pool.end();
  if (savedSupabaseUrl !== undefined) process.env.SUPABASE_URL = savedSupabaseUrl;
});

function staffToken(id: string): string {
  return jwt.sign({ sub: id }, getJWTSecret(), { algorithm: "HS256", expiresIn: "5m" });
}

function residentToken(supabaseUserId: string, phone: string): string {
  return jwt.sign({ sub: supabaseUserId, phone }, getJWTSecret(), {
    algorithm: "HS256",
    expiresIn: "5m",
  });
}

interface Api {
  status: number;
  body: Record<string, unknown> & { error?: { code: string; message: string } };
}

async function api(method: string, path: string, token: string | null, body?: unknown): Promise<Api> {
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

let counter = 0;
function uniq(prefix: string): string {
  counter += 1;
  return `${prefix}${Date.now() % 100000}${counter}`;
}

function freshPhone(): string {
  counter += 1;
  return `+2547${String(Date.now() % 1_000_000).padStart(6, "0")}${String(counter % 100).padStart(2, "0")}`;
}

async function claimedResident(prefix: string, displayName = "Amina Wanjiru") {
  const u = await api("POST", "/api/admin/units", staffToken(adminId), { label: uniq(prefix) });
  expect(u.status, JSON.stringify(u.body)).toBe(201);
  const unit = u.body.unit as { id: string; label: string };
  createdUnitIds.push(unit.id);
  const c = await api("POST", `/api/admin/units/${unit.id}/claim-codes`, staffToken(adminId), {});
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  const { code } = c.body.claimCode as { code: string };
  const userId = randomUUID();
  const phone = freshPhone();
  const token = residentToken(userId, phone.slice(1));
  const r = await api("POST", "/api/resident/claim", token, { code, displayName });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const resident = r.body.resident as { id: string; unitId: string; unitLabel: string };
  return { unit, token, resident, phone };
}

interface IssuedPass {
  id: string;
  qrToken: string;
  passUrl: string;
  passRef: string;
  pin: string;
  host: string;
  unit: string;
  plate: string | null;
  expiresAt: string;
  issuedAt: string;
}

async function issue(token: string, body: Record<string, unknown>): Promise<Api> {
  return api("POST", "/api/resident/passes", token, body);
}

describe("resident pass — end to end through the existing gate scan", () => {
  it("claim → issue → preview → guard scan consumes → second scan is QR_REPLAYED", async () => {
    const { token, resident, unit } = await claimedResident("RX-E");

    const r = await issue(token, { visitorName: "John Kamau", plate: "kca 123a", ttlHours: 6 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const pass = r.body.invitation as IssuedPass;
    expect(pass.host).toBe("Amina Wanjiru");
    expect(pass.unit).toBe(unit.label);
    expect(pass.plate).toBe("KCA 123A");
    expect(pass.passUrl).toContain(`/pass/${pass.qrToken}`);
    expect(pass.pin).toMatch(/^\d{6}$/);
    const ttlMs = new Date(pass.expiresAt).getTime() - new Date(pass.issuedAt).getTime();
    expect(Math.abs(ttlMs - 6 * 3600_000)).toBeLessThan(5_000);

    const [row] = await db
      .select()
      .from(authorizationDecisions)
      .where(eq(authorizationDecisions.id, pass.id));
    expect(row.issuedByResidentId).toBe(resident.id);
    expect(row.qrTokenHash).toBe(hashQrToken(pass.qrToken));
    expect(JSON.stringify(row)).not.toContain(pass.qrToken);
    expect(row.pinHash).not.toContain(pass.pin);

    const preview = await api("GET", `/api/visitor-invitations/${encodeURIComponent(pass.qrToken)}/preview`, null);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.invitation).toEqual({
      visitorName: "John Kamau",
      host: "Amina Wanjiru",
      unit: unit.label,
      plate: "KCA 123A",
      expiresAt: pass.expiresAt,
    });

    const scan = await api("POST", "/api/entries/qr/validate", staffToken(guardId), {
      qrToken: pass.qrToken,
      scannedAt: new Date().toISOString(),
    });
    expect(scan.status, JSON.stringify(scan.body)).toBe(200);
    expect(scan.body.outcome).toBe("valid");
    expect((scan.body.visitor as { unit: string; host: string })).toMatchObject({
      unit: unit.label,
      host: "Amina Wanjiru",
    });

    const replay = await api("POST", "/api/entries/qr/validate", staffToken(guardId), {
      qrToken: pass.qrToken,
      scannedAt: new Date().toISOString(),
    });
    expect(replay.status).toBe(409);
    expect(replay.body.error?.code).toBe("QR_REPLAYED");
  });

  it("audit: qr_invitation_issued is attributed to the resident, never a guard, with no raw secrets", async () => {
    const { token, resident, unit, phone } = await claimedResident("RX-A");
    const r = await issue(token, { visitorName: "Audit Visitor" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const pass = r.body.invitation as IssuedPass;

    const rows = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.eventType, "qr_invitation_issued"), eq(auditEvents.residentId, resident.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0].guardId).toBeNull();
    expect(rows[0].payload).toMatchObject({
      invitationId: pass.id,
      unit: unit.label,
      unitId: unit.id,
      host: "Amina Wanjiru",
      issuedBy: "resident",
    });
    const serialized = JSON.stringify(rows[0].payload);
    expect(serialized).not.toContain(pass.qrToken);
    expect(serialized).not.toContain(pass.pin);
    expect(serialized).not.toContain(phone);

    const mem = getAuditLog().filter((e) => e.type === "qr_invitation_issued" && e.residentId === resident.id);
    expect(mem).toHaveLength(1);
    expect(mem[0].guardId).toBeNull();
  });
});

describe("resident pass — scope", () => {
  it("client-supplied host / unit / role are ignored; the server derives them", async () => {
    const victim = await claimedResident("RX-V", "Victim Resident");
    const { token } = await claimedResident("RX-S", "Sender Resident");

    const r = await issue(token, {
      visitorName: "Sneaky",
      host: "Victim Resident",
      unit: victim.unit.label,
      unitId: victim.unit.id,
      residentId: victim.resident.id,
      role: "admin",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const pass = r.body.invitation as IssuedPass;
    expect(pass.host).toBe("Sender Resident");
    expect(pass.unit).not.toBe(victim.unit.label);

    const victimPasses = await db
      .select({ id: authorizationDecisions.id })
      .from(authorizationDecisions)
      .where(eq(authorizationDecisions.unit, victim.unit.label));
    expect(victimPasses).toHaveLength(0);
  });

  it("staff tokens are refused on the resident route; anon is 401; a resident cannot use the staff route", async () => {
    const { token } = await claimedResident("RX-X");
    for (const id of [guardId, seniorId, adminId]) {
      const r = await issue(staffToken(id), { visitorName: "Nope" });
      expect(r.status).toBe(403);
      expect(r.body.error?.code).toBe("AUTH_NO_RESIDENT_LINK");
    }
    const anon = await issue("", { visitorName: "Nope" });
    expect(anon.status).toBe(401);

    const staffRoute = await api("POST", "/api/visitor-invitations", token, {
      visitorName: "Nope",
      host: "Anyone",
      unit: "ANY",
    });
    expect([401, 403]).toContain(staffRoute.status);
  });

  it("deactivated resident and deactivated unit are refused (403)", async () => {
    const a = await claimedResident("RX-DR");
    await api("POST", `/api/admin/residents/${a.resident.id}/deactivate`, staffToken(adminId));
    expect((await issue(a.token, { visitorName: "X" })).status).toBe(403);

    const b = await claimedResident("RX-DU");
    await api("POST", `/api/admin/units/${b.unit.id}/deactivate`, staffToken(adminId));
    expect((await issue(b.token, { visitorName: "X" })).status).toBe(403);
  });

  it("a resident deactivated after auth resolved is refused inside the transaction", async () => {
    const a = await claimedResident("RX-ST");
    const [row] = await db.select().from(residents).where(eq(residents.id, a.resident.id));
    const staleIdentity = {
      residentId: row.id,
      supabaseUserId: row.supabaseUserId,
      displayName: row.displayName,
      phoneE164: row.phoneE164,
      unitId: row.unitId,
      unitLabel: a.unit.label,
    };
    await api("POST", `/api/admin/residents/${a.resident.id}/deactivate`, staffToken(adminId));

    await expect(
      issueResidentPass({ visitorName: "Late", plate: null, ttlHours: 4 }, staleIdentity, db),
    ).rejects.toMatchObject({ code: "RESIDENT_INACTIVE", statusCode: 403 });

    const b = await claimedResident("RX-SU");
    const [rowB] = await db.select().from(residents).where(eq(residents.id, b.resident.id));
    await api("POST", `/api/admin/units/${b.unit.id}/deactivate`, staffToken(adminId));
    await expect(
      issueResidentPass(
        { visitorName: "Late", plate: null, ttlHours: 4 },
        { ...staleIdentity, residentId: rowB.id, supabaseUserId: rowB.supabaseUserId, unitId: rowB.unitId, unitLabel: b.unit.label },
        db,
      ),
    ).rejects.toMatchObject({ code: "UNIT_INACTIVE", statusCode: 403 });

    const passes = await db
      .select({ id: authorizationDecisions.id })
      .from(authorizationDecisions)
      .where(inArray(authorizationDecisions.unit, [a.unit.label, b.unit.label]));
    expect(passes).toHaveLength(0);
  });
});

describe("resident pass — limits", () => {
  it("ttlHours above 48 is rejected (422); 48 is accepted; default is 24", async () => {
    const { token } = await claimedResident("RX-T");
    const over = await issue(token, { visitorName: "Long Stay", ttlHours: 49 });
    expect(over.status).toBe(422);
    expect(over.body.error?.code).toBe("RESIDENT_INVALID_INPUT");

    const max = await issue(token, { visitorName: "Max Stay", ttlHours: 48 });
    expect(max.status, JSON.stringify(max.body)).toBe(201);
    const maxPass = max.body.invitation as IssuedPass;
    const maxMs = new Date(maxPass.expiresAt).getTime() - new Date(maxPass.issuedAt).getTime();
    expect(Math.abs(maxMs - 48 * 3600_000)).toBeLessThan(5_000);

    const def = await issue(token, { visitorName: "Default Stay" });
    const defPass = def.body.invitation as IssuedPass;
    const defMs = new Date(defPass.expiresAt).getTime() - new Date(defPass.issuedAt).getTime();
    expect(Math.abs(defMs - 24 * 3600_000)).toBeLessThan(5_000);
  });

  it(`exactly ${RESIDENT_MAX_OPEN_PASSES_PER_UNIT} open passes per unit; used and expired passes free capacity`, async () => {
    const { token, unit } = await claimedResident("RX-C");
    const ids: string[] = [];
    for (let i = 0; i < RESIDENT_MAX_OPEN_PASSES_PER_UNIT; i += 1) {
      const r = await issue(token, { visitorName: `Visitor ${i}` });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      ids.push((r.body.invitation as IssuedPass).id);
    }
    const over = await issue(token, { visitorName: "One too many" });
    expect(over.status).toBe(409);
    expect(over.body.error?.code).toBe("RESIDENT_PASS_LIMIT_REACHED");

    await db.update(authorizationDecisions).set({ isUsed: true, usedAt: new Date() }).where(eq(authorizationDecisions.id, ids[0]));
    expect((await issue(token, { visitorName: "After use" })).status).toBe(201);
    expect((await issue(token, { visitorName: "Full again" })).status).toBe(409);

    await db.update(authorizationDecisions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(authorizationDecisions.id, ids[1]));
    expect((await issue(token, { visitorName: "After expiry" })).status).toBe(201);

    const open = await db
      .select({ id: authorizationDecisions.id })
      .from(authorizationDecisions)
      .where(
        and(
          eq(authorizationDecisions.unit, unit.label),
          eq(authorizationDecisions.isUsed, false),
          sql`${authorizationDecisions.expiresAt} > now()`,
        ),
      );
    expect(open).toHaveLength(RESIDENT_MAX_OPEN_PASSES_PER_UNIT);
  });

  it("concurrent issues for one unit cannot exceed the cap", async () => {
    const { token, unit } = await claimedResident("RX-R");
    const results = await Promise.all(
      Array.from({ length: RESIDENT_MAX_OPEN_PASSES_PER_UNIT + 6 }, (_, i) =>
        issue(token, { visitorName: `Racer ${i}` }),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(RESIDENT_MAX_OPEN_PASSES_PER_UNIT);
    expect(statuses.filter((s) => s === 409)).toHaveLength(6);

    const rows = await db
      .select({ id: authorizationDecisions.id })
      .from(authorizationDecisions)
      .where(eq(authorizationDecisions.unit, unit.label));
    expect(rows).toHaveLength(RESIDENT_MAX_OPEN_PASSES_PER_UNIT);
  });

  it("staff-issued passes for the unit do not consume the resident cap", async () => {
    const { token, unit } = await claimedResident("RX-SC");
    const staff = await api("POST", "/api/visitor-invitations", staffToken(seniorId), {
      visitorName: "Staff Guest",
      host: "Front desk",
      unit: unit.label,
    });
    expect(staff.status, JSON.stringify(staff.body)).toBe(201);
    for (let i = 0; i < RESIDENT_MAX_OPEN_PASSES_PER_UNIT; i += 1) {
      expect((await issue(token, { visitorName: `V${i}` })).status).toBe(201);
    }
  });
});

describe("resident pass — atomicity", () => {
  it("a genuine audit insert failure leaves no pass row and no published event", async () => {
    const { token, unit, resident } = await claimedResident("RX-F");
    const r = await issue(token, { visitorName: "AUDIT-FAIL visitor" });
    expect(r.status).toBe(500);

    const rows = await db
      .select({ id: authorizationDecisions.id })
      .from(authorizationDecisions)
      .where(eq(authorizationDecisions.unit, unit.label));
    expect(rows).toHaveLength(0);
    expect(
      getAuditLog().filter((e) => e.type === "qr_invitation_issued" && e.residentId === resident.id),
    ).toHaveLength(0);

    expect((await issue(token, { visitorName: "Fine visitor" })).status).toBe(201);
  });
});
