/**
 * GatePass — Exit Tracking Service
 *
 * Source: src/docs/specs/exit-tracking.md §§5–7
 * Source: Trustless-System-Auditor — every exit attempt (success or fail)
 *         writes exactly one audit row. No silent success, no silent failure.
 * Source: Security-and-Hardening — guard attribution on every exit.
 *
 * Responsibilities:
 *   1. recordExit(entryId, guardId, db) — create an exit record for an
 *      open entry. Default-deny on missing entry and already-exited.
 *   2. listOnPremise(db) — return all entries with no matching exit.
 */

import { eq, and, sql } from "drizzle-orm";
import { randomUUID } from "crypto";

import { entryRecords, exitRecords, guards } from "@/db/schema";
import { emitAuditEvent } from "./audit-logger";
import { ServiceError } from "./errors";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DrizzleDB {
  select: (...args: unknown[]) => unknown;
  insert: (...args: unknown[]) => unknown;
  query: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ExitRecordRow {
  id: string;
  entryId: string;
  guardId: string;
  traceId: string;
  createdAt: string;
}

export interface OnPremiseEntryRow {
  id: string;
  visitorName: string;
  host: string;
  unit: string;
  plate: string | null;
  method: string;
  guardId: string;
  createdAt: string;
}

// ─── Error Codes ─────────────────────────────────────────────────────────────

export const ExitErrorCodes = {
  EXIT_NO_OPEN_ENTRY: "EXIT_NO_OPEN_ENTRY",
  EXIT_ALREADY_RECORDED: "EXIT_ALREADY_RECORDED",
} as const;

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * Records a visitor exit against an existing open entry.
 *
 * Default-deny contract:
 * - Entry must exist → 404 EXIT_NO_OPEN_ENTRY
 * - Entry must not already have an exit → 409 EXIT_ALREADY_RECORDED
 * - On success → INSERT exit_records + audit event exit_recorded
 * - On failure → audit event exit_blocked with the error code
 */
export async function recordExit(
  entryId: string,
  guardId: string,
  db: DrizzleDB,
): Promise<{ exit: ExitRecordRow; traceId: string }> {
  const traceId = `trace-${randomUUID()}`;

  // Step 1: Verify the entry exists and is a visitor entry.
  // Exit tracking is visitor-only; delivery entries have their own lifecycle.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entryRows = await (db as any)
    .select({ id: entryRecords.id })
    .from(entryRecords)
    .where(and(eq(entryRecords.id, entryId), eq(entryRecords.entryKind, "visitor")))
    .limit(1);

  if (!entryRows || entryRows.length === 0) {
    await emitAuditEvent("exit_blocked", guardId, traceId, {
      entryId,
      code: ExitErrorCodes.EXIT_NO_OPEN_ENTRY,
    });
    throw new ServiceError(
      ExitErrorCodes.EXIT_NO_OPEN_ENTRY,
      "No entry found for the provided ID",
      404,
      "entryId",
    );
  }

  // Step 2: Verify no exit already exists for this entry.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existingExit = await (db as any)
    .select({ id: exitRecords.id })
    .from(exitRecords)
    .where(eq(exitRecords.entryId, entryId))
    .limit(1);

  if (existingExit && existingExit.length > 0) {
    await emitAuditEvent("exit_blocked", guardId, traceId, {
      entryId,
      code: ExitErrorCodes.EXIT_ALREADY_RECORDED,
    });
    throw new ServiceError(
      ExitErrorCodes.EXIT_ALREADY_RECORDED,
      "An exit has already been recorded for this entry",
      409,
      "entryId",
    );
  }

  // Step 3: Insert the exit record.
  // Race-safe: if a concurrent request wins the INSERT (UNIQUE violation),
  // catch the error, re-verify, and emit exit_blocked instead of a 500.
  const exitId = randomUUID();
  const now = new Date();

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any).insert(exitRecords).values({
      id: exitId,
      entryId,
      guardId,
      traceId,
      createdAt: now,
    });
  } catch (insertErr: unknown) {
    const msg = insertErr instanceof Error ? insertErr.message : String(insertErr);
    if (msg.includes("unique") || msg.includes("duplicate") || msg.includes("UNIQUE")) {
      await emitAuditEvent("exit_blocked", guardId, traceId, {
        entryId,
        code: ExitErrorCodes.EXIT_ALREADY_RECORDED,
      });
      throw new ServiceError(
        ExitErrorCodes.EXIT_ALREADY_RECORDED,
        "An exit has already been recorded for this entry",
        409,
        "entryId",
      );
    }
    throw insertErr;
  }

  // Step 4: Emit audit event.
  await emitAuditEvent("exit_recorded", guardId, traceId, {
    entryId,
    exitId,
  });

  return {
    exit: {
      id: exitId,
      entryId,
      guardId,
      traceId,
      createdAt: now.toISOString(),
    },
    traceId,
  };
}

/**
 * Returns all entries that have no matching exit record.
 *
 * Uses a LEFT JOIN exclusion pattern:
 *   SELECT entry_records.*
 *   FROM entry_records
 *   LEFT JOIN exit_records ON entry_records.id = exit_records.entry_id
 *   WHERE exit_records.id IS NULL
 *   ORDER BY entry_records.created_at DESC
 */
export async function listOnPremise(
  db: DrizzleDB,
): Promise<{ entries: OnPremiseEntryRow[]; count: number; traceId: string }> {
  const traceId = `trace-${randomUUID()}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await (db as any).execute(
    sql`SELECT
          e.id,
          e.visitor_name AS "visitorName",
          e.host,
          e.unit,
          e.plate,
          e.method,
          e.guard_id AS "guardId",
          e.created_at AS "createdAt"
        FROM entry_records e
        LEFT JOIN exit_records x ON e.id = x.entry_id
        WHERE x.id IS NULL AND e.entry_kind = 'visitor'
        ORDER BY e.created_at DESC`
  );

  const rawRows: unknown[] =
    Array.isArray(rows) ? rows : Array.isArray((rows as Record<string, unknown>)?.rows) ? (rows as Record<string, unknown>).rows as unknown[] : [];

  const entries: OnPremiseEntryRow[] = rawRows.map(
    (r: unknown) => {
      const row = r as Record<string, unknown>;
      return {
        id: row.id as string,
        visitorName: row.visitorName as string,
        host: row.host as string,
        unit: row.unit as string,
        plate: (row.plate as string | null) ?? null,
        method: row.method as string,
        guardId: row.guardId as string,
        createdAt:
          row.createdAt instanceof Date
            ? row.createdAt.toISOString()
            : String(row.createdAt),
      };
    },
  );

  return { entries, count: entries.length, traceId };
}
