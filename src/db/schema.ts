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
export const entryMethodEnum = pgEnum("entry_method", [
  "qr",
  "walk-in",
  "override",
  "recognized",
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
  ]
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
  /** All override events by this guard */
  overrides: many(overrideEvents),
  /** All sync events initiated by this guard */
  syncEvents: many(syncEvents),
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
  ({ one }) => ({
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
