/**
 * GatePass — Sync Service (Offline Sync Engine)
 *
 * Source: gatepass-api-contract.md §3.3 — POST /api/entries/sync
 * Source: GATEPASS DEFINITION §4 — "Offline Continuity"
 *
 * Algorithm:
 * 1. Verify guard exists and is active
 * 2. For each entry in the batch:
 *    a. Check offlineId for duplicate (idempotency key)
 *    b. If duplicate → status: "duplicate", return existing serverId
 *    c. If new → validate, insert entry_records, status: "synced"
 *    d. If invalid → status: "rejected", include error
 * 3. Create sync_events records for audit
 * 4. Return per-entry results
 *
 * HARD RULES:
 * - System MUST be idempotent (same offlineId → same result)
 * - No data loss (rejected entries report error, don't disappear)
 * - No duplicate entries (offlineId UNIQUE in DB)
 *
 * Conflict resolution:
 * - offlineId collision → "duplicate" (not error, not re-insert)
 * - Validation failure → "rejected" (other entries still process)
 * - Guard failure → entire batch rejected (403)
 */

import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { guards, entryRecords, syncEvents, overrideEvents } from "@/db/schema";
import { ServiceError } from "./entry-service";
import { createOverrideEvent, toOverrideRow } from "./override-service";
import { emitAuditEvent } from "./audit-logger";
import { SyncErrorCodes } from "../validation/sync-schemas";
import type {
  SyncBatchInput,
  SyncEntryInput,
  SyncBatchResponse,
  SyncEntryResult,
} from "../validation/sync-schemas";
import type { DrizzleDB } from "./entry-service";

/**
 * Processes a batch of offline-created entries.
 *
 * Source: contract §3.3
 * Returns per-entry results so frontend can handle partial failures.
 *
 * @returns 200 if all synced, 207 if partial success
 */
export async function syncEntries(
  input: SyncBatchInput,
  db: DrizzleDB
): Promise<{ response: SyncBatchResponse; statusCode: number }> {
  const traceId = `trace-${randomUUID()}`;

  // Step 1: Verify guard exists and is active
  // Source: contract §3.3 — "403 GUARD_SESSION_EXPIRED"
  const guard = await (db as any)
    .select({ id: guards.id, isActive: guards.isActive })
    .from(guards)
    .where(eq(guards.id, input.guardId))
    .limit(1);

  if (!guard || guard.length === 0 || !guard[0].isActive) {
    throw new ServiceError(
      SyncErrorCodes.GUARD_SESSION_EXPIRED,
      "Guard identity not found or session expired",
      403,
      "guardId"
    );
  }

  // Step 2: Process each entry independently
  // Source: contract §3.3 — "per-entry results"
  // HARD RULE: Partial failure must NOT block successful entries
  const results: SyncEntryResult[] = [];
  let syncedCount = 0;
  let duplicateCount = 0;
  let rejectedCount = 0;

  for (const entry of input.entries) {
    const entryResult = await processOneEntry(
      entry,
      input.guardId,
      traceId,
      db
    );

    results.push(entryResult);

    switch (entryResult.status) {
      case "synced":
        syncedCount++;
        break;
      case "duplicate":
        duplicateCount++;
        break;
      case "rejected":
        rejectedCount++;
        break;
    }
  }

  // Step 3: Emit batch sync audit event
  await emitAuditEvent("batch_sync_completed", input.guardId, traceId, {
    totalEntries: input.entries.length,
    syncedCount,
    duplicateCount,
    rejectedCount,
  });

  // Step 4: Determine HTTP status
  // Source: contract §3.3 — "207 (Multi-Status): Partial success"
  const statusCode =
    rejectedCount > 0 && syncedCount > 0
      ? 207 // Partial success
      : rejectedCount > 0 && syncedCount === 0
        ? 207 // All rejected but still return results
        : 200; // Full success (includes all-duplicate)

  const response: SyncBatchResponse = {
    results,
    syncedCount,
    duplicateCount,
    rejectedCount,
    traceId,
  };

  return { response, statusCode };
}

/**
 * Processes a single entry within a sync batch.
 *
 * Idempotency: If offlineId already exists → "duplicate" (not error).
 * This makes retries safe — network recovery re-sends produce same result.
 */
async function processOneEntry(
  entry: SyncEntryInput,
  guardId: string,
  traceId: string,
  db: DrizzleDB
): Promise<SyncEntryResult> {
  try {
    // Step 2a: Check for duplicate by offlineId
    // HARD RULE: "No duplicate entries allowed"
    // Source: DB UNIQUE constraint on offline_id
    const existing = await (db as any)
      .select({ id: entryRecords.id })
      .from(entryRecords)
      .where(eq(entryRecords.offlineId, entry.offlineId))
      .limit(1);

    if (existing && existing.length > 0) {
      // Idempotent: return existing server ID, don't re-insert
      return {
        offlineId: entry.offlineId,
        serverId: existing[0].id,
        status: "duplicate",
      };
    }

    // Step 2c: Insert new entry + override atomically
    // [M1 FIX] Wrapped in transaction per Incremental-Implementation + Security-and-Hardening:
    // - Entry insert and override_events insert use the SAME tx instance
    // - If either fails → rollback entire operation (no orphaned entries)
    // - sync_events insert occurs AFTER transaction commit (audit trail, not part of atomic unit)
    const entryId = randomUUID();
    const now = new Date();

    const entryRow = {
      id: entryId,
      visitorName: entry.visitorName,
      host: entry.host,
      unit: entry.unit,
      plate: entry.plate ?? null,
      reason: entry.reason || "",
      method: entry.method,
      guardId,
      status: "logged" as const,
      syncState: "synced" as const,
      offlineId: entry.offlineId,
      preApprovalId: null,
      deviceCreatedAt: new Date(entry.createdAt),
      createdAt: now,
      traceId,
    };

    // Atomic transaction: entry + override (if applicable)
    await (db as any).transaction(async (tx: any) => {
      // Insert entry record
      await tx.insert(entryRecords).values(entryRow);

      // If override, create override event via hardened service + insert in same tx
      if (entry.method === "override") {
        const overrideResult = await createOverrideEvent({
          entryId,
          guardId,
          reason: entry.reason,
          traceId,
        });
        await tx.insert(overrideEvents).values(toOverrideRow(overrideResult));
      }
    });

    // sync_events insert AFTER transaction commit — audit record, not part of atomic unit
    // Source: contract §3.3 — EVENT: entry_synced
    const syncEventRow = {
      id: randomUUID(),
      guardId,
      offlineId: entry.offlineId,
      entryId,
      status: "synced" as const,
      errorCode: null,
      errorMessage: null,
      originalCreatedAt: new Date(entry.createdAt),
      syncedAt: now,
      traceId,
    };

    await (db as any).insert(syncEvents).values(syncEventRow);

    // Emit per-entry audit event
    await emitAuditEvent("entry_created", guardId, traceId, {
      entryId,
      offlineId: entry.offlineId,
      method: entry.method,
      unit: entry.unit,
      status: "logged",
      syncSource: "offline",
    });

    return {
      offlineId: entry.offlineId,
      serverId: entryId,
      status: "synced",
    };
  } catch (err) {
    // Step 2d: Entry-level failure → "rejected", don't abort batch
    // HARD RULE: "No data loss" — rejected entries report error
    const errorMessage =
      err instanceof Error ? err.message : "Unknown error processing entry";
    const errorCode =
      err instanceof ServiceError ? err.code : "SYNC_ENTRY_FAILED";

    // Create sync_events record for rejected entry
    const syncEventRow = {
      id: randomUUID(),
      guardId,
      offlineId: entry.offlineId,
      entryId: null,
      status: "rejected" as const,
      errorCode,
      errorMessage,
      originalCreatedAt: new Date(entry.createdAt),
      syncedAt: new Date(),
      traceId,
    };

    try {
      await (db as any).insert(syncEvents).values(syncEventRow);
    } catch (syncErr) {
      // [H2 FIX] Log sync_events insert failure — no silent swallowing
      // Source: Debugging-and-Error-Recovery — "Preserve evidence, surface hidden failures"
      // Source: Code-Review-and-Quality — "No empty catch blocks"
      // We still return the rejected result (don't abort batch), but ops has visibility.
      console.error(
        `[SYNC] Failed to persist sync_events record | trace=${traceId} | offlineId=${entry.offlineId} | error=${syncErr instanceof Error ? syncErr.message : String(syncErr)}`
      );
    }

    return {
      offlineId: entry.offlineId,
      serverId: "",
      status: "rejected",
      error: {
        code: errorCode,
        message: errorMessage,
      },
    };
  }
}
