/**
 * GatePass — Guard Notes Service (Feature 9 / Stage 2)
 *
 * Source: src/docs/specs/guard-notes.md §§4–6
 * Source: Trustless-System-Auditor — every successful note writes exactly one
 *         audit row; a missing target default-denies (404), never a silent no-op.
 * Source: Security-and-Hardening — guard attribution on every note; input
 *         already validated at the route boundary; parameterised queries only.
 *
 * Responsibilities:
 *   1. addGuardNote(target, guardId, input, db) — attach a standardised note to
 *      an existing entry OR exit record.
 *   2. listNotesForEntry(entryId, db) — read notes for one entry.
 */

import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

import { entryRecords, exitRecords, guardNotes } from "@/db/schema";
import type {
  AddGuardNoteInput,
  GuardNoteTag,
  GuardNoteView,
} from "../validation/guard-note-schemas";
import { GuardNoteErrorCodes } from "../validation/guard-note-schemas";
import { emitAuditEvent } from "./audit-logger";
import { ServiceError } from "./errors";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DrizzleDB {
  select: (...args: unknown[]) => unknown;
  insert: (...args: unknown[]) => unknown;
  [key: string]: unknown;
}

export type GuardNoteTargetKind = "entry" | "exit";

interface GuardNoteRow {
  id: string;
  entryId: string | null;
  exitId: string | null;
  guardId: string;
  tag: GuardNoteTag;
  noteText: string | null;
  traceId: string;
  createdAt: string | Date;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function toView(row: GuardNoteRow): GuardNoteView {
  return {
    id: row.id,
    entryId: row.entryId,
    exitId: row.exitId,
    guardId: row.guardId,
    tag: row.tag,
    text: row.noteText,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    traceId: row.traceId,
  };
}

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * Attaches a standardised note to an existing entry or exit record.
 *
 * Default-deny contract:
 * - Target row must exist → else 404 GUARD_NOTE_TARGET_NOT_FOUND (no write).
 * - On success → INSERT guard_notes + audit event guard_note_added.
 *
 * `guardId` is the verified token identity (injected upstream), never the body.
 * Input has already been validated/normalised by AddGuardNoteSchema.
 */
export async function addGuardNote(
  target: { kind: GuardNoteTargetKind; id: string },
  guardId: string,
  input: AddGuardNoteInput,
  db: DrizzleDB,
): Promise<{ note: GuardNoteView; traceId: string }> {
  const traceId = `trace-${randomUUID()}`;

  // Step 1: Verify the target row exists.
  const targetTable = target.kind === "entry" ? entryRecords : exitRecords;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const targetRows = await (db as any)
    .select({ id: targetTable.id })
    .from(targetTable)
    .where(eq(targetTable.id, target.id))
    .limit(1);

  if (!targetRows || targetRows.length === 0) {
    throw new ServiceError(
      GuardNoteErrorCodes.GUARD_NOTE_TARGET_NOT_FOUND,
      target.kind === "entry"
        ? "No entry found for the provided ID"
        : "No exit found for the provided ID",
      404,
      target.kind === "entry" ? "entryId" : "exitId",
    );
  }

  // Step 2: Insert the note. Free text only persists for tag='other'.
  const noteText = input.tag === "other" ? (input.text ?? null) : null;
  const values = {
    entryId: target.kind === "entry" ? target.id : null,
    exitId: target.kind === "exit" ? target.id : null,
    guardId,
    tag: input.tag,
    noteText,
    traceId,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inserted = (await (db as any)
    .insert(guardNotes)
    .values(values)
    .returning()) as GuardNoteRow[];

  const row = inserted[0];
  if (!row) {
    // An INSERT ... RETURNING that yields no row is a broken invariant, not a
    // business outcome — surface it rather than silently succeeding.
    throw new ServiceError(
      "GUARD_NOTE_WRITE_FAILED",
      "Failed to persist guard note",
      500,
    );
  }

  // Step 3: Audit. Free text is deliberately excluded (may contain PII).
  await emitAuditEvent("guard_note_added", guardId, traceId, {
    noteId: row.id,
    tag: row.tag,
    ...(target.kind === "entry"
      ? { entryId: target.id }
      : { exitId: target.id }),
  });

  return { note: toView(row), traceId };
}

/** Lists all notes attached to a single entry, oldest first. */
export async function listNotesForEntry(
  entryId: string,
  db: DrizzleDB,
): Promise<{ notes: GuardNoteView[]; traceId: string }> {
  const traceId = `trace-${randomUUID()}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (await (db as any)
    .select()
    .from(guardNotes)
    .where(eq(guardNotes.entryId, entryId))) as GuardNoteRow[];

  const notes = rows.map(toView).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { notes, traceId };
}
