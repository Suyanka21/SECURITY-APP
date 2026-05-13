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
]);

// ─── Table 6: Audit Events ──────────────────────────────────────────────────
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
