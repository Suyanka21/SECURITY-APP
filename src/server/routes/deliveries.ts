/**
 * GatePass — Delivery Management Route Handlers
 *
 * Source: src/docs/specs/delivery-management.md §4
 *
 * Two handlers:
 *   POST /api/entries/deliveries   requireAuth (any guard) — create delivery entry
 *   GET  /api/entries/deliveries   requireAuth + requireRole('admin','senior-guard') — list
 */

import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

import {
  validateDeliveryEntry,
  DeliveryValidationErrorCodes,
} from "../validation/delivery-schemas";
import {
  createDeliveryEntry,
  listDeliveries,
} from "../services/delivery-service";
import { ServiceError } from "../services/errors";
import type { AuthenticatedRequest } from "../middleware/auth";

// ─── POST /api/entries/deliveries ───────────────────────────────────────────

export async function handleCreateDeliveryEntry(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const traceId = `trace-${randomUUID()}`;

    const validation = validateDeliveryEntry(req.body);

    if (!validation.success) {
      res.status(422).json({
        error: {
          code: validation.code,
          message: validation.message,
          ...(validation.field && { field: validation.field }),
          traceId,
        },
      });
      return;
    }

    const guardId = (req as AuthenticatedRequest).guardId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (req as any).db;

    const { response, statusCode } = await createDeliveryEntry(
      { ...validation.data, guardId },
      db,
    );

    res.status(statusCode).json(response);
  } catch (err) {
    if (err instanceof ServiceError) {
      res.status(err.statusCode).json({
        error: {
          code: err.code,
          message: err.message,
          ...(err.field && { field: err.field }),
          traceId: err.traceId ?? `trace-${randomUUID()}`,
        },
      });
      return;
    }
    next(err);
  }
}

// ─── GET /api/entries/deliveries ────────────────────────────────────────────

export async function handleListDeliveries(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (req as any).db;

    const result = await listDeliveries(db);

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
