/**
 * GatePass — Resident Portal R3 (capabilities 2 + 3: household members,
 * workers and vehicles) against a REAL Postgres, over REAL HTTP.
 *
 * Source: src/docs/specs/resident-portal.md §3.4, §7.
 *
 * Proven here:
 *   - person / vehicle registration writes the registration, a resident-
 *     attributed visitor profile and a 90-day auto-approval rule; host and
 *     unit come from the resident row, client overrides are ignored
 *   - the existing evaluate() matches a person on exact name/host/unit only;
 *     a resident vehicle matches on unit + plate whatever name/host is typed;
 *     staff rules and person rules never match by plate alone
 *   - a guard's walk-in approval request for the registered plate is
 *     auto-approved end to end
 *   - removal / resident deactivation / unit deactivation stop matching
 *   - renew window, renewal, disabled rules stay disabled, expired rules are
 *     audited under the resident
 *   - another resident's registrations are invisible (404, not 403)
 *   - atomicity: a genuine audit insert failure leaves no partial rows
 *   - staff block: an admin switch-off of a resident rule cannot be undone
 *     by remove + re-register; only an admin clear (with reason) lifts it
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
  approvalRequests,
  auditEvents,
  autoApprovalRules,
  entryRecords,
  guards,
  residentClaimAttempts,
  residents,
  unitClaimCodes,
  unitRegistrations,
  units,
  visitorProfiles,
} from "@/db/schema";
import { createApp } from "../../app";
import { getJWTSecret } from "../../middleware/auth";
import { clearAuditDB, clearAuditLog, getAuditLog, setAuditDB } from "../../services/audit-logger";
import { evaluate } from "../../services/auto-approval-service";

const savedSupabaseUrl = process.env.SUPABASE_URL;

let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let server: Server;
let baseUrl: string;

let adminId: string;
let guardId: string;
let seniorId: string;
const createdUnitIds: string[] = [];
const staffRuleIds: string[] = [];

const AUDIT_TRIGGER_FN = "gatepass_test_fail_registration_audit";
const AUDIT_TRIGGER_NAME = "gatepass_test_fail_registration_audit_trg";
const DAY_MS = 24 * 3600 * 1000;

beforeAll(async () => {
  delete process.env.SUPABASE_URL;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for integration tests.");
  if (!process.env.PIN_PEPPER) {
    process.env.PIN_PEPPER = "integration-test-pepper-not-for-production";
  }

  pool = new Pool({ connectionString: databaseUrl, max: 10 });
  db = drizzle(pool, { schema });
  setAuditDB(db);

  const stamp = Date.now();
  const staff = await db
    .insert(guards)
    .values([
      { id: randomUUID(), badgeNumber: `RG-ADMIN-${stamp}`, name: "RG Admin", role: "admin", isActive: true },
      { id: randomUUID(), badgeNumber: `RG-GUARD-${stamp}`, name: "RG Guard", role: "guard", isActive: true },
      { id: randomUUID(), badgeNumber: `RG-SENIOR-${stamp}`, name: "RG Senior", role: "senior-guard", isActive: true },
    ])
    .returning({ id: guards.id, role: guards.role });
  adminId = staff.find((s) => s.role === "admin")!.id;
  guardId = staff.find((s) => s.role === "guard")!.id;
  seniorId = staff.find((s) => s.role === "senior-guard")!.id;

  await db.execute(sql`
    CREATE OR REPLACE FUNCTION ${sql.raw(AUDIT_TRIGGER_FN)}() RETURNS trigger AS $$
    BEGIN
      IF (NEW.event_type::text = 'resident_registration_created' AND NEW.payload->>'label' LIKE 'AUDIT-FAIL-CREATE%')
         OR (NEW.event_type::text = 'resident_registration_removed' AND NEW.payload->>'label' LIKE 'AUDIT-FAIL-REMOVE%')
         OR (NEW.event_type::text IN ('resident_registration_blocked', 'resident_registration_block_cleared')
             AND EXISTS (SELECT 1 FROM units u WHERE u.id::text = NEW.payload->>'unitId' AND u.label LIKE 'RG-BAF%')) THEN
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
  if (staffRuleIds.length > 0) {
    await db.delete(autoApprovalRules).where(inArray(autoApprovalRules.id, staffRuleIds));
    staffRuleIds.length = 0;
  }
  if (createdUnitIds.length > 0) {
    const labels = (
      await db.select({ label: units.label }).from(units).where(inArray(units.id, createdUnitIds))
    ).map((u) => u.label);
    const residentIds = (
      await db.select({ id: residents.id }).from(residents).where(inArray(residents.unitId, createdUnitIds))
    ).map((r) => r.id);
    await db.delete(unitRegistrations).where(inArray(unitRegistrations.unitId, createdUnitIds));
    if (residentIds.length > 0) {
      await db.delete(visitorProfiles).where(inArray(visitorProfiles.createdByResidentId, residentIds));
      await db.delete(autoApprovalRules).where(inArray(autoApprovalRules.createdByResidentId, residentIds));
      await db.delete(auditEvents).where(inArray(auditEvents.residentId, residentIds));
    }
    if (labels.length > 0) {
      await db.delete(approvalRequests).where(inArray(approvalRequests.unit, labels));
      await db.delete(entryRecords).where(inArray(entryRecords.unit, labels));
    }
    await db.delete(unitClaimCodes).where(inArray(unitClaimCodes.unitId, createdUnitIds));
    await db.delete(residents).where(inArray(residents.unitId, createdUnitIds));
    await db.delete(units).where(inArray(units.id, createdUnitIds));
    createdUnitIds.length = 0;
  }
  await db.delete(auditEvents).where(inArray(auditEvents.guardId, [adminId, guardId, seniorId]));
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
  return jwt.sign({ sub: supabaseUserId, phone }, getJWTSecret(), { algorithm: "HS256", expiresIn: "5m" });
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
  const phone = freshPhone();
  const token = residentToken(randomUUID(), phone.slice(1));
  const r = await api("POST", "/api/resident/claim", token, { code, displayName });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const resident = r.body.resident as { id: string };
  return { unit, token, resident, phone, displayName };
}

interface RegistrationView {
  id: string;
  kind: "person" | "vehicle";
  label: string;
  plate: string | null;
  status: string;
  expiresAt: string;
  createdAt: string;
}

async function register(token: string, body: Record<string, unknown>): Promise<RegistrationView> {
  const r = await api("POST", "/api/resident/registrations", token, body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.registration as RegistrationView;
}

async function registrationRow(id: string) {
  const [row] = await db.select().from(unitRegistrations).where(eq(unitRegistrations.id, id));
  return row;
}

describe("household member (person) registration", () => {
  it("writes registration + resident-attributed profile + 90-day rule; evaluate() matches exact name/host/unit only", async () => {
    const { token, resident, unit, phone } = await claimedResident("RG-P");
    const before = Date.now();
    const reg = await register(token, { kind: "person", label: "Mary Njeri" });
    expect(reg).toMatchObject({ kind: "person", label: "Mary Njeri", plate: null, status: "active" });

    const row = await registrationRow(reg.id);
    expect(row).toMatchObject({ unitId: unit.id, residentId: resident.id, kind: "person", deletedAt: null });

    const [profile] = await db.select().from(visitorProfiles).where(eq(visitorProfiles.id, row.visitorProfileId));
    expect(profile).toMatchObject({
      visitorName: "Mary Njeri",
      host: "Amina Wanjiru",
      unit: unit.label,
      plate: null,
      notes: null,
      watchFlag: false,
      phoneE164: null,
      createdByGuardId: null,
      createdByResidentId: resident.id,
      deletedAt: null,
    });

    const [rule] = await db.select().from(autoApprovalRules).where(eq(autoApprovalRules.id, row.autoApprovalRuleId));
    expect(rule).toMatchObject({
      visitorName: "Mary Njeri",
      host: "Amina Wanjiru",
      unit: unit.label,
      plateRequired: null,
      active: true,
      createdByGuardId: null,
      createdByResidentId: resident.id,
    });
    const ttl = rule.expiresAt.getTime() - before;
    expect(Math.abs(ttl - 90 * DAY_MS)).toBeLessThan(60_000);

    const exact = await evaluate({ visitorName: "mary njeri", host: "amina wanjiru", unit: unit.label }, db);
    expect(exact.match).toBe(true);
    expect(exact.rule?.id).toBe(rule.id);

    const shortHost = await evaluate({ visitorName: "Mary Njeri", host: "Amina", unit: unit.label }, db);
    expect(shortHost).toMatchObject({ match: false, reason: "NO_RULE" });

    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.eventType, "resident_registration_created"), eq(auditEvents.residentId, resident.id)));
    expect(audit).toHaveLength(1);
    expect(audit[0].guardId).toBeNull();
    expect(audit[0].payload).toMatchObject({
      registrationId: reg.id,
      kind: "person",
      unitId: unit.id,
      unit: unit.label,
      visitorProfileId: profile.id,
      autoApprovalRuleId: rule.id,
    });
    expect(JSON.stringify(audit[0].payload)).not.toContain(phone);
    expect(getAuditLog().filter((e) => e.type === "resident_registration_created" && e.residentId === resident.id)).toHaveLength(1);
  });

  it("client-supplied host / unit / notes / watchFlag / attribution are ignored", async () => {
    const victim = await claimedResident("RG-V", "Victim Resident");
    const { token, resident, unit } = await claimedResident("RG-S", "Sender Resident");
    const reg = await register(token, {
      kind: "person",
      label: "Sneaky Worker",
      host: "Victim Resident",
      unit: victim.unit.label,
      unitId: victim.unit.id,
      residentId: victim.resident.id,
      notes: "staff only",
      watchFlag: true,
      createdByGuardId: adminId,
    });
    const row = await registrationRow(reg.id);
    expect(row.unitId).toBe(unit.id);
    expect(row.residentId).toBe(resident.id);
    const [profile] = await db.select().from(visitorProfiles).where(eq(visitorProfiles.id, row.visitorProfileId));
    expect(profile).toMatchObject({
      host: "Sender Resident",
      unit: unit.label,
      notes: null,
      watchFlag: false,
      createdByGuardId: null,
      createdByResidentId: resident.id,
    });
    const victimRules = await db.select().from(autoApprovalRules).where(eq(autoApprovalRules.unit, victim.unit.label));
    expect(victimRules).toHaveLength(0);
  });

  it("a person registration never matches by plate alone, and accepts no plate", async () => {
    const { token, unit } = await claimedResident("RG-PP");
    const reg = await register(token, { kind: "person", label: "Driver Person", plate: "KDB 777Z" });
    expect(reg.plate).toBeNull();
    const d = await evaluate({ visitorName: "Someone Else", host: "Anyone", unit: unit.label, plate: "KDB 777Z" }, db);
    expect(d).toMatchObject({ match: false, reason: "NO_RULE" });
  });

  it("an already-registered name for the unit is a 409", async () => {
    const { token } = await claimedResident("RG-DP");
    await register(token, { kind: "person", label: "Twice Person" });
    const again = await api("POST", "/api/resident/registrations", token, { kind: "person", label: "twice person" });
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe("REGISTRATION_DUPLICATE");
  });
});

describe("vehicle registration — plate matching for resident vehicles", () => {
  it("requires a plate; matches on unit + plate whatever name/host the guard types", async () => {
    const { token, resident, unit } = await claimedResident("RG-VH");
    const noPlate = await api("POST", "/api/resident/registrations", token, { kind: "vehicle", label: "White Vitz" });
    expect(noPlate.status).toBe(422);
    expect(noPlate.body.error?.code).toBe("RESIDENT_INVALID_INPUT");

    const reg = await register(token, { kind: "vehicle", label: "White Vitz", plate: "kda 123x" });
    expect(reg).toMatchObject({ kind: "vehicle", label: "White Vitz", plate: "KDA 123X", status: "active" });
    const row = await registrationRow(reg.id);
    expect(row.plateNorm).toBe("KDA123X");
    const [rule] = await db.select().from(autoApprovalRules).where(eq(autoApprovalRules.id, row.autoApprovalRuleId));
    expect(rule).toMatchObject({
      visitorName: "White Vitz (KDA 123X)",
      plateRequired: "KDA 123X",
      createdByResidentId: resident.id,
      createdByGuardId: null,
    });

    const anyName = await evaluate({ visitorName: "Peter Otieno", host: "Unknown", unit: unit.label, plate: "kda-123x" }, db);
    expect(anyName.match).toBe(true);
    expect(anyName.rule?.id).toBe(rule.id);

    const [bumped] = await db.select().from(autoApprovalRules).where(eq(autoApprovalRules.id, rule.id));
    expect(bumped.matchCount).toBe(1);

    expect(await evaluate({ visitorName: "Peter", host: "X", unit: "SOME-OTHER-UNIT", plate: "KDA 123X" }, db)).toMatchObject({
      match: false,
      reason: "NO_RULE",
    });
    expect(await evaluate({ visitorName: "Peter", host: "X", unit: unit.label, plate: "KDA 124X" }, db)).toMatchObject({
      match: false,
      reason: "NO_RULE",
    });
    expect(await evaluate({ visitorName: "Peter", host: "X", unit: unit.label, plate: null }, db)).toMatchObject({
      match: false,
      reason: "NO_RULE",
    });
  });

  it("staff-created rules keep requiring the exact name/host/unit even when a plate is pinned", async () => {
    const { unit } = await claimedResident("RG-ST");
    const [staffRule] = await db
      .insert(autoApprovalRules)
      .values({
        visitorName: "Staff Visitor",
        host: "Staff Host",
        unit: unit.label,
        plateRequired: "KCC 555C",
        createdByGuardId: adminId,
        expiresAt: new Date(Date.now() + 10 * DAY_MS),
      })
      .returning({ id: autoApprovalRules.id });
    staffRuleIds.push(staffRule.id);

    expect(await evaluate({ visitorName: "Other Name", host: "Staff Host", unit: unit.label, plate: "KCC 555C" }, db)).toMatchObject({
      match: false,
      reason: "NO_RULE",
    });
    expect(await evaluate({ visitorName: "Staff Visitor", host: "Staff Host", unit: unit.label, plate: "KCC 556C" }, db)).toMatchObject({
      match: false,
      reason: "PLATE_MISMATCH",
    });
    const exact = await evaluate({ visitorName: "Staff Visitor", host: "Staff Host", unit: unit.label, plate: "KCC 555C" }, db);
    expect(exact.match).toBe(true);
    expect(exact.rule?.id).toBe(staffRule.id);
  });

  it("a guard's walk-in approval request for the registered plate is auto-approved end to end", async () => {
    const { token, unit } = await claimedResident("RG-WK");
    await register(token, { kind: "vehicle", label: "Blue Demio", plate: "KDE 900E" });
    const r = await api("POST", "/api/approvals", staffToken(guardId), {
      offlineId: randomUUID(),
      draft: {
        visitorName: "Driver Brian",
        host: "Amina",
        unit: unit.label,
        plate: "KDE900E",
        reason: "",
        method: "walk-in",
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.autoApproved).toBe(true);
    expect((r.body.entry as { method: string; unit: string }).method).toBe("auto");
    expect((r.body.matchedRule as { visitorName: string }).visitorName).toBe("Blue Demio (KDE 900E)");
  });

  it("the same plate twice in one unit is a 409; another unit may register it", async () => {
    const a = await claimedResident("RG-DV");
    await register(a.token, { kind: "vehicle", label: "Car One", plate: "KDF 111F" });
    const again = await api("POST", "/api/resident/registrations", a.token, {
      kind: "vehicle",
      label: "Car Renamed",
      plate: "kdf111f",
    });
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe("REGISTRATION_DUPLICATE");

    const b = await claimedResident("RG-DV2");
    await register(b.token, { kind: "vehicle", label: "Car One", plate: "KDF 111F" });
  });
});

describe("removal, deactivation and renewal", () => {
  it("removal soft-deletes the profile (resident remover), disables the rule, and stops matching", async () => {
    const { token, resident, unit } = await claimedResident("RG-RM");
    const reg = await register(token, { kind: "vehicle", label: "Grey Probox", plate: "KDG 222G" });
    const input = { visitorName: "Anyone", host: "Anyone", unit: unit.label, plate: "KDG 222G" };
    expect((await evaluate(input, db)).match).toBe(true);

    const del = await api("DELETE", `/api/resident/registrations/${reg.id}`, token);
    expect(del.status, JSON.stringify(del.body)).toBe(200);

    const row = await registrationRow(reg.id);
    expect(row.deletedAt).not.toBeNull();
    const [profile] = await db.select().from(visitorProfiles).where(eq(visitorProfiles.id, row.visitorProfileId));
    expect(profile.deletedAt).not.toBeNull();
    expect(profile.deletedByResidentId).toBe(resident.id);
    expect(profile.deletedByGuardId).toBeNull();
    const [rule] = await db.select().from(autoApprovalRules).where(eq(autoApprovalRules.id, row.autoApprovalRuleId));
    expect(rule.active).toBe(false);

    expect((await evaluate(input, db)).match).toBe(false);
    const list = await api("GET", "/api/resident/registrations", token);
    expect(list.body.count).toBe(0);

    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.eventType, "resident_registration_removed"), eq(auditEvents.residentId, resident.id)));
    expect(audit).toHaveLength(1);
    expect(audit[0].guardId).toBeNull();

    expect((await api("DELETE", `/api/resident/registrations/${reg.id}`, token)).status).toBe(404);

    const reRegister = await register(token, { kind: "vehicle", label: "Grey Probox", plate: "KDG 222G" });
    expect(reRegister.id).not.toBe(reg.id);
  });

  it("another resident's registration is invisible: list excludes it, delete and renew are 404", async () => {
    const a = await claimedResident("RG-XA", "Resident A");
    const b = await claimedResident("RG-XB", "Resident B");
    const reg = await register(a.token, { kind: "vehicle", label: "A Car", plate: "KDH 333H" });

    const listB = await api("GET", "/api/resident/registrations", b.token);
    expect(listB.status).toBe(200);
    expect(listB.body.count).toBe(0);
    for (const [method, path] of [
      ["DELETE", `/api/resident/registrations/${reg.id}`],
      ["POST", `/api/resident/registrations/${reg.id}/renew`],
    ] as const) {
      const r = await api(method, path, b.token);
      expect(r.status).toBe(404);
      expect(r.body.error?.code).toBe("REGISTRATION_NOT_FOUND");
    }
    expect((await evaluate({ visitorName: "x", host: "x", unit: a.unit.label, plate: "KDH 333H" }, db)).match).toBe(true);
  });

  it("deactivating the resident disables their rules; deactivating the unit stops vehicle matching", async () => {
    const a = await claimedResident("RG-DR");
    await register(a.token, { kind: "person", label: "Nanny Rose" });
    await register(a.token, { kind: "vehicle", label: "Red Fit", plate: "KDJ 444J" });
    const d = await api("POST", `/api/admin/residents/${a.resident.id}/deactivate`, staffToken(adminId));
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect((await evaluate({ visitorName: "Nanny Rose", host: "Amina Wanjiru", unit: a.unit.label }, db)).match).toBe(false);
    expect((await evaluate({ visitorName: "x", host: "x", unit: a.unit.label, plate: "KDJ 444J" }, db)).match).toBe(false);
    expect((await api("GET", "/api/resident/registrations", a.token)).status).toBe(403);
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.eventType, "resident_deactivated"), sql`${auditEvents.payload}->>'residentId' = ${a.resident.id}`));
    expect(audit.payload).toMatchObject({ disabledRuleCount: 2 });

    const b = await claimedResident("RG-DU");
    await register(b.token, { kind: "vehicle", label: "Black Note", plate: "KDK 555K" });
    expect((await evaluate({ visitorName: "x", host: "x", unit: b.unit.label, plate: "KDK 555K" }, db)).match).toBe(true);
    await api("POST", `/api/admin/units/${b.unit.id}/deactivate`, staffToken(adminId));
    expect((await evaluate({ visitorName: "x", host: "x", unit: b.unit.label, plate: "KDK 555K" }, db)).match).toBe(false);
    expect((await api("POST", "/api/resident/registrations", b.token, { kind: "person", label: "Late" })).status).toBe(403);
  });

  it("renew window: <14 days is renew_due; renew restores 90 days and is audited", async () => {
    const { token, resident } = await claimedResident("RG-RN");
    const reg = await register(token, { kind: "person", label: "Gardener Joe" });
    const row = await registrationRow(reg.id);
    await db
      .update(autoApprovalRules)
      .set({ expiresAt: new Date(Date.now() + 5 * DAY_MS) })
      .where(eq(autoApprovalRules.id, row.autoApprovalRuleId));

    const list = await api("GET", "/api/resident/registrations", token);
    expect(list.body.renewPromptDays).toBe(14);
    expect((list.body.registrations as RegistrationView[])[0].status).toBe("renew_due");

    const before = Date.now();
    const renewed = await api("POST", `/api/resident/registrations/${reg.id}/renew`, token);
    expect(renewed.status, JSON.stringify(renewed.body)).toBe(200);
    const view = renewed.body.registration as RegistrationView;
    expect(view.status).toBe("active");
    expect(Math.abs(new Date(view.expiresAt).getTime() - before - 90 * DAY_MS)).toBeLessThan(60_000);

    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.eventType, "resident_registration_renewed"), eq(auditEvents.residentId, resident.id)));
    expect(audit).toHaveLength(1);
    expect(audit[0].guardId).toBeNull();
  });

  it("a rule switched off by staff stays off: renew is 409 REGISTRATION_DISABLED", async () => {
    const { token } = await claimedResident("RG-OFF");
    const reg = await register(token, { kind: "person", label: "Switched Off" });
    const row = await registrationRow(reg.id);
    const off = await api("POST", `/api/auto-approval-rules/${row.autoApprovalRuleId}/deactivate`, staffToken(adminId));
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    const list = await api("GET", "/api/resident/registrations", token);
    expect((list.body.registrations as RegistrationView[])[0].status).toBe("disabled");
    const r = await api("POST", `/api/resident/registrations/${reg.id}/renew`, token);
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe("REGISTRATION_DISABLED");
  });

  it("an expired resident vehicle rule is RULE_EXPIRED and audited under the resident", async () => {
    const { token, resident, unit } = await claimedResident("RG-EX");
    const reg = await register(token, { kind: "vehicle", label: "Old Car", plate: "KDL 666L" });
    const row = await registrationRow(reg.id);
    await db
      .update(autoApprovalRules)
      .set({ createdAt: new Date(Date.now() - 2 * DAY_MS), expiresAt: new Date(Date.now() - 1000) })
      .where(eq(autoApprovalRules.id, row.autoApprovalRuleId));

    const d = await evaluate({ visitorName: "x", host: "x", unit: unit.label, plate: "KDL 666L" }, db);
    expect(d).toMatchObject({ match: false, reason: "RULE_EXPIRED" });
    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.eventType, "auto_approval_rule_expired"), eq(auditEvents.residentId, resident.id)));
    expect(audit).toHaveLength(1);
    expect(audit[0].guardId).toBeNull();
    expect(audit[0].payload).toMatchObject({ ruleId: row.autoApprovalRuleId });

    const list = await api("GET", "/api/resident/registrations", token);
    expect((list.body.registrations as RegistrationView[])[0].status).toBe("expired");
  });
});

describe("access and atomicity", () => {
  it("staff tokens are refused (AUTH_NO_RESIDENT_LINK); anon is 401", async () => {
    for (const id of [guardId, seniorId, adminId]) {
      const r = await api("GET", "/api/resident/registrations", staffToken(id));
      expect(r.status).toBe(403);
      expect(r.body.error?.code).toBe("AUTH_NO_RESIDENT_LINK");
      const c = await api("POST", "/api/resident/registrations", staffToken(id), { kind: "person", label: "X" });
      expect(c.status).toBe(403);
    }
    expect((await api("GET", "/api/resident/registrations", null)).status).toBe(401);
  });

  it("a genuine audit insert failure on create leaves no registration, profile or rule", async () => {
    const { token, resident } = await claimedResident("RG-AF");
    const r = await api("POST", "/api/resident/registrations", token, { kind: "vehicle", label: "AUDIT-FAIL-CREATE car", plate: "KDM 777M" });
    expect(r.status).toBe(500);
    expect(await db.select().from(unitRegistrations).where(eq(unitRegistrations.residentId, resident.id))).toHaveLength(0);
    expect(await db.select().from(visitorProfiles).where(eq(visitorProfiles.createdByResidentId, resident.id))).toHaveLength(0);
    expect(await db.select().from(autoApprovalRules).where(eq(autoApprovalRules.createdByResidentId, resident.id))).toHaveLength(0);
    expect(getAuditLog().filter((e) => e.residentId === resident.id && e.type === "resident_registration_created")).toHaveLength(0);
  });

  it("a genuine audit insert failure on removal leaves the registration, profile and rule live", async () => {
    const { token, unit } = await claimedResident("RG-AR");
    const reg = await register(token, { kind: "vehicle", label: "AUDIT-FAIL-REMOVE keep", plate: "KDN 888N" });
    const del = await api("DELETE", `/api/resident/registrations/${reg.id}`, token);
    expect(del.status).toBe(500);
    const row = await registrationRow(reg.id);
    expect(row.deletedAt).toBeNull();
    const [profile] = await db.select().from(visitorProfiles).where(eq(visitorProfiles.id, row.visitorProfileId));
    expect(profile.deletedAt).toBeNull();
    const [rule] = await db.select().from(autoApprovalRules).where(eq(autoApprovalRules.id, row.autoApprovalRuleId));
    expect(rule.active).toBe(true);
    expect((await evaluate({ visitorName: "x", host: "x", unit: unit.label, plate: "KDN 888N" }, db)).match).toBe(true);
  });
});

describe("staff block — a staff switch-off survives remove + re-register", () => {
  async function liveRegistrations(unitId: string) {
    return db
      .select()
      .from(unitRegistrations)
      .where(and(eq(unitRegistrations.unitId, unitId), sql`${unitRegistrations.deletedAt} IS NULL`));
  }

  async function activeResidentRules(residentId: string) {
    return db
      .select()
      .from(autoApprovalRules)
      .where(and(eq(autoApprovalRules.createdByResidentId, residentId), eq(autoApprovalRules.active, true)));
  }

  it("the exact bypass: deactivate -> delete -> re-register is refused; the rule stays blocked, not live", async () => {
    const { token, resident, unit } = await claimedResident("RG-BYP");
    const reg = await register(token, { kind: "vehicle", label: "Blue Demio", plate: "KDB 404B" });
    const row = await registrationRow(reg.id);
    expect((await evaluate({ visitorName: "x", host: "x", unit: unit.label, plate: "KDB 404B" }, db)).match).toBe(true);

    const off = await api(
      "POST",
      `/api/auto-approval-rules/${row.autoApprovalRuleId}/deactivate`,
      staffToken(adminId),
      { reason: "Vehicle linked to a reported incident" },
    );
    expect(off.status, JSON.stringify(off.body)).toBe(200);

    const del = await api("DELETE", `/api/resident/registrations/${reg.id}`, token);
    expect(del.status, JSON.stringify(del.body)).toBe(200);

    for (const plate of ["KDB 404B", "kdb-404b", "K.D.B 404b"]) {
      const again = await api("POST", "/api/resident/registrations", token, {
        kind: "vehicle",
        label: "Blue Demio again",
        plate,
      });
      expect(again.status, JSON.stringify(again.body)).toBe(409);
      expect(again.body.error?.code).toBe("REGISTRATION_BLOCKED");
    }

    expect(await liveRegistrations(unit.id)).toHaveLength(0);
    expect(await activeResidentRules(resident.id)).toHaveLength(0);
    expect(
      await db
        .select()
        .from(visitorProfiles)
        .where(and(eq(visitorProfiles.createdByResidentId, resident.id), sql`${visitorProfiles.deletedAt} IS NULL`)),
    ).toHaveLength(0);
    expect((await evaluate({ visitorName: "x", host: "x", unit: unit.label, plate: "KDB 404B" }, db)).match).toBe(false);

    const blocked = await registrationRow(reg.id);
    expect(blocked.deletedAt).not.toBeNull();
    expect(blocked.blockedAt).not.toBeNull();
    expect(blocked.blockedByGuardId).toBe(adminId);
    expect(blocked.blockReason).toBe("Vehicle linked to a reported incident");
    expect(blocked.blockClearedAt).toBeNull();

    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.eventType, "resident_registration_blocked"), eq(auditEvents.guardId, adminId), sql`${auditEvents.payload}->>'registrationId' = ${reg.id}`));
    expect(audit.residentId).toBeNull();
    expect(audit.payload).toMatchObject({ ruleId: row.autoApprovalRuleId, unitId: unit.id, kind: "vehicle", reasonProvided: true });
    expect(JSON.stringify(audit.payload)).not.toContain("reported incident");
  });

  it("a household member block matches the name case- and whitespace-insensitively; other names are unaffected", async () => {
    const { token, unit } = await claimedResident("RG-BPN");
    const reg = await register(token, { kind: "person", label: "Jane Doe" });
    const row = await registrationRow(reg.id);
    expect((await api("POST", `/api/auto-approval-rules/${row.autoApprovalRuleId}/deactivate`, staffToken(adminId))).status).toBe(200);
    expect((await api("DELETE", `/api/resident/registrations/${reg.id}`, token)).status).toBe(200);

    for (const label of ["Jane Doe", "  jane   DOE "]) {
      const again = await api("POST", "/api/resident/registrations", token, { kind: "person", label });
      expect(again.status, JSON.stringify(again.body)).toBe(409);
      expect(again.body.error?.code).toBe("REGISTRATION_BLOCKED");
    }
    await register(token, { kind: "person", label: "Jane Doe Junior" });
    expect(await liveRegistrations(unit.id)).toHaveLength(1);
  });

  it("the block is per unit: another unit may register the same plate", async () => {
    const a = await claimedResident("RG-BUA");
    const b = await claimedResident("RG-BUB");
    const reg = await register(a.token, { kind: "vehicle", label: "Car", plate: "KDC 505C" });
    const row = await registrationRow(reg.id);
    await api("POST", `/api/auto-approval-rules/${row.autoApprovalRuleId}/deactivate`, staffToken(adminId));
    await register(b.token, { kind: "vehicle", label: "Car", plate: "KDC 505C" });
  });

  it("switching off a rule the resident already removed still blocks re-registration", async () => {
    const { token, unit } = await claimedResident("RG-BRM");
    const reg = await register(token, { kind: "vehicle", label: "Gone", plate: "KDD 606D" });
    const row = await registrationRow(reg.id);
    expect((await api("DELETE", `/api/resident/registrations/${reg.id}`, token)).status).toBe(200);
    const off = await api("POST", `/api/auto-approval-rules/${row.autoApprovalRuleId}/deactivate`, staffToken(adminId));
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect((await registrationRow(reg.id)).blockedByGuardId).toBe(adminId);
    const again = await api("POST", "/api/resident/registrations", token, { kind: "vehicle", label: "Gone", plate: "KDD 606D" });
    expect(again.body.error?.code).toBe("REGISTRATION_BLOCKED");
    expect(await liveRegistrations(unit.id)).toHaveLength(0);
  });

  it("blocking also switches off a same-subject registration made after the blocked one was removed", async () => {
    const { token, resident } = await claimedResident("RG-BSB");
    const first = await register(token, { kind: "vehicle", label: "Old", plate: "KDE 707E" });
    const firstRow = await registrationRow(first.id);
    expect((await api("DELETE", `/api/resident/registrations/${first.id}`, token)).status).toBe(200);
    const second = await register(token, { kind: "vehicle", label: "New", plate: "kde707e" });

    await api("POST", `/api/auto-approval-rules/${firstRow.autoApprovalRuleId}/deactivate`, staffToken(adminId));
    expect(await activeResidentRules(resident.id)).toHaveLength(0);
    const list = await api("GET", "/api/resident/registrations", token);
    expect((list.body.registrations as RegistrationView[]).find((r) => r.id === second.id)?.status).toBe("disabled");
  });

  it("re-deactivating is idempotent: no second block audit, block untouched", async () => {
    const { token } = await claimedResident("RG-BID");
    const reg = await register(token, { kind: "person", label: "Twice" });
    const row = await registrationRow(reg.id);
    await api("POST", `/api/auto-approval-rules/${row.autoApprovalRuleId}/deactivate`, staffToken(adminId));
    const blockedAt = (await registrationRow(reg.id)).blockedAt;
    const r2 = await api("POST", `/api/auto-approval-rules/${row.autoApprovalRuleId}/deactivate`, staffToken(adminId));
    expect(r2.status).toBe(200);
    expect((await registrationRow(reg.id)).blockedAt).toEqual(blockedAt);
    const audits = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.eventType, "resident_registration_blocked"), sql`${auditEvents.payload}->>'registrationId' = ${reg.id}`));
    expect(audits).toHaveLength(1);
  });

  it("only an admin can clear: resident, guard and senior-guard are refused and the block stands", async () => {
    const { token } = await claimedResident("RG-BAZ");
    const reg = await register(token, { kind: "vehicle", label: "Locked", plate: "KDF 808F" });
    const row = await registrationRow(reg.id);
    await api("POST", `/api/auto-approval-rules/${row.autoApprovalRuleId}/deactivate`, staffToken(adminId));
    const path = `/api/auto-approval-rules/${row.autoApprovalRuleId}/clear-block`;

    const asResident = await api("POST", path, token, { reason: "please let me" });
    expect([401, 403]).toContain(asResident.status);
    for (const id of [guardId, seniorId]) {
      const r = await api("POST", path, staffToken(id), { reason: "trying to clear" });
      expect(r.status, JSON.stringify(r.body)).toBe(403);
    }
    expect((await api("POST", path, null, { reason: "anon" })).status).toBe(401);
    expect((await api("POST", path, staffToken(adminId), {})).status).toBe(422);

    const blocked = await registrationRow(reg.id);
    expect(blocked.blockedAt).not.toBeNull();
    expect(blocked.blockClearedAt).toBeNull();
    expect((await api("DELETE", `/api/resident/registrations/${reg.id}`, token)).status).toBe(200);
    const again = await api("POST", "/api/resident/registrations", token, { kind: "vehicle", label: "Locked", plate: "KDF 808F" });
    expect(again.body.error?.code).toBe("REGISTRATION_BLOCKED");
  });

  it("after an admin clears the block (with reason) the resident may register again; clearing twice is 409", async () => {
    const { token, unit } = await claimedResident("RG-BCL");
    const reg = await register(token, { kind: "vehicle", label: "Cleared", plate: "KDG 909G" });
    const row = await registrationRow(reg.id);
    await api("POST", `/api/auto-approval-rules/${row.autoApprovalRuleId}/deactivate`, staffToken(adminId));
    await api("DELETE", `/api/resident/registrations/${reg.id}`, token);

    const path = `/api/auto-approval-rules/${row.autoApprovalRuleId}/clear-block`;
    const clear = await api("POST", path, staffToken(adminId), { reason: "Checked with the owner" });
    expect(clear.status, JSON.stringify(clear.body)).toBe(200);
    const cleared = await registrationRow(reg.id);
    expect(cleared.blockClearedByGuardId).toBe(adminId);
    expect(cleared.blockClearReason).toBe("Checked with the owner");

    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.eventType, "resident_registration_block_cleared"), sql`${auditEvents.payload}->>'registrationId' = ${reg.id}`));
    expect(audit.guardId).toBe(adminId);
    expect(audit.payload).toMatchObject({ blockedByGuardId: adminId, unitId: unit.id });

    const twice = await api("POST", path, staffToken(adminId), { reason: "again please" });
    expect(twice.status).toBe(409);
    expect(twice.body.error?.code).toBe("REGISTRATION_NOT_BLOCKED");

    await register(token, { kind: "vehicle", label: "Cleared", plate: "KDG 909G" });
    expect((await evaluate({ visitorName: "x", host: "x", unit: unit.label, plate: "KDG 909G" }, db)).match).toBe(true);
  });

  it("clear-block on a staff rule with no registration is 404", async () => {
    const [rule] = await db
      .insert(autoApprovalRules)
      .values({
        visitorName: "Staff Only",
        host: "Someone",
        unit: "Z9",
        createdByGuardId: adminId,
        active: false,
        expiresAt: new Date(Date.now() + DAY_MS),
      })
      .returning({ id: autoApprovalRules.id });
    staffRuleIds.push(rule.id);
    const r = await api("POST", `/api/auto-approval-rules/${rule.id}/clear-block`, staffToken(adminId), { reason: "valid reason" });
    expect(r.status).toBe(404);
  });

  it("a genuine audit failure while blocking leaves the rule live and no block recorded", async () => {
    const { token, unit } = await claimedResident("RG-BAF");
    const reg = await register(token, { kind: "vehicle", label: "Atomic", plate: "KDH 111H" });
    const row = await registrationRow(reg.id);
    const off = await api("POST", `/api/auto-approval-rules/${row.autoApprovalRuleId}/deactivate`, staffToken(adminId));
    expect(off.status).toBe(500);
    const after = await registrationRow(reg.id);
    expect(after.blockedAt).toBeNull();
    const [rule] = await db.select().from(autoApprovalRules).where(eq(autoApprovalRules.id, row.autoApprovalRuleId));
    expect(rule.active).toBe(true);
    expect(
      await db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.eventType, "auto_approval_rule_deactivated"), sql`${auditEvents.payload}->>'ruleId' = ${row.autoApprovalRuleId}`)),
    ).toHaveLength(0);
    expect(getAuditLog().filter((e) => e.payload.ruleId === row.autoApprovalRuleId)).toHaveLength(0);
    expect((await evaluate({ visitorName: "x", host: "x", unit: unit.label, plate: "KDH 111H" }, db)).match).toBe(true);
  });
});
