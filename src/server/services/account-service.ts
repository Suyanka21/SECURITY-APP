/**
 * GatePass — Admin Account-Provisioning Service (Decision A1)
 *
 * Source: src/docs/adr/0001-...md — A1: accounts are provisioned by an
 *         authenticated admin; the ROLE is server-controlled and persisted in
 *         guards.role. No public signup, no client-selected role.
 * Source: src/server/services/auto-approval-service.ts — service conventions
 *         (DrizzleDB shape, ServiceError, emitAuditEvent, best-effort audit).
 * Source: Security-and-Hardening — least privilege, validate at boundary,
 *         secrets never logged, compensating action on partial failure.
 *
 * Responsibility:
 *   provisionAccount() — create a Supabase Auth user + a linked guards row in
 *   one logical operation, with a compensating delete so the two systems never
 *   drift into an orphaned state.
 *
 * Cross-system failure model (Auth = Supabase, profile = Postgres are separate
 * systems with no shared transaction):
 *   1. create Auth user            → if it fails, nothing was written; throw.
 *   2. insert guards row (role)     → if it fails, DELETE the Auth user we just
 *                                     created (compensation) so we never leave
 *                                     an Auth user with no guard profile, then
 *                                     surface the original failure.
 *   The reverse orphan (guard row with no Auth user) cannot happen because the
 *   guard row is only written after the Auth user exists.
 */

import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";

import { guards } from "@/db/schema";
import { emitAuditEvent } from "./audit-logger";
import { ServiceError } from "./errors";
import {
  SupabaseAdminError,
  realSupabaseAdminDeps,
  type SupabaseAdminDeps,
} from "../auth/supabase-admin";
import {
  AccountErrorCodes,
  PROVISIONABLE_ROLES,
  type ProvisionableRole,
  type ProvisionedAccountView,
} from "../validation/account-schemas";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Minimal typed view of the Drizzle query builder we actually use here. Typing
 * just these chains lets the service avoid `any` while staying decoupled from
 * the concrete driver (and easy to mock in tests).
 */
export interface DrizzleDB {
  select: () => {
    from: (table: unknown) => {
      where: (clause: unknown) => Promise<GuardRow[]>;
    };
  };
  insert: (table: unknown) => {
    values: (row: unknown) => {
      returning: () => Promise<GuardRow[]>;
    };
  };
}

export interface ProvisionAccountInput {
  email: string;
  name: string;
  badgeNumber: string;
  role: ProvisionableRole;
  /** Optional caller-supplied password; when absent, one is generated. */
  password?: string;
}

export interface ProvisionAccountResult {
  view: ProvisionedAccountView;
  /** Only set when the server generated the password. Never persisted/logged. */
  temporaryPassword?: string;
}

interface GuardRow {
  id: string;
  badgeNumber: string;
  name: string;
  isActive: boolean;
  role: ProvisionableRole;
  supabaseUserId: string | null;
}

// ─── Password generation ─────────────────────────────────────────────────────

/**
 * Generates a strong temporary password with mixed character classes. Returned
 * to the admin ONCE (never persisted in plaintext, never logged) so they can
 * relay it to the new operator, who should rotate it on first sign-in.
 */
export function generateTemporaryPassword(): string {
  // 24 url-safe bytes → ~32 chars of entropy, then guarantee class coverage.
  const core = randomBytes(24).toString("base64url");
  // Deterministic, non-secret suffix guarantees upper/lower/digit/symbol.
  return `Gp!${core}9`;
}

// ─── provisionAccount() ──────────────────────────────────────────────────────

/**
 * Admin-only account provisioning. Authorization (requireRole("admin")) is
 * enforced upstream in the route; this service trusts that the caller is an
 * admin and NEVER reads a role from anywhere but its own `input.role`
 * argument, which the route derived from the validated body's closed enum.
 *
 * @throws ServiceError(ACCOUNT_PROVISIONING_UNAVAILABLE, 503) when the
 *         service-role key / Supabase URL are not configured.
 * @throws ServiceError(ACCOUNT_INVALID_INPUT, 422) on defensive re-validation.
 * @throws ServiceError(ACCOUNT_DUPLICATE, 409) on duplicate badge or email.
 * @throws ServiceError(ACCOUNT_CREATED_AUDIT_FAILED, 500) when the account was
 *         created but its audit row could not be written — the admin must not
 *         retry, or they provision a duplicate.
 * @throws ServiceError(INTERNAL_ERROR, 500) on unexpected provider/DB failure.
 */
export async function provisionAccount(
  actingAdminGuardId: string,
  input: ProvisionAccountInput,
  db: DrizzleDB,
  admin: SupabaseAdminDeps = realSupabaseAdminDeps,
  now: () => Date = () => new Date(),
): Promise<ProvisionAccountResult> {
  // Fail fast if provisioning isn't configured — do not attempt a doomed call.
  if (!admin.isConfigured()) {
    throw new ServiceError(
      AccountErrorCodes.ACCOUNT_PROVISIONING_UNAVAILABLE,
      "Account provisioning is not configured on this server",
      503,
    );
  }

  const email = (input.email ?? "").trim().toLowerCase();
  const name = (input.name ?? "").trim();
  const badgeNumber = (input.badgeNumber ?? "").trim();
  const role = input.role;

  // Defensive boundary re-validation (route already validated via zod).
  if (!email || email.length > 254) {
    throw new ServiceError(
      AccountErrorCodes.ACCOUNT_INVALID_INPUT,
      "email must be 1..254 characters",
      422,
      "email",
    );
  }
  if (!name || name.length > 120) {
    throw new ServiceError(
      AccountErrorCodes.ACCOUNT_INVALID_INPUT,
      "name must be 1..120 characters",
      422,
      "name",
    );
  }
  if (!badgeNumber || badgeNumber.length > 32) {
    throw new ServiceError(
      AccountErrorCodes.ACCOUNT_INVALID_INPUT,
      "badgeNumber must be 1..32 characters",
      422,
      "badgeNumber",
    );
  }
  if (!PROVISIONABLE_ROLES.includes(role)) {
    throw new ServiceError(
      AccountErrorCodes.ACCOUNT_INVALID_INPUT,
      `role must be one of: ${PROVISIONABLE_ROLES.join(", ")}`,
      422,
      "role",
    );
  }

  // Pre-check duplicate badge for a clean 409 (the UNIQUE index also enforces
  // it, but the pre-check yields a structured error instead of a raw DB error
  // AND avoids creating an Auth user we'd only have to compensate away).
  const existingByBadge = await db
    .select()
    .from(guards)
    .where(eq(guards.badgeNumber, badgeNumber));
  if (existingByBadge && existingByBadge.length > 0) {
    throw new ServiceError(
      AccountErrorCodes.ACCOUNT_DUPLICATE,
      "A guard with this badge number already exists",
      409,
      "badgeNumber",
    );
  }

  const generated = input.password === undefined;
  const password = input.password ?? generateTemporaryPassword();

  // Step 1 — create the Supabase Auth user.
  let authUserId: string;
  try {
    const user = await admin.createUser(email, password);
    authUserId = user.id;
  } catch (err) {
    if (err instanceof SupabaseAdminError && err.kind === "duplicate") {
      throw new ServiceError(
        AccountErrorCodes.ACCOUNT_DUPLICATE,
        "An account with this email already exists",
        409,
        "email",
      );
    }
    if (err instanceof SupabaseAdminError && err.kind === "unavailable") {
      throw new ServiceError(
        AccountErrorCodes.ACCOUNT_PROVISIONING_UNAVAILABLE,
        "Account provisioning is temporarily unavailable",
        503,
      );
    }
    throw new ServiceError(
      AccountErrorCodes.INTERNAL_ERROR,
      "Failed to create authentication account",
      500,
    );
  }

  // Step 2 — insert the linked guards row with the SERVER-trusted role.
  const nowDate = now();
  let inserted: GuardRow[];
  try {
    inserted = await db
      .insert(guards)
      .values({
        badgeNumber,
        name,
        role,
        isActive: true,
        supabaseUserId: authUserId,
        createdAt: nowDate,
        updatedAt: nowDate,
      })
      .returning();
  } catch (dbErr) {
    // Compensation — delete the Auth user so we never orphan it. Best-effort:
    // a failure here is logged as a reconciliation TODO but the ORIGINAL error
    // (the DB insert failure) is what the admin sees.
    try {
      await admin.deleteUser(authUserId);
    } catch {
      console.error(
        `[ACCOUNT] Compensation failed: orphaned auth user ${authUserId} ` +
          `has no guard row and could not be deleted. Manual cleanup required.`,
      );
    }

    // A unique-violation on badge (race with the pre-check) is a duplicate.
    const message = dbErr instanceof Error ? dbErr.message : String(dbErr);
    if (/unique|duplicate/i.test(message)) {
      throw new ServiceError(
        AccountErrorCodes.ACCOUNT_DUPLICATE,
        "A guard with this badge number already exists",
        409,
        "badgeNumber",
      );
    }
    throw new ServiceError(
      AccountErrorCodes.INTERNAL_ERROR,
      "Failed to create guard profile",
      500,
    );
  }

  if (!inserted || inserted.length === 0) {
    // Row not returned — compensate and fail closed.
    try {
      await admin.deleteUser(authUserId);
    } catch {
      console.error(
        `[ACCOUNT] Compensation failed: orphaned auth user ${authUserId}.`,
      );
    }
    throw new ServiceError(
      AccountErrorCodes.INTERNAL_ERROR,
      "Failed to create guard profile",
      500,
    );
  }

  const row = inserted[0];

  // Audit — privileged action. Payload carries NO password/token/secret.
  // The audit write stays mandatory (a privileged action with no trail is not
  // acceptable), but the account already exists at this point and cannot be
  // compensated away safely, so the failure must say so: a bare INTERNAL_ERROR
  // would send the admin into a retry that only yields a duplicate.
  try {
    await emitAuditEvent(
      "account_provisioned",
      actingAdminGuardId,
      `account-${row.id}`,
      {
        createdGuardId: row.id,
        badgeNumber: row.badgeNumber,
        role: row.role,
        // email is operational metadata, not a secret; useful for the audit trail.
        email,
      },
    );
  } catch (auditErr) {
    console.error(
      `[ACCOUNT] Account ${row.id} (badge ${row.badgeNumber}) was created but ` +
        `its account_provisioned audit row could not be written. ` +
        `Manual reconciliation required.`,
      auditErr instanceof Error ? auditErr.message : auditErr,
    );
    throw new ServiceError(
      AccountErrorCodes.ACCOUNT_CREATED_AUDIT_FAILED,
      `The account for badge ${row.badgeNumber} was created, but writing it to ` +
        `the audit trail failed. Do not retry — the account exists. Report this ` +
        `so the audit gap is reconciled.`,
      500,
    );
  }

  const view: ProvisionedAccountView = {
    guardId: row.id,
    email,
    name: row.name,
    badgeNumber: row.badgeNumber,
    role: row.role,
    isActive: row.isActive,
  };

  return generated ? { view, temporaryPassword: password } : { view };
}

// Keep the schema graph linked even though we only query `guards` here.
export { ServiceError };
