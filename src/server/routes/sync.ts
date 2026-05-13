/**
 * GatePass — Sync Routes
 *
 * Source: gatepass-api-contract.md §3.3 — POST /api/entries/sync
 * Source: TRUSTLESS-AUDIT-REPORT [C3] — guardId from auth token, not body
 */

import { Router } from "express";
import { validateSyncBatch } from "../validation/sync-schemas";
import { syncEntries } from "../services/sync-service";
import { randomUUID } from "crypto";
import type { AuthenticatedRequest } from "../middleware/auth";

export const syncRouter = Router();

/**
 * POST /api/entries/sync
 *
 * Processes a batch of offline-created entries.
 * guardId injected from verified JWT token (auth middleware).
 */
syncRouter.post("/", async (req, res, next) => {
  try {
    const validation = validateSyncBatch(req.body);

    if (!validation.success) {
      const traceId = `trace-${randomUUID()}`;
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

    // [C3 FIX] guardId comes from verified JWT token, NOT request body
    const guardId = (req as AuthenticatedRequest).guardId;

    const db = (req as any).db;
    const { response, statusCode } = await syncEntries(
      { ...validation.data, guardId },
      db
    );

    res.status(statusCode).json(response);
  } catch (err) {
    next(err);
  }
});
