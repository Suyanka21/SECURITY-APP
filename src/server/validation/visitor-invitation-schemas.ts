/**
 * GatePass — Visitor Invitation Validation Schemas
 *
 * Source: src/docs/specs/guest-qr-ticket.md §6 (Backend — Endpoints).
 * Source: API-and-Interface-Design — "validate at the boundary".
 * Source: Security-and-Hardening — "validate all external input".
 *
 * Endpoints validated:
 *   1. POST /api/visitor-invitations
 *        — admin/senior-guard issue
 *   2. GET  /api/visitor-invitations/:token/preview
 *        — public read-only preview (token is the auth)
 */

import { z } from "zod";

// ─── Error codes ─────────────────────────────────────────────────────────────
// Closed set; never re-numbered. New codes are additive.
// Source: spec §6 — error tables for issue and preview endpoints.

export const VisitorInvitationErrorCodes = {
  INVITATION_INVALID_INPUT: "INVITATION_INVALID_INPUT",
  INVITATION_NOT_FOUND: "INVITATION_NOT_FOUND",
  INVITATION_EXPIRED: "INVITATION_EXPIRED",
  INVITATION_CONSUMED: "INVITATION_CONSUMED",
  AUTH_FORBIDDEN: "AUTH_FORBIDDEN",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type VisitorInvitationErrorCode =
  (typeof VisitorInvitationErrorCodes)[keyof typeof VisitorInvitationErrorCodes];

// ─── Bounds (HARD constants — not env-driven) ────────────────────────────────
// Source: spec §4 A5 — "MAX_INVITATION_TTL_HOURS=168".
// Hard-coding the ceiling prevents an over-generous env from leaking through.

export const MIN_TTL_HOURS = 1;
export const DEFAULT_TTL_HOURS = 24;
export const MAX_TTL_HOURS = 168; // 7 days

// ─── Field schemas ───────────────────────────────────────────────────────────
// Mirrors the existing authorization_decisions CHECK constraints
// (authorization_visitor_name_not_empty / host / unit) — see src/db/schema.ts
// lines 178-194.

const visitorNameSchema = z
  .string()
  .trim()
  .min(1, "visitorName must be 1..120 characters")
  .max(120, "visitorName must be 1..120 characters");

const hostSchema = z
  .string()
  .trim()
  .min(1, "host must be 1..120 characters")
  .max(120, "host must be 1..120 characters");

const unitSchema = z
  .string()
  .trim()
  .min(1, "unit must be 1..30 characters")
  .max(30, "unit must be 1..30 characters");

// Plate is optional; when present, mirrors entry_records.plate format.
const plateSchema = z
  .string()
  .trim()
  .min(1, "plate must be 1..12 characters when provided")
  .max(12, "plate must be 1..12 characters when provided")
  .transform((s) => s.toUpperCase());

const ttlHoursSchema = z
  .number()
  .int("ttlHours must be a whole number")
  .min(MIN_TTL_HOURS, `ttlHours must be at least ${MIN_TTL_HOURS}`)
  .max(MAX_TTL_HOURS, `ttlHours cannot exceed ${MAX_TTL_HOURS} (7 days)`);

// ─── Issue endpoint ──────────────────────────────────────────────────────────
// POST /api/visitor-invitations
// Source: spec §6, "Issue".

export const IssueInvitationSchema = z.object({
  visitorName: visitorNameSchema,
  host: hostSchema,
  unit: unitSchema,
  plate: plateSchema.nullable().optional(),
  ttlHours: ttlHoursSchema.optional(),
});

export type IssueInvitationInput = z.infer<typeof IssueInvitationSchema>;

// ─── Preview endpoint ────────────────────────────────────────────────────────
// GET /api/visitor-invitations/:token/preview
// Source: spec §6, "Preview".
//
// The token is read from the URL path (req.params.token), NOT from a body
// or query. We validate the path param shape here so a malformed token
// (wrong length, illegal chars) is rejected with 404 INVITATION_NOT_FOUND
// — same code as "valid format but no match" so the response does not
// leak format vs. existence.

// Base64url alphabet (RFC 4648 §5): A-Z a-z 0-9 - _
// 32 random bytes → 43 base64url chars (no padding).
// Allow 40..96 to absorb future token size changes without route churn.
const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;

export const PreviewTokenSchema = z
  .string()
  .min(40, "token format is invalid")
  .max(96, "token format is invalid")
  .regex(BASE64URL_REGEX, "token format is invalid");

// ─── Response shapes ─────────────────────────────────────────────────────────
// Plain TypeScript interfaces (no Zod) — these describe the SERVER's
// response. Clients should still validate at the boundary on their side.

export interface IssueInvitationResponse {
  invitation: {
    id: string;
    qrToken: string; // raw — sent ONCE, never logged
    passUrl: string;
    visitorName: string;
    host: string;
    unit: string;
    plate: string | null;
    expiresAt: string; // ISO 8601
    issuedAt: string; // ISO 8601
  };
  traceId: string;
}

export interface PreviewInvitationResponse {
  invitation: {
    visitorName: string;
    host: string;
    unit: string;
    plate: string | null;
    expiresAt: string;
  };
}
