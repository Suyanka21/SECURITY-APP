/**
 * GatePass — Drizzle ORM Schema
 *
 * Source of truth: src/docs/gatepass-api-contract.md
 * Aligned with:   src/features/gatepass/types.ts
 *
 * Drizzle ORM pgTable + pgEnum API reference:
 * https://orm.drizzle.team/docs/column-types/pg
 * https://orm.drizzle.team/docs/relations
 *
 * Design decisions:
 * - UUID primary keys (API contract uses string IDs)
 * - snake_case columns in PostgreSQL, camelCase in TypeScript via Drizzle aliases
 * - timestamp(3) with timezone for sub-millisecond precision
 * - CHECK constraints enforce business rules at database level
 * - No CASCADE deletes — audit system must never lose records
 */

import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// ─── Enums ───────────────────────────────────────────────────────────────────
// Source: gatepass-api-contract.md §2, types.ts L3–L28

/** Entry method — how the visitor was processed at the gate */
// Source: types.ts L3, contract §2
// "auto" added in Feature 3 (auto-approval engine) — written ONLY when
// the rule evaluator short-circuits an approval. See
// src/docs/specs/auto-approval.md §5.
export const entryMethodEnum = pgEnum("entry_method", [
  "qr",
  "walk-in",
  "override",
  "recognized",
  "auto",
]);

/** Entry lifecycle status */
// Source: types.ts L4, contract §2
export const entryStatusEnum = pgEnum("entry_status", [
  "draft",
  "pending",
  "approved",
  "denied",
  "logged",
  "sync-pending",
  "failed",
]);

/** Sync reconciliation state */
// Source: types.ts L30, contract §2
export const syncStateEnum = pgEnum("sync_state", [
  "synced",
  "queued",
  "failed",
]);

/** Visitor recognition classification */
// Source: types.ts L13, contract §2
export const recognitionTagEnum = pgEnum("recognition_tag", [
  "pre-approved",
  "frequent",
  "watch",
]);

/** Per-entry sync result status */
// Source: contract §3.3 SyncPendingResponse.results[].status
export const syncResultStatusEnum = pgEnum("sync_result_status", [
  "synced",
  "duplicate",
  "rejected",
]);

/** Entry kind — visitor vs delivery */
// Source: src/docs/specs/delivery-management.md §3
export const entryKindEnum = pgEnum("entry_kind", [
  "visitor",
  "delivery",
]);

/** Delivery sub-category — only meaningful when entry_kind = 'delivery' */
// Source: src/docs/specs/delivery-management.md §3
export const deliveryCategoryEnum = pgEnum("delivery_category", [
  "parcel",
  "food",
  "ride",
  "gas",
  "water",
  "moving",
  "maintenance",
  "other",
]);

/** Predefined guard-note tags (Feature 9). Standardised enum so notes are
 *  reportable/aggregatable, never free-form strings. 'other' unlocks a single
 *  capped free-text field. */
// Source: src/docs/specs/guard-notes.md §3
export const guardNoteTagEnum = pgEnum("guard_note_tag", [
  "delivered_parcel",
  "left_id_at_gate",
  "escorted_by_resident",
  "other",
]);

// ─── Table 1: Guards ─────────────────────────────────────────────────────────
// Source: contract §3.1–3.4 — guardId referenced across all endpoints
// GATEPASS DEFINITION §2: "guard ID" required for every action

export const guards = pgTable("guards", {
  /** Server-generated canonical guard ID */
  id: uuid("id").primaryKey().defaultRandom(),

  /** Guard badge/employee number — unique per guard */
  // Source: DEFINITION §2 "guard ID", §4 "linked to guard ID"
  badgeNumber: text("badge_number").notNull().unique(),

  /** Guard display name — required for audit trail display */
  name: text("name").notNull(),

  /** Whether this guard can currently operate the system */
  // Source: contract — "must resolve to active guard session"
  isActive: boolean("is_active").notNull().default(true),

  /**
   * Authorization role for admin-only endpoints.
   *
   * Source: src/docs/specs/auto-approval.md §8 — admin-only seed of
   * auto-approval rules. Closed set: 'guard' | 'senior-guard' | 'admin'.
   * DB CHECK constraint enforces the values (see migration 0004).
   *
   * Default 'guard' keeps every pre-Feature-3 row valid without a backfill.
   */
  role: text("role").notNull().default("guard"),

  /**
   * Link to the Supabase Auth user (auth.users.id) that signs in as this guard.
   *
   * Source: auth-and-role-routing.md §7 + ADR 0001. After Supabase Auth lands,
   * the verified JWT's `sub` is the Supabase user UUID; requireAuth resolves it
   * to this guard row via this column, then requireRole reads guards.role. The
   * role is NEVER taken from the token/metadata — only from guards.role.
   *
   * Nullable so pre-existing guard rows (and test fixtures using the legacy
   * self-issued JWT where sub === guards.id) remain valid without a backfill.
   * The cross-schema FK to auth.users(id) is added in migration 0009 (guarded
   * so it only applies where the Supabase `auth` schema exists) because Drizzle
   * cannot express a reference to the Supabase-managed auth schema here.
   */
  supabaseUserId: uuid("supabase_user_id").unique(),

  /** Server-generated creation timestamp */
  createdAt: timestamp("created_at", { precision: 3, withTimezone: true })
    .notNull()
    .defaultNow(),

  /** Server-generated update timestamp */
  updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ─── Table 2: Authorization Decisions ────────────────────────────────────────
// Source: contract §3.1 QR validation — preApprovalId links to approval record
// Source: contract §3.2 — preApprovalId required when method = "qr"

export const authorizationDecisions = pgTable(
  "authorization_decisions",
  {
    /** Server-generated canonical approval ID */
    // Source: contract §3.1 response — preApprovalId
    id: uuid("id").primaryKey().defaultRandom(),

    /** Pre-approved visitor name */
    // Source: contract §3.1 response — visitor.name
    visitorName: text("visitor_name").notNull(),

    /** Host/resident who authorized the visit */
    // Source: contract §3.1 response — visitor.host
    host: text("host").notNull(),

    /** Property unit associated with the approval */
    // Source: contract §3.1 response — visitor.unit
    unit: text("unit").notNull(),

    /** Vehicle plate — optional */
    // Source: contract §3.1 response — visitor.plate (string | null)
    plate: text("plate"),

    /** SHA-256 hash of the QR token — NEVER store raw tokens */
    // Source: contract §3.1 backend event — qrToken (hash)
    // Security: UNIQUE prevents storing duplicate tokens
    qrTokenHash: text("qr_token_hash").notNull().unique(),

    /** When this QR approval expires */
    // Source: contract §3.1 response — expiresAt
    expiresAt: timestamp("expires_at", { precision: 3, withTimezone: true })
      .notNull(),

    /** Whether this approval has been consumed (replay prevention) */
    // Security: database-level replay attack prevention
    isUsed: boolean("is_used").notNull().default(false),

    /** When the QR was consumed — null if unused */
    usedAt: timestamp("used_at", { precision: 3, withTimezone: true }),

    /** Which guard consumed this QR — null if unused */
    usedByGuardId: uuid("used_by_guard_id").references(() => guards.id),

    // ─── Feature 11 (Stage 4) — One-Time PIN Backup ──────────────────────
    // Source: src/docs/specs/one-time-pin-backup.md §4.
    // A PIN is an alternate way to redeem THIS same record; either method
    // flips is_used above. All fields nullable/defaulted for back-compat
    // with rows issued before this feature.

    /** Short, non-secret pass reference the guard types alongside the PIN */
    passRef: text("pass_ref").unique(),

    /** HMAC-SHA256(PIN_PEPPER, "<id>:<pin>") — NEVER the raw PIN */
    pinHash: text("pin_hash"),

    /** Consecutive wrong-PIN attempts for THIS pass (per-pass lockout) */
    pinFailedAttempts: integer("pin_failed_attempts").notNull().default(0),

    /** Non-null + in the future ⇒ this pass is locked (PIN and QR) */
    pinLockedUntil: timestamp("pin_locked_until", {
      precision: 3,
      withTimezone: true,
    }),

    /** Server-generated creation timestamp */
    createdAt: timestamp("created_at", { precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Visitor name must not be empty/whitespace
    check(
      "authorization_visitor_name_not_empty",
      sql`length(trim(${table.visitorName})) > 0`
    ),
    // Host must not be empty/whitespace
    check(
      "authorization_host_not_empty",
      sql`length(trim(${table.host})) > 0`
    ),
    // Unit must not be empty/whitespace
    check(
      "authorization_unit_not_empty",
      sql`length(trim(${table.unit})) > 0`
    ),
  ]
);

// ─── Table 3: Entry Records ─────────────────────────────────────────────────
// Source: contract §3.2 — CreateEntryRequest + CreateEntryResponse
// HARD RULE: entry cannot exist without guard_id

export const entryRecords = pgTable(
  "entry_records",
  {
    /** Server-generated canonical entry ID */
    // Source: contract §3.2 response — "Server-generated canonical ID"
    // WARNING: Frontend generates client-side IDs (entry-${index}) — those are NEVER used here
    id: uuid("id").primaryKey().defaultRandom(),

    /** Visitor full name */
    // Source: contract §3.2 — "Non-empty after trim"
    visitorName: text("visitor_name").notNull(),

    /** Host/resident being visited */
    // Source: contract §3.2 — "Non-empty after trim"
    host: text("host").notNull(),

    /** Property unit */
    // Source: contract §3.2 — "Non-empty after trim"
    unit: text("unit").notNull(),

    /** Vehicle plate number — optional */
    // Source: contract §3.2 — "Optional, max 20 chars if provided"
    plate: text("plate"),

    /** Reason for visit — required for override method (min 8 chars) */
    // Source: contract §3.2 — "When method=override: min 8 chars after trim"
    reason: text("reason").notNull().default(""),

    /** How the visitor was processed */
    // Source: contract §3.2 — "Must be one of: qr, walk-in, override, recognized"
    method: entryMethodEnum("method").notNull(),

    /** Guard who processed this entry — MANDATORY */
    // HARD RULE: "EntryRecord must always have guard_id"
    // Source: DEFINITION §4 — "linked to guard ID"
    guardId: uuid("guard_id")
      .notNull()
      .references(() => guards.id),

    /** Entry lifecycle status */
    // Source: contract §3.2 response — status: "logged"
    status: entryStatusEnum("status").notNull().default("logged"),

    /** Sync reconciliation state */
    // Source: contract §3.2 response — syncState: "synced"
    syncState: syncStateEnum("sync_state").notNull().default("synced"),

    /** Client-generated idempotency key for offline deduplication */
    // Source: contract §3.2 — "UUID format, used for dedup"
    // UNIQUE prevents duplicate entries from offline sync
    offlineId: uuid("offline_id").unique(),

    /** Link to pre-approval record — required when method = "qr" */
    // Source: contract §3.2 — "Required when method = qr"
    preApprovalId: uuid("pre_approval_id").references(
      () => authorizationDecisions.id
    ),

    /** Original timestamp from the guard's device */
    // Source: contract §3.2 — createdAt: "Device timestamp (ISO 8601)"
    deviceCreatedAt: timestamp("device_created_at", {
      precision: 3,
      withTimezone: true,
    }).notNull(),

    /** Server-generated canonical timestamp */
    // HARD RULE: "Timestamps must be server-generated"
    createdAt: timestamp("created_at", { precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),

    /** Server-generated trace ID for audit correlation */
    // Source: contract §3.2 response — traceId
    traceId: text("trace_id").notNull(),

    /** Entry kind — visitor (default) or delivery */
    // Source: src/docs/specs/delivery-management.md §3.2
    // Default 'visitor' keeps every pre-Feature-8 row valid.
    entryKind: entryKindEnum("entry_kind").notNull().default("visitor"),

    /** Delivery sub-category — required when entryKind = 'delivery' */
    // Source: src/docs/specs/delivery-management.md §3.2
    // NULL for visitor entries; CHECK constraint enforces coherence.
    deliveryCategory: deliveryCategoryEnum("delivery_category"),
  },
  (table) => [
    // Override entries must have meaningful reason (≥8 chars after trim)
    // Source: contract §3.2 — "method=override AND reason < 8 chars" → OVERRIDE_REASON_TOO_SHORT
    check(
      "entry_override_reason_length",
      sql`${table.method} != 'override' OR length(trim(${table.reason})) >= 8`
    ),
    // Plate max 20 chars when provided
    // Source: contract §3.2 — "Optional, max 20 chars if provided"
    check(
      "entry_plate_max_length",
      sql`${table.plate} IS NULL OR length(${table.plate}) <= 20`
    ),
    // Visitor name must not be empty/whitespace
    // Source: contract §3.2 — "Non-empty after trim"
    check(
      "entry_visitor_name_not_empty",
      sql`length(trim(${table.visitorName})) > 0`
    ),
    // Host must not be empty/whitespace
    // Source: contract §3.2 — "Non-empty after trim"
    check("entry_host_not_empty", sql`length(trim(${table.host})) > 0`),
    // Unit must not be empty/whitespace
    // Source: contract §3.2 — "Non-empty after trim"
    check("entry_unit_not_empty", sql`length(trim(${table.unit})) > 0`),
    // Delivery ↔ category coherence
    // Source: src/docs/specs/delivery-management.md §3.2
    check(
      "entry_delivery_category_coherence",
      sql`(${table.entryKind} = 'visitor' AND ${table.deliveryCategory} IS NULL) OR (${table.entryKind} = 'delivery' AND ${table.deliveryCategory} IS NOT NULL)`
    ),
  ]
);

// ─── Table 3b: Exit Records ─────────────────────────────────────────────────
// Source: src/docs/specs/exit-tracking.md §5 (data model)
// HARD RULES:
// - One exit per entry (entry_id UNIQUE)
// - Every exit attributed to a guard (guard_id NOT NULL)
// - Every exit carries a trace_id for audit correlation
// - No CASCADE deletes — audit trail must never lose records

export const exitRecords = pgTable("exit_records", {
  /** Server-generated exit record ID */
  id: uuid("id").primaryKey().defaultRandom(),

  /** The entry this exit closes — 1:1 relationship */
  // UNIQUE constraint enforces one exit per entry (no double-exit)
  entryId: uuid("entry_id")
    .notNull()
    .unique()
    .references(() => entryRecords.id),

  /** Guard who processed the exit — may differ from entry guard */
  guardId: uuid("guard_id")
    .notNull()
    .references(() => guards.id),

  /** Server-generated trace ID for audit correlation */
  traceId: text("trace_id").notNull(),

  /** Server-generated canonical timestamp — NEVER client-generated */
  createdAt: timestamp("created_at", { precision: 3, withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ─── Table 3c: Guard Notes ──────────────────────────────────────────────────
// Source: src/docs/specs/guard-notes.md §§3–5 (Feature 9).
// HARD RULES (DB-enforced):
// - A note attaches to exactly one target: an entry OR an exit (XOR).
// - Every note is attributed to a guard (guard_id NOT NULL + FK).
// - tag is a standardised enum — reportable, never a raw string.
// - Free text is allowed ONLY for tag='other', is required there, and is
//   capped at 280 chars after trim. Non-'other' tags carry no free text.
// - No CASCADE deletes — the audit trail must never lose a note.

export const guardNotes = pgTable(
  "guard_notes",
  {
    /** Server-generated note ID */
    id: uuid("id").primaryKey().defaultRandom(),

    /** The entry this note annotates — XOR with exit_id */
    entryId: uuid("entry_id").references(() => entryRecords.id),

    /** The exit this note annotates — XOR with entry_id */
    exitId: uuid("exit_id").references(() => exitRecords.id),

    /** Guard who attached the note — MANDATORY */
    guardId: uuid("guard_id")
      .notNull()
      .references(() => guards.id),

    /** Standardised tag (enum) */
    tag: guardNoteTagEnum("tag").notNull(),

    /** Free text — only for tag='other', capped at 280 chars */
    noteText: text("note_text"),

    /** Server-generated trace ID for audit correlation */
    traceId: text("trace_id").notNull(),

    /** Server-generated canonical timestamp — NEVER client-generated */
    createdAt: timestamp("created_at", { precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Exactly one target (entry XOR exit).
    check(
      "guard_note_target_xor",
      sql`(${table.entryId} IS NOT NULL AND ${table.exitId} IS NULL) OR (${table.entryId} IS NULL AND ${table.exitId} IS NOT NULL)`
    ),
    // Free text coherence: required + bounded for 'other', absent otherwise.
    check(
      "guard_note_text_coherence",
      sql`(${table.tag} = 'other' AND ${table.noteText} IS NOT NULL AND length(trim(${table.noteText})) BETWEEN 1 AND 280) OR (${table.tag} != 'other' AND ${table.noteText} IS NULL)`
    ),
  ]
);

// ─── Table 3d: Watchlist Entries ────────────────────────────────────────────
// Source: src/docs/specs/watchlist.md §§2, 7 (Feature 12 / Stage 5).
//
// HARD RULES (DB-enforced):
// - `reason` is MANDATORY text, never a boolean flag — a guard must be told
//   WHY someone is flagged, otherwise the warning is unactionable.
// - Nothing here can auto-deny entry. This table only ever produces a WARNING
//   plus a supervisor-escalation requirement (spec §1, §3).
// - Review model (spec §7, Option 2 — accepted): an entry never expires on its
//   own. `review_due_at` makes it OVERDUE, which is a presentation state for
//   admins; the entry keeps warning guards until a human removes it. Overdue
//   is derived at read time (review_due_at < now) — no background sweep to
//   silently fail, no stored status to drift out of sync with the clock.
// - Removal is soft and attributed (status + who + why) so the audit trail
//   never loses the fact that a subject WAS watchlisted.
// - No CASCADE deletes.

export const watchlistEntries = pgTable(
  "watchlist_entries",
  {
    /** Server-generated entry ID */
    id: uuid("id").primaryKey().defaultRandom(),

    /** Normalised name used for matching (trim → collapse spaces → upper) */
    subjectName: text("subject_name").notNull(),

    /** Original casing, for display back to admins/guards */
    subjectNameDisplay: text("subject_name_display").notNull(),

    /** Optional normalised plate — narrows a match when present */
    subjectPlate: text("subject_plate"),

    /** WHY this subject is flagged — MANDATORY, shown to the guard */
    reason: text("reason").notNull(),

    /** 'active' (matches + warns) | 'removed' (soft-deleted, never matches) */
    status: text("status").notNull().default("active"),

    /** Admin/senior-guard who created it — from the verified JWT, never body */
    addedByGuardId: uuid("added_by_guard_id")
      .notNull()
      .references(() => guards.id),

    /** Last time a human confirmed this entry is still warranted */
    lastReviewedAt: timestamp("last_reviewed_at", {
      precision: 3,
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    /** lastReviewedAt + WATCHLIST_REVIEW_INTERVAL_DAYS — overdue past this */
    reviewDueAt: timestamp("review_due_at", {
      precision: 3,
      withTimezone: true,
    }).notNull(),

    /** Who removed it (required once status='removed') */
    removedByGuardId: uuid("removed_by_guard_id").references(() => guards.id),

    /** Why it was removed (required once status='removed') */
    removedReason: text("removed_reason"),

    createdAt: timestamp("created_at", { precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Reason must be real text, not whitespace, and bounded.
    check(
      "watchlist_reason_not_blank",
      sql`length(trim(${table.reason})) BETWEEN 1 AND 500`
    ),
    // Closed status set — no 'expired' (see the review model above).
    check(
      "watchlist_status_valid",
      sql`${table.status} IN ('active', 'removed')`
    ),
    // Removal coherence: removed rows carry WHO and WHY; active rows carry
    // neither. Prevents a half-removed row that still matches.
    check(
      "watchlist_removal_coherence",
      sql`(${table.status} = 'removed' AND ${table.removedByGuardId} IS NOT NULL AND ${table.removedReason} IS NOT NULL AND length(trim(${table.removedReason})) BETWEEN 1 AND 500) OR (${table.status} = 'active' AND ${table.removedByGuardId} IS NULL AND ${table.removedReason} IS NULL)`
    ),
    index("watchlist_entries_subject_name_idx").on(table.subjectName),
    index("watchlist_entries_subject_plate_idx").on(table.subjectPlate),
    index("watchlist_entries_review_idx").on(table.status, table.reviewDueAt),
  ]
);

export const watchlistEntriesRelations = relations(
  watchlistEntries,
  ({ one }) => ({
    addedBy: one(guards, {
      fields: [watchlistEntries.addedByGuardId],
      references: [guards.id],
    }),
  })
);

// ─── Table 4: Override Events ────────────────────────────────────────────────
// Source: contract §3.2 (method=override)
// Source: DEFINITION §2D — "Manual Override: Guard selects Allow, Chooses reason, Entry logged with metadata"
// Source: DEFINITION §3 — "Guard override (always available but logged)"
// HARD RULE: "OverrideEvent must always have reason + timestamp"

export const overrideEvents = pgTable(
  "override_events",
  {
    /** Server-generated override event ID */
    id: uuid("id").primaryKey().defaultRandom(),

    /** The entry this override authorizes — 1:1 relationship */
    // UNIQUE constraint enforces one override per entry
    entryId: uuid("entry_id")
      .notNull()
      .unique()
      .references(() => entryRecords.id),

    /** Guard who performed the override — MANDATORY */
    // Source: DEFINITION — "guard ID" required for every override
    guardId: uuid("guard_id")
      .notNull()
      .references(() => guards.id),

    /** Override justification — MANDATORY, minimum 8 chars */
    // HARD RULE: "override cannot exist without reason"
    // Source: contract §3.2 — "method=override AND reason < 8 chars" → error
    reason: text("reason").notNull(),

    /** Server-generated timestamp — MANDATORY */
    // HARD RULE: "OverrideEvent must always have reason + timestamp"
    createdAt: timestamp("created_at", { precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),

    /** Server-generated trace ID for audit correlation */
    traceId: text("trace_id").notNull(),
  },
  (table) => [
    // Override reason must be meaningful (≥8 chars after trim)
    // Source: contract §3.2 — OVERRIDE_REASON_TOO_SHORT
    check(
      "override_reason_length",
      sql`length(trim(${table.reason})) >= 8`
    ),
  ]
);

// ─── Table 5: Sync Events ───────────────────────────────────────────────────
// Source: contract §3.3 — SyncPendingResponse.results[] per-entry results
// Source: DEFINITION §4 — "Offline Continuity: System must function without connectivity and sync later safely"

export const syncEvents = pgTable(
  "sync_events",
  {
    /** Server-generated sync event ID */
    id: uuid("id").primaryKey().defaultRandom(),

    /** Guard who initiated the sync batch */
    // Source: contract §3.3 — "one guard per sync batch"
    guardId: uuid("guard_id")
      .notNull()
      .references(() => guards.id),

    /** Client-generated offline ID for the entry being synced */
    // Source: contract §3.3 — "Required per entry, UUID format"
    offlineId: uuid("offline_id").notNull(),

    /** Server-assigned entry ID — null if rejected */
    // Source: contract §3.3 response — serverId
    entryId: uuid("entry_id").references(() => entryRecords.id),

    /** Per-entry sync result */
    // Source: contract §3.3 response — status: "synced" | "duplicate" | "rejected"
    status: syncResultStatusEnum("status").notNull(),

    /** Error code for rejected entries */
    // Source: contract §3.3 response — error.code
    errorCode: text("error_code"),

    /** Human-readable error message for rejected entries */
    // Source: contract §3.3 response — error.message
    errorMessage: text("error_message"),

    /** Original device timestamp from when the entry was created offline */
    // Source: contract §3.3 event — originalCreatedAt
    originalCreatedAt: timestamp("original_created_at", {
      precision: 3,
      withTimezone: true,
    }).notNull(),

    /** Server-generated timestamp of when this sync was processed */
    // Source: contract §3.3 event — syncedAt
    syncedAt: timestamp("synced_at", { precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),

    /** Server-generated trace ID for audit correlation */
    // Source: contract §3.3 response — traceId
    traceId: text("trace_id").notNull(),
  },
  (table) => [
    // If status is 'synced', entry_id must exist (successfully synced entries have a server ID)
    check(
      "sync_synced_requires_entry",
      sql`${table.status} != 'synced' OR ${table.entryId} IS NOT NULL`
    ),
    // If status is 'rejected', error_code must exist (rejected entries must explain why)
    check(
      "sync_rejected_requires_error",
      sql`${table.status} != 'rejected' OR ${table.errorCode} IS NOT NULL`
    ),
  ]
);

// ─── Enum: Approval Request Status ──────────────────────────────────────────
// Source: src/docs/specs/resident-approval-flow.md §5 — state machine terminals
// Source: src/docs/specs/resident-approval-flow.md §8 — DB migration shape
//
// Lifecycle (server-enforced):
//   pending  → approved | denied | expired
//   approved | denied | expired are terminal — no further transitions
//
// The server lazily flips pending → expired on every read of an approval
// whose expires_at has passed, so clients can never observe a stale
// pending row past the deadline.
export const approvalStatusEnum = pgEnum("approval_status", [
  "pending",
  "approved",
  "denied",
  "expired",
]);

// ─── Table 6: Approval Requests ─────────────────────────────────────────────
// Source: src/docs/specs/resident-approval-flow.md §7–§9
// Source: GATEPASS DEFINITION.md §USER FLOW.2.B — "request approval"
//
// Captures resident approval decisions for walk-ins that aren't pre-approved.
// The magic-link token (32 random bytes) is shown to the resident ONCE in the
// URL; only its SHA-256 hash is stored. After a successful decision the hash
// is wiped, making the token strictly single-use.
//
// HARD RULES (enforced by CHECK constraints below):
// - approved rows MUST link to entry_id (no "approved but no entry")
// - denied rows MUST record denied_reason (audit trail, not just a flag)
// - decided rows (any terminal status) MUST record decided_at
//
// Source: Security-and-Hardening — single-use, hashed-at-rest tokens

export const approvalRequests = pgTable(
  "approval_requests",
  {
    /** Server-generated canonical approval ID */
    // Source: spec §7.1 response — approvalId
    id: uuid("id").primaryKey().defaultRandom(),

    /** Client offline ID — ties this approval to the deferred entry */
    // Source: spec §7.1 request — offlineId
    // UNIQUE: one approval per pending walk-in, no double-requests
    offlineId: uuid("offline_id").notNull().unique(),

    /** Visitor full name (from the walk-in draft) */
    visitorName: text("visitor_name").notNull(),

    /** Host/resident being visited */
    host: text("host").notNull(),

    /** Property unit */
    unit: text("unit").notNull(),

    /** Vehicle plate — optional */
    plate: text("plate"),

    /** Walk-in reason — optional */
    reason: text("reason").notNull().default(""),

    /** Entry method — always 'walk-in' in v1 (override/qr take other paths) */
    method: entryMethodEnum("method").notNull(),

    /** Guard who requested approval — set from JWT, never from request body */
    // Source: spec §9 — "Approval bound to wrong guard" mitigation
    requestedByGuardId: uuid("requested_by_guard_id")
      .notNull()
      .references(() => guards.id),

    /** SHA-256 hash of the magic-link token — NEVER store the raw token */
    // Source: spec §9 — "Token leaked in logs" mitigation
    // Nullable so it can be wiped after a successful decision (single-use)
    tokenHash: text("token_hash").unique(),

    /** Request status — see approvalStatusEnum */
    status: approvalStatusEnum("status").notNull().default("pending"),

    /** When the resident (or server expiry) decided this request */
    decidedAt: timestamp("decided_at", {
      precision: 3,
      withTimezone: true,
    }),

    /** Reason supplied by the resident when denying */
    // Sanitized at API boundary: trimmed, control chars stripped, capped at 200
    deniedReason: text("denied_reason"),

    /** The entry created on approve — null until status='approved' */
    // ON DELETE: NO ACTION (audit trail must remain intact even if entry deleted)
    entryId: uuid("entry_id").references(() => entryRecords.id),

    /** When this request becomes invalid; pending past this point auto-expires */
    // Source: spec §4 A2 — default 300s, configurable via APPROVAL_TIMEOUT_SECONDS
    expiresAt: timestamp("expires_at", {
      precision: 3,
      withTimezone: true,
    }).notNull(),

    /** Server-generated creation timestamp */
    createdAt: timestamp("created_at", { precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),

    /** Server-generated trace ID for audit correlation */
    traceId: text("trace_id").notNull(),

    /** Optional resident phone in E.164 form. Drives Feature 2 delivery. */
    // Source: src/docs/specs/notifications.md §4 + §7.1
    // Nullable so legacy approvals (no phone known) continue to work
    // and the guard hand-copies the link.
    hostPhoneE164: text("host_phone_e164"),
  },
  (table) => [
    // Visitor name must not be empty/whitespace (mirrors entry_records)
    check(
      "approval_visitor_name_not_empty",
      sql`length(trim(${table.visitorName})) > 0`
    ),
    // Host must not be empty/whitespace
    check(
      "approval_host_not_empty",
      sql`length(trim(${table.host})) > 0`
    ),
    // Unit must not be empty/whitespace
    check(
      "approval_unit_not_empty",
      sql`length(trim(${table.unit})) > 0`
    ),
    // Approved rows MUST link to a real entry
    // Source: spec §8 — CHECK constraint
    check(
      "approval_approved_requires_entry",
      sql`${table.status} != 'approved' OR ${table.entryId} IS NOT NULL`
    ),
    // Denied rows MUST record a reason
    check(
      "approval_denied_requires_reason",
      sql`${table.status} != 'denied' OR ${table.deniedReason} IS NOT NULL`
    ),
    // Any terminal status MUST record decided_at
    check(
      "approval_terminal_requires_decided_at",
      sql`${table.status} = 'pending' OR ${table.decidedAt} IS NOT NULL`
    ),
    // Source: spec §8 — supports the expiry sweep + pending-by-guard queries
    // SELECT … WHERE status = 'pending' AND expires_at < now()
    index("approval_requests_status_expires_at_idx").on(
      table.status,
      table.expiresAt
    ),
    // Supports a guard's "my pending approvals" view
    index("approval_requests_requested_by_guard_id_idx").on(
      table.requestedByGuardId
    ),
  ]
);

// ─── Relations ──────────────────────────────────────────────────────────────
// Drizzle relations are application-level abstractions for the relational query API.
// They do NOT create database constraints — FKs above handle that.
// Source: https://orm.drizzle.team/docs/relations

export const guardsRelations = relations(guards, ({ many }) => ({
  /** All entries processed by this guard */
  entries: many(entryRecords),
  /** All exit records processed by this guard */
  exitRecords: many(exitRecords),
  /** All override events by this guard */
  overrides: many(overrideEvents),
  /** All sync events initiated by this guard */
  syncEvents: many(syncEvents),
  /** All guard notes attached by this guard */
  guardNotes: many(guardNotes),
}));

export const authorizationDecisionsRelations = relations(
  authorizationDecisions,
  ({ one, many }) => ({
    /** Guard who consumed this authorization (if used) */
    usedByGuard: one(guards, {
      fields: [authorizationDecisions.usedByGuardId],
      references: [guards.id],
    }),
    /** Entries that used this pre-approval */
    entries: many(entryRecords),
  })
);

export const entryRecordsRelations = relations(
  entryRecords,
  ({ one, many }) => ({
    /** The guard who processed this entry */
    guard: one(guards, {
      fields: [entryRecords.guardId],
      references: [guards.id],
    }),
    /** The pre-approval record (for QR entries) */
    authorization: one(authorizationDecisions, {
      fields: [entryRecords.preApprovalId],
      references: [authorizationDecisions.id],
    }),
    /** The override event (if method = override) — 1:1 */
    override: one(overrideEvents),
    /** The exit record (if visitor has departed) — 1:1 */
    exit: one(exitRecords),
    /** Guard notes attached to this entry */
    notes: many(guardNotes),
  })
);

export const overrideEventsRelations = relations(
  overrideEvents,
  ({ one }) => ({
    /** The entry this override authorizes */
    entry: one(entryRecords, {
      fields: [overrideEvents.entryId],
      references: [entryRecords.id],
    }),
    /** The guard who performed the override */
    guard: one(guards, {
      fields: [overrideEvents.guardId],
      references: [guards.id],
    }),
  })
);

export const exitRecordsRelations = relations(
  exitRecords,
  ({ one, many }) => ({
    /** The entry this exit closes */
    entry: one(entryRecords, {
      fields: [exitRecords.entryId],
      references: [entryRecords.id],
    }),
    /** The guard who processed the exit */
    guard: one(guards, {
      fields: [exitRecords.guardId],
      references: [guards.id],
    }),
    /** Guard notes attached to this exit */
    notes: many(guardNotes),
  })
);

export const guardNotesRelations = relations(guardNotes, ({ one }) => ({
  /** The entry this note annotates (if any) */
  entry: one(entryRecords, {
    fields: [guardNotes.entryId],
    references: [entryRecords.id],
  }),
  /** The exit this note annotates (if any) */
  exit: one(exitRecords, {
    fields: [guardNotes.exitId],
    references: [exitRecords.id],
  }),
  /** The guard who attached the note */
  guard: one(guards, {
    fields: [guardNotes.guardId],
    references: [guards.id],
  }),
}));

export const syncEventsRelations = relations(syncEvents, ({ one }) => ({
  /** The guard who initiated this sync */
  guard: one(guards, {
    fields: [syncEvents.guardId],
    references: [guards.id],
  }),
  /** The entry created by this sync (if successful) */
  entry: one(entryRecords, {
    fields: [syncEvents.entryId],
    references: [entryRecords.id],
  }),
}));

export const approvalRequestsRelations = relations(
  approvalRequests,
  ({ one, many }) => ({
    /** The guard who requested approval */
    requestedByGuard: one(guards, {
      fields: [approvalRequests.requestedByGuardId],
      references: [guards.id],
    }),
    /** The entry created on approve (1:1, null until status='approved') */
    entry: one(entryRecords, {
      fields: [approvalRequests.entryId],
      references: [entryRecords.id],
    }),
    /** Outbound deliveries for this approval (Feature 2). */
    notifications: many(notifications),
  })
);

// ─── Enums: Notification Channel + Status ───────────────────────────────────
// Source: src/docs/specs/notifications.md §4 (data model), §9 (state machine)
//
// notification_channel: 'whatsapp' is preferred; 'sms' is the fallback per
// GATEPASS DEFINITION L58–60.
//
// notification_status lifecycle:
//   queued → sending → delivered             (terminal success)
//                  ↓
//                 failed → permanently_failed (terminal failure after 3 retries)
//
// The server lazily flips long-stalled 'sending' rows to 'failed' on read
// (same pattern as approval expiry — no background job).
export const notificationChannelEnum = pgEnum("notification_channel", [
  "whatsapp",
  "sms",
]);

export const notificationStatusEnum = pgEnum("notification_status", [
  "queued",
  "sending",
  "delivered",
  "failed",
  "permanently_failed",
]);

// ─── Table 8: Notifications ─────────────────────────────────────────────────
// Source: src/docs/specs/notifications.md §4 (schema), §5 (architecture),
//         §9 (state machine).
//
// One row per outbound delivery ATTEMPT (not per approval). A WhatsApp
// failure followed by SMS fallback produces two rows. The
// idempotency_key (sha256(approval_id || channel || attempt_no)) is
// UNIQUE so the dispatcher can be safely enqueued twice without
// producing duplicate provider calls.
//
// HARD RULES (CHECK constraints below):
// - target_phone must not be empty/whitespace (full E.164 validated at
//   the API boundary).
// - attempts is non-negative and bounded at 10 (prevents runaway DB
//   growth from a misbehaving dispatcher).
// - provider response excerpt is capped at 200 chars (spec §3 PII rule).
// - terminal statuses require the matching timestamp.
//
// Source: Security-and-Hardening — bounded retry, scrubbed response.

export const notifications = pgTable(
  "notifications",
  {
    /** Server-generated unique notification ID */
    id: uuid("id").primaryKey().defaultRandom(),

    /** The approval this delivery serves. CASCADE on approval delete. */
    approvalId: uuid("approval_id")
      .notNull()
      .references(() => approvalRequests.id, { onDelete: "cascade" }),

    /** Channel used (whatsapp | sms) */
    channel: notificationChannelEnum("channel").notNull(),

    /** Target phone in E.164 form. Validated at the API boundary. */
    targetPhone: text("target_phone").notNull(),

    /** Template key (e.g. 'approval.magic_link'). Audit reproducibility. */
    templateKey: text("template_key").notNull(),

    /**
     * Rendered body actually sent to the provider. Stored for audit.
     * May contain the magic-link URL; the embedded token is single-use
     * and already lifecycle-bound by Feature 1, so persisting the
     * rendered body does NOT extend its security exposure.
     */
    renderedBody: text("rendered_body").notNull(),

    /** Lifecycle status — see notificationStatusEnum + state machine §9 */
    status: notificationStatusEnum("status").notNull().default("queued"),

    /** Send attempts so far (bounded 0..10 by CHECK constraint) */
    attempts: integer("attempts").notNull().default(0),

    /**
     * sha256(approval_id || channel || attempt_no).
     * UNIQUE — collapses duplicate dispatcher enqueues into one outbound.
     */
    idempotencyKey: text("idempotency_key").notNull().unique(),

    /** Last provider HTTP status code (when known) */
    lastProviderResponseCode: integer("last_provider_response_code"),

    /** Last provider response body — scrubbed, ≤ 200 chars (PII rule) */
    lastProviderResponseExcerpt: text("last_provider_response_excerpt"),

    /** Last error code from NotificationError union (e.g. PROVIDER_5XX) */
    lastErrorCode: text("last_error_code"),

    /** Server-generated creation timestamp */
    createdAt: timestamp("created_at", { precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),

    /** Updated on every status flip */
    updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),

    /** Set when status becomes 'delivered' (terminal success) */
    deliveredAt: timestamp("delivered_at", {
      precision: 3,
      withTimezone: true,
    }),

    /** Set when status becomes 'failed' or 'permanently_failed' */
    failedAt: timestamp("failed_at", { precision: 3, withTimezone: true }),
  },
  (table) => [
    check(
      "notification_target_phone_not_empty",
      sql`length(trim(${table.targetPhone})) > 0`
    ),
    check(
      "notification_attempts_bounded",
      sql`${table.attempts} >= 0 AND ${table.attempts} <= 10`
    ),
    check(
      "notification_response_excerpt_bounded",
      sql`${table.lastProviderResponseExcerpt} IS NULL OR length(${table.lastProviderResponseExcerpt}) <= 200`
    ),
    check(
      "notification_delivered_requires_ts",
      sql`${table.status} != 'delivered' OR ${table.deliveredAt} IS NOT NULL`
    ),
    check(
      "notification_failed_requires_ts",
      sql`${table.status} NOT IN ('failed','permanently_failed') OR ${table.failedAt} IS NOT NULL`
    ),
    // Lookup by approval for the per-approval status panel
    index("notifications_approval_idx").on(table.approvalId),
    // Partial index covering the dispatcher poll + lazy-flip sweep
    index("notifications_status_updated_idx")
      .on(table.status, table.updatedAt)
      .where(sql`${table.status} IN ('queued','sending','failed')`),
  ]
);

export const notificationsRelations = relations(notifications, ({ one }) => ({
  /** The approval this delivery serves */
  approval: one(approvalRequests, {
    fields: [notifications.approvalId],
    references: [approvalRequests.id],
  }),
}));

// ─── Table 6.5: Auto-approval rules ─────────────────────────────────────────
// Source: src/docs/specs/auto-approval.md §3
// Source: GATEPASS DEFINITION.md L18 ("Pre-approved frequent visitors should
//         not need re-approval every time")
//
// WHY:
// A bounded, default-deny rule table the approval-service consults BEFORE
// minting a magic link. If a rule matches, the approval short-circuits to
// 'approved' synchronously and an entry is logged inside the same handler.
// If anything fails (no rule, expired rule, inactive rule, plate mismatch,
// evaluator exception), the approval falls through to the manual flow.
//
// HARD RULES (DB-enforced — never trust the application):
// - Lookup is case-insensitive on (lower(visitor_name), lower(host),
//   lower(unit)). The partial UNIQUE index lives in the SQL migration
//   because Drizzle's `unique()` helper does not support functional
//   indices today.
// - expires_at > created_at — a rule must have a positive TTL.
// - Name/host/unit are bounded to the same widths as entry_records.
// - plate_required is NULL or 1..32 chars.
//
// SECURITY:
// - active=false is the kill switch; flipping it stops the rule firing
//   without needing a delete (audit trail preserved).
// - last_matched_at and match_count let admins find stale rules.
// - created_by_guard_id is captured so admins can attribute every rule
//   to a real person (no anonymous rule injection).
//
// ROLLBACK:
// - DROP TABLE auto_approval_rules; the audit_event_type values cannot
//   be removed once added in PostgreSQL — they remain harmlessly unused.

export const autoApprovalRules = pgTable(
  "auto_approval_rules",
  {
    /** Server-generated unique rule ID */
    id: uuid("id").primaryKey().defaultRandom(),

    /** Visitor name match (case-insensitive lookup) */
    visitorName: text("visitor_name").notNull(),

    /** Host name match (case-insensitive lookup) */
    host: text("host").notNull(),

    /** Unit identifier match (case-insensitive lookup) */
    unit: text("unit").notNull(),

    /**
     * Optional plate pin. NULL means the rule does NOT check the plate.
     * Non-NULL means the walk-in's plate must equal this (case-insensitive)
     * for the rule to fire.
     */
    plateRequired: text("plate_required"),

    /** The guard / admin who seeded this rule */
    createdByGuardId: uuid("created_by_guard_id")
      .notNull()
      .references(() => guards.id),

    /** Hard kill switch — false stops the rule firing immediately */
    active: boolean("active").notNull().default(true),

    /** Server-enforced TTL — rule NEVER fires after this */
    expiresAt: timestamp("expires_at", {
      precision: 3,
      withTimezone: true,
    }).notNull(),

    /** Server-generated creation timestamp */
    createdAt: timestamp("created_at", { precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),

    /** Bumped on every mutation */
    updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),

    /** Set on every successful match — surfaces stale rules to admins */
    lastMatchedAt: timestamp("last_matched_at", {
      precision: 3,
      withTimezone: true,
    }),

    /** Bumped on every successful match */
    matchCount: integer("match_count").notNull().default(0),
  },
  (table) => [
    check(
      "auto_approval_visitor_name_not_empty",
      sql`length(trim(${table.visitorName})) BETWEEN 1 AND 120`
    ),
    check(
      "auto_approval_host_bounded",
      sql`length(trim(${table.host})) BETWEEN 1 AND 120`
    ),
    check(
      "auto_approval_unit_bounded",
      sql`length(trim(${table.unit})) BETWEEN 1 AND 32`
    ),
    check(
      "auto_approval_plate_bounded",
      sql`${table.plateRequired} IS NULL OR length(trim(${table.plateRequired})) BETWEEN 1 AND 32`
    ),
    check(
      "auto_approval_positive_ttl",
      sql`${table.expiresAt} > ${table.createdAt}`
    ),
    // Lookup index for the evaluator. The functional partial UNIQUE index
    // (on lower(name), lower(host), lower(unit) WHERE active=true) is
    // created in the migration SQL.
    index("auto_approval_rules_triple_idx").on(
      table.visitorName,
      table.host,
      table.unit
    ),
    // Admin queries by guard + active + expiry
    index("auto_approval_rules_guard_idx").on(table.createdByGuardId),
  ]
);

export const autoApprovalRulesRelations = relations(
  autoApprovalRules,
  ({ one }) => ({
    /** The guard who seeded this rule (for admin attribution) */
    createdByGuard: one(guards, {
      fields: [autoApprovalRules.createdByGuardId],
      references: [guards.id],
    }),
  })
);

// ─── Table 6.6: Visitor profiles ─────────────────────────────────────────────
// Source: src/docs/specs/visitor-profiles.md §2 (data model)
// Source: GATEPASS DEFINITION.md §6 (visitor profile CRUD was listed as out of
//         scope of PR #1 — Feature 4 territory).
//
// WHY:
// Today the recognized-visitor list is derived from entry_records at query
// time. This table makes visitor profiles first-class so admins/senior-guards
// can attach a phone number (for Feature 2 delivery), set a watch_flag,
// record notes, and soft-delete a profile while preserving the audit trail.
//
// HARD RULES (DB-enforced — never trust the application):
// - Lookup is case-insensitive on (lower(visitor_name), lower(host),
//   lower(unit)). The partial UNIQUE index on the same triple WHERE
//   deleted_at IS NULL lives in the SQL migration (Drizzle's `unique()`
//   helper cannot express functional indices).
// - Soft-deleted rows do NOT block re-adding the same identity.
// - All text fields are bounded by CHECK constraints (length(trim(...))).
// - phone_e164 NULL OR matches '^\+[1-9]\d{1,14}$' (E.164).
// - Soft-delete consistency: (deleted_at IS NULL) = (deleted_by_guard_id
//   IS NULL).
//
// SECURITY:
// - watch_flag is a visual signal only — a flagged visitor is NOT
//   auto-denied (that would be a silent-deny surface; see spec §13).
// - created_by_guard_id and deleted_by_guard_id let admins attribute
//   every mutation to a real person.
//
// ROLLBACK:
// - DROP TABLE visitor_profiles;
//   The four audit_event_type values cannot be removed in PostgreSQL —
//   they remain harmlessly unused.

export const visitorProfiles = pgTable(
  "visitor_profiles",
  {
    /** Server-generated unique profile ID */
    id: uuid("id").primaryKey().defaultRandom(),

    /** Visitor name (case-insensitive lookup) */
    visitorName: text("visitor_name").notNull(),

    /** Host name (case-insensitive lookup) */
    host: text("host").notNull(),

    /** Unit identifier (case-insensitive lookup) */
    unit: text("unit").notNull(),

    /** Optional plate. NULL means the profile does not pin a plate. */
    plate: text("plate"),

    /**
     * Optional phone in E.164 format. Used by Feature 2's notification
     * dispatch path (future wiring). Format is enforced at the DB layer
     * so a malformed phone never reaches the provider.
     */
    phoneE164: text("phone_e164"),

    /** Free-form notes (bounded to 1000 chars after trim). */
    notes: text("notes"),

    /**
     * Watch flag — visitors flagged for extra scrutiny. Surfaced
     * visually in the UI (border + WATCH pill). DOES NOT block entry
     * — guards still make the final decision.
     */
    watchFlag: boolean("watch_flag").notNull().default(false),

    /** Guard / admin who created this profile */
    createdByGuardId: uuid("created_by_guard_id")
      .notNull()
      .references(() => guards.id),

    /** Server-generated creation timestamp */
    createdAt: timestamp("created_at", { precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),

    /** Bumped on every mutation */
    updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),

    /** Soft-delete marker. NULL means active. */
    deletedAt: timestamp("deleted_at", {
      precision: 3,
      withTimezone: true,
    }),

    /** Guard who soft-deleted this profile. NULL iff deletedAt is NULL. */
    deletedByGuardId: uuid("deleted_by_guard_id").references(() => guards.id),
  },
  (table) => [
    check(
      "visitor_profile_name_bounded",
      sql`length(trim(${table.visitorName})) BETWEEN 1 AND 120`
    ),
    check(
      "visitor_profile_host_bounded",
      sql`length(trim(${table.host})) BETWEEN 1 AND 120`
    ),
    check(
      "visitor_profile_unit_bounded",
      sql`length(trim(${table.unit})) BETWEEN 1 AND 32`
    ),
    check(
      "visitor_profile_plate_bounded",
      sql`${table.plate} IS NULL OR length(trim(${table.plate})) BETWEEN 1 AND 32`
    ),
    check(
      "visitor_profile_phone_e164_format",
      sql`${table.phoneE164} IS NULL OR ${table.phoneE164} ~ '^\\+[1-9]\\d{1,14}$'`
    ),
    check(
      "visitor_profile_notes_bounded",
      sql`${table.notes} IS NULL OR length(trim(${table.notes})) BETWEEN 1 AND 1000`
    ),
    check(
      "visitor_profile_soft_delete_consistent",
      sql`((${table.deletedAt} IS NULL) AND (${table.deletedByGuardId} IS NULL)) OR ((${table.deletedAt} IS NOT NULL) AND (${table.deletedByGuardId} IS NOT NULL))`
    ),
    // Resident-scoped listings + creator attribution. The functional
    // partial UNIQUE index on (lower(name), lower(host), lower(unit))
    // WHERE deleted_at IS NULL lives in the migration SQL.
    index("visitor_profiles_host_unit_idx").on(table.host, table.unit),
    index("visitor_profiles_creator_idx").on(table.createdByGuardId),
  ]
);

export const visitorProfilesRelations = relations(
  visitorProfiles,
  ({ one }) => ({
    /** The guard / admin who created this profile */
    createdByGuard: one(guards, {
      fields: [visitorProfiles.createdByGuardId],
      references: [guards.id],
      relationName: "visitor_profile_created_by",
    }),
    /** The guard who soft-deleted this profile (NULL when active) */
    deletedByGuard: one(guards, {
      fields: [visitorProfiles.deletedByGuardId],
      references: [guards.id],
      relationName: "visitor_profile_deleted_by",
    }),
  })
);

// ─── Enum: Audit Event Types ─────────────────────────────────────────────────
// Source: contract §5 — Backend Event Traceability Matrix
// Every frontend action MUST produce one of these traceable events

export const auditEventTypeEnum = pgEnum("audit_event_type", [
  "entry_created",
  "entry_blocked",
  "qr_scan_succeeded",
  "qr_scan_rejected",
  "override_authorized",
  "override_rejected",
  "visitor_selected",
  "visitor_search",
  "batch_sync_completed",
  "override_flow_entered",
  "flow_reset",
  "camera_initialized",
  "camera_failure",
  // Source: src/docs/specs/resident-approval-flow.md — Feature 1 audit events.
  // approval_* events are emitted by the approval-service on each state
  // transition; together they reconstruct the full decision history.
  "approval_requested",
  "approval_approved",
  "approval_denied",
  "approval_expired",
  // Source: src/docs/specs/notifications.md §11 — Feature 2 audit events.
  // Each delivery attempt writes one of these; together they reconstruct
  // the full notification timeline for any approval.
  "notification_sent",
  "notification_failed",
  "notification_permanently_failed",
  // Source: src/docs/specs/auto-approval.md §3 — Feature 3 audit events.
  // The rule_created / rule_deactivated / rule_expired events let admins
  // reconstruct the lifecycle of any rule. The `auto_approval_matched`
  // event is written ALONGSIDE the existing entry_created row inside the
  // same transaction so the audit trail is louder for auto-approvals,
  // not quieter (spec §1 contract).
  "auto_approval_rule_created",
  "auto_approval_rule_deactivated",
  "auto_approval_rule_expired",
  "auto_approval_matched",
  // Source: src/docs/specs/visitor-profiles.md §5 — Feature 4 audit events.
  // Mutations to a visitor profile always write exactly one of these rows
  // inside the same transaction as the mutation. Reads do NOT emit an
  // audit row (would flood the log). Soft-delete restoration is an
  // explicit, separate event so admins can reconstruct the lifecycle.
  "visitor_profile_created",
  "visitor_profile_updated",
  "visitor_profile_soft_deleted",
  "visitor_profile_restored",
  // Source: src/docs/specs/guest-qr-ticket.md §6 — Feature 6 issue event.
  // Written when an admin/senior-guard mints a single-use visitor QR
  // invitation. Payload contains the qr_token_hash (SHA-256) only —
  // the raw token is NEVER persisted (see visitor-invitation-service).
  // Migration: drizzle/0006_qr_invitation_audit_enum.sql.
  "qr_invitation_issued",
  // Source: src/docs/specs/exit-tracking.md §5 — Feature 7 audit events.
  // exit_recorded is written when a guard successfully records a
  // visitor's departure. exit_blocked is written when an exit attempt
  // is rejected (no open entry, already exited).
  // Migration: drizzle/0007_exit_records.sql.
  "exit_recorded",
  "exit_blocked",
  // Source: src/docs/specs/delivery-management.md §3.3 — Feature 8 audit events.
  // delivery_entry_logged on successful delivery entry creation.
  // delivery_entry_blocked when a delivery attempt is rejected.
  // Migration: drizzle/0008_delivery_management.sql.
  "delivery_entry_logged",
  "delivery_entry_blocked",
  // Source: src/docs/adr/0001-...md — Stage 1 (A1) admin account provisioning.
  // Written when an admin creates a guard/admin account.
  // Migration: drizzle/0010_account_provisioned_audit_enum.sql.
  "account_provisioned",
  // Source: src/docs/specs/guard-notes.md — Feature 9 (Stage 2).
  // Written when a guard attaches a note (tag) to an entry/exit record.
  // Migration: drizzle/0011_guard_notes.sql.
  "guard_note_added",
  // Source: src/docs/specs/one-time-pin-backup.md §6 — Feature 11 (Stage 4).
  // pin_redeemed: a PIN redeemed the shared authorization_decisions record.
  // pin_failed: a wrong / not-found / locked PIN attempt (reason + counter,
  //   NEVER the PIN or its hash). pin_locked: the per-pass limiter tripped.
  // Migration: drizzle/0012_one_time_pin.sql.
  "pin_redeemed",
  "pin_failed",
  "pin_locked",
  // Source: src/docs/specs/watchlist.md §6 — Feature 12 (Stage 5).
  // watchlist_matched is written when a visitor at the gate matches an active
  // watchlist entry. It records the WARNING, never a denial — the system does
  // not auto-deny (spec §1); escalation reuses override_authorized/_rejected.
  // There is deliberately NO watchlist_entry_expired: under the accepted
  // review model (spec §7, Option 2) nothing ever drops off on its own.
  "watchlist_entry_added",
  "watchlist_matched",
  "watchlist_entry_reviewed",
  "watchlist_entry_removed",
]);

// ─── Table 7: Audit Events ──────────────────────────────────────────────────
// Source: contract §5 — Backend Event Traceability Matrix
// Source: GATEPASS DEFINITION — "Every action is written to shift log"
//
// HARD RULES:
// - APPEND-ONLY: No UPDATE, no DELETE operations exposed
// - IMMUTABLE: Once written, cannot be altered
// - COMPLETE: Every system action generates an event
// - RECONSTRUCTABLE: Full system state can be rebuilt from events

export const auditEvents = pgTable("audit_events", {
  /** Server-generated immutable event ID */
  id: uuid("id").primaryKey().defaultRandom(),

  /** Event type from the traceability matrix */
  // Source: contract §5 — event type column
  eventType: auditEventTypeEnum("event_type").notNull(),

  /** Guard who triggered this action */
  // Source: contract §5 — guardId in every event
  guardId: uuid("guard_id")
    .notNull()
    .references(() => guards.id),

  /** Server-generated trace ID for cross-event correlation */
  // Source: contract §5 — traceId in every event
  traceId: text("trace_id").notNull(),

  /** Event-specific payload — stored as JSONB for native JSON querying */
  // Source: contract §5 — audit fields per event type
  // [M3 FIX] Changed from text() to jsonb() — enables JSON operators, indexing,
  // and structured queries without CAST overhead.
  // Migration: ALTER TABLE audit_events ALTER COLUMN payload TYPE jsonb USING payload::jsonb;
  payload: jsonb("payload").notNull().default({}),

  /** Server-generated immutable timestamp — NEVER client-generated */
  // HARD RULE: "Timestamps must be server-generated"
  createdAt: timestamp("created_at", { precision: 3, withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const auditEventsRelations = relations(auditEvents, ({ one }) => ({
  /** The guard who generated this event */
  guard: one(guards, {
    fields: [auditEvents.guardId],
    references: [guards.id],
  }),
}));
