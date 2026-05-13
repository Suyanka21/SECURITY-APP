/**
 * GatePass — Visitor Validation Schemas
 *
 * Source: gatepass-api-contract.md §3.4 — GET /api/visitors/recognized
 */

import { z } from "zod";

// ─── Error Codes ─────────────────────────────────────────────────────────────

export const VisitorErrorCodes = {
  GUARD_ID_MISSING: "GUARD_ID_MISSING",
  GUARD_SESSION_EXPIRED: "GUARD_SESSION_EXPIRED",
  VALIDATION_ERROR: "VALIDATION_ERROR",
} as const;

// ─── Query Params Schema ─────────────────────────────────────────────────────
// Source: contract §3.4 RecognizedVisitorsParams

export const RecognizedVisitorsSchema = z.object({
  // [C3 FIX] guardId REMOVED from query params.
  // Guard identity now comes from verified JWT token (auth middleware).

  // Source: contract §3.4 — "Optional fuzzy search on name/plate"
  q: z.string().optional().default(""),

  // Source: contract §3.4 — "Default: 1"
  page: z.coerce.number().int().min(1).default(1),

  // Source: contract §3.4 — "Default: 20, max: 50"
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export type RecognizedVisitorsInput = z.infer<typeof RecognizedVisitorsSchema>;

// ─── Response Types ──────────────────────────────────────────────────────────
// Source: contract §3.4 RecognizedVisitorsResponse

export interface RecognizedVisitorItem {
  id: string;
  name: string;
  host: string;
  unit: string;
  plate: string | null;
  lastSeen: string;
  recognition: "pre-approved" | "frequent" | "watch";
}

export interface RecognizedVisitorsResponse {
  visitors: RecognizedVisitorItem[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
  traceId: string;
}

// ─── Validation Helper ───────────────────────────────────────────────────────

export function validateVisitorParams(
  params: unknown
): { success: true; data: RecognizedVisitorsInput } | { success: false; code: string; message: string; field?: string } {
  const result = RecognizedVisitorsSchema.safeParse(params);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const firstError = result.error.issues[0];
  const field = firstError.path[0]?.toString();

  // [C3 FIX] guardId no longer in schema — handled by auth middleware
  const code = VisitorErrorCodes.VALIDATION_ERROR;

  return {
    success: false,
    code,
    message: firstError.message,
    field,
  };
}
