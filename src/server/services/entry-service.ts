/**
 * GatePass — Entry Service (Business Logic)
 *
 * Source: gatepass-api-contract.md §3.2 — POST /api/entries
 * Isolated from HTTP concerns per API-and-Interface-Design skill.
 *
 * Responsibilities:
 * 1. Verify guard exists and is active
 * 2. Check offlineId uniqueness (dedup)
 * 3. Check preApprovalId validity (QR entries)
 * 4. Insert entry_records atomically
 * 5. Insert override_events if method = override
 * 6. Return structured CreateEntryResponse
 */

import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  entryRecords,
  guards,
  overrideEvents,
  authorizationDecisions,
} from "@/db/schema";
import type { CreateEntryInput, CreateEntryResponse } from "../validation/entry-schemas";
import { EntryErrorCodes } from "../validation/entry-schemas";
import { createOverrideEvent, toOverrideRow } from "./override-service";
import { emitAuditEvent } from "./audit-logger";

// ─── Error Types ─────────────────────────────────────────────────────────────
// [S2 FIX] ServiceError extracted to errors.ts to break circular dependency.
// Re-exported here for backward compatibility with existing consumers.
import { ServiceError } from "./errors";
export { ServiceError };

// ─── DB Type ─────────────────────────────────────────────────────────────────
// Accepts any Drizzle db instance — enables testing with mocks

export interface DrizzleDB {
  select: (...args: unknown[]) => unknown;
  insert: (...args: unknown[]) => unknown;
  query: Record<string, unknown>;
  // Allow any Drizzle db shape
  [key: string]: unknown;
}

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * Creates an entry record with full validation and audit trail.
 *
 * Source: contract §3.2 — POST /api/entries
 * Hard rules enforced:
 * - Must reject missing or invalid fields (done at validation layer)
 * - Must attach guard_id to every entry
 * - Must persist entry atomically
 * - Must return structured response (not raw DB object)
 * - No silent failure allowed
 */
export async function createEntry(
  input: CreateEntryInput,
  db: DrizzleDB
): Promise<{ response: CreateEntryResponse; statusCode: number }> {
  const traceId = generateTraceId();

  // Step 1: Verify guard exists and is active
  // Source: contract §3.2 — "guardId: Must resolve to an active guard"
  // Source: contract §3.2 — "403 GUARD_SESSION_EXPIRED"
  const guard = await (db as any)
    .select({ id: guards.id, isActive: guards.isActive })
    .from(guards)
    .where(eq(guards.id, input.guardId))
    .limit(1);

  if (!guard || guard.length === 0) {
    throw new ServiceError(
      EntryErrorCodes.GUARD_SESSION_EXPIRED,
      "Guard identity not found or session expired",
      403,
      "guardId"
    );
  }

  if (!guard[0].isActive) {
    throw new ServiceError(
      EntryErrorCodes.GUARD_SESSION_EXPIRED,
      "Guard session is no longer active",
      403,
      "guardId"
    );
  }

  // Step 2: Check offlineId uniqueness (dedup for offline sync)
  // Source: contract §3.2 — "409 DUPLICATE_ENTRY: offlineId already exists"
  if (input.offlineId) {
    const existing = await (db as any)
      .select({ id: entryRecords.id })
      .from(entryRecords)
      .where(eq(entryRecords.offlineId, input.offlineId))
      .limit(1);

    if (existing && existing.length > 0) {
      throw new ServiceError(
        EntryErrorCodes.DUPLICATE_ENTRY,
        "An entry with this offlineId already exists",
        409,
        "offlineId"
      );
    }
  }

  // Step 3: Validate preApprovalId for QR entries
  // Source: contract §3.2 — "404 PRE_APPROVAL_NOT_FOUND: method=qr but preApprovalId invalid"
  if (input.method === "qr" && input.preApprovalId) {
    const approval = await (db as any)
      .select({ id: authorizationDecisions.id })
      .from(authorizationDecisions)
      .where(eq(authorizationDecisions.id, input.preApprovalId))
      .limit(1);

    if (!approval || approval.length === 0) {
      throw new ServiceError(
        EntryErrorCodes.PRE_APPROVAL_NOT_FOUND,
        "Pre-approval record not found for the provided ID",
        404,
        "preApprovalId"
      );
    }
  }

  // Step 4: Insert entry_records atomically
  // Source: contract §3.2 — "Server-generated canonical ID"
  // HARD RULE: "Timestamps must be server-generated"
  const entryId = randomUUID();
  const now = new Date();

  const entryRow = {
    id: entryId,
    visitorName: input.visitorName,
    host: input.host,
    unit: input.unit,
    plate: input.plate ?? null,
    reason: input.reason || "",
    method: input.method,
    guardId: input.guardId,
    status: "logged" as const,
    syncState: "synced" as const,
    offlineId: input.offlineId ?? null,
    preApprovalId: input.preApprovalId ?? null,
    deviceCreatedAt: new Date(input.createdAt),
    createdAt: now,
    traceId,
  };

  // [H1 FIX] Wrap entry + override in a single transaction.
  // Source: TRUSTLESS-AUDIT-REPORT [H1] — "Entry + override not transactional"
  // HARD RULE: If ANY insert fails, the ENTIRE operation rolls back.
  // No partial writes allowed — an override entry CANNOT exist without its override_events record.
  await (db as any).transaction(async (tx: any) => {
    // Insert entry record
    await tx.insert(entryRecords).values(entryRow);

    // If override method, create override event within the SAME transaction
    // Source: DEFINITION §2D — "Manual Override: Entry logged with metadata"
    if (input.method === "override") {
      const overrideResult = await createOverrideEvent({
        entryId,
        guardId: input.guardId,
        reason: input.reason,
        traceId,
      });

      await tx.insert(overrideEvents).values(toOverrideRow(overrideResult));
    }
  });

  // [C4/S1 FIX] Await audit persistence — no silent drops
  await emitAuditEvent("entry_created", input.guardId, traceId, {
    entryId,
    method: input.method,
    unit: input.unit,
    status: "logged",
  });

  // Step 6: Return structured response (NOT raw DB object)
  // Source: contract §3.2 — CreateEntryResponse
  const response: CreateEntryResponse = {
    entry: {
      id: entryId,
      visitorName: input.visitorName,
      host: input.host,
      unit: input.unit,
      plate: input.plate ?? null,
      reason: input.reason || "",
      method: input.method,
      guardId: input.guardId,
      createdAt: now.toISOString(),
      status: "logged",
      syncState: "synced",
    },
    traceId,
  };

  return { response, statusCode: 201 };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Generates a unique trace ID for audit correlation.
 * Source: contract §2 — "traceId: Server-generated, for audit correlation"
 */
function generateTraceId(): string {
  return `trace-${randomUUID()}`;
}
