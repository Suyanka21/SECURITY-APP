/**
 * GatePass — Guard Notes Route Handlers (Feature 9 / Stage 2)
 *
 * Source: src/docs/specs/guard-notes.md §4 (API surface), §6 (security).
 * Source: API-and-Interface-Design — single error shape, validate at boundary.
 * Source: Security-and-Hardening — guardId from verified JWT, never the body.
 *
 * Three handlers:
 *   POST /api/entries/:entryId/notes   requireAuth (any guard)
 *   POST /api/exits/:exitId/notes      requireAuth (any guard)
 *   GET  /api/entries/:entryId/notes   requireAuth
 */

import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

import {
  AddGuardNoteSchema,
  EntryNoteParamsSchema,
  ExitNoteParamsSchema,
  GuardNoteErrorCodes,
  type AddGuardNoteResponse,
  type ListGuardNotesResponse,
} from "../validation/guard-note-schemas";
import { addGuardNote, listNotesForEntry } from "../services/guard-note-service";
import type { AuthenticatedRequest } from "../middleware/auth";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getDb(req: Request): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (req as any).db;
}

function invalidInput(
  res: Response,
  message: string,
  field: string | undefined,
): void {
  res.status(422).json({
    error: {
      code: GuardNoteErrorCodes.GUARD_NOTE_INVALID_INPUT,
      message,
      ...(field && { field }),
      traceId: `trace-${randomUUID()}`,
    },
  });
}

// ─── POST /api/entries/:entryId/notes ───────────────────────────────────────

export async function handleAddEntryNote(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const params = EntryNoteParamsSchema.safeParse(req.params);
    if (!params.success) {
      invalidInput(res, params.error.issues[0]?.message ?? "Invalid entryId", "entryId");
      return;
    }

    const body = AddGuardNoteSchema.safeParse(req.body);
    if (!body.success) {
      const issue = body.error.issues[0];
      invalidInput(res, issue?.message ?? "Invalid note", issue?.path?.[0]?.toString());
      return;
    }

    const guardId = (req as AuthenticatedRequest).guardId;
    const result = await addGuardNote(
      { kind: "entry", id: params.data.entryId },
      guardId,
      body.data,
      getDb(req),
    );

    const payload: AddGuardNoteResponse = {
      note: result.note,
      traceId: result.traceId,
    };
    res.status(201).json(payload);
  } catch (err) {
    next(err);
  }
}

// ─── POST /api/exits/:exitId/notes ──────────────────────────────────────────

export async function handleAddExitNote(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const params = ExitNoteParamsSchema.safeParse(req.params);
    if (!params.success) {
      invalidInput(res, params.error.issues[0]?.message ?? "Invalid exitId", "exitId");
      return;
    }

    const body = AddGuardNoteSchema.safeParse(req.body);
    if (!body.success) {
      const issue = body.error.issues[0];
      invalidInput(res, issue?.message ?? "Invalid note", issue?.path?.[0]?.toString());
      return;
    }

    const guardId = (req as AuthenticatedRequest).guardId;
    const result = await addGuardNote(
      { kind: "exit", id: params.data.exitId },
      guardId,
      body.data,
      getDb(req),
    );

    const payload: AddGuardNoteResponse = {
      note: result.note,
      traceId: result.traceId,
    };
    res.status(201).json(payload);
  } catch (err) {
    next(err);
  }
}

// ─── GET /api/entries/:entryId/notes ────────────────────────────────────────

export async function handleListEntryNotes(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const params = EntryNoteParamsSchema.safeParse(req.params);
    if (!params.success) {
      invalidInput(res, params.error.issues[0]?.message ?? "Invalid entryId", "entryId");
      return;
    }

    const result = await listNotesForEntry(params.data.entryId, getDb(req));

    const payload: ListGuardNotesResponse = {
      notes: result.notes,
      count: result.notes.length,
      traceId: result.traceId,
    };
    res.status(200).json(payload);
  } catch (err) {
    next(err);
  }
}
