/**
 * GatePass — Entry Creation Validation Schemas
 *
 * Source: gatepass-api-contract.md §3.2 — POST /api/entries
 * Every field, constraint, and error code traces to the contract.
 *
 * Zod validation at system boundary per:
 * - API-and-Interface-Design skill §3: "Validate at Boundaries"
 * - Security-and-Hardening skill: "Validate all external input at the system boundary"
 */

import { z } from "zod";

import type { WatchlistMatchView } from "./watchlist-schemas";

// ─── Timestamp Validation Constants ──────────────────────────────────────────
// Source: contract §3.2 — "Valid ISO 8601, max 24 hours old"
// Source: TRUSTLESS-AUDIT-REPORT [H4] — "createdAt lacks 24-hour backdating protection"
// Source: Security-and-Hardening — "Prevent historical injection"

const MAX_AGE_MS = 24 * 60 * 60 * 1000;      // 24 hours
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;   // 5 minutes (clock skew tolerance)

// ─── Enums ───────────────────────────────────────────────────────────────────
// Source: contract §2, types.ts L3

const ENTRY_METHODS = ["qr", "walk-in", "override", "recognized"] as const;

// ─── Error Codes ─────────────────────────────────────────────────────────────
// Source: contract §3.2 Error Responses table

export const EntryErrorCodes = {
  VISITOR_NAME_REQUIRED: "VISITOR_NAME_REQUIRED",
  HOST_REQUIRED: "HOST_REQUIRED",
  UNIT_REQUIRED: "UNIT_REQUIRED",
  OVERRIDE_REASON_TOO_SHORT: "OVERRIDE_REASON_TOO_SHORT",
  GUARD_ID_MISSING: "GUARD_ID_MISSING",
  DUPLICATE_ENTRY: "DUPLICATE_ENTRY",
  PRE_APPROVAL_NOT_FOUND: "PRE_APPROVAL_NOT_FOUND",
  PRE_APPROVAL_REQUIRED: "PRE_APPROVAL_REQUIRED",
  GUARD_SESSION_EXPIRED: "GUARD_SESSION_EXPIRED",
  TIMESTAMP_TOO_OLD: "TIMESTAMP_TOO_OLD",
  TIMESTAMP_IN_FUTURE: "TIMESTAMP_IN_FUTURE",
  VALIDATION_ERROR: "VALIDATION_ERROR",
} as const;

// ─── Request Schema ──────────────────────────────────────────────────────────
// Source: contract §3.2 CreateEntryRequest

export const CreateEntrySchema = z
  .object({
    // Source: contract §3.2 — "Non-empty after trim"
    visitorName: z
      .string({ required_error: "Visitor name is required" })
      .trim()
      .min(1, "Visitor name is required before entry can be logged"),

    // Source: contract §3.2 — "Non-empty after trim"
    host: z
      .string({ required_error: "Host is required" })
      .trim()
      .min(1, "Resident or host is required for accountability"),

    // Source: contract §3.2 — "Non-empty after trim"
    unit: z
      .string({ required_error: "Unit is required" })
      .trim()
      .min(1, "Unit is required to prevent orphan entries"),

    // Source: contract §3.2 — "Optional, max 20 chars if provided"
    plate: z.string().max(20, "Plate must be 20 characters or fewer").nullable().optional().default(null),

    // Source: contract §3.2 — reason field (validated conditionally for override)
    reason: z.string().default(""),

    // Source: contract §3.2 — "Must be one of: qr, walk-in, override, recognized"
    method: z.enum(ENTRY_METHODS, {
      errorMap: () => ({ message: `Method must be one of: ${ENTRY_METHODS.join(", ")}` }),
    }),

    // [C3 FIX] guardId REMOVED from request body.
    // Guard identity now comes from verified JWT token (auth middleware).
    // This prevents guard impersonation via direct guardId injection.

    // Source: contract §3.2 — "Valid ISO 8601, max 24 hours old"
    // [H4 FIX] Validates format AND age boundaries
    createdAt: z
      .string({ required_error: "Device timestamp is required" })
      .datetime("createdAt must be a valid ISO 8601 timestamp")
      .superRefine((val, ctx) => {
        const ts = new Date(val).getTime();
        const now = Date.now();

        // [H4 FIX] Reject timestamps older than 24 hours
        // Source: TRUSTLESS-AUDIT-REPORT [H4] — "Prevent historical injection"
        if (now - ts > MAX_AGE_MS) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Device timestamp is older than 24 hours — entry rejected",
          });
        }

        // [H4 FIX] Reject timestamps in the future (beyond 5-min clock skew tolerance)
        // Source: Security-and-Hardening — "Prevent future-dated injection"
        if (ts - now > FUTURE_TOLERANCE_MS) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Device timestamp is in the future — entry rejected",
          });
        }
      }),

    // Source: contract §3.2 — "Required when method = qr"
    preApprovalId: z.string().uuid("preApprovalId must be a valid UUID").optional(),

    // Source: contract §3.2 — "Optional, UUID format, used for dedup"
    offlineId: z.string().uuid("offlineId must be a valid UUID").optional(),
  })
  .superRefine((data, ctx) => {
    // Cross-field validation: override method requires meaningful reason
    // Source: contract §3.2 — "method=override AND reason < 8 chars" → OVERRIDE_REASON_TOO_SHORT
    if (data.method === "override" && data.reason.trim().length < 8) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Manual override requires a meaningful reason (minimum 8 characters)",
        path: ["reason"],
      });
    }

    // Cross-field validation: QR method requires preApprovalId
    // Source: contract §3.2 — "Required when method = qr"
    if (data.method === "qr" && !data.preApprovalId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Pre-approval ID is required for QR entries",
        path: ["preApprovalId"],
      });
    }
  });

// ─── Inferred Types ──────────────────────────────────────────────────────────

export type CreateEntryInput = z.infer<typeof CreateEntrySchema>;

// ─── Response Types ──────────────────────────────────────────────────────────
// Source: contract §3.2 CreateEntryResponse

export interface CreateEntryResponse {
  entry: {
    id: string;
    visitorName: string;
    host: string;
    unit: string;
    plate: string | null;
    reason: string;
    method: typeof ENTRY_METHODS[number];
    guardId: string;
    createdAt: string;
    status: "logged";
    syncState: "synced";
  };
  /**
   * Feature 12 (Stage 5) — present ONLY when the visitor matched an active
   * watchlist entry. Purely additive: the entry above was still created.
   * Source: src/docs/specs/watchlist.md §3 — warn, never auto-deny.
   */
  watchlistMatch?: WatchlistMatchView;
  traceId: string;
}

// ─── API Error Shape ─────────────────────────────────────────────────────────
// Source: contract §2 — "Shared Error Shape (every endpoint, no exceptions)"

export interface APIError {
  error: {
    code: string;
    message: string;
    field?: string;
    traceId: string;
  };
}

// ─── Validation Helper ───────────────────────────────────────────────────────

/**
 * Validates a raw request body and returns either the parsed input or
 * a structured error with the first validation failure.
 *
 * Returns the FIRST error only — per contract, each error response
 * has a single code/message/field triple.
 */
export function validateCreateEntry(
  body: unknown
): { success: true; data: CreateEntryInput } | { success: false; code: string; message: string; field?: string } {
  const result = CreateEntrySchema.safeParse(body);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const firstError = result.error.issues[0];
  const field = firstError.path[0]?.toString();

  // Map Zod field errors to contract-specific error codes
  // Source: contract §3.2 Error Responses table
  const code = mapFieldToErrorCode(field, firstError.message);

  return {
    success: false,
    code,
    message: firstError.message,
    field,
  };
}

/**
 * Maps a field name to its contract-defined error code.
 * Source: contract §3.2 Error Responses table
 */
function mapFieldToErrorCode(field: string | undefined, message: string): string {
  if (!field) return EntryErrorCodes.VALIDATION_ERROR;

  const fieldCodeMap: Record<string, string> = {
    visitorName: EntryErrorCodes.VISITOR_NAME_REQUIRED,
    host: EntryErrorCodes.HOST_REQUIRED,
    unit: EntryErrorCodes.UNIT_REQUIRED,
    // Map specific fields to contract error codes
    preApprovalId: EntryErrorCodes.PRE_APPROVAL_REQUIRED,
  };

  // Special case: reason field errors are always OVERRIDE_REASON_TOO_SHORT
  if (field === "reason") return EntryErrorCodes.OVERRIDE_REASON_TOO_SHORT;

  // [H4 FIX] Map createdAt field errors to timestamp-specific codes
  if (field === "createdAt") {
    if (message.includes("older than")) return EntryErrorCodes.TIMESTAMP_TOO_OLD;
    if (message.includes("future")) return EntryErrorCodes.TIMESTAMP_IN_FUTURE;
  }

  return fieldCodeMap[field] || EntryErrorCodes.VALIDATION_ERROR;
}
