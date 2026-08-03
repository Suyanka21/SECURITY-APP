/**
 * GatePass — One-Time PIN Redemption Route (Feature 11 / Stage 4)
 *
 * Source: src/docs/specs/one-time-pin-backup.md §6 — POST /api/entries/pin/validate
 * Source: TRUSTLESS-AUDIT-REPORT [C3] — guardId from auth token, not body.
 *
 * Mirrors routes/qr.ts: validate the boundary, inject the guard id from the
 * verified JWT, delegate to validatePinRedemption. Errors thrown by the
 * service (ServiceError) are handled by the global error handler.
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { validatePinRequest } from "../validation/pin-schemas";
import { validatePinRedemption } from "../services/pin-service";
import type { AuthenticatedRequest } from "../middleware/auth";

/**
 * POST /api/entries/pin/validate handler.
 *
 * Redeems a pass by pass reference + 6-digit PIN. guardId comes from the
 * verified JWT (auth middleware), never the request body. Exported for
 * direct unit testing (the project has no supertest dependency).
 */
export async function handlePinValidate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const validation = validatePinRequest(req.body);

    if (!validation.success) {
      const traceId = `trace-${randomUUID()}`;
      res.status(validation.code === "PIN_MALFORMED" ? 400 : 422).json({
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
    const { response, statusCode } = await validatePinRedemption(
      { ...validation.data, guardId },
      db
    );

    res.status(statusCode).json(response);
  } catch (err) {
    next(err);
  }
}

export const pinRouter = Router();
pinRouter.post("/", handlePinValidate);
