/**
 * GatePass — QR Validation Schemas
 *
 * Source: gatepass-api-contract.md §3.1 — POST /api/entries/qr/validate
 * Every field traces to the contract.
 */

import { z } from "zod";

import type { WatchlistMatchView } from "./watchlist-schemas";

// ─── Error Codes ─────────────────────────────────────────────────────────────
// Source: contract §3.1 Error Responses table

export const QrErrorCodes = {
  QR_MALFORMED: "QR_MALFORMED",
  QR_NOT_FOUND: "QR_NOT_FOUND",
  QR_REPLAYED: "QR_REPLAYED",
  QR_EXPIRED: "QR_EXPIRED",
  // Feature 11 (Stage 4): the shared pass was locked by the PIN limiter.
  // "Lock the pass" disables BOTH redemption methods, so QR honours it too.
  QR_LOCKED: "QR_LOCKED",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  GUARD_ID_MISSING: "GUARD_ID_MISSING",
  GUARD_SESSION_EXPIRED: "GUARD_SESSION_EXPIRED",
} as const;

// ─── Request Schema ──────────────────────────────────────────────────────────
// Source: contract §3.1 QrValidateRequest

export const QrValidateSchema = z.object({
  // Source: contract §3.1 — "Non-empty string, max 512 chars"
  qrToken: z
    .string({ required_error: "QR token is required" })
    .min(1, "QR token cannot be empty")
    .max(512, "QR token exceeds maximum length"),

  // [C3 FIX] guardId REMOVED from request body.
  // Guard identity now comes from verified JWT token (auth middleware).

  // Source: contract §3.1 — "Valid ISO 8601, not more than 5 minutes in the future"
  scannedAt: z
    .string({ required_error: "Scan timestamp is required" })
    .datetime("scannedAt must be a valid ISO 8601 timestamp"),
});

export type QrValidateInput = z.infer<typeof QrValidateSchema>;

// ─── Response Types ──────────────────────────────────────────────────────────
// Source: contract §3.1 QrValidateResponse

export interface QrValidateResponse {
  outcome: "valid";
  visitor: {
    name: string;
    host: string;
    unit: string;
    plate: string | null;
    preApprovalId: string;
  };
  expiresAt: string;
  /**
   * Feature 12 (Stage 5) — present ONLY when the visitor matched an active
   * watchlist entry. Additive and non-authoritative: `outcome` stays "valid"
   * and the pass was still redeemed.
   * Source: src/docs/specs/watchlist.md §3 — warn, never auto-deny.
   */
  watchlistMatch?: WatchlistMatchView;
  traceId: string;
}

// ─── Validation Helper ───────────────────────────────────────────────────────

export function validateQrRequest(
  body: unknown
): { success: true; data: QrValidateInput } | { success: false; code: string; message: string; field?: string } {
  const result = QrValidateSchema.safeParse(body);

  if (result.success) {
    // Additional check: scannedAt not more than 5 minutes in the future
    // Source: contract §3.1 — "not more than 5 minutes in the future"
    const scannedTime = new Date(result.data.scannedAt).getTime();
    const fiveMinutesFromNow = Date.now() + 5 * 60 * 1000;

    if (scannedTime > fiveMinutesFromNow) {
      return {
        success: false,
        code: QrErrorCodes.VALIDATION_ERROR,
        message: "scannedAt cannot be more than 5 minutes in the future",
        field: "scannedAt",
      };
    }

    return { success: true, data: result.data };
  }

  const firstError = result.error.issues[0];
  const field = firstError.path[0]?.toString();

  // Map fields to contract error codes
  // [C3 FIX] guardId no longer in schema — handled by auth middleware
  const code = field === "qrToken"
    ? QrErrorCodes.QR_MALFORMED
    : QrErrorCodes.VALIDATION_ERROR;

  return {
    success: false,
    code,
    message: firstError.message,
    field,
  };
}
