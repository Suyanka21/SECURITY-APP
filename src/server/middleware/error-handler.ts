/**
 * GatePass — Error Handler Middleware
 *
 * Source: gatepass-api-contract.md §2 — "Shared Error Shape (every endpoint, no exceptions)"
 * Source: Security-and-Hardening skill — "Never expose stack traces or internal error details to users"
 *
 * Every error response follows the APIError shape:
 * { error: { code, message, field?, traceId } }
 */

import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { ServiceError } from "../services/entry-service";

/**
 * Express error handling middleware.
 * Catches all errors and returns the contract-defined APIError shape.
 *
 * Source: contract §2 — consistent error format
 */
export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const traceId = `trace-${randomUUID()}`;

  // Known service errors — map directly to HTTP response
  if (err instanceof ServiceError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.field && { field: err.field }),
        traceId,
      },
    });
    return;
  }

  // Unknown errors — 500 with generic message
  // Security: never expose internal error details
  // Source: Security-and-Hardening skill — "Never expose stack traces"
  console.error(`[${traceId}] Unhandled error:`, err);

  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
      traceId,
    },
  });
}
