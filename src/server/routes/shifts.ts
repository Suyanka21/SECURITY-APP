/**
 * GatePass — Shift Log Route Handlers
 *
 * Source: src/docs/specs/shift-log-aggregation.md §4 (API surface), §9 (security).
 * Source: API-and-Interface-Design — single error shape, validate at the
 *         boundary, additive responses.
 * Source: Security-and-Hardening — admin / senior-guard role required at
 *         the middleware layer (requireRole); never trusted at the body
 *         layer.
 *
 * One handler:
 *   GET /api/admin/shifts   requireAuth + requireRole('admin', 'senior-guard')
 */

import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

import {
  ListShiftsQuerySchema,
  ShiftLogErrorCodes,
  type ListShiftsResponse,
} from "../validation/shift-log-schemas";
import { listShifts } from "../services/shift-log-service";

// ─── Validation error helper ────────────────────────────────────────────────

function send422(
  res: Response,
  message: string,
  field: string | undefined,
  traceId: string
) {
  res.status(422).json({
    error: {
      code: ShiftLogErrorCodes.SHIFT_WINDOW_INVALID,
      message,
      field,
      traceId,
    },
  });
}

// ─── Default window helpers ─────────────────────────────────────────────────
// Source: spec §3 — "Default window: start of today (UTC) through now".

function startOfTodayUtc(now: Date = new Date()): string {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0)
  );
  return d.toISOString();
}

function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

// ─── GET /api/admin/shifts ──────────────────────────────────────────────────

export async function handleListShifts(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const traceId = `trace-${randomUUID()}`;

    const parsed = ListShiftsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path?.[0]?.toString();
      send422(
        res,
        issue?.message ?? "Invalid shift query",
        field,
        traceId
      );
      return;
    }

    // Default the window server-side so the client can omit it.
    // The service does additional boundary validation (from < to,
    // ≤ 31 days) and throws typed errors mapped to 422 by the
    // shared errorHandler.
    const fromIso = parsed.data.fromIso ?? startOfTodayUtc();
    const toIso = parsed.data.toIso ?? nowIso();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (req as any).db;

    const result = await listShifts(
      { fromIso, toIso, guardId: parsed.data.guardId },
      db
    );

    const body: ListShiftsResponse = {
      window: result.window,
      shifts: result.shifts,
      traceId,
    };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}
