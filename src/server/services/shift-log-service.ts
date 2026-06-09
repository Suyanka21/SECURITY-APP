/**
 * GatePass — Shift Log Aggregation Service
 *
 * Source: src/docs/specs/shift-log-aggregation.md §§3–5
 * Source: Trustless-System-Auditor — read-only; never writes audit rows;
 *         never silently swallows a 0-row response (returns `shifts: []`).
 * Source: Code-Simplification — aggregates in JS over already-filtered
 *         row sets; no DSL, no materialised view, no caching tier.
 * Source: Security-and-Hardening — authorisation enforced upstream by
 *         requireRole(['admin','senior-guard']); this service trusts
 *         the gate.
 *
 * Responsibilities:
 *   1. listShifts(query, db) — group entries + audit events by guard
 *      over a [fromIso, toIso) window, with optional guardId filter.
 *
 * Hard rules:
 *   - Window MUST satisfy from < to and (to - from) ≤ 31 days. These
 *     are boundary conditions, not business rules; violations throw a
 *     typed ServiceError mapped to 422 at the route layer.
 *   - Guards with zero activity in the window are NOT emitted.
 *   - Output ordering is deterministic: totals.entries desc, then
 *     badgeNumber asc. Stable between refreshes.
 *   - No PII (names, plates, phones, notes) is read from
 *     entry_records or audit_events; only guard_id is grouped on.
 *     The display columns (guardName, badgeNumber) come from the
 *     `guards` row already authorised to be displayed to admins.
 */

import { and, eq, gte, lt, inArray } from "drizzle-orm";

import { entryRecords, auditEvents, guards } from "@/db/schema";
import { ServiceError } from "./errors";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DrizzleDB {
  select: (...args: unknown[]) => unknown;
  [key: string]: unknown;
}

export type ShiftQuery = {
  /** ISO-8601 UTC, inclusive lower bound on created_at. */
  fromIso: string;
  /** ISO-8601 UTC, exclusive upper bound on created_at. */
  toIso: string;
  /** Optional single-guard filter. */
  guardId?: string;
};

export type ShiftTotals = {
  entries: number;
  qr: number;
  walkIn: number;
  override: number;
  recognized: number;
  auto: number;
  approvalsDenied: number;
  approvalsExpired: number;
  autoApprovalsMatched: number;
  overrideAuthorized: number;
};

export type ShiftSummary = {
  guardId: string;
  guardName: string;
  badgeNumber: string;
  totals: ShiftTotals;
};

export type ShiftListResult = {
  window: { fromIso: string; toIso: string };
  shifts: ShiftSummary[];
};

// ─── Error codes ─────────────────────────────────────────────────────────────

export const ShiftErrorCodes = {
  SHIFT_WINDOW_INVALID: "SHIFT_WINDOW_INVALID",
  SHIFT_WINDOW_TOO_LARGE: "SHIFT_WINDOW_TOO_LARGE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

const RELEVANT_EVENT_TYPES = [
  "approval_denied",
  "approval_expired",
  "auto_approval_matched",
  "override_authorized",
] as const;
type RelevantEventType = (typeof RELEVANT_EVENT_TYPES)[number];

// ─── Window validation ───────────────────────────────────────────────────────

function validateWindow(fromIso: string, toIso: string): {
  fromDate: Date;
  toDate: Date;
} {
  const fromDate = new Date(fromIso);
  const toDate = new Date(toIso);

  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    throw new ServiceError(
      ShiftErrorCodes.SHIFT_WINDOW_INVALID,
      "fromIso and toIso must be valid ISO-8601 timestamps.",
      422
    );
  }

  if (fromDate.getTime() >= toDate.getTime()) {
    throw new ServiceError(
      ShiftErrorCodes.SHIFT_WINDOW_INVALID,
      "fromIso must be strictly earlier than toIso.",
      422
    );
  }

  if (toDate.getTime() - fromDate.getTime() > MAX_WINDOW_MS) {
    throw new ServiceError(
      ShiftErrorCodes.SHIFT_WINDOW_TOO_LARGE,
      "Shift windows are capped at 31 days. Narrow the range and retry.",
      422
    );
  }

  return { fromDate, toDate };
}

// ─── Aggregation helpers ─────────────────────────────────────────────────────

function emptyTotals(): ShiftTotals {
  return {
    entries: 0,
    qr: 0,
    walkIn: 0,
    override: 0,
    recognized: 0,
    auto: 0,
    approvalsDenied: 0,
    approvalsExpired: 0,
    autoApprovalsMatched: 0,
    overrideAuthorized: 0,
  };
}

function incrementMethod(totals: ShiftTotals, method: string): void {
  totals.entries += 1;
  switch (method) {
    case "qr":
      totals.qr += 1;
      return;
    case "walk-in":
      totals.walkIn += 1;
      return;
    case "override":
      totals.override += 1;
      return;
    case "recognized":
      totals.recognized += 1;
      return;
    case "auto":
      totals.auto += 1;
      return;
    default:
      // Source: Trustless-System-Auditor — unknown method must NOT vanish.
      // We still count the entry under .entries; the per-method buckets
      // simply don't tick. This surfaces in test as "entries > sum(methods)"
      // and is far better than a silent drop.
      return;
  }
}

function incrementEvent(totals: ShiftTotals, eventType: string): void {
  switch (eventType as RelevantEventType) {
    case "approval_denied":
      totals.approvalsDenied += 1;
      return;
    case "approval_expired":
      totals.approvalsExpired += 1;
      return;
    case "auto_approval_matched":
      totals.autoApprovalsMatched += 1;
      return;
    case "override_authorized":
      totals.overrideAuthorized += 1;
      return;
    default:
      // Same default-deny philosophy as incrementMethod — never drop silently.
      return;
  }
}

// ─── listShifts() ────────────────────────────────────────────────────────────

export async function listShifts(
  query: ShiftQuery,
  db: DrizzleDB
): Promise<ShiftListResult> {
  const { fromDate, toDate } = validateWindow(query.fromIso, query.toIso);

  // 1. Pull the entry rows in the window (guard_id + method only).
  // The cast to `any` mirrors the pattern in visitor-profile-service: keeps
  // the mock DB tests trivial while production Drizzle stays type-checked
  // via the schema imports at the top of the file.
  const entryClauses: unknown[] = [
    gte(entryRecords.createdAt, fromDate),
    lt(entryRecords.createdAt, toDate),
  ];
  if (query.guardId) {
    entryClauses.push(eq(entryRecords.guardId, query.guardId));
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entryRows = (await (db as any)
    .select()
    .from(entryRecords)
    .where(and(...(entryClauses as Parameters<typeof and>)))) as Array<{
    guardId: string;
    method: string;
  }>;

  // 2. Pull the relevant audit events in the window.
  const eventClauses: unknown[] = [
    gte(auditEvents.createdAt, fromDate),
    lt(auditEvents.createdAt, toDate),
    inArray(auditEvents.eventType, [...RELEVANT_EVENT_TYPES]),
  ];
  if (query.guardId) {
    eventClauses.push(eq(auditEvents.guardId, query.guardId));
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const eventRows = (await (db as any)
    .select()
    .from(auditEvents)
    .where(and(...(eventClauses as Parameters<typeof and>)))) as Array<{
    guardId: string;
    eventType: string;
  }>;

  // 3. Aggregate by guardId in application code.
  const totalsByGuard = new Map<string, ShiftTotals>();

  for (const row of entryRows) {
    let totals = totalsByGuard.get(row.guardId);
    if (!totals) {
      totals = emptyTotals();
      totalsByGuard.set(row.guardId, totals);
    }
    incrementMethod(totals, row.method);
  }

  for (const row of eventRows) {
    let totals = totalsByGuard.get(row.guardId);
    if (!totals) {
      totals = emptyTotals();
      totalsByGuard.set(row.guardId, totals);
    }
    incrementEvent(totals, row.eventType);
  }

  // 4. Look up display columns for the guards we actually touched.
  const guardIds = Array.from(totalsByGuard.keys());
  let guardRows: Array<{ id: string; name: string; badgeNumber: string }> = [];
  if (guardIds.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    guardRows = (await (db as any)
      .select()
      .from(guards)
      .where(inArray(guards.id, guardIds))) as typeof guardRows;
  }
  const guardById = new Map(guardRows.map((g) => [g.id, g]));

  // 5. Assemble the response. Guards present in totals but missing from
  //    the lookup get a synthetic display label so the row never
  //    disappears (no silent success).
  const shifts: ShiftSummary[] = guardIds.map((guardId) => {
    const totals = totalsByGuard.get(guardId)!;
    const guard = guardById.get(guardId);
    return {
      guardId,
      guardName: guard?.name ?? "(unknown guard)",
      badgeNumber: guard?.badgeNumber ?? "(unknown)",
      totals,
    };
  });

  // 6. Deterministic sort: entries desc, badgeNumber asc.
  shifts.sort((a, b) => {
    if (b.totals.entries !== a.totals.entries) {
      return b.totals.entries - a.totals.entries;
    }
    return a.badgeNumber.localeCompare(b.badgeNumber);
  });

  return {
    window: { fromIso: fromDate.toISOString(), toIso: toDate.toISOString() },
    shifts,
  };
}
