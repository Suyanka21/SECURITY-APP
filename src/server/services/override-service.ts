/**
 * GatePass — Override Service (Critical Control)
 *
 * Source: GATEPASS DEFINITION §2D — "Manual Override"
 * Source: GATEPASS DEFINITION §3 — "Guard override (always available but logged)"
 * Source: gatepass-api-contract.md §3.2 — method=override validation
 *
 * HARD RULES (enforced at every layer):
 * 1. Override MUST include reason (≥ 8 chars after trim)
 * 2. Override MUST include guard_id (NOT NULL FK)
 * 3. Override MUST generate audit event (via audit-logger)
 * 4. Override CANNOT exist without entry linkage (entry_id NOT NULL FK)
 *
 * Security-and-Hardening: Defense in depth — validated at:
 * Layer 1: Zod schema (entry-schemas.ts) — HTTP boundary
 * Layer 2: Authorization service — business logic
 * Layer 3: This service — override-specific enforcement
 * Layer 4: Database CHECK constraint — override_reason_length ≥ 8
 * Layer 5: Database FK constraint — entry_id NOT NULL REFERENCES entry_records
 *
 * If ANY layer fails, the override is rejected. No silent bypass path exists.
 */

import { randomUUID } from "crypto";
import { emitAuditEvent } from "./audit-logger";
import { ServiceError } from "./errors";

// ─── Override Types ──────────────────────────────────────────────────────────

export interface OverrideInput {
  /** The entry being overridden — MUST exist */
  entryId: string;
  /** Guard performing the override — MUST be active */
  guardId: string;
  /** Override justification — MUST be ≥ 8 chars after trim */
  reason: string;
  /** Server-generated trace ID from entry creation */
  traceId: string;
}

export interface OverrideResult {
  /** Override event ID */
  id: string;
  /** Linked entry ID */
  entryId: string;
  /** Guard who authorized */
  guardId: string;
  /** Override reason */
  reason: string;
  /** Server timestamp */
  createdAt: string;
  /** Audit trace */
  traceId: string;
  /** Audit event emitted */
  auditEventEmitted: boolean;
}

// ─── Override Errors ─────────────────────────────────────────────────────────
// [S2 FIX] OverrideError now extends ServiceError (not Error)
// This ensures the error handler returns structured 422 responses,
// not generic 500s for known validation failures.

export class OverrideError extends ServiceError {
  constructor(
    code: string,
    message: string,
    field?: string
  ) {
    // All override validation errors are 422 (Unprocessable Entity)
    super(code, message, 422, field);
    this.name = "OverrideError";
  }
}

// ─── Override Service ────────────────────────────────────────────────────────

/**
 * Creates an override event with mandatory audit trail.
 *
 * HARD RULES enforced:
 * 1. reason MUST be ≥ 8 chars after trim → OverrideError
 * 2. guardId MUST be non-empty → OverrideError
 * 3. entryId MUST be non-empty → OverrideError
 * 4. Audit event MUST be emitted before returning
 *
 * @returns OverrideResult with auditEventEmitted=true (always)
 * @throws OverrideError if any hard rule is violated
 */
export async function createOverrideEvent(input: OverrideInput): Promise<OverrideResult> {
  const { entryId, guardId, reason, traceId } = input;

  // ── Hard Rule 1: Override MUST include reason ──────────────────────────
  // Source: contract §3.2 — "OVERRIDE_REASON_TOO_SHORT"
  // Source: DB CHECK — override_reason_length ≥ 8
  const trimmedReason = reason?.trim() || "";
  if (trimmedReason.length < 8) {
    // Emit REJECTION audit event — even failed overrides are logged
    await emitAuditEvent("override_rejected", guardId || "unknown", traceId, {
      reason: "REASON_TOO_SHORT",
      providedLength: trimmedReason.length,
      requiredLength: 8,
      entryId,
    });

    throw new OverrideError(
      "OVERRIDE_REASON_TOO_SHORT",
      `Override reason must be at least 8 characters (got ${trimmedReason.length})`,
      "reason"
    );
  }

  // ── Hard Rule 2: Override MUST include guard_id ────────────────────────
  // Source: DEFINITION §2 — "guard ID required for every action"
  if (!guardId || guardId.trim().length === 0) {
    await emitAuditEvent("override_rejected", "unknown", traceId, {
      reason: "GUARD_ID_MISSING",
      entryId,
    });

    throw new OverrideError(
      "GUARD_ID_MISSING",
      "Guard identity is required for override",
      "guardId"
    );
  }

  // ── Hard Rule 4: Override CANNOT exist without entry linkage ───────────
  // Source: DB FK — entry_id NOT NULL REFERENCES entry_records
  if (!entryId || entryId.trim().length === 0) {
    await emitAuditEvent("override_rejected", guardId, traceId, {
      reason: "ENTRY_LINKAGE_MISSING",
    });

    throw new OverrideError(
      "ENTRY_LINKAGE_MISSING",
      "Override must be linked to an existing entry",
      "entryId"
    );
  }

  // ── Build override event row ──────────────────────────────────────────
  const overrideId = randomUUID();
  const now = new Date();

  const result: OverrideResult = {
    id: overrideId,
    entryId,
    guardId,
    reason: trimmedReason,
    createdAt: now.toISOString(),
    traceId,
    auditEventEmitted: false, // Set to true after audit emit
  };

  // ── Hard Rule 3: Override MUST generate audit event ────────────────────
  // Source: contract §5 — override_flow_entered event
  // Source: DEFINITION — "Every override, approval, or bypass must be logged"
  await emitAuditEvent("override_authorized", guardId, traceId, {
    overrideId,
    entryId,
    reason: trimmedReason,
    reasonLength: trimmedReason.length,
  });

  // Mark that audit event was successfully emitted
  result.auditEventEmitted = true;

  return result;
}

/**
 * Returns the override event row data ready for DB insertion.
 * Separates the DB row shape from the service result.
 */
export function toOverrideRow(result: OverrideResult) {
  return {
    id: result.id,
    entryId: result.entryId,
    guardId: result.guardId,
    reason: result.reason,
    createdAt: new Date(result.createdAt),
    traceId: result.traceId,
  };
}
