/**
 * GatePass — every staff-facing response type in src/lib/api/types.ts that the
 * other integration files never reach (or only reach with an empty list) is
 * checked here against the REAL server response over REAL HTTP on a REAL
 * Postgres: each typed field is present, and the server sends no field the
 * type lacks.
 *
 * Field lists are typed `Record<keyof T, …>`, so `tsc` fails if a list drifts
 * from the client type.
 *
 * PREREQUISITES: DATABASE_URL set, schema migrated.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { inArray, or } from "drizzle-orm";
import { randomUUID } from "crypto";
import * as jwt from "jsonwebtoken";
import * as schema from "@/db/schema";
import {
  approvalRequests,
  auditEvents,
  authorizationDecisions,
  entryRecords,
  exitRecords,
  guardNotes,
  guards,
  notifications,
  overrideEvents,
  syncEvents,
  visitorProfiles,
  watchlistEntries,
} from "@/db/schema";
import type {
  AddGuardNoteResponse,
  CreateDeliveryEntryResponse,
  CreateEntryResponse,
  DeliveryEntryView,
  DeliveryListEntryView,
  ExitRecordView,
  GuardNoteView,
  ListDeliveriesResponse,
  ListGuardNotesResponse,
  ListOnPremiseResponse,
  ListShiftsResponse,
  ListWatchlistResponse,
  NotificationView,
  NotificationsListResponse,
  OnPremiseEntryView,
  OnPremiseNoteView,
  PinValidateResponse,
  QrValidateResponse,
  RecognizedVisitorItem,
  RecognizedVisitorsResponse,
  RecordExitResponse,
  ServerEntry,
  ShiftSummaryView,
  ShiftTotalsView,
  SyncBatchResponse,
  SyncEntryResult,
  VisitorProfileResponse,
  VisitorProfileView,
  WatchlistEntryResponse,
  WatchlistEntryView,
  WatchlistMatchView,
} from "@/lib/api/types";
import { createApp } from "../../app";
import { getJWTSecret } from "../../middleware/auth";
import { clearAuditDB, clearAuditLog, setAuditDB } from "../../services/audit-logger";
import { MockNotificationProvider } from "../../services/notifications/mock-provider";
import { resetNotificationProviders, setNotificationProviders } from "../../services/notifications/registry";

const savedSupabaseUrl = process.env.SUPABASE_URL;

let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let server: Server;
let baseUrl: string;
let adminId: string;
let guardId: string;

const stamp = Date.now();
const UNIT = `AS-${stamp}`;
const WATCHED = `Watched Person ${stamp}`;

// "req" = always sent, "opt" = sent only in some cases (still allowed).
type Fields<T> = Record<keyof T, "req" | "opt">;
function fields<T>(f: Fields<T>): Fields<T> {
  return f;
}

/** Every "req" field is present, and nothing outside the type is sent. */
function expectShape<T>(label: string, value: unknown, f: Fields<T>): void {
  expect(value, `${label}: missing`).toBeTypeOf("object");
  expect(value, `${label}: null`).not.toBeNull();
  const got = Object.keys(value as object).sort();
  const allowed = Object.keys(f).sort();
  const required = allowed.filter((k) => f[k as keyof T] === "req");
  expect(got.filter((k) => !allowed.includes(k)), `${label}: fields the type lacks`).toEqual([]);
  expect(required.filter((k) => !got.includes(k)), `${label}: typed fields the server did not send`).toEqual([]);
}

function expectItems<T>(label: string, list: unknown, f: Fields<T>): void {
  expect(Array.isArray(list), `${label}: not a list`).toBe(true);
  expect((list as unknown[]).length, `${label}: empty, item fields not checked`).toBeGreaterThan(0);
  for (const item of list as unknown[]) expectShape(label, item, f);
}

const ENTRY = fields<ServerEntry>({
  id: "req", visitorName: "req", host: "req", unit: "req", plate: "req", reason: "req",
  method: "req", guardId: "req", createdAt: "req", status: "req", syncState: "req",
});
const WATCH_MATCH = fields<WatchlistMatchView>({
  matched: "req", entryId: "req", reason: "req", matchedOn: "req", requiresEscalation: "req",
});
const QR_OK = fields<QrValidateResponse>({
  outcome: "req", visitor: "req", expiresAt: "req", watchlistMatch: "opt", traceId: "req",
});
const QR_VISITOR = fields<QrValidateResponse["visitor"]>({
  name: "req", host: "req", unit: "req", plate: "req", preApprovalId: "req",
});
const WATCH_ENTRY = fields<WatchlistEntryView>({
  id: "req", subjectName: "req", subjectPlate: "req", reason: "req", status: "req",
  addedByGuardId: "req", lastReviewedAt: "req", reviewDueAt: "req", reviewOverdue: "req",
  removedByGuardId: "req", removedReason: "req", createdAt: "req", updatedAt: "req",
});
const NOTE = fields<GuardNoteView>({
  id: "req", entryId: "req", exitId: "req", guardId: "req", tag: "req", text: "req",
  createdAt: "req", traceId: "req",
});

beforeAll(async () => {
  delete process.env.SUPABASE_URL;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for integration tests.");
  if (!process.env.PIN_PEPPER) process.env.PIN_PEPPER = "integration-test-pepper-not-for-production";
  pool = new Pool({ connectionString: databaseUrl, max: 10 });
  db = drizzle(pool, { schema });
  setAuditDB(db);
  const staff = await db
    .insert(guards)
    .values([
      { id: randomUUID(), badgeNumber: `AS-ADMIN-${stamp}`, name: "AS Admin", role: "admin", isActive: true },
      { id: randomUUID(), badgeNumber: `AS-GUARD-${stamp}`, name: "AS Guard", role: "guard", isActive: true },
    ])
    .returning({ id: guards.id, role: guards.role });
  adminId = staff.find((s) => s.role === "admin")!.id;
  guardId = staff.find((s) => s.role === "guard")!.id;
  server = createServer(createApp(db));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  resetNotificationProviders();
  clearAuditLog();
  const ids = [adminId, guardId];
  const entryIds = (
    await db.select({ id: entryRecords.id }).from(entryRecords).where(inArray(entryRecords.guardId, ids))
  ).map((e) => e.id);
  await db.delete(guardNotes).where(inArray(guardNotes.guardId, ids));
  await db.delete(exitRecords).where(inArray(exitRecords.guardId, ids));
  await db.delete(syncEvents).where(inArray(syncEvents.guardId, ids));
  await db.delete(overrideEvents).where(inArray(overrideEvents.guardId, ids));
  if (entryIds.length > 0) {
    await db
      .update(authorizationDecisions)
      .set({ usedByGuardId: null })
      .where(inArray(authorizationDecisions.usedByGuardId, ids));
  }
  const approvalIds = (
    await db.select({ id: approvalRequests.id }).from(approvalRequests).where(inArray(approvalRequests.requestedByGuardId, ids))
  ).map((a) => a.id);
  if (approvalIds.length > 0) {
    await db.delete(notifications).where(inArray(notifications.approvalId, approvalIds));
    await db.delete(approvalRequests).where(inArray(approvalRequests.id, approvalIds));
  }
  await db.delete(entryRecords).where(inArray(entryRecords.guardId, ids));
  await db.delete(authorizationDecisions).where(inArray(authorizationDecisions.unit, [UNIT]));
  await db.delete(visitorProfiles).where(inArray(visitorProfiles.createdByGuardId, ids));
  await db
    .delete(watchlistEntries)
    .where(or(inArray(watchlistEntries.addedByGuardId, ids), inArray(watchlistEntries.removedByGuardId, ids)));
  await db.delete(auditEvents).where(inArray(auditEvents.guardId, ids));
  await db.delete(guards).where(inArray(guards.id, ids));
  clearAuditDB();
  await pool.end();
  if (savedSupabaseUrl !== undefined) process.env.SUPABASE_URL = savedSupabaseUrl;
});

function token(id: string): string {
  return jwt.sign({ sub: id }, getJWTSecret(), { algorithm: "HS256", expiresIn: "5m" });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, id: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token(id)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function ok(method: string, path: string, id: string, status: number, body?: unknown) {
  const r = await api(method, path, id, body);
  expect(r.status, `${method} ${path}: ${JSON.stringify(r.body).slice(0, 300)}`).toBe(status);
  return r.body;
}

describe("staff response types match what the server really returns", () => {
  it("watchlist, QR (with a watchlist hit), PIN, entry, sync, recognized, profile, notes, on-premise, exit, deliveries, shifts, notifications", async () => {
    // Watchlist entry (admin) — WatchlistEntryResponse, ListWatchlistResponse.
    const w = (await ok("POST", "/api/watchlist", adminId, 201, {
      subjectName: WATCHED,
      reason: "Integration shape check",
    })) as WatchlistEntryResponse;
    expectShape("WatchlistEntryResponse", w, fields<WatchlistEntryResponse>({ entry: "req", traceId: "req" }));
    expectShape("WatchlistEntryView", w.entry, WATCH_ENTRY);
    const wl = (await ok("GET", "/api/watchlist?status=all", adminId, 200)) as ListWatchlistResponse;
    expectShape("ListWatchlistResponse", wl, fields<ListWatchlistResponse>({
      entries: "req", count: "req", overdueCount: "req", traceId: "req",
    }));
    expectItems("ListWatchlistResponse.entries[]", wl.entries, WATCH_ENTRY);

    // Staff pass for the watchlisted visitor, scanned by QR — QrValidateResponse with watchlistMatch.
    const inv = await ok("POST", "/api/visitor-invitations", adminId, 201, {
      visitorName: WATCHED, host: "Shape Host", unit: UNIT, plate: null,
    });
    const qr = (await ok("POST", "/api/entries/qr/validate", guardId, 200, {
      qrToken: inv.invitation.qrToken, scannedAt: new Date().toISOString(),
    })) as QrValidateResponse;
    expectShape("QrValidateResponse", qr, QR_OK);
    expectShape("QrValidateResponse.visitor", qr.visitor, QR_VISITOR);
    expect(qr.watchlistMatch, "QR scan of a watchlisted visitor carries watchlistMatch").toBeDefined();
    expectShape("WatchlistMatchView", qr.watchlistMatch, WATCH_MATCH);

    // A second pass redeemed by PIN — PinValidateResponse.
    const inv2 = await ok("POST", "/api/visitor-invitations", adminId, 201, {
      visitorName: "Pin Visitor", host: "Shape Host", unit: UNIT, plate: "KAS 111A",
    });
    const pin = (await ok("POST", "/api/entries/pin/validate", guardId, 200, {
      passRef: inv2.invitation.passRef, pin: inv2.invitation.pin, scannedAt: new Date().toISOString(),
    })) as PinValidateResponse;
    expectShape("PinValidateResponse", pin, QR_OK);
    expectShape("PinValidateResponse.visitor", pin.visitor, QR_VISITOR);

    // Walk-in entry — CreateEntryResponse.
    const ce = (await ok("POST", "/api/entries", guardId, 201, {
      visitorName: "Shape Walkin", host: "Shape Host", unit: UNIT, plate: null, reason: "",
      method: "walk-in", createdAt: new Date().toISOString(),
    })) as CreateEntryResponse;
    expectShape("CreateEntryResponse", ce, fields<CreateEntryResponse>({
      entry: "req", watchlistMatch: "opt", traceId: "req",
    }));
    expectShape("ServerEntry", ce.entry, ENTRY);

    // Offline sync batch — SyncBatchResponse.
    const sb = (await ok("POST", "/api/entries/sync", guardId, 200, {
      entries: [{
        offlineId: randomUUID(), visitorName: "Shape Synced", host: "Shape Host", unit: UNIT,
        plate: null, reason: "", method: "walk-in", createdAt: new Date(Date.now() - 60_000).toISOString(),
      }],
    })) as SyncBatchResponse;
    expectShape("SyncBatchResponse", sb, fields<SyncBatchResponse>({
      results: "req", syncedCount: "req", duplicateCount: "req", rejectedCount: "req", traceId: "req",
    }));
    expectItems("SyncBatchResponse.results[]", sb.results, fields<SyncEntryResult>({
      offlineId: "req", serverId: "req", status: "req", error: "opt",
    }));
    expect(sb.syncedCount).toBe(1);

    // Recognized visitors — RecognizedVisitorsResponse.
    const rv = (await ok("GET", "/api/visitors/recognized?q=Shape%20Walkin", guardId, 200)) as RecognizedVisitorsResponse;
    expectShape("RecognizedVisitorsResponse", rv, fields<RecognizedVisitorsResponse>({
      visitors: "req", pagination: "req", traceId: "req",
    }));
    expectShape("RecognizedVisitorsResponse.pagination", rv.pagination, fields<RecognizedVisitorsResponse["pagination"]>({
      page: "req", pageSize: "req", totalItems: "req", totalPages: "req",
    }));
    expectItems("RecognizedVisitorItem", rv.visitors, fields<RecognizedVisitorItem>({
      id: "req", name: "req", host: "req", unit: "req", plate: "req", lastSeen: "req", recognition: "req",
    }));

    // Visitor profile — VisitorProfileResponse.
    const vp = (await ok("POST", "/api/visitor-profiles", adminId, 201, {
      visitorName: "Shape Profile", host: "Shape Host", unit: UNIT,
    })) as VisitorProfileResponse;
    expectShape("VisitorProfileResponse", vp, fields<VisitorProfileResponse>({ profile: "req", traceId: "req" }));
    expectShape("VisitorProfileView", vp.profile, fields<VisitorProfileView>({
      id: "req", visitorName: "req", host: "req", unit: "req", plate: "req", phoneE164: "req",
      notes: "req", watchFlag: "req", createdAt: "req", updatedAt: "req", deletedAt: "req",
    }));

    // Guard note on the walk-in — AddGuardNoteResponse, ListGuardNotesResponse.
    const an = (await ok("POST", `/api/entries/${ce.entry.id}/notes`, guardId, 201, {
      tag: "left_id_at_gate",
    })) as AddGuardNoteResponse;
    expectShape("AddGuardNoteResponse", an, fields<AddGuardNoteResponse>({ note: "req", traceId: "req" }));
    expectShape("GuardNoteView", an.note, NOTE);
    const ln = (await ok("GET", `/api/entries/${ce.entry.id}/notes`, guardId, 200)) as ListGuardNotesResponse;
    expectShape("ListGuardNotesResponse", ln, fields<ListGuardNotesResponse>({ notes: "req", count: "req", traceId: "req" }));
    expectItems("ListGuardNotesResponse.notes[]", ln.notes, NOTE);

    // On-premise list (with the note attached) — ListOnPremiseResponse.
    const op = (await ok("GET", "/api/entries/on-premise", adminId, 200)) as ListOnPremiseResponse;
    expectShape("ListOnPremiseResponse", op, fields<ListOnPremiseResponse>({ entries: "req", count: "req", traceId: "req" }));
    const ours = op.entries.filter((e) => e.unit === UNIT);
    expectItems("OnPremiseEntryView", ours, fields<OnPremiseEntryView>({
      id: "req", visitorName: "req", host: "req", unit: "req", plate: "req", method: "req",
      guardId: "req", createdAt: "req", notes: "req",
    }));
    expectItems("OnPremiseNoteView", ours.find((e) => e.id === ce.entry.id)?.notes, fields<OnPremiseNoteView>({
      id: "req", tag: "req", text: "req", guardId: "req", createdAt: "req",
    }));

    // Exit — RecordExitResponse.
    const ex = (await ok("POST", `/api/entries/${ce.entry.id}/exit`, guardId, 201, {})) as RecordExitResponse;
    expectShape("RecordExitResponse", ex, fields<RecordExitResponse>({ exit: "req", traceId: "req" }));
    expectShape("ExitRecordView", ex.exit, fields<ExitRecordView>({
      id: "req", entryId: "req", guardId: "req", createdAt: "req", traceId: "req",
    }));

    // Delivery — CreateDeliveryEntryResponse, ListDeliveriesResponse.
    const cd = (await ok("POST", "/api/entries/deliveries", guardId, 201, {
      visitorName: "Shape Rider", unit: UNIT, createdAt: new Date().toISOString(),
      entryKind: "delivery", deliveryCategory: "parcel",
    })) as CreateDeliveryEntryResponse;
    expectShape("CreateDeliveryEntryResponse", cd, fields<CreateDeliveryEntryResponse>({ entry: "req", traceId: "req" }));
    expectShape("DeliveryEntryView", cd.entry, fields<DeliveryEntryView>({
      ...ENTRY, entryKind: "req", deliveryCategory: "req",
    }));
    const ld = (await ok("GET", "/api/entries/deliveries", adminId, 200)) as ListDeliveriesResponse;
    expectShape("ListDeliveriesResponse", ld, fields<ListDeliveriesResponse>({ entries: "req", count: "req", traceId: "req" }));
    expectItems("DeliveryListEntryView", ld.entries.filter((e) => e.unit === UNIT), fields<DeliveryListEntryView>({
      id: "req", visitorName: "req", host: "req", unit: "req", plate: "req", deliveryCategory: "req",
      method: "req", guardId: "req", createdAt: "req",
    }));

    // Shift summary — ListShiftsResponse.
    const sh = (await ok("GET", `/api/admin/shifts?guardId=${guardId}`, adminId, 200)) as ListShiftsResponse;
    expectShape("ListShiftsResponse", sh, fields<ListShiftsResponse>({ window: "req", shifts: "req", traceId: "req" }));
    expectShape("ListShiftsResponse.window", sh.window, fields<ListShiftsResponse["window"]>({ fromIso: "req", toIso: "req" }));
    expectItems("ShiftSummaryView", sh.shifts, fields<ShiftSummaryView>({
      guardId: "req", guardName: "req", badgeNumber: "req", totals: "req",
    }));
    expectShape("ShiftTotalsView", sh.shifts[0].totals, fields<ShiftTotalsView>({
      entries: "req", qr: "req", walkIn: "req", override: "req", recognized: "req", auto: "req",
      approvalsDenied: "req", approvalsExpired: "req", autoApprovalsMatched: "req", overrideAuthorized: "req",
    }));

    // Notification row (templateKey was typed but never sent before) — NotificationView.
    setNotificationProviders({
      whatsapp: new MockNotificationProvider("whatsapp"),
      sms: new MockNotificationProvider("sms"),
    });
    const ap = await ok("POST", "/api/approvals", guardId, 201, {
      offlineId: randomUUID(),
      draft: { visitorName: "Shape Approval", host: "Shape Host", unit: UNIT, plate: null, reason: "", method: "walk-in" },
      hostPhoneE164: "+254700000555",
    });
    const nl = (await ok("GET", `/api/notifications?approvalId=${ap.approvalId}`, guardId, 200)) as NotificationsListResponse;
    expectItems("NotificationView", nl.notifications, fields<NotificationView>({
      id: "req", approvalId: "req", channel: "req", status: "req", attempts: "req", targetPhoneMasked: "req",
      templateKey: "req", lastErrorCode: "req", lastProviderResponseCode: "req", createdAt: "req",
      updatedAt: "req", deliveredAt: "req", failedAt: "req",
    }));
  });
});
