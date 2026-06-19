/**
 * GatePass — Exit Tracking Route Handlers
 *
 * Source: src/docs/specs/exit-tracking.md §6 (API surface), §7 (invariants).
 * Source: API-and-Interface-Design — single error shape, validate at boundary.
 * Source: Security-and-Hardening — guard auth via JWT (any role for POST,
 *         admin/senior-guard for GET on-premise list).
 *
 * Two handlers:
 *   POST /api/entries/:entryId/exit   requireAuth (any guard)
 *   GET  /api/entries/on-premise      requireAuth + requireRole('admin','senior-guard')
 */

import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

import {
  ExitEntryIdSchema,
  ExitTrackingErrorCodes,
  type RecordExitResponse,
  type ListOnPremiseResponse,
} from "../validation/exit-tracking-schemas";
import { recordExit, listOnPremise } from "../services/exit-tracking-service";
import type { AuthenticatedRequest } from "../middleware/auth";

// ─── POST /api/entries/:entryId/exit ────────────────────────────────────────

export async function handleRecordExit(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const traceId = `trace-${randomUUID()}`;

    const parsed = ExitEntryIdSchema.safeParse(req.params);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      res.status(422).json({
        error: {
          code: ExitTrackingErrorCodes.EXIT_ENTRY_ID_INVALID,
          message: issue?.message ?? "Invalid entryId",
          field: "entryId",
          traceId,
        },
      });
      return;
    }

    const guardId = (req as AuthenticatedRequest).guardId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (req as any).db;

    const result = await recordExit(parsed.data.entryId, guardId, db);

    const body: RecordExitResponse = {
      exit: {
        id: result.exit.id,
        entryId: result.exit.entryId,
        guardId: result.exit.guardId,
        createdAt: result.exit.createdAt,
        traceId: result.exit.traceId,
      },
      traceId: result.traceId,
    };
    res.status(201).json(body);
  } catch (err) {
    next(err);
  }
}

// ─── GET /api/entries/on-premise ────────────────────────────────────────────

export async function handleListOnPremise(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (req as any).db;

    const result = await listOnPremise(db);

    const body: ListOnPremiseResponse = {
      entries: result.entries,
      count: result.count,
      traceId: result.traceId,
    };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}
