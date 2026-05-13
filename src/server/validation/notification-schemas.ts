/**
 * GatePass — Notification Validation Schemas
 *
 * Source: src/docs/specs/notifications.md §7 (endpoints), §3 (security),
 *         §6 (provider interface), §9 (state machine).
 * Source: API-and-Interface-Design skill — "Validate at boundaries".
 * Source: Security-and-Hardening skill — "Validate all external input".
 *
 * Endpoints validated here:
 *   1. POST /api/approvals (extended — gains optional hostPhoneE164)
 *   2. GET  /api/notifications?approvalId=:id  → query schema
 *   3. POST /api/notifications/:id/retry       → route param only
 */

import { z } from "zod";

// ─── Error codes ─────────────────────────────────────────────────────────────
// Source: spec §3 + §7. Codes are stable strings; the reducer maps each
// to a specific banner. New codes are additive; existing ones never change.

export const NotificationErrorCodes = {
  HOST_PHONE_INVALID: "HOST_PHONE_INVALID",
  NOTIFICATION_NOT_FOUND: "NOTIFICATION_NOT_FOUND",
  NOTIFICATION_GUARD_MISMATCH: "NOTIFICATION_GUARD_MISMATCH",
  NOTIFICATION_NOT_RETRYABLE: "NOTIFICATION_NOT_RETRYABLE",
  RETRY_RATE_LIMITED: "RETRY_RATE_LIMITED",
  APPROVAL_TERMINAL: "APPROVAL_TERMINAL",
  // Surfaced when an approvalId query param is missing or malformed.
  APPROVAL_ID_INVALID: "APPROVAL_ID_INVALID",
  VALIDATION_ERROR: "VALIDATION_ERROR",
} as const;

export type NotificationErrorCode =
  (typeof NotificationErrorCodes)[keyof typeof NotificationErrorCodes];

// ─── E.164 phone validation ──────────────────────────────────────────────────
// Source: spec §3 — "phone number tampering: validated at approval
// creation (E.164 format)". The regex covers + then 7..15 digits with the
// leading digit in 1..9 (no leading-zero country codes).
//
// Why not libphonenumber-js? Adding a 100KB phone library for one regex
// check is over-engineering. The shape is enforced here; semantic
// correctness (real country code, real subscriber number) is the
// responsibility of the resident — the same as any direct-input phone.

export const E164_REGEX = /^\+[1-9]\d{6,14}$/;

export const phoneE164Schema = z
  .string()
  .trim()
  .regex(E164_REGEX, "Must be E.164 (+1234567890)")
  .max(16);

// Used by the approvalCreate schema extension — must be `optional` so an
// approval without a phone (legacy hand-copy path) is still valid.
export const optionalHostPhoneSchema = phoneE164Schema.optional();

// ─── GET /api/notifications query ────────────────────────────────────────────
// approvalId is a UUID (matches the approval_requests.id column shape).
// Anything else is a 400 before the route handler runs.

export const ListNotificationsQuerySchema = z.object({
  approvalId: z.string().uuid("approvalId must be a UUID"),
});

export type ListNotificationsQuery = z.infer<typeof ListNotificationsQuerySchema>;

// ─── Route param: /:id (retry handler) ───────────────────────────────────────
export const NotificationIdParamSchema = z.object({
  id: z.string().uuid("Notification id must be a UUID"),
});

export type NotificationIdParam = z.infer<typeof NotificationIdParamSchema>;

// ─── Public View Types ───────────────────────────────────────────────────────
// What route handlers return to the frontend. Mirrors spec §7.2.
// Excludes audit-only fields (idempotency_key, rendered_body) so a
// compromised guard token cannot read other residents' message bodies
// through this API.

export interface NotificationView {
  id: string;
  approvalId: string;
  channel: "whatsapp" | "sms";
  status:
    | "queued"
    | "sending"
    | "delivered"
    | "failed"
    | "permanently_failed";
  attempts: number;
  lastErrorCode: string | null;
  lastProviderResponseCode: number | null;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  deliveredAt: string | null; // ISO 8601 | null
  failedAt: string | null; // ISO 8601 | null
}

export interface NotificationsListResponse {
  notifications: NotificationView[];
  traceId: string;
}

export interface NotificationRetryResponse {
  notification: NotificationView;
  traceId: string;
}
