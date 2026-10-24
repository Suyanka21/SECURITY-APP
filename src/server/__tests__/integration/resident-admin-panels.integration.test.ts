/**
 * GatePass — R4a admin screens (S1–S3) against a REAL Postgres, over REAL HTTP.
 *
 * Source: src/docs/specs/resident-admin-panels.md §5, §6.
 *
 * Proven here:
 *   - S1 GET /api/admin/units/:id/registrations is admin only, scoped to the
 *     unit, includes removed-but-blocked rows and omits removed, never-blocked
 *     rows
 *   - S2 the full resident number (E.164, digits without +, national digits)
 *     is absent from the raw text of every admin response that touches the
 *     resident, including the audit list
 *   - S3 switching off a resident rule without a reason is 422
 *     REASON_REQUIRED with nothing written; clear-block needs a reason
 *   - after a clear, a not-removed entry still blocks re-registration as a
 *     duplicate until the resident removes it
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
import { clearAuditDB, clearAuditLog, setAuditDB } from "../../services/audit-logger";

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
      { id: randomUUID(), badgeNumber: `PA-ADMIN-${stamp}`, name: "PA Admin", role: "admin", isActive: true },
      { id: randomUUID(), badgeNumber: `PA-GUARD-${stamp}`, name: "PA Guard", role: "guard", isActive: true },
      { id: randomUUID(), badgeNumber: `PA-SENIOR-${stamp}`, name: "PA Senior", role: "senior-guard", isActive: true },
    ])
    .returning({ id: guards.id, role: guards.role });
  adminId = staff.find((s) => s.role === "admin")!.id;
  guardId = staff.find((s) => s.role === "guard")!.id;
  seniorId = staff.find((s) => s.role === "senior-guard")!.id;

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

interface Raw {
  status: number;
  text: string;
}

async function raw(method: string, path: string, token: string | null, body?: unknown): Promise<Raw> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

function phoneForms(phone: string): string[] {
  // E.164, digits without "+", national significant digits (after +254)
  return [phone, phone.slice(1), phone.slice(4)];
}

function expectNoPhone(label: string, r: Raw, phone: string): void {
  for (const form of phoneForms(phone)) {
    expect(r.text.includes(form), `${label} (HTTP ${r.status}) contains ${form.length}-char phone form`).toBe(false);
  }
}

async function blockedAndRemoved(token: string, admin: string, label: string) {
  const reg = await register(token, { kind: "person", label });
  const row = await registrationRow(reg.id);
  const off = await api("POST", `/api/auto-approval-rules/${row.autoApprovalRuleId}/deactivate`, admin, {
    reason: "Reported by the committee",
  });
  expect(off.status, JSON.stringify(off.body)).toBe(200);
  const del = await api("DELETE", `/api/resident/registrations/${reg.id}`, token);
  expect(del.status, JSON.stringify(del.body)).toBe(200);
  return { reg, row };
}

interface AdminRegistration {
  id: string;
  residentId: string;
  residentDisplayName: string;
  status: string;
  ruleId: string;
  ruleActive: boolean;
  removedAt: string | null;
  block: null | { blockedBy: string; reason: string | null; clearedAt: string | null; clearedBy: string | null; clearReason: string | null };
}

describe("S1 GET /api/admin/units/:id/registrations", () => {
  it("anon 401; guard and senior-guard 403; a resident token is refused", async () => {
    const { unit, token } = await claimedResident("PA-ACL");
    const path = `/api/admin/units/${unit.id}/registrations`;
    expect((await api("GET", path, null)).status).toBe(401);
    for (const id of [guardId, seniorId]) {
      const r = await api("GET", path, staffToken(id));
      expect(r.status, JSON.stringify(r.body)).toBe(403);
    }
    const asResident = await api("GET", path, token);
    expect([401, 403], JSON.stringify(asResident.body)).toContain(asResident.status);
    expect(asResident.body.registrations).toBeUndefined();
  });

  it("422 for a non-UUID id, 404 UNIT_NOT_FOUND for an unknown unit", async () => {
    const bad = await api("GET", "/api/admin/units/nope/registrations", staffToken(adminId));
    expect(bad.status).toBe(422);
    expect(bad.body.error).toMatchObject({ code: "RESIDENT_INVALID_INPUT", field: "id" });
    const missing = await api("GET", `/api/admin/units/${randomUUID()}/registrations`, staffToken(adminId));
    expect(missing.status).toBe(404);
    expect(missing.body.error?.code).toBe("UNIT_NOT_FOUND");
  });

  it("returns only that unit's rows: live rows and removed-but-blocked rows, not removed never-blocked rows", async () => {
    const admin = staffToken(adminId);
    const a = await claimedResident("PA-SA", "Unit A Resident");
    const b = await claimedResident("PA-SB", "Unit B Resident");
    const live = await register(a.token, { kind: "vehicle", label: "Family car", plate: "KDA 101A" });
    const removedPlain = await register(a.token, { kind: "person", label: "Old Cleaner" });
    expect((await api("DELETE", `/api/resident/registrations/${removedPlain.id}`, a.token)).status).toBe(200);
    const { reg: removedBlocked } = await blockedAndRemoved(a.token, admin, "Barred Worker");
    const other = await register(b.token, { kind: "person", label: "Unit B Guest" });

    const r = await api("GET", `/api/admin/units/${a.unit.id}/registrations`, admin);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const rows = r.body.registrations as AdminRegistration[];
    const ids = rows.map((x) => x.id);
    expect(ids).toContain(live.id);
    expect(ids).toContain(removedBlocked.id);
    expect(ids).not.toContain(removedPlain.id);
    expect(ids).not.toContain(other.id);
    expect(r.body.count).toBe(rows.length);

    const liveRow = rows.find((x) => x.id === live.id)!;
    expect(liveRow).toMatchObject({ status: "active", ruleActive: true, removedAt: null, block: null, residentId: a.resident.id, residentDisplayName: "Unit A Resident" });
    const blockedRow = rows.find((x) => x.id === removedBlocked.id)!;
    expect(blockedRow.status).toBe("removed");
    expect(blockedRow.removedAt).not.toBeNull();
    expect(blockedRow.block).toMatchObject({ blockedBy: "PA Admin", reason: "Reported by the committee", clearedAt: null });
    expect(JSON.stringify(r.body)).not.toMatch(/phone/i);
  });
});

describe("S2 the full resident number never appears in an admin response", () => {
  it("residents list/deactivate, S1, units list/deactivate and the audit list carry no form of the number", async () => {
    const admin = staffToken(adminId);
    const { unit, token, resident, phone } = await claimedResident("PA-PH", "Phone Owner");
    const auditEventsBefore = await raw("GET", "/api/audit/events", admin);
    expect(auditEventsBefore.status).toBe(200);
    const reg = await register(token, { kind: "vehicle", label: "Phone Owner car", plate: "KDB 202B" });
    const row = await registrationRow(reg.id);
    expect(
      (await api("POST", `/api/auto-approval-rules/${row.autoApprovalRuleId}/deactivate`, admin, { reason: "Checking the masking" })).status,
    ).toBe(200);

    const responses: [string, Raw][] = [];
    const list = await raw("GET", `/api/admin/residents?unitId=${unit.id}&includeInactive=true`, admin);
    expect(list.status).toBe(200);
    const listed = (JSON.parse(list.text).residents as { id: string; phoneMasked: string }[]).find((x) => x.id === resident.id)!;
    expect(listed).not.toHaveProperty("phoneE164");
    expect(listed.phoneMasked).toMatch(/^\+254•+\d{3}$/);
    expect(listed.phoneMasked.slice(-3)).toBe(phone.slice(-3));
    responses.push(["GET /api/admin/residents", list]);
    responses.push(["GET /api/admin/residents (all units)", await raw("GET", "/api/admin/residents?includeInactive=true", admin)]);
    responses.push(["GET S1", await raw("GET", `/api/admin/units/${unit.id}/registrations`, admin)]);
    responses.push(["GET /api/admin/units", await raw("GET", "/api/admin/units?includeInactive=true", admin)]);
    responses.push(["GET /api/audit/events (before deactivation)", await raw("GET", "/api/audit/events", admin)]);

    const deact = await raw("POST", `/api/admin/residents/${resident.id}/deactivate`, admin);
    expect(deact.status, deact.text).toBe(200);
    expect(JSON.parse(deact.text).resident).toMatchObject({ id: resident.id, isActive: false, phoneMasked: listed.phoneMasked });
    expect(JSON.parse(deact.text).resident).not.toHaveProperty("phoneE164");
    responses.push(["POST /api/admin/residents/:id/deactivate", deact]);

    const unitOff = await raw("POST", `/api/admin/units/${unit.id}/deactivate`, admin);
    expect(unitOff.status, unitOff.text).toBe(200);
    responses.push(["POST /api/admin/units/:id/deactivate", unitOff]);
    responses.push(["GET /api/audit/events (after deactivation)", await raw("GET", "/api/audit/events", admin)]);
    responses.push(["GET /api/audit/events as senior-guard", await raw("GET", "/api/audit/events", staffToken(seniorId))]);

    for (const [label, r] of responses) {
      expect(r.status, label).toBe(200);
      expectNoPhone(label, r, phone);
    }
  });

  it("control: the resident's own claim response carries its own full number", async () => {
    const u = await api("POST", "/api/admin/units", staffToken(adminId), { label: uniq("PA-OWN") });
    const unit = u.body.unit as { id: string };
    createdUnitIds.push(unit.id);
    const c = await api("POST", `/api/admin/units/${unit.id}/claim-codes`, staffToken(adminId), {});
    const { code } = c.body.claimCode as { code: string };
    const phone = freshPhone();
    const claim = await raw("POST", "/api/resident/claim", residentToken(randomUUID(), phone.slice(1)), { code, displayName: "Own Number" });
    expect(claim.status, claim.text).toBe(201);
    expect(claim.text).toContain(phone);
  });
});

describe("S3 a reason is required to switch off a resident's rule; clear-block needs one too", () => {
  it("no reason → 422 REASON_REQUIRED (field reason), rule still live, no block, no audit row; repeat calls need it too", async () => {
    const admin = staffToken(adminId);
    const { token } = await claimedResident("PA-RR");
    const reg = await register(token, { kind: "person", label: "Needs Reason" });
    const row = await registrationRow(reg.id);
    const ruleId = row.autoApprovalRuleId;

    for (const body of [undefined, {}]) {
      const r = await api("POST", `/api/auto-approval-rules/${ruleId}/deactivate`, admin, body);
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      expect(r.body.error).toMatchObject({ code: "REASON_REQUIRED", field: "reason" });
    }
    const [rule] = await db.select().from(autoApprovalRules).where(eq(autoApprovalRules.id, ruleId));
    expect(rule.active).toBe(true);
    expect((await registrationRow(reg.id)).blockedAt).toBeNull();
    const audits = await db
      .select()
      .from(auditEvents)
      .where(and(inArray(auditEvents.eventType, ["auto_approval_rule_deactivated", "resident_registration_blocked"]), sql`${auditEvents.payload}->>'ruleId' = ${ruleId}`));
    expect(audits).toHaveLength(0);

    const short = await api("POST", `/api/auto-approval-rules/${ruleId}/deactivate`, admin, { reason: "no" });
    expect(short.status).toBe(422);
    expect(short.body.error?.code).toBe("RULE_INVALID_INPUT");

    const ok = await api("POST", `/api/auto-approval-rules/${ruleId}/deactivate`, admin, { reason: "Reported incident" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await registrationRow(reg.id)).blockedAt).not.toBeNull();

    const again = await api("POST", `/api/auto-approval-rules/${ruleId}/deactivate`, admin);
    expect(again.status).toBe(422);
    expect(again.body.error?.code).toBe("REASON_REQUIRED");
  });

  it("a staff-created rule can still be switched off without a reason", async () => {
    const admin = staffToken(adminId);
    const created = await api("POST", "/api/auto-approval-rules", admin, {
      visitorName: uniq("PA Staff Rule "),
      host: "Staff Host",
      unit: uniq("PA-STAFF"),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const ruleId = (created.body.rule as { id: string }).id;
    staffRuleIds.push(ruleId);
    const off = await api("POST", `/api/auto-approval-rules/${ruleId}/deactivate`, admin);
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect((off.body.rule as { active: boolean }).active).toBe(false);
  });

  it("clear-block without a reason is 422 and the block stands; with a reason, a not-removed entry is still a duplicate until removed", async () => {
    const admin = staffToken(adminId);
    const { token, unit } = await claimedResident("PA-CB");
    const reg = await register(token, { kind: "person", label: "Cleared Later" });
    const row = await registrationRow(reg.id);
    const ruleId = row.autoApprovalRuleId;
    expect((await api("POST", `/api/auto-approval-rules/${ruleId}/deactivate`, admin, { reason: "Reported incident" })).status).toBe(200);

    for (const body of [undefined, {}, { reason: "  " }, { reason: "ok" }]) {
      const r = await api("POST", `/api/auto-approval-rules/${ruleId}/clear-block`, admin, body);
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      expect(r.body.error).toMatchObject({ code: "RULE_INVALID_INPUT", field: "reason" });
    }
    expect((await registrationRow(reg.id)).blockClearedAt).toBeNull();

    const cleared = await api("POST", `/api/auto-approval-rules/${ruleId}/clear-block`, admin, { reason: "Verified with the owner" });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);

    const s1 = await api("GET", `/api/admin/units/${unit.id}/registrations`, admin);
    const shown = (s1.body.registrations as AdminRegistration[]).find((x) => x.id === reg.id)!;
    expect(shown).toMatchObject({ status: "disabled", removedAt: null });
    expect(shown.block).toMatchObject({ clearedBy: "PA Admin", clearReason: "Verified with the owner" });

    const dup = await api("POST", "/api/resident/registrations", token, { kind: "person", label: "Cleared Later" });
    expect(dup.status, JSON.stringify(dup.body)).toBe(409);
    expect(dup.body.error?.code).toBe("REGISTRATION_DUPLICATE");

    expect((await api("DELETE", `/api/resident/registrations/${reg.id}`, token)).status).toBe(200);
    const again = await api("POST", "/api/resident/registrations", token, { kind: "person", label: "Cleared Later" });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
  });
});
