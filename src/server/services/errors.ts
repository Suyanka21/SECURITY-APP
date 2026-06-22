/**
 * GatePass — Shared Error Types
 *
 * Source: gatepass-api-contract.md §2 — "Shared Error Shape (every endpoint, no exceptions)"
 *
 * [S2 FIX] Extracted from entry-service.ts to break circular dependency:
 * entry-service → override-service → entry-service (for ServiceError)
 *
 * All known service errors extend ServiceError so the error handler
 * returns structured responses, never generic 500s.
 */

export class ServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
    public readonly field?: string,
    public readonly traceId?: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}
