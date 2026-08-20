/**
 * GatePass — Admin Account-Provisioning Validation Schemas
 *
 * Source: src/docs/adr/0001-...md — Decision A1: accounts are provisioned by
 *         an authenticated admin; the ROLE is server-controlled and stored in
 *         guards.role. There is no public signup.
 * Source: API-and-Interface-Design — validate at the boundary; single error
 *         shape; additive/optional fields.
 * Source: Security-and-Hardening — validate all external input; least
 *         privilege (only an admin reaches this schema, enforced by
 *         requireRole upstream — never trusted from the body).
 *
 * Endpoint validated:
 *   POST /api/admin/accounts   requireAuth + requireRole("admin")
 */

import { z } from "zod";

// ─── Error codes ─────────────────────────────────────────────────────────────
// Closed set; additive only.

export const AccountErrorCodes = {
  ACCOUNT_INVALID_INPUT: "ACCOUNT_INVALID_INPUT",
  ACCOUNT_DUPLICATE: "ACCOUNT_DUPLICATE",
  ACCOUNT_PROVISIONING_UNAVAILABLE: "ACCOUNT_PROVISIONING_UNAVAILABLE",
  // The account exists but its audit-trail row could not be written. Surfaced
  // as a warning ON a 201 (never as the failure of the call) so the admin keeps
  // the one-time password and is told not to retry into a duplicate.
  ACCOUNT_CREATED_AUDIT_FAILED: "ACCOUNT_CREATED_AUDIT_FAILED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type AccountErrorCode =
  (typeof AccountErrorCodes)[keyof typeof AccountErrorCodes];

// ─── Provisionable roles ─────────────────────────────────────────────────────
// The role a NEW account may be created with. Mirrors the closed GuardRole set
// (guards.role CHECK). The value is stored server-side in guards.role and is
// the ONLY authorization source — never read back from the client.

export const PROVISIONABLE_ROLES = [
  "guard",
  "senior-guard",
  "admin",
] as const;

export type ProvisionableRole = (typeof PROVISIONABLE_ROLES)[number];

// ─── POST /api/admin/accounts body ──────────────────────────────────────────

export const ProvisionAccountSchema = z
  .object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email("email must be a valid email address")
      .max(254, "email must be at most 254 characters"),
    name: z
      .string()
      .trim()
      .min(1, "name must be 1..120 characters")
      .max(120, "name must be 1..120 characters"),
    badgeNumber: z
      .string()
      .trim()
      .min(1, "badgeNumber must be 1..32 characters")
      .max(32, "badgeNumber must be 1..32 characters"),
    role: z.enum(PROVISIONABLE_ROLES, {
      errorMap: () => ({
        message: `role must be one of: ${PROVISIONABLE_ROLES.join(", ")}`,
      }),
    }),
    /**
     * Optional initial password. When omitted, the server generates a strong
     * temporary password and returns it EXACTLY ONCE in the response so the
     * admin can hand it to the new operator. When supplied, it must be strong.
     */
    password: z
      .string()
      .min(12, "password must be at least 12 characters")
      .max(128, "password must be at most 128 characters")
      .optional(),
  })
  .strict();

export type ProvisionAccountBody = z.infer<typeof ProvisionAccountSchema>;

// ─── Response shape (wire format) ────────────────────────────────────────────

export interface ProvisionedAccountView {
  guardId: string;
  email: string;
  name: string;
  badgeNumber: string;
  role: ProvisionableRole;
  isActive: boolean;
}

/**
 * Non-fatal warning attached to a successful provisioning response: the
 * account and its password are real, but the audit row is missing.
 */
export interface AccountAuditWarning {
  code: typeof AccountErrorCodes.ACCOUNT_CREATED_AUDIT_FAILED;
  message: string;
}

export interface ProvisionAccountResponse {
  account: ProvisionedAccountView;
  /**
   * Present ONLY when the server generated the password (caller omitted it).
   * Returned once and never persisted in plaintext — the admin must relay it
   * to the new operator out of band. Never logged.
   */
  temporaryPassword?: string;
  /** Present when the account was created but its audit row was not written. */
  auditWarning?: AccountAuditWarning;
  traceId: string;
}
