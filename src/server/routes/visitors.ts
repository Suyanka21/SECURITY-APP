/**
 * GatePass — Visitor Routes
 *
 * Source: gatepass-api-contract.md §3.4 — GET /api/visitors/recognized
 * Source: TRUSTLESS-AUDIT-REPORT [C3] — guardId from auth token, not query
 */

import { Router } from "express";
import { validateVisitorParams } from "../validation/visitor-schemas";
import { getRecognizedVisitors } from "../services/visitor-service";
import { randomUUID } from "crypto";
import type { AuthenticatedRequest } from "../middleware/auth";

export const visitorsRouter = Router();

/**
 * GET /api/visitors/recognized
 *
 * Returns recognized visitors with recognition tags and pagination.
 * guardId injected from verified JWT token (auth middleware).
 */
visitorsRouter.get("/recognized", async (req, res, next) => {
  try {
    const validation = validateVisitorParams(req.query);

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

    // [C3 FIX] guardId comes from verified JWT token, NOT query params
    const guardId = (req as AuthenticatedRequest).guardId;

    const db = (req as any).db;
    const { response, statusCode } = await getRecognizedVisitors(
      { ...validation.data, guardId },
      db
    );

    res.status(statusCode).json(response);
  } catch (err) {
    next(err);
  }
});
