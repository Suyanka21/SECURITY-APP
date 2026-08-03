/**
 * GatePass — One-Time PIN Backup Validation Schemas (Feature 11 / Stage 4)
 *
 * Source: src/docs/specs/one-time-pin-backup.md §6.
 * Source: API-and-Interface-Design — "validate at the boundary".
 * Source: Security-and-Hardening — "validate all external input".
 *
 * Endpoint validated:
 *   POST /api/entries/pin/validate  (requireAuth + strictLimiter)
 *
 * The guard supplies a short, non-secret pass reference plus the 6-digit
 * PIN. Guard identity comes from the verified JWT, NEVER the body — the
 * request carries no guardId (mirrors the [C3] QR fix).
 */

import { z } from "zod";

// ─── Error codes ─────────────────────────────────────────────────────────────
// Closed set; additive only. The redemption path reuses the QR response
// shape, but its own error codes so a locked/invalid PIN is distinguishable
// from a QR failure in logs and on the client.

export const PinErrorCodes = {
  PIN_MALFORMED: "PIN_MALFORMED",
  PIN_NOT_FOUND: "PIN_NOT_FOUND",
  PIN_INVALID: "PIN_INVALID",
  PIN_REPLAYED: "PIN_REPLAYED",
  PIN_EXPIRED: "PIN_EXPIRED",
  PIN_LOCKED: "PIN_LOCKED",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  GUARD_SESSION_EXPIRED: "GUARD_SESSION_EXPIRED",
} as const;

export type PinErrorCode = (typeof PinErrorCodes)[keyof typeof PinErrorCodes];

// ─── Field shapes ────────────────────────────────────────────────────────────
// passRef: Crockford base32 alphabet (excludes I L O U to avoid ambiguity),
// upper-cased, fixed 8 chars. Non-secret — identifies exactly one pass.
const PASS_REF_REGEX = /^[0-9A-HJKMNP-TV-Z]{8}$/;

// PIN: exactly 6 decimal digits. Leading zeros are significant, so it is a
// string, never a number.
const PIN_REGEX = /^[0-9]{6}$/;

export const PinValidateSchema = z.object({
  passRef: z
    .string({ required_error: "Pass reference is required" })
    .trim()
    .transform((s) => s.toUpperCase())
    .refine((s) => PASS_REF_REGEX.test(s), "Pass reference is invalid"),

  pin: z
    .string({ required_error: "PIN is required" })
    .trim()
    .refine((s) => PIN_REGEX.test(s), "PIN must be exactly 6 digits"),

  // Source: contract §3.1 — mirrors the QR route so the client sends the
  // same envelope for both redemption methods.
  scannedAt: z
    .string({ required_error: "Scan timestamp is required" })
    .datetime("scannedAt must be a valid ISO 8601 timestamp"),
});

export type PinValidateInput = z.infer<typeof PinValidateSchema>;

// ─── Boundary helper ─────────────────────────────────────────────────────────

export function validatePinRequest(
  body: unknown
):
  | { success: true; data: PinValidateInput }
  | { success: false; code: string; message: string; field?: string } {
  const result = PinValidateSchema.safeParse(body);

  if (result.success) {
    const scannedTime = new Date(result.data.scannedAt).getTime();
    const fiveMinutesFromNow = Date.now() + 5 * 60 * 1000;
    if (scannedTime > fiveMinutesFromNow) {
      return {
        success: false,
        code: PinErrorCodes.VALIDATION_ERROR,
        message: "scannedAt cannot be more than 5 minutes in the future",
        field: "scannedAt",
      };
    }
    return { success: true, data: result.data };
  }

  const firstError = result.error.issues[0];
  const field = firstError.path[0]?.toString();

  // passRef / pin format problems map to PIN_MALFORMED (400); anything else
  // (e.g. bad scannedAt) is a generic 422 VALIDATION_ERROR.
  const code =
    field === "passRef" || field === "pin"
      ? PinErrorCodes.PIN_MALFORMED
      : PinErrorCodes.VALIDATION_ERROR;

  return { success: false, code, message: firstError.message, field };
}
