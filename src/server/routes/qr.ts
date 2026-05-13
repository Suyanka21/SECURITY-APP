/**
 * GatePass — QR Validation Route
 *
 * Source: gatepass-api-contract.md §3.1 — POST /api/entries/qr/validate
 * Source: TRUSTLESS-AUDIT-REPORT [C3] — guardId from auth token, not body
 */

import { Router } from "express";
import { validateQrRequest } from "../validation/qr-schemas";
import { validateQrToken } from "../services/qr-service";
import { randomUUID } from "crypto";
import type { AuthenticatedRequest } from "../middleware/auth";

export const qrRouter = Router();

/**
 * POST /api/entries/qr/validate
 *
 * Validates a QR token and returns pre-approved visitor data.
 * guardId injected from verified JWT token (auth middleware).
 */
qrRouter.post("/", async (req, res, next) => {
  try {
    const validation = validateQrRequest(req.body);

    if (!validation.success) {
      const traceId = `trace-${randomUUID()}`;
      res.status(validation.code === "QR_MALFORMED" ? 400 : 422).json({
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
    const { response, statusCode } = await validateQrToken(
      { ...validation.data, guardId },
      db
    );

    res.status(statusCode).json(response);
  } catch (err) {
    next(err);
  }
});
