/**
 * GatePass — Shift Log Validation Schemas
 *
 * Source: src/docs/specs/shift-log-aggregation.md §4 (API surface).
 * Source: API-and-Interface-Design — validate at the boundary.
 * Source: Security-and-Hardening — validate all external input.
 */

import { z } from "zod";

// ─── Error codes (closed set) ────────────────────────────────────────────────

export const ShiftLogErrorCodes = {
  SHIFT_WINDOW_INVALID: "SHIFT_WINDOW_INVALID",
  SHIFT_WINDOW_TOO_LARGE: "SHIFT_WINDOW_TOO_LARGE",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  AUTH_FORBIDDEN: "AUTH_FORBIDDEN",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

// ─── Query schema ────────────────────────────────────────────────────────────
// Source: spec §4 — fromIso/toIso optional, defaulted server-side; guardId
// optional, UUID when supplied.

const isoUtcRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export const ListShiftsQuerySchema = z
  .object({
    fromIso: z
      .string()
      .regex(isoUtcRegex, {
        message: "fromIso must be an ISO-8601 UTC timestamp (e.g. 2024-01-15T00:00:00.000Z)",
      })
      .optional(),
    toIso: z
      .string()
      .regex(isoUtcRegex, {
        message: "toIso must be an ISO-8601 UTC timestamp (e.g. 2024-01-15T00:00:00.000Z)",
      })
      .optional(),
    guardId: z.string().uuid({ message: "guardId must be a UUID" }).optional(),
  })
  .strict();

export type ListShiftsQuery = z.infer<typeof ListShiftsQuerySchema>;

// ─── Response types ──────────────────────────────────────────────────────────

export type ShiftTotalsView = {
  entries: number;
  qr: number;
  walkIn: number;
  override: number;
  recognized: number;
  auto: number;
  approvalsDenied: number;
  approvalsExpired: number;
  autoApprovalsMatched: number;
  overrideAuthorized: number;
};

export type ShiftSummaryView = {
  guardId: string;
  guardName: string;
  badgeNumber: string;
  totals: ShiftTotalsView;
};

export type ListShiftsResponse = {
  window: { fromIso: string; toIso: string };
  shifts: ShiftSummaryView[];
  traceId: string;
};
