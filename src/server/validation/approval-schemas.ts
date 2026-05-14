/**
 * GatePass — Resident Approval Validation Schemas
 *
 * Source: src/docs/specs/resident-approval-flow.md §7 — endpoint contracts
 * Source: API-and-Interface-Design skill — "Validate at boundaries"
 * Source: Security-and-Hardening skill — "Validate all external input"
 *
 * Three endpoints, three schemas:
 *   1. POST   /api/approvals             → CreateApprovalSchema
 *   2. GET    /api/approvals/:id/status  → no body, id is route param
 *   3. POST   /api/approvals/:id/decide  → DecideApprovalSchema
 */

import { z } from "zod";

// ─── Error Codes ─────────────────────────────────────────────────────────────
// Source: spec §7 — error responses per endpoint
// Codes are stable strings the frontend reducer maps to specific banners.

export const ApprovalErrorCodes = {
  // POST /api/approvals
  APPROVAL_REQUEST_INVALID: "APPROVAL_REQUEST_INVALID",
  APPROVAL_DUPLICATE: "APPROVAL_DUPLICATE",
  GUARD_SESSION_EXPIRED: "GUARD_SESSION_EXPIRED",
  // GET /api/approvals/:id/status
  APPROVAL_NOT_FOUND: "APPROVAL_NOT_FOUND",
  APPROVAL_GUARD_MISMATCH: "APPROVAL_GUARD_MISMATCH",
  // POST /api/approvals/:id/decide
  APPROVAL_TOKEN_INVALID: "APPROVAL_TOKEN_INVALID",
  APPROVAL_EXPIRED: "APPROVAL_EXPIRED",
  APPROVAL_ALREADY_DECIDED: "APPROVAL_ALREADY_DECIDED",
  APPROVAL_DENY_REASON_REQUIRED: "APPROVAL_DENY_REASON_REQUIRED",
  // Generic
  VALIDATION_ERROR: "VALIDATION_ERROR",
} as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Sanitizes free-text input from the resident.
 *
 * Source: spec §9 — XSS / log-injection mitigation table.
 * - Strips control chars (everything below \x20, plus \x7F DEL).
 * - Trims whitespace.
 * - Caps at 200 chars to prevent log/UI overflow attacks.
 *
 * NOTE: This is defense-in-depth — the UI/audit consumers must still
 * encode output. Sanitization on input is NOT a substitute for output
 * encoding (OWASP cheat-sheet).
 */
export function sanitizeFreeText(raw: string, maxLen = 200): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x1F\x7F]/g, "").trim().slice(0, maxLen);
}

// ─── Request Schemas ─────────────────────────────────────────────────────────

/**
 * POST /api/approvals
 *
 * Source: spec §7.1 — guard-initiated approval request.
 * The guard supplies the draft entry + an offlineId (idempotency key tying
 * the approval to a single deferred entry). The guard's identity is taken
 * from JWT, never from the body.
 */
export const CreateApprovalSchema = z.object({
  /** Idempotency key from the deferred entry — must match the eventual entry's offlineId */
  // Source: spec §7.1 request — offlineId
  offlineId: z
    .string({ required_error: "offlineId is required" })
    .uuid("offlineId must be a valid UUID"),

  /** Draft entry the resident will approve or deny */
  // Source: spec §7.1 request — draft
  draft: z.object({
    visitorName: z
      .string({ required_error: "Visitor name is required" })
      .trim()
      .min(1, "Visitor name is required"),

    host: z
      .string({ required_error: "Host is required" })
      .trim()
      .min(1, "Host is required"),

    unit: z
      .string({ required_error: "Unit is required" })
      .trim()
      .min(1, "Unit is required"),

    plate: z
      .string()
      .max(20, "Plate must be 20 characters or fewer")
      .nullable()
      .optional()
      .default(null),

    reason: z.string().default(""),

    // Approval flow only supports walk-in in v1. QR/override paths don't
    // need a resident decision; recognized visitors are pre-approved.
    method: z.enum(["walk-in"] as const, {
      errorMap: () => ({ message: "method must be 'walk-in'" }),
    }),
  }),

  /** Optional contact hint — purely informational, NOT used for delivery in v1.
   *  Feature 2 (Notifications) will plug WhatsApp/SMS off the same approval row;
   *  see remaining-features-rollout.md.
   */
  hostContactHint: z
    .string()
    .max(200, "hostContactHint must be 200 characters or fewer")
    .optional(),

  /** Optional E.164 phone — drives Feature 2 delivery.
   *  Source: src/docs/specs/notifications.md §7.1, B4.
   *  When absent, the approval falls back to the legacy hand-copy
   *  flow (no notification row is enqueued). When present, the
   *  controller enqueues a WhatsApp delivery; SMS fallback fires
   *  automatically on WA failure (spec §5).
   */
  hostPhoneE164: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{6,14}$/, "hostPhoneE164 must be E.164 (+1234567890)")
    .max(16)
    .optional(),
});

export type CreateApprovalInput = z.infer<typeof CreateApprovalSchema>;

/**
 * POST /api/approvals/:id/decide
 *
 * Source: spec §7.3 — resident-side decision.
 * NO JWT here. The magic-link token in the body IS the auth.
 * - token: raw 64-hex string (32 bytes printed as hex). Hashed server-side
 *   and looked up against approval_requests.token_hash.
 * - decision: "approve" or "deny".
 * - reason: required when decision === "deny", sanitized.
 */
export const DecideApprovalSchema = z
  .object({
    token: z
      .string({ required_error: "token is required" })
      .regex(/^[0-9a-f]{64}$/i, "token must be 64 hex characters"),

    decision: z.enum(["approve", "deny"] as const, {
      errorMap: () => ({ message: "decision must be 'approve' or 'deny'" }),
    }),

    reason: z.string().max(500, "reason must be 500 characters or fewer").optional(),
  })
  .superRefine((data, ctx) => {
    if (data.decision === "deny") {
      const trimmed = (data.reason ?? "").trim();
      if (trimmed.length < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reason"],
          message: "reason is required when denying",
        });
      }
    }
  });

export type DecideApprovalInput = z.infer<typeof DecideApprovalSchema>;

// ─── Response Types ──────────────────────────────────────────────────────────

/**
 * Public-safe view of an approval request.
 *
 * Source: spec §6.1 — pendingApproval reducer shape.
 * NEVER includes tokenHash or raw token. The guard sees status + metadata;
 * the resident sees the same plus their decision UI.
 */
export interface ApprovalRequestView {
  id: string;
  offlineId: string;
  visitorName: string;
  host: string;
  unit: string;
  plate: string | null;
  reason: string;
  method: "walk-in";
  requestedByGuardId: string;
  status: "pending" | "approved" | "denied" | "expired";
  /** ISO 8601 */
  expiresAt: string;
  /** ISO 8601 — null while status === "pending" */
  decidedAt: string | null;
  deniedReason: string | null;
  entryId: string | null;
  traceId: string;
}

/**
 * Response for POST /api/approvals.
 *
 * Source: spec §7.1 response.
 * `magicLinkUrl` is what the guard hands to the resident (QR / SMS / link).
 * The raw token is embedded once in the URL and never returned again.
 */
export interface CreateApprovalResponse {
  approvalId: string;
  magicLinkUrl: string;
  /** ISO 8601 */
  expiresAt: string;
  traceId: string;
  /**
   * Set when an auto-approval rule short-circuited this request and
   * an entry was created synchronously (no resident decision needed).
   *
   * Source: src/docs/specs/auto-approval.md §5 (state machine extension).
   * Additive — pre-Feature-3 callers default-read as `false` via `?? false`.
   * When true, `magicLinkUrl` is still returned but is moot — the entry
   * is already logged. The reducer dispatches APPROVAL_AUTO_APPROVED
   * instead of APPROVAL_AWAITING.
   */
  autoApproved?: boolean;
  /**
   * The entry record produced when autoApproved=true. Null otherwise.
   * Shape mirrors POST /api/entries so the reducer can plug it into
   * the existing recordedEntries list without translation. The
   * method field is `"auto"` here (vs `"walk-in"` on /decide).
   */
  entry?: {
    id: string;
    visitorName: string;
    host: string;
    unit: string;
    plate: string | null;
    reason: string;
    method: "auto";
    guardId: string;
    createdAt: string;
    status: "logged";
    syncState: "synced";
  } | null;
  /**
   * The rule view that fired. Useful for UI surfacing ("auto-approved
   * by rule visitor=… host=… unit=…"). Null when autoApproved=false.
   */
  matchedRule?: {
    id: string;
    visitorName: string;
    host: string;
    unit: string;
  } | null;
}

/**
 * Response for GET /api/approvals/:id/status.
 *
 * Source: spec §7.2 response.
 * Server lazily flips pending rows past expires_at to "expired" before returning.
 */
export interface ApprovalStatusResponse {
  approval: ApprovalRequestView;
  /** Server-generated; mirrors `approval.traceId` for parity with other endpoints. */
  traceId: string;
}

/**
 * Response for POST /api/approvals/:id/decide.
 *
 * Source: spec §7.3 response.
 * On approve: entry has the full EntryRecord shape (mirrors /api/entries).
 * On deny:    entry is null and the denied_reason is echoed back for confirmation.
 */
export interface DecideApprovalResponse {
  approval: ApprovalRequestView;
  entry: {
    id: string;
    visitorName: string;
    host: string;
    unit: string;
    plate: string | null;
    reason: string;
    method: "walk-in";
    guardId: string;
    createdAt: string;
    status: "logged";
    syncState: "synced";
  } | null;
  traceId: string;
}

// ─── Boundary Helpers ────────────────────────────────────────────────────────

/**
 * Validates the create-approval request body at the API boundary.
 *
 * Source: API-and-Interface-Design — single, structured failure path.
 */
export function validateCreateApprovalRequest(
  body: unknown
):
  | { success: true; data: CreateApprovalInput }
  | { success: false; code: string; message: string; field?: string } {
  const result = CreateApprovalSchema.safeParse(body);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const issue = result.error.issues[0];
  const field = issue.path.join(".") || undefined;
  return {
    success: false,
    code: ApprovalErrorCodes.APPROVAL_REQUEST_INVALID,
    message: issue.message,
    field,
  };
}

/**
 * Validates the decide-approval request body at the API boundary.
 *
 * Returns a stable error code per failure mode so the frontend can render
 * a specific banner without inspecting messages.
 */
export function validateDecideApprovalRequest(
  body: unknown
):
  | { success: true; data: DecideApprovalInput }
  | { success: false; code: string; message: string; field?: string } {
  const result = DecideApprovalSchema.safeParse(body);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const issue = result.error.issues[0];
  const field = issue.path.join(".") || undefined;

  // Map specific failure modes to dedicated codes; everything else is generic.
  let code: string = ApprovalErrorCodes.VALIDATION_ERROR;
  if (field === "token") code = ApprovalErrorCodes.APPROVAL_TOKEN_INVALID;
  else if (field === "reason") code = ApprovalErrorCodes.APPROVAL_DENY_REASON_REQUIRED;

  return { success: false, code, message: issue.message, field };
}
