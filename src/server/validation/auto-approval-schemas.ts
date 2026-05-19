/**
 * GatePass — Auto-Approval Validation Schemas
 *
 * Source: src/docs/specs/auto-approval.md §6 (error codes), §7 (boundaries).
 * Source: API-and-Interface-Design — "validate at the boundary".
 * Source: Security-and-Hardening — "validate all external input".
 *
 * Endpoints validated:
 *   1. POST /api/auto-approval-rules        — admin seed
 *   2. GET  /api/auto-approval-rules        — admin/senior list
 *   3. POST /api/auto-approval-rules/:id/deactivate — admin kill switch
 */

import { z } from "zod";

// ─── Error codes ─────────────────────────────────────────────────────────────
// Closed set; never re-numbered. New codes are additive.

export const AutoApprovalErrorCodes = {
  RULE_INVALID_INPUT: "RULE_INVALID_INPUT",
  RULE_DUPLICATE: "RULE_DUPLICATE",
  NOT_FOUND: "NOT_FOUND",
  AUTH_FORBIDDEN: "AUTH_FORBIDDEN",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type AutoApprovalErrorCode =
  (typeof AutoApprovalErrorCodes)[keyof typeof AutoApprovalErrorCodes];

// ─── ISO 8601 datetime ───────────────────────────────────────────────────────
// Zod 3.22+ provides z.string().datetime() with strict ISO parsing.

const isoDateTimeSchema = z
  .string()
  .datetime({ offset: true, message: "expires_at must be ISO 8601" });

// ─── POST /api/auto-approval-rules body ──────────────────────────────────────

export const SeedAutoApprovalRuleSchema = z
  .object({
    visitorName: z
      .string()
      .trim()
      .min(1, "visitor_name must be 1..120 characters")
      .max(120, "visitor_name must be 1..120 characters"),
    host: z
      .string()
      .trim()
      .min(1, "host must be 1..120 characters")
      .max(120, "host must be 1..120 characters"),
    unit: z
      .string()
      .trim()
      .min(1, "unit must be 1..32 characters")
      .max(32, "unit must be 1..32 characters"),
    plateRequired: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .optional()
      .nullable(),
    expiresAt: isoDateTimeSchema,
  })
  .strict();

export type SeedAutoApprovalRuleBody = z.infer<typeof SeedAutoApprovalRuleSchema>;

// ─── GET /api/auto-approval-rules query ──────────────────────────────────────

export const ListAutoApprovalRulesQuerySchema = z
  .object({
    host: z.string().trim().min(1).max(120).optional(),
    unit: z.string().trim().min(1).max(32).optional(),
    includeInactive: z
      .union([z.literal("true"), z.literal("false")])
      .optional()
      .transform((s) => s === "true"),
  })
  .partial();

export type ListAutoApprovalRulesQuery = z.infer<
  typeof ListAutoApprovalRulesQuerySchema
>;

// ─── :id param ───────────────────────────────────────────────────────────────

export const RuleIdParamSchema = z
  .object({
    id: z.string().uuid("id must be a UUID"),
  })
  .strict();

// ─── Response shapes (wire format) ──────────────────────────────────────────

export interface AutoApprovalRuleResponse {
  rule: {
    id: string;
    visitorName: string;
    host: string;
    unit: string;
    plateRequired: string | null;
    active: boolean;
    expiresAt: string;
    createdAt: string;
    updatedAt: string;
    lastMatchedAt: string | null;
    matchCount: number;
  };
  traceId: string;
}

export interface ListAutoApprovalRulesResponse {
  rules: AutoApprovalRuleResponse["rule"][];
  traceId: string;
}
