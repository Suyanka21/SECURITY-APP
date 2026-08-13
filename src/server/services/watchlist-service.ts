/**
 * GatePass — Watchlist Service (Feature 12 / Stage 5)
 *
 * Source: src/docs/specs/watchlist.md §§2–4, §6, §7
 * Source: Trustless-System-Auditor — every mutation writes exactly one audit
 *         row; a missing target default-denies (404), never a silent no-op.
 * Source: Security-and-Hardening — guard identity from the verified JWT,
 *         parameterised queries only, input already validated at the boundary.
 *
 * HARD RULE (spec §1): nothing in this service can deny entry. `findWatchlistMatch`
 * returns a warning; the caller attaches it to an otherwise-successful response.
 */

import { and, eq, isNotNull, lt, or } from "drizzle-orm";
import { randomUUID } from "crypto";

import { watchlistEntries } from "@/db/schema";
import { normalizePlate } from "@/features/gatepass/plate-verification";
import {
  normalizeSubjectName,
  WATCHLIST_REVIEW_INTERVAL_DAYS,
  WatchlistErrorCodes,
  type CreateWatchlistEntryInput,
  type ListWatchlistQuery,
  type RemoveWatchlistEntryInput,
  type ReviewWatchlistEntryInput,
  type WatchlistEntryView,
  type WatchlistMatchView,
} from "../validation/watchlist-schemas";
import { emitAuditEvent } from "./audit-logger";
import { ServiceError } from "./errors";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DrizzleDB {
  select: (...args: unknown[]) => unknown;
  insert: (...args: unknown[]) => unknown;
  update: (...args: unknown[]) => unknown;
  [key: string]: unknown;
}

interface WatchlistRow {
  id: string;
  subjectName: string;
  subjectNameDisplay: string;
  subjectPlate: string | null;
  reason: string;
  status: string;
  addedByGuardId: string;
  lastReviewedAt: string | Date;
  reviewDueAt: string | Date;
  removedByGuardId: string | null;
  removedReason: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** review_due_at for a review happening at `from`. */
export function computeReviewDueAt(from: Date): Date {
  return new Date(
    from.getTime() + WATCHLIST_REVIEW_INTERVAL_DAYS * 24 * 60 * 60 * 1000,
  );
}

/**
 * Overdue is DERIVED, never stored (spec §7). No background sweep exists that
 * could silently fail, and the flag can never drift out of sync with the clock.
 */
export function isReviewOverdue(
  row: Pick<WatchlistRow, "status" | "reviewDueAt">,
  now: Date = new Date(),
): boolean {
  if (row.status !== "active") return false;
  return new Date(iso(row.reviewDueAt)).getTime() < now.getTime();
}

function toView(row: WatchlistRow, now: Date = new Date()): WatchlistEntryView {
  return {
    id: row.id,
    // Admins see what they typed; the normalised form is a matching detail.
    subjectName: row.subjectNameDisplay,
    subjectPlate: row.subjectPlate,
    reason: row.reason,
    status: row.status === "removed" ? "removed" : "active",
    addedByGuardId: row.addedByGuardId,
    lastReviewedAt: iso(row.lastReviewedAt),
    reviewDueAt: iso(row.reviewDueAt),
    reviewOverdue: isReviewOverdue(row, now),
    removedByGuardId: row.removedByGuardId,
    removedReason: row.removedReason,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

async function loadEntry(id: string, db: DrizzleDB): Promise<WatchlistRow> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (await (db as any)
    .select()
    .from(watchlistEntries)
    .where(eq(watchlistEntries.id, id))
    .limit(1)) as WatchlistRow[];

  const row = rows?.[0];
  if (!row) {
    throw new ServiceError(
      WatchlistErrorCodes.WATCHLIST_NOT_FOUND,
      "No watchlist entry found for the provided ID",
      404,
      "id",
    );
  }
  return row;
}

// ─── Create ──────────────────────────────────────────────────────────────────

/**
 * Adds a subject to the watchlist. `reason` is mandatory (enforced at the
 * boundary AND by a DB CHECK) — a warning a guard can't act on is useless.
 */
export async function createWatchlistEntry(
  input: CreateWatchlistEntryInput,
  guardId: string,
  db: DrizzleDB,
): Promise<{ entry: WatchlistEntryView; traceId: string }> {
  const traceId = `trace-${randomUUID()}`;
  const now = new Date();

  const plate = input.subjectPlate ? normalizePlate(input.subjectPlate) : "";

  const values = {
    subjectName: normalizeSubjectName(input.subjectName),
    subjectNameDisplay: input.subjectName.trim(),
    subjectPlate: plate.length > 0 ? plate : null,
    reason: input.reason,
    status: "active",
    addedByGuardId: guardId,
    lastReviewedAt: now,
    reviewDueAt: computeReviewDueAt(now),
    createdAt: now,
    updatedAt: now,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inserted = (await (db as any)
    .insert(watchlistEntries)
    .values(values)
    .returning()) as WatchlistRow[];

  const row = inserted?.[0];
  if (!row) {
    // INSERT ... RETURNING with no row is a broken invariant, not an outcome.
    throw new ServiceError(
      "WATCHLIST_WRITE_FAILED",
      "Failed to persist watchlist entry",
      500,
    );
  }

  await emitAuditEvent("watchlist_entry_added", guardId, traceId, {
    watchlistEntryId: row.id,
    hasPlate: row.subjectPlate !== null,
    reviewDueAt: iso(row.reviewDueAt),
  });

  return { entry: toView(row, now), traceId };
}

// ─── List ────────────────────────────────────────────────────────────────────

export async function listWatchlistEntries(
  query: ListWatchlistQuery,
  db: DrizzleDB,
): Promise<{
  entries: WatchlistEntryView[];
  overdueCount: number;
  traceId: string;
}> {
  const traceId = `trace-${randomUUID()}`;
  const now = new Date();

  const conditions = [];
  if (query.status !== "all") {
    conditions.push(eq(watchlistEntries.status, query.status));
  }
  if (query.needsReview) {
    // Overdue only ever applies to active entries.
    conditions.push(eq(watchlistEntries.status, "active"));
    conditions.push(lt(watchlistEntries.reviewDueAt, now));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let builder = (db as any).select().from(watchlistEntries);
  if (conditions.length > 0) {
    builder = builder.where(
      conditions.length === 1 ? conditions[0] : and(...conditions),
    );
  }
  const rows = (await builder) as WatchlistRow[];

  const entries = (rows ?? [])
    .map((row) => toView(row, now))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return {
    entries,
    overdueCount: entries.filter((e) => e.reviewOverdue).length,
    traceId,
  };
}

// ─── Review (re-confirm) ─────────────────────────────────────────────────────

/**
 * Re-confirms an entry: resets the review clock (spec §7, Option 2) and may
 * revise the reason. A removed entry cannot be reconfirmed back into life —
 * that would resurrect a warning without the deliberate act of re-adding it.
 */
export async function reviewWatchlistEntry(
  id: string,
  input: ReviewWatchlistEntryInput,
  guardId: string,
  db: DrizzleDB,
): Promise<{ entry: WatchlistEntryView; traceId: string }> {
  const traceId = `trace-${randomUUID()}`;
  const now = new Date();

  const existing = await loadEntry(id, db);
  if (existing.status !== "active") {
    throw new ServiceError(
      WatchlistErrorCodes.WATCHLIST_ALREADY_REMOVED,
      "This watchlist entry has been removed and cannot be reviewed",
      409,
      "id",
    );
  }

  const wasOverdue = isReviewOverdue(existing, now);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updated = (await (db as any)
    .update(watchlistEntries)
    .set({
      ...(input.reason ? { reason: input.reason } : {}),
      lastReviewedAt: now,
      reviewDueAt: computeReviewDueAt(now),
      updatedAt: now,
    })
    .where(
      and(
        eq(watchlistEntries.id, id),
        eq(watchlistEntries.status, "active"),
      ),
    )
    .returning()) as WatchlistRow[];

  const row = updated?.[0];
  if (!row) {
    // Lost a race with a concurrent removal — report the real state.
    throw new ServiceError(
      WatchlistErrorCodes.WATCHLIST_ALREADY_REMOVED,
      "This watchlist entry has been removed and cannot be reviewed",
      409,
      "id",
    );
  }

  await emitAuditEvent("watchlist_entry_reviewed", guardId, traceId, {
    watchlistEntryId: row.id,
    reasonRevised: Boolean(input.reason),
    wasOverdue,
    reviewDueAt: iso(row.reviewDueAt),
  });

  return { entry: toView(row, now), traceId };
}

// ─── Remove (soft) ───────────────────────────────────────────────────────────

/**
 * The ONLY way an entry stops warning guards. Soft, attributed, and audited so
 * the trail never loses the fact that the subject WAS watchlisted.
 */
export async function removeWatchlistEntry(
  id: string,
  input: RemoveWatchlistEntryInput,
  guardId: string,
  db: DrizzleDB,
): Promise<{ entry: WatchlistEntryView; traceId: string }> {
  const traceId = `trace-${randomUUID()}`;
  const now = new Date();

  const existing = await loadEntry(id, db);
  if (existing.status !== "active") {
    throw new ServiceError(
      WatchlistErrorCodes.WATCHLIST_ALREADY_REMOVED,
      "This watchlist entry has already been removed",
      409,
      "id",
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updated = (await (db as any)
    .update(watchlistEntries)
    .set({
      status: "removed",
      removedByGuardId: guardId,
      removedReason: input.removedReason,
      updatedAt: now,
    })
    .where(
      and(
        eq(watchlistEntries.id, id),
        eq(watchlistEntries.status, "active"),
      ),
    )
    .returning()) as WatchlistRow[];

  const row = updated?.[0];
  if (!row) {
    throw new ServiceError(
      WatchlistErrorCodes.WATCHLIST_ALREADY_REMOVED,
      "This watchlist entry has already been removed",
      409,
      "id",
    );
  }

  await emitAuditEvent("watchlist_entry_removed", guardId, traceId, {
    watchlistEntryId: row.id,
  });

  return { entry: toView(row, now), traceId };
}

// ─── Match at entry time ─────────────────────────────────────────────────────

export interface WatchlistMatchCandidate {
  visitorName: string | null | undefined;
  plate: string | null | undefined;
}

/**
 * Looks for an ACTIVE watchlist entry matching the visitor at the gate.
 *
 * HARD RULES:
 * - Returns a WARNING or null. It never throws a "denied" outcome and the
 *   caller must never turn a match into a rejection (spec §1).
 * - Overdue-for-review entries still match — review state is an admin
 *   presentation concern and must never silence a warning (spec §7).
 * - Matching is deterministic normalised equality; no fuzzy matching in v1,
 *   so a guard is never warned about the wrong person by a similarity score.
 * - A lookup failure must not break entry logging; the caller treats a thrown
 *   error as "no warning available" rather than failing the entry.
 */
export async function findWatchlistMatch(
  candidate: WatchlistMatchCandidate,
  db: DrizzleDB,
): Promise<WatchlistMatchView | null> {
  const name = candidate.visitorName
    ? normalizeSubjectName(candidate.visitorName)
    : "";
  const plate = candidate.plate ? normalizePlate(candidate.plate) : "";

  if (name.length === 0 && plate.length === 0) return null;

  const identityChecks = [];
  if (name.length > 0) {
    identityChecks.push(eq(watchlistEntries.subjectName, name));
  }
  if (plate.length > 0) {
    identityChecks.push(
      and(
        isNotNull(watchlistEntries.subjectPlate),
        eq(watchlistEntries.subjectPlate, plate),
      ),
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (await (db as any)
    .select()
    .from(watchlistEntries)
    .where(
      and(
        eq(watchlistEntries.status, "active"),
        identityChecks.length === 1 ? identityChecks[0] : or(...identityChecks),
      ),
    )) as WatchlistRow[];

  if (!rows || rows.length === 0) return null;

  // Precedence: the most specific match wins so the guard sees the strongest
  // evidence first (spec §4).
  const scored = rows.map((row) => {
    const nameHit = name.length > 0 && row.subjectName === name;
    const plateHit =
      plate.length > 0 && row.subjectPlate !== null && row.subjectPlate === plate;
    const matchedOn: WatchlistMatchView["matchedOn"] =
      nameHit && plateHit ? "name+plate" : plateHit ? "plate" : "name";
    const score = nameHit && plateHit ? 3 : plateHit ? 2 : 1;
    return { row, matchedOn, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  return {
    matched: true,
    entryId: best.row.id,
    reason: best.row.reason,
    matchedOn: best.matchedOn,
    requiresEscalation: true,
  };
}

/**
 * Match + audit, for callers on the entry path.
 *
 * Never throws: a watchlist lookup failure must degrade to "no warning shown"
 * rather than blocking a gate operation, so the entry still succeeds — the same
 * warn-never-block posture the feature requires end to end.
 *
 * A failure is NOT silent: it is logged with the traceId, because "the guard
 * saw no warning" and "there was no warning to see" must be distinguishable
 * when this is reviewed after an incident.
 */
export async function checkWatchlistForEntry(
  candidate: WatchlistMatchCandidate,
  guardId: string,
  traceId: string,
  db: DrizzleDB,
): Promise<WatchlistMatchView | null> {
  let match: WatchlistMatchView | null = null;
  try {
    match = await findWatchlistMatch(candidate, db);
  } catch (error) {
    console.error(
      `[watchlist] match check failed — no warning could be shown to the guard | trace=${traceId} | guard=${guardId}`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }

  if (!match) return null;

  await emitAuditEvent("watchlist_matched", guardId, traceId, {
    watchlistEntryId: match.entryId,
    matchedOn: match.matchedOn,
    // Recorded explicitly so the trail proves the system warned and did NOT
    // deny — the auditor can distinguish this from a block.
    outcome: "warned_requires_escalation",
  });

  return match;
}
