/**
 * GatePass — Watchlist Validation Schemas (Feature 12 / Stage 5)
 *
 * Source: src/docs/specs/watchlist.md §§2–4, §7
 * Source: API-and-Interface-Design — validate at the boundary, single error shape.
 * Source: Security-and-Hardening — the client never supplies identity or status.
 *
 * The client can only ever send subject/reason text. `status`, `addedByGuardId`,
 * `lastReviewedAt` and `reviewDueAt` are server-owned and are deliberately NOT
 * part of any request schema.
 */

import { z } from "zod";

/**
 * Review interval for the accepted review model (spec §7, Option 2).
 *
 * An entry is never auto-dropped. Passing this interval only marks it OVERDUE
 * for admins — it keeps warning guards until a human removes it.
 */
export const WATCHLIST_REVIEW_INTERVAL_DAYS = 90;

/** Mirrors the DB CHECK constraints (reason + removedReason). */
export const WATCHLIST_REASON_MAX = 500;
export const WATCHLIST_SUBJECT_NAME_MAX = 120;

/**
 * Normalises a subject name for matching: trim → collapse internal runs of
 * whitespace → upper-case. Comparison-only; the display form is stored
 * separately so admins see what they actually typed.
 */
export function normalizeSubjectName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

/** The mandatory-reason field, shared by create and edit. */
const reasonField = z
  .string({ required_error: "Reason is required" })
  .trim()
  .min(1, "Reason is required")
  .max(WATCHLIST_REASON_MAX, `Reason must be at most ${WATCHLIST_REASON_MAX} characters`);

// ─── POST /api/watchlist ─────────────────────────────────────────────────────

export const CreateWatchlistEntrySchema = z.object({
  subjectName: z
    .string({ required_error: "Subject name is required" })
    .trim()
    .min(1, "Subject name is required")
    .max(
      WATCHLIST_SUBJECT_NAME_MAX,
      `Subject name must be at most ${WATCHLIST_SUBJECT_NAME_MAX} characters`,
    ),
  // Optional — narrows a match when the subject is known by vehicle too.
  subjectPlate: z.string().trim().max(32, "Plate must be at most 32 characters").optional(),
  reason: reasonField,
});

export type CreateWatchlistEntryInput = z.infer<typeof CreateWatchlistEntrySchema>;

// ─── GET /api/watchlist ──────────────────────────────────────────────────────

export const ListWatchlistQuerySchema = z.object({
  status: z.enum(["active", "removed", "all"]).default("active"),
  // "true" (string) arrives on the query string; anything else means "no filter".
  needsReview: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => v === true || v === "true"),
});

export type ListWatchlistQuery = z.infer<typeof ListWatchlistQuerySchema>;

// ─── PATCH /api/watchlist/:id (reconfirm / edit reason) ──────────────────────

/**
 * A PATCH always reconfirms (resets the review clock) and may optionally
 * revise the reason. An empty body is valid: "I looked at this, it still
 * stands" is exactly the human review the model is asking for.
 */
export const ReviewWatchlistEntrySchema = z.object({
  reason: reasonField.optional(),
});

export type ReviewWatchlistEntryInput = z.infer<typeof ReviewWatchlistEntrySchema>;

// ─── DELETE /api/watchlist/:id ───────────────────────────────────────────────

/** Removal is soft and must say WHY, so the audit trail stays reconstructable. */
export const RemoveWatchlistEntrySchema = z.object({
  removedReason: reasonField,
});

export type RemoveWatchlistEntryInput = z.infer<typeof RemoveWatchlistEntrySchema>;

export const WatchlistParamsSchema = z.object({
  id: z.string().uuid("id must be a valid UUID"),
});

// ─── Views ───────────────────────────────────────────────────────────────────

export interface WatchlistEntryView {
  id: string;
  subjectName: string;
  subjectPlate: string | null;
  reason: string;
  status: "active" | "removed";
  addedByGuardId: string;
  lastReviewedAt: string;
  reviewDueAt: string;
  /** Derived at read time (reviewDueAt < now) — never a stored status. */
  reviewOverdue: boolean;
  removedByGuardId: string | null;
  removedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WatchlistEntryResponse {
  entry: WatchlistEntryView;
  traceId: string;
}

export interface ListWatchlistResponse {
  entries: WatchlistEntryView[];
  count: number;
  /** How many ACTIVE entries are past their review date — drives the admin badge. */
  overdueCount: number;
  traceId: string;
}

/**
 * The warning attached to an entry/scan response when the visitor matches an
 * active watchlist entry.
 *
 * HARD RULE (spec §1, §3): this is a WARNING. Its presence never changes the
 * outcome of the request it rides on — the entry/scan still succeeds.
 * `requiresEscalation` tells the UI to route the guard through supervisor
 * override instead of logging directly.
 */
export interface WatchlistMatchView {
  matched: true;
  entryId: string;
  reason: string;
  matchedOn: "name" | "plate" | "name+plate";
  requiresEscalation: true;
}

export const WatchlistErrorCodes = {
  WATCHLIST_INVALID_INPUT: "WATCHLIST_INVALID_INPUT",
  WATCHLIST_NOT_FOUND: "WATCHLIST_NOT_FOUND",
  WATCHLIST_ALREADY_REMOVED: "WATCHLIST_ALREADY_REMOVED",
} as const;
