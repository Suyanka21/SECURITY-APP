/**
 * GatePass — Entry Routes
 *
 * Source: gatepass-api-contract.md §3.2 — POST /api/entries
 * Source: TRUSTLESS-AUDIT-REPORT [C3] — guardId from auth token, not body
 */

import { Router } from "express";
import { validateCreateEntry } from "../validation/entry-schemas";
import { createEntry, ServiceError } from "../services/entry-service";
import { randomUUID } from "crypto";
import type { AuthenticatedRequest } from "../middleware/auth";

export const entriesRouter = Router();

/**
 * POST /api/entries
 *
 * Creates an audited entry record.
 * guardId injected from verified JWT token (auth middleware).
 */
entriesRouter.post("/", async (req, res, next) => {
  try {
    const validation = validateCreateEntry(req.body);

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
    const { response, statusCode } = await createEntry(
      { ...validation.data, guardId },
      db
    );

    res.status(statusCode).json(response);
  } catch (err) {
    next(err);
  }
});
