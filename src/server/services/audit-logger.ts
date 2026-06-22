/**
 * GatePass — Audit Logger (Immutable Truth)
 *
 * Source: gatepass-api-contract.md §5 — Backend Event Traceability Matrix
 * Source: GATEPASS DEFINITION — "Every action is written to shift log"
 *
 * HARD RULES:
 * - APPEND-ONLY: No update or delete operations exist
 * - IMMUTABLE: Once an event is stored, it cannot be modified
 * - COMPLETE: Every system action MUST emit an event
 * - RECONSTRUCTABLE: Full system state can be rebuilt from events
 *
 * Architecture:
 * - In-memory store for testing + observability
 * - DB persistence via audit_events table (append-only)
 * - Synchronous emit — caller blocks until event is recorded
 * - No audit event can be silently dropped
 */

import { randomUUID } from "crypto";

// ─── Audit Event Types ───────────────────────────────────────────────────────
// Source: contract §5 — Backend Event Traceability Matrix

export type AuditEventType =
  | "entry_created"
  | "entry_blocked"
  | "qr_scan_succeeded"
  | "qr_scan_rejected"
  | "override_authorized"
  | "override_rejected"
  | "visitor_selected"
  | "visitor_search"
  | "batch_sync_completed"
  | "override_flow_entered"
  | "flow_reset"
  | "camera_initialized"
  | "camera_failure"
  // Source: src/docs/specs/resident-approval-flow.md — Feature 1 audit events.
  // The approval-service emits one of these on every state transition;
  // together they reconstruct the full decision history per request.
  | "approval_requested"
  | "approval_approved"
  | "approval_denied"
  | "approval_expired"
  // Source: src/docs/specs/notifications.md §11 — Feature 2 audit events.
  // Each delivery attempt writes one of these.
  | "notification_sent"
  | "notification_failed"
  | "notification_permanently_failed"
  // Source: src/docs/specs/auto-approval.md §3 — Feature 3 audit events.
  // The auto_approval_matched event is written ALONGSIDE the existing
  // entry_created row inside the same transaction so the audit trail
  // is louder for auto-approvals, not quieter (spec §1 contract).
  | "auto_approval_rule_created"
  | "auto_approval_rule_deactivated"
  | "auto_approval_rule_expired"
  | "auto_approval_matched"
  // Source: src/docs/specs/visitor-profiles.md §5 — Feature 4 audit events.
  // Mutations to a visitor profile always write exactly one of these rows
  // inside the same transaction as the mutation. Reads do NOT emit an
  // audit row (would flood the log).
  | "visitor_profile_created"
  | "visitor_profile_updated"
  | "visitor_profile_soft_deleted"
  | "visitor_profile_restored"
  // Source: src/docs/specs/guest-qr-ticket.md §6 — Feature 6 issue event.
  // Written when an admin/senior-guard issues a visitor invitation.
  // The raw QR token is NEVER part of the payload — only the SHA-256
  // hash, mirroring the discipline in qr-service.ts.
  | "qr_invitation_issued"
  // Source: src/docs/specs/exit-tracking.md §5 — Feature 7 audit events.
  // exit_recorded: successful exit (payload: { entryId, exitId }).
  // exit_blocked: rejected exit attempt (payload: { entryId, code }).
  | "exit_recorded"
  | "exit_blocked"
  // Source: src/docs/specs/delivery-management.md §3.3 — Feature 8 audit events.
  // delivery_entry_logged: successful delivery entry creation.
  // delivery_entry_blocked: rejected delivery attempt.
  | "delivery_entry_logged"
  | "delivery_entry_blocked";

export interface AuditEvent {
  /** Unique immutable event ID */
  id: string;
  /** Event type from the traceability matrix */
  type: AuditEventType;
  /** ISO 8601 server timestamp — NEVER client-generated */
  timestamp: string;
  /** Guard who triggered this action */
  guardId: string;
  /** Server-generated trace ID for correlation */
  traceId: string;
  /** Event-specific payload */
  payload: Record<string, unknown>;
}

// ─── Audit Log Store (In-Memory + Observability) ─────────────────────────────
// HARD RULE: Append-only — no update, no delete operations exist
// The in-memory store supplements DB persistence for testing and local debugging
//
// [H3 FIX] Capped at MAX_IN_MEMORY_EVENTS to prevent unbounded memory growth.
// Source: TRUSTLESS-AUDIT-REPORT [H3] — "In-memory audit log has no size limit"
// Source: Performance-Optimization — "Memory growth → unbounded caches"
// DB remains the immutable source of truth; in-memory is for observability only.

const MAX_IN_MEMORY_EVENTS = 10_000;
const auditLog: AuditEvent[] = [];

// ─── DB Persistence Layer ────────────────────────────────────────────────────
// Pluggable DB handle — set via setAuditDB() during app initialization

type AuditDB = {
  insert: (table: any) => { values: (data: any) => Promise<void> };
};

let auditDB: AuditDB | null = null;

/**
 * Connects the audit logger to the database for persistent storage.
 * Called once during app initialization.
 */
export function setAuditDB(db: AuditDB): void {
  auditDB = db;
}

/**
 * Disconnects the audit logger from the database.
 * Used in tests to prevent DB writes during unit testing.
 */
export function clearAuditDB(): void {
  auditDB = null;
}

/**
 * Emits a structured audit event.
 *
 * Source: contract §5 — "Every frontend action MUST produce a traceable backend event"
 * Source: TRUSTLESS-AUDIT-REPORT [C4/S1] — "Audit DB write must NOT be fire-and-forget"
 *
 * [C4/S1 FIX] This function is now async and AWAITS DB persistence.
 * If the DB write fails, the error propagates to the caller — no silent drops.
 *
 * HARD RULE: No audit event can be silently dropped.
 * - Always appends to in-memory store
 * - Always logs to stdout
 * - AWAITS DB persistence (throws if DB write fails)
 *
 * @returns The emitted event (for chaining/assertions)
 */
export async function emitAuditEvent(
  type: AuditEventType,
  guardId: string,
  traceId: string,
  payload: Record<string, unknown> = {}
): Promise<AuditEvent> {
  const event: AuditEvent = {
    id: randomUUID(),
    type,
    timestamp: new Date().toISOString(),
    guardId,
    traceId,
    payload,
  };

  // Layer 1: In-memory store (always succeeds)
  auditLog.push(event);

  // [H3 FIX] Enforce size cap — drop oldest events when limit exceeded
  // Source: Code-Simplification — minimal splice approach, no new abstractions
  if (auditLog.length > MAX_IN_MEMORY_EVENTS) {
    auditLog.splice(0, auditLog.length - MAX_IN_MEMORY_EVENTS);
  }

  // Layer 2: Stdout log for observability (always succeeds)
  // Security: Never log sensitive data (QR tokens, passwords)
  console.log(
    `[AUDIT] ${event.type} | guard=${guardId} | trace=${traceId} | ${JSON.stringify(payload)}`
  );

  // Layer 3: DB persistence (AWAITED — no silent failures)
  // [C4/S1 FIX] Removed fire-and-forget .catch() — errors now propagate
  // If auditDB is null (test environment), skip silently (in-memory is sufficient)
  if (auditDB) {
    await persistAuditEvent(event);
  }

  return event;
}

/**
 * Persists an audit event to the database.
 * APPEND-ONLY: Only INSERT is used — no UPDATE, no DELETE.
 *
 * [M3 FIX] payload is now JSONB — passed as a native object, not JSON.stringify'd.
 * Validation ensures payload is always valid JSON before insert.
 */
async function persistAuditEvent(event: AuditEvent): Promise<void> {
  if (!auditDB) return;

  // [M3 FIX] Validate payload is serializable JSON before DB write.
  // Source: API-and-Interface-Design — "Validate at boundary"
  // Catches: circular references, BigInt, undefined values, functions
  const validatedPayload = validatePayload(event.payload);

  // Dynamic import to avoid circular dependency with schema
  const { auditEvents } = await import("@/db/schema");

  await auditDB.insert(auditEvents).values({
    id: event.id,
    eventType: event.type,
    guardId: event.guardId,
    traceId: event.traceId,
    payload: validatedPayload,
    createdAt: new Date(event.timestamp),
  });
}

// ─── Query API ───────────────────────────────────────────────────────────────
// HARD RULE: Read-only operations only — no modifications

/**
 * Returns all audit events (for testing and reporting).
 * Source: DEFINITION §5 — "Every action is written to shift log"
 */
export function getAuditLog(): ReadonlyArray<AuditEvent> {
  return [...auditLog];
}

/**
 * Returns audit events filtered by type.
 */
export function getAuditEventsByType(type: AuditEventType): AuditEvent[] {
  return auditLog.filter((e) => e.type === type);
}

/**
 * Returns audit events filtered by guard.
 * Source: DEFINITION §5 — "Aggregated per guard per shift"
 */
export function getAuditEventsByGuard(guardId: string): AuditEvent[] {
  return auditLog.filter((e) => e.guardId === guardId);
}

/**
 * Returns audit events filtered by traceId.
 * Used for reconstructing the full chain of events for a single action.
 */
export function getAuditEventsByTraceId(traceId: string): AuditEvent[] {
  return auditLog.filter((e) => e.traceId === traceId);
}

/**
 * Returns audit events within a time range.
 * Used for shift-based reporting.
 */
export function getAuditEventsByTimeRange(
  from: Date,
  to: Date
): AuditEvent[] {
  return auditLog.filter((e) => {
    const ts = new Date(e.timestamp);
    return ts >= from && ts <= to;
  });
}

/**
 * Reconstructs the state of a specific entry from its audit trail.
 * Source: GATEPASS DEFINITION — event-sourcing principle
 *
 * Returns all events related to a given traceId in chronological order,
 * providing a complete, verifiable history of what happened.
 */
export function reconstructEntryHistory(traceId: string): {
  events: AuditEvent[];
  timeline: { timestamp: string; action: string; detail: string }[];
} {
  const events = getAuditEventsByTraceId(traceId).sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const timeline = events.map((e) => ({
    timestamp: e.timestamp,
    action: e.type,
    detail: formatEventDetail(e),
  }));

  return { events, timeline };
}

/**
 * Reconstructs a guard's shift summary from audit events.
 * Source: GATEPASS DEFINITION — "Aggregated per guard per shift"
 */
export function reconstructGuardShift(guardId: string): {
  guardId: string;
  totalEvents: number;
  entriesCreated: number;
  qrScansSucceeded: number;
  qrScansRejected: number;
  overridesAuthorized: number;
  overridesRejected: number;
  syncBatches: number;
  events: AuditEvent[];
} {
  const events = getAuditEventsByGuard(guardId);

  return {
    guardId,
    totalEvents: events.length,
    entriesCreated: events.filter((e) => e.type === "entry_created").length,
    qrScansSucceeded: events.filter((e) => e.type === "qr_scan_succeeded").length,
    qrScansRejected: events.filter((e) => e.type === "qr_scan_rejected").length,
    overridesAuthorized: events.filter((e) => e.type === "override_authorized").length,
    overridesRejected: events.filter((e) => e.type === "override_rejected").length,
    syncBatches: events.filter((e) => e.type === "batch_sync_completed").length,
    events,
  };
}

/**
 * Formats an event's detail for human-readable timeline display.
 */
function formatEventDetail(event: AuditEvent): string {
  switch (event.type) {
    case "entry_created":
      return `Entry ${event.payload.entryId} created via ${event.payload.method} for unit ${event.payload.unit}`;
    case "qr_scan_succeeded":
      return `QR scan approved for visitor ${event.payload.visitorName}`;
    case "qr_scan_rejected":
      return `QR scan rejected: ${event.payload.reason}`;
    case "override_authorized":
      return `Override authorized: "${event.payload.reason}"`;
    case "override_rejected":
      return `Override rejected: ${event.payload.reason}`;
    case "batch_sync_completed":
      return `Batch sync: ${event.payload.syncedCount} synced, ${event.payload.duplicateCount} duplicate, ${event.payload.rejectedCount} rejected`;
    default:
      return JSON.stringify(event.payload);
  }
}

/**
 * Validates that a payload is valid JSON-serializable data.
 *
 * [M3 FIX] Source: API-and-Interface-Design — "Validate at boundary"
 * Source: Deprecation-and-Migration — schema change from TEXT→JSONB requires
 * ensuring all payloads are valid JSON before they hit the database.
 *
 * Catches: circular references, BigInt, functions, undefined values.
 * Returns the round-tripped (cleaned) payload object.
 *
 * @throws Error if payload cannot be serialized to JSON
 */
export function validatePayload(
  payload: Record<string, unknown>
): Record<string, unknown> {
  try {
    // Round-trip through JSON to catch non-serializable values
    // This also strips undefined values and converts Date → string
    const serialized = JSON.stringify(payload);
    return JSON.parse(serialized) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `[AUDIT] Payload is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Clears the audit log (for testing only).
 * SECURITY: This function exists ONLY for test isolation.
 * In production, the in-memory log is supplementary — the DB is the source of truth.
 */
export function clearAuditLog(): void {
  auditLog.length = 0;
}
