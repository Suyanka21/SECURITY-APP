/**
 * GatePass — a resident's full phone number never reaches a staff screen or
 * any response other than the resident's own, against a REAL Postgres over
 * REAL HTTP.
 *
 * Flow: a resident claims a unit, registers a vehicle and issues a pass; a
 * guard requests a walk-in approval with that resident's number as the host
 * phone, and the WhatsApp notification is delivered (mock provider). Then
 * the raw text of every staff response is searched for the number in three
 * forms (E.164, digits without "+", national digits).
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
  authorizationDecisions,
  notifications,
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
import { MockNotificationProvider } from "../../services/notifications/mock-provider";
import { resetNotificationProviders, setNotificationProviders } from "../../services/notifications/registry";
import { maskPhoneE164 } from "../../services/phone-mask";

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
      { id: randomUUID(), badgeNumber: `PX-ADMIN-${stamp}`, name: "PX Admin", role: "admin", isActive: true },
      { id: randomUUID(), badgeNumber: `PX-GUARD-${stamp}`, name: "PX Guard", role: "guard", isActive: true },
      { id: randomUUID(), badgeNumber: `PX-SENIOR-${stamp}`, name: "PX Senior", role: "senior-guard", isActive: true },
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

const approvalIds: string[] = [];

afterEach(async () => {
  resetNotificationProviders();
  if (createdUnitIds.length > 0) {
    const residentIds = (
      await db.select({ id: residents.id }).from(residents).where(inArray(residents.unitId, createdUnitIds))
    ).map((r) => r.id);
    if (residentIds.length > 0) {
      await db.delete(authorizationDecisions).where(inArray(authorizationDecisions.issuedByResidentId, residentIds));
    }
  }
  if (approvalIds.length > 0) {
    await db.delete(notifications).where(inArray(notifications.approvalId, approvalIds));
    await db.delete(approvalRequests).where(inArray(approvalRequests.id, approvalIds));
    approvalIds.length = 0;
  }
});

async function waitForDelivered(approvalId: string, token: string) {
  for (let i = 0; i < 40; i += 1) {
    const r = await api("GET", `/api/notifications?approvalId=${approvalId}`, token);
    const rows = (r.body.notifications ?? []) as { status: string }[];
    if (rows.some((n) => n.status === "delivered")) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("notification was not delivered");
}

describe("a resident's full number never reaches a staff response", () => {
  it("approvals, notifications, audit, rules, profiles, residents, units, entries, shifts and watchlist carry no form of it", async () => {
    setNotificationProviders({
      whatsapp: new MockNotificationProvider("whatsapp"),
      sms: new MockNotificationProvider("sms"),
    });
    const admin = staffToken(adminId);
    const guard = staffToken(guardId);
    const { unit, token, phone, displayName } = await claimedResident("PX-PH", "Phone Host");
    await register(token, { kind: "vehicle", label: "Host car", plate: "KDX 321X" });
    const pass = await api("POST", "/api/resident/passes", token, { visitorName: "Pass Guest" });
    expect(pass.status, JSON.stringify(pass.body)).toBe(201);

    const create = await raw("POST", "/api/approvals", guard, {
      offlineId: randomUUID(),
      draft: { visitorName: "Walk In Visitor", host: displayName, unit: unit.label, plate: null, reason: "", method: "walk-in" },
      hostPhoneE164: phone,
    });
    expect(create.status, create.text).toBe(201);
    const created = JSON.parse(create.text) as { approvalId: string; traceId: string };
    approvalIds.push(created.approvalId);

    const [stored] = await db.select().from(notifications).where(eq(notifications.approvalId, created.approvalId));
    expect(stored.targetPhone).toBe(phone);
    await waitForDelivered(created.approvalId, guard);

    const list = await raw("GET", `/api/notifications?approvalId=${created.approvalId}`, guard);
    const rows = JSON.parse(list.text).notifications as { id: string; targetPhoneMasked: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).not.toHaveProperty("targetPhone");
    expect(rows[0].targetPhoneMasked).toBe(maskPhoneE164(phone));

    const responses: [string, Raw][] = [
      ["POST /api/approvals", create],
      ["GET /api/notifications", list],
      ["POST /api/notifications/:id/retry", await raw("POST", `/api/notifications/${rows[0].id}/retry`, guard, {})],
      ["GET /api/approvals/:id/status", await raw("GET", `/api/approvals/${created.approvalId}/status`, guard)],
      ["GET /api/audit/events", await raw("GET", "/api/audit/events", admin)],
      ["GET /api/audit/events (senior-guard)", await raw("GET", "/api/audit/events", staffToken(seniorId))],
      ["GET /api/audit/reconstruct/:traceId", await raw("GET", `/api/audit/reconstruct/${created.traceId}`, admin)],
      ["GET /api/audit/shift/:guardId", await raw("GET", `/api/audit/shift/${guardId}`, admin)],
      ["GET /api/auto-approval-rules", await raw("GET", "/api/auto-approval-rules?includeInactive=true", admin)],
      ["GET /api/visitor-profiles", await raw("GET", "/api/visitor-profiles", admin)],
      ["GET /api/admin/residents", await raw("GET", "/api/admin/residents?includeInactive=true", admin)],
      ["GET /api/admin/units", await raw("GET", "/api/admin/units?includeInactive=true", admin)],
      ["GET /api/admin/units/:id/registrations", await raw("GET", `/api/admin/units/${unit.id}/registrations`, admin)],
      ["GET /api/entries/on-premise", await raw("GET", "/api/entries/on-premise", admin)],
      ["GET /api/entries/deliveries", await raw("GET", "/api/entries/deliveries", admin)],
      ["GET /api/admin/shifts", await raw("GET", "/api/admin/shifts", admin)],
      ["GET /api/watchlist", await raw("GET", "/api/watchlist?status=all", admin)],
      ["GET /api/auth/me (guard)", await raw("GET", "/api/auth/me", guard)],
    ];
    for (const [label, r] of responses) {
      expect(r.status, `${label}: ${r.text.slice(0, 200)}`).toBeLessThan(500);
      expectNoPhone(label, r, phone);
    }
    const okCount = responses.filter(([, r]) => r.status === 200 || r.status === 201).length;
    expect(okCount, responses.map(([l, r]) => `${l}=${r.status}`).join(", ")).toBeGreaterThanOrEqual(responses.length - 1);
  });

  it("control: the resident's own /api/resident/me still returns the full number", async () => {
    const { token, phone } = await claimedResident("PX-ME", "Own Number");
    const me = await raw("GET", "/api/resident/me", token);
    expect(me.status, me.text).toBe(200);
    expect(me.text).toContain(phone);
  });
});
