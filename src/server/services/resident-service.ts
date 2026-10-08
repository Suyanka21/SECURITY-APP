/**
 * GatePass — Units, residents and unit claim codes (Resident Portal, PR R1).
 *
 * Source: src/docs/specs/resident-portal.md §2 (data model), §3 (auth/claim).
 *
 * HARD RULES:
 * - Claim codes are HMAC-SHA256(PIN_PEPPER, "unit-claim:<code>") at rest; the
 *   raw code leaves the server exactly once, in the admin's issue response,
 *   and is never logged or written to an audit payload.
 * - A code is consumed in the SAME transaction that creates the resident
 *   row — a failure anywhere leaves the code unused and no resident behind.
 * - Wrong codes cannot be attributed to any code row, so failures are
 *   counted per CALLER (Supabase user) and lock the caller out, using the
 *   same 5-attempt / 15-minute shape as the PIN limiter. The failure counter
 *   is written OUTSIDE the claim transaction so it survives the rollback.
 * - Unit / host for a resident are derived from these rows server-side —
 *   never from the client.
 */

import { createHmac, randomInt, randomUUID } from "crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "@/db/schema";
import {
  authorizationDecisions,
  autoApprovalRules,
  residentClaimAttempts,
  residents,
  unitClaimCodes,
  units,
} from "@/db/schema";
import { emitAuditEvent, emitResidentAuditEvent, publishAuditEvent } from "./audit-logger";
import type { AuditEvent } from "./audit-logger";
import { ServiceError } from "./errors";
import { resolvePinPepper } from "./pin-service";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ResidentDb = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<ResidentDb["transaction"]>[0]>[0];

export interface UnitView {
  id: string;
  label: string;
  isActive: boolean;
  createdAt: string;
  deactivatedAt: string | null;
  /** Active residents currently linked to this unit */
  activeResidentCount: number;
}

export interface ResidentView {
  id: string;
  displayName: string;
  phoneE164: string;
  isActive: boolean;
  unitId: string;
  unitLabel: string;
  claimedAt: string;
  deactivatedAt: string | null;
}

export interface ClaimCodeIssued {
  claimCodeId: string;
  unitId: string;
  unitLabel: string;
  /** Raw code, formatted XXXX-XXXX. Shown to the admin ONCE. */
  code: string;
  expiresAt: string;
}

export interface ClaimInput {
  supabaseUserId: string;
  /** From the verified token — never from the body */
  phoneE164: string | undefined;
  code: string;
  displayName: string;
}

// ─── Policy constants (HARD — not env-driven) ───────────────────────────────

export const CLAIM_CODE_LENGTH = 8;
export const DEFAULT_CLAIM_CODE_TTL_HOURS = 72;
export const MAX_CLAIM_CODE_TTL_HOURS = 7 * 24;
export const MAX_CLAIM_ATTEMPTS = 5;
export const CLAIM_LOCK_WINDOW_MS = 15 * 60 * 1000;

// Crockford base32 — no I L O U, so a code read over the phone is unambiguous.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const E164 = /^\+[1-9][0-9]{7,14}$/;

// ─── Pure helpers ────────────────────────────────────────────────────────────

export function normalizeUnitLabel(label: string): string {
  return label.trim().toLowerCase();
}

/** Uppercases and strips separators so "abcd-1234" and "ABCD 1234" match. */
export function normalizeClaimCode(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export function formatClaimCode(normalized: string): string {
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

export function generateClaimCode(): string {
  let out = "";
  for (let i = 0; i < CLAIM_CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  }
  return out;
}

export function hashClaimCode(normalized: string): string {
  return createHmac("sha256", resolvePinPepper())
    .update(`unit-claim:${normalized}`)
    .digest("hex");
}

export function clampClaimCodeTtlHours(requested: number | undefined): number {
  const hours = requested ?? DEFAULT_CLAIM_CODE_TTL_HOURS;
  return Math.min(Math.max(hours, 1), MAX_CLAIM_CODE_TTL_HOURS);
}

function iso(value: Date): string {
  return value.toISOString();
}

function isoOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Constraint name of a Postgres unique_violation, whether raw from pg or
 * wrapped by Drizzle (`cause`); "" if pg did not name it, null if not 23505.
 */
export function uniqueViolationConstraint(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const { code, constraint, cause } = err as {
    code?: unknown;
    constraint?: unknown;
    cause?: unknown;
  };
  if (code === "23505") return typeof constraint === "string" ? constraint : "";
  return uniqueViolationConstraint(cause);
}

function isUniqueViolation(err: unknown): boolean {
  return uniqueViolationConstraint(err) !== null;
}

// ─── Units (admin) ───────────────────────────────────────────────────────────

async function unitView(db: ResidentDb | Tx, unitId: string): Promise<UnitView> {
  const rows = await db
    .select({
      id: units.id,
      label: units.label,
      isActive: units.isActive,
      createdAt: units.createdAt,
      deactivatedAt: units.deactivatedAt,
      activeResidentCount: sql<number>`(
        SELECT count(*)::int FROM ${residents}
        WHERE ${residents.unitId} = ${units.id} AND ${residents.isActive} = true
      )`,
    })
    .from(units)
    .where(eq(units.id, unitId));
  const row = rows[0];
  if (!row) {
    throw new ServiceError("UNIT_NOT_FOUND", "Unit not found", 404);
  }
  return {
    id: row.id,
    label: row.label,
    isActive: row.isActive,
    createdAt: iso(row.createdAt),
    deactivatedAt: isoOrNull(row.deactivatedAt),
    activeResidentCount: Number(row.activeResidentCount),
  };
}

export async function createUnit(
  input: { label: string },
  adminGuardId: string,
  db: ResidentDb,
): Promise<UnitView> {
  const traceId = `trace-${randomUUID()}`;
  const label = input.label.trim();

  let created: { id: string; event: AuditEvent };
  try {
    created = await db.transaction(async (tx) => {
      const rows = await tx
        .insert(units)
        .values({ label, createdByGuardId: adminGuardId })
        .returning({ id: units.id });
      const event = await emitAuditEvent(
        "unit_created",
        adminGuardId,
        traceId,
        { unitId: rows[0].id, label },
        { tx },
      );
      return { id: rows[0].id, event };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ServiceError(
        "UNIT_LABEL_TAKEN",
        "A unit with this label already exists",
        409,
        "label",
        traceId,
      );
    }
    throw err;
  }

  publishAuditEvent(created.event);
  return unitView(db, created.id);
}

export async function listUnits(
  db: ResidentDb,
  opts: { includeInactive?: boolean } = {},
): Promise<UnitView[]> {
  const rows = await db
    .select({
      id: units.id,
      label: units.label,
      isActive: units.isActive,
      createdAt: units.createdAt,
      deactivatedAt: units.deactivatedAt,
      activeResidentCount: sql<number>`(
        SELECT count(*)::int FROM ${residents}
        WHERE ${residents.unitId} = ${units.id} AND ${residents.isActive} = true
      )`,
    })
    .from(units)
    .where(opts.includeInactive ? undefined : eq(units.isActive, true))
    .orderBy(units.labelNorm);
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    isActive: row.isActive,
    createdAt: iso(row.createdAt),
    deactivatedAt: isoOrNull(row.deactivatedAt),
    activeResidentCount: Number(row.activeResidentCount),
  }));
}

export type UnitDeactivated = UnitView & {
  expiredPassCount: number;
  deactivatedResidentCount: number;
  disabledRuleCount: number;
};

/**
 * Deactivates a unit. Per spec §10 decision 4, every open pass issued for the
 * unit's label is expired in the same transaction, and every active resident
 * of the unit is deactivated — a moved-out tenant keeps nothing.
 */
export async function deactivateUnit(
  unitId: string,
  adminGuardId: string,
  db: ResidentDb,
): Promise<UnitDeactivated> {
  const traceId = `trace-${randomUUID()}`;
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    const current = await tx
      .select({ id: units.id, label: units.label, isActive: units.isActive })
      .from(units)
      .where(eq(units.id, unitId))
      .for("update");
    const unit = current[0];
    if (!unit) {
      throw new ServiceError("UNIT_NOT_FOUND", "Unit not found", 404, undefined, traceId);
    }
    if (!unit.isActive) {
      throw new ServiceError(
        "UNIT_ALREADY_INACTIVE",
        "Unit is already deactivated",
        409,
        undefined,
        traceId,
      );
    }

    await tx
      .update(units)
      .set({
        isActive: false,
        deactivatedAt: now,
        deactivatedByGuardId: adminGuardId,
        updatedAt: now,
      })
      .where(eq(units.id, unitId));

    const deactivatedResidents = await tx
      .update(residents)
      .set({
        isActive: false,
        deactivatedAt: now,
        deactivatedByGuardId: adminGuardId,
        updatedAt: now,
      })
      .where(and(eq(residents.unitId, unitId), eq(residents.isActive, true)))
      .returning({ id: residents.id });

    // Open passes for this unit label (case-insensitive, like the matching
    // engine): unused and not yet expired → expire now.
    const expiredPasses = await tx
      .update(authorizationDecisions)
      .set({ expiresAt: now })
      .where(
        and(
          sql`lower(trim(${authorizationDecisions.unit})) = ${normalizeUnitLabel(unit.label)}`,
          eq(authorizationDecisions.isUsed, false),
          sql`${authorizationDecisions.expiresAt} > ${now}`,
        ),
      )
      .returning({ id: authorizationDecisions.id });

    // Standing auto-approval rules for the label are passes too: a unit that
    // no longer exists must not keep waving visitors through.
    const disabledRules = await tx
      .update(autoApprovalRules)
      .set({ active: false, updatedAt: now })
      .where(
        and(
          sql`lower(trim(${autoApprovalRules.unit})) = ${normalizeUnitLabel(unit.label)}`,
          eq(autoApprovalRules.active, true),
        ),
      )
      .returning({ id: autoApprovalRules.id });

    const event = await emitAuditEvent(
      "unit_deactivated",
      adminGuardId,
      traceId,
      {
        unitId,
        label: unit.label,
        deactivatedResidentCount: deactivatedResidents.length,
        expiredPassCount: expiredPasses.length,
        disabledRuleCount: disabledRules.length,
      },
      { tx },
    );

    return {
      event,
      expiredPassCount: expiredPasses.length,
      deactivatedResidentCount: deactivatedResidents.length,
      disabledRuleCount: disabledRules.length,
    };
  });

  publishAuditEvent(result.event);
  const view = await unitView(db, unitId);
  return {
    ...view,
    expiredPassCount: result.expiredPassCount,
    deactivatedResidentCount: result.deactivatedResidentCount,
    disabledRuleCount: result.disabledRuleCount,
  };
}

// ─── Claim codes (admin) ─────────────────────────────────────────────────────

export async function issueClaimCode(
  input: { unitId: string; ttlHours?: number },
  adminGuardId: string,
  db: ResidentDb,
): Promise<ClaimCodeIssued> {
  const traceId = `trace-${randomUUID()}`;
  const ttlHours = clampClaimCodeTtlHours(input.ttlHours);
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

  // code_hash is UNIQUE; on the astronomically rare collision, re-mint.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const normalized = generateClaimCode();
    const codeHash = hashClaimCode(normalized);
    try {
      // The unit row is share-locked so a concurrent deactivateUnit (FOR
      // UPDATE) cannot commit between the active check and the insert; the
      // code row and its audit row commit together or not at all.
      const issued = await db.transaction(async (tx) => {
        const unitRows = await tx
          .select({ id: units.id, label: units.label, isActive: units.isActive })
          .from(units)
          .where(eq(units.id, input.unitId))
          .for("share");
        const unit = unitRows[0];
        if (!unit) {
          throw new ServiceError("UNIT_NOT_FOUND", "Unit not found", 404, "unitId", traceId);
        }
        if (!unit.isActive) {
          throw new ServiceError(
            "UNIT_INACTIVE",
            "Cannot issue a claim code for a deactivated unit",
            409,
            "unitId",
            traceId,
          );
        }

        const rows = await tx
          .insert(unitClaimCodes)
          .values({
            unitId: unit.id,
            codeHash,
            issuedByGuardId: adminGuardId,
            expiresAt,
          })
          .returning({ id: unitClaimCodes.id });
        const claimCodeId = rows[0].id;

        const event = await emitAuditEvent(
          "unit_claim_code_issued",
          adminGuardId,
          traceId,
          { claimCodeId, unitId: unit.id, label: unit.label, expiresAt: iso(expiresAt) },
          { tx },
        );
        return { claimCodeId, unit, event };
      });

      publishAuditEvent(issued.event);
      return {
        claimCodeId: issued.claimCodeId,
        unitId: issued.unit.id,
        unitLabel: issued.unit.label,
        code: formatClaimCode(normalized),
        expiresAt: iso(expiresAt),
      };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new ServiceError(
    "INTERNAL_ERROR",
    "Could not mint a unique claim code",
    500,
    undefined,
    traceId,
  );
}

// ─── Claim (resident) ────────────────────────────────────────────────────────

/** A refusal that counts against the caller's lockout budget. */
class ClaimRefusal extends ServiceError {
  constructor(code: string, message: string, statusCode: number, traceId: string) {
    super(code, message, statusCode, "code", traceId);
    this.name = "ClaimRefusal";
  }
}

async function readLock(
  db: ResidentDb,
  supabaseUserId: string,
): Promise<{ failedAttempts: number; lockedUntil: Date | null } | null> {
  const rows = await db
    .select({
      failedAttempts: residentClaimAttempts.failedAttempts,
      lockedUntil: residentClaimAttempts.lockedUntil,
    })
    .from(residentClaimAttempts)
    .where(eq(residentClaimAttempts.supabaseUserId, supabaseUserId));
  return rows[0] ?? null;
}

async function recordClaimFailure(
  db: ResidentDb,
  supabaseUserId: string,
): Promise<{ attemptsRemaining: number; lockedUntil: Date | null }> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - CLAIM_LOCK_WINDOW_MS);
  const rows = await db
    .insert(residentClaimAttempts)
    .values({
      supabaseUserId,
      failedAttempts: 1,
      lastFailedAt: now,
      lockedUntil: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: residentClaimAttempts.supabaseUserId,
      set: {
        // Failures older than the window are forgotten: the count restarts.
        failedAttempts: sql`CASE WHEN ${residentClaimAttempts.lastFailedAt} IS NULL OR ${residentClaimAttempts.lastFailedAt} < ${windowStart} THEN 1 ELSE ${residentClaimAttempts.failedAttempts} + 1 END`,
        lastFailedAt: now,
        updatedAt: now,
      },
    })
    .returning({ failedAttempts: residentClaimAttempts.failedAttempts });

  const failed = rows[0].failedAttempts;
  if (failed >= MAX_CLAIM_ATTEMPTS) {
    const lockedUntil = new Date(now.getTime() + CLAIM_LOCK_WINDOW_MS);
    await db
      .update(residentClaimAttempts)
      .set({ lockedUntil, failedAttempts: 0, updatedAt: now })
      .where(eq(residentClaimAttempts.supabaseUserId, supabaseUserId));
    return { attemptsRemaining: 0, lockedUntil };
  }
  return { attemptsRemaining: MAX_CLAIM_ATTEMPTS - failed, lockedUntil: null };
}

/**
 * Redeems a claim code: creates the resident row and marks the code used in
 * ONE transaction. Refusals for a wrong / used / expired code are generic to
 * the caller ("invalid or expired") and count toward the caller's lockout.
 */
export async function claimUnit(
  input: ClaimInput,
  db: ResidentDb,
): Promise<ResidentView> {
  const traceId = `trace-${randomUUID()}`;
  const now = new Date();

  const lock = await readLock(db, input.supabaseUserId);
  if (lock?.lockedUntil && lock.lockedUntil.getTime() > now.getTime()) {
    throw new ServiceError(
      "CLAIM_LOCKED",
      "Too many incorrect codes. Try again later.",
      423,
      "code",
      traceId,
    );
  }

  if (!input.phoneE164 || !E164.test(input.phoneE164)) {
    throw new ServiceError(
      "CLAIM_PHONE_REQUIRED",
      "A verified phone number is required to claim a unit",
      400,
      undefined,
      traceId,
    );
  }
  const phoneE164 = input.phoneE164;
  const displayName = input.displayName.trim();
  const codeHash = hashClaimCode(normalizeClaimCode(input.code));

  let outcome: { residentId: string; event: AuditEvent };
  try {
    outcome = await db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: residents.id })
        .from(residents)
        .where(and(eq(residents.supabaseUserId, input.supabaseUserId), eq(residents.isActive, true)))
        .for("update");
      if (existing.length > 0) {
        throw new ServiceError(
          "RESIDENT_ALREADY_CLAIMED",
          "This account is already linked to a unit",
          409,
          undefined,
          traceId,
        );
      }

      const codeRows = await tx
        .select({
          id: unitClaimCodes.id,
          unitId: unitClaimCodes.unitId,
          expiresAt: unitClaimCodes.expiresAt,
          unitLabel: units.label,
          unitActive: units.isActive,
        })
        .from(unitClaimCodes)
        .innerJoin(units, eq(units.id, unitClaimCodes.unitId))
        .where(and(eq(unitClaimCodes.codeHash, codeHash), isNull(unitClaimCodes.usedAt)))
        .for("update", { of: unitClaimCodes });
      const code = codeRows[0];

      // Wrong, already-used and unit-inactive are indistinguishable to the
      // caller on purpose: a code is either redeemable or it is not.
      if (!code || !code.unitActive) {
        throw new ClaimRefusal("CLAIM_CODE_INVALID", "This code is invalid or has expired.", 403, traceId);
      }
      if (code.expiresAt.getTime() <= now.getTime()) {
        throw new ClaimRefusal("CLAIM_CODE_EXPIRED", "This code is invalid or has expired.", 403, traceId);
      }

      // Share-lock the unit so a concurrent deactivateUnit cannot commit
      // between this check and the resident insert.
      const lockedUnit = await tx
        .select({ isActive: units.isActive })
        .from(units)
        .where(eq(units.id, code.unitId))
        .for("share");
      if (!lockedUnit[0]?.isActive) {
        throw new ClaimRefusal("CLAIM_CODE_INVALID", "This code is invalid or has expired.", 403, traceId);
      }

      // Every claim inserts a NEW membership row. A resident who moved out
      // (old row deactivated) gets a fresh row for the new unit, so the old
      // row — and everything referencing it — still resolves to the old unit.
      let inserted: { id: string };
      try {
        const rows = await tx
          .insert(residents)
          .values({
            supabaseUserId: input.supabaseUserId,
            unitId: code.unitId,
            displayName,
            phoneE164,
            claimedAt: now,
          })
          .returning({ id: residents.id });
        inserted = rows[0];
      } catch (err) {
        const constraint = uniqueViolationConstraint(err);
        if (constraint === "residents_active_user_unique") {
          throw new ServiceError(
            "RESIDENT_ALREADY_CLAIMED",
            "This account is already linked to a unit",
            409,
            undefined,
            traceId,
          );
        }
        if (constraint !== null) {
          throw new ServiceError(
            "RESIDENT_PHONE_TAKEN",
            "This phone number is already linked to a unit",
            409,
            undefined,
            traceId,
          );
        }
        throw err;
      }

      const consumed = await tx
        .update(unitClaimCodes)
        .set({ usedAt: now, usedByResidentId: inserted.id })
        .where(and(eq(unitClaimCodes.id, code.id), isNull(unitClaimCodes.usedAt)))
        .returning({ id: unitClaimCodes.id });
      if (consumed.length !== 1) {
        throw new ClaimRefusal("CLAIM_CODE_INVALID", "This code is invalid or has expired.", 403, traceId);
      }

      await tx
        .delete(residentClaimAttempts)
        .where(eq(residentClaimAttempts.supabaseUserId, input.supabaseUserId));

      const event = await emitResidentAuditEvent(
        "resident_claimed",
        inserted.id,
        traceId,
        { unitId: code.unitId, label: code.unitLabel, claimCodeId: code.id },
        { tx },
      );
      return { residentId: inserted.id, event };
    });
  } catch (err) {
    if (err instanceof ClaimRefusal) {
      const failure = await recordClaimFailure(db, input.supabaseUserId);
      if (failure.lockedUntil) {
        throw new ServiceError(
          "CLAIM_LOCKED",
          "Too many incorrect codes. Try again later.",
          423,
          "code",
          traceId,
        );
      }
    }
    throw err;
  }

  publishAuditEvent(outcome.event);
  return getResidentView(outcome.residentId, db);
}

// ─── Residents ───────────────────────────────────────────────────────────────

export async function getResidentView(residentId: string, db: ResidentDb): Promise<ResidentView> {
  const rows = await db
    .select({
      id: residents.id,
      displayName: residents.displayName,
      phoneE164: residents.phoneE164,
      isActive: residents.isActive,
      unitId: residents.unitId,
      unitLabel: units.label,
      claimedAt: residents.claimedAt,
      deactivatedAt: residents.deactivatedAt,
    })
    .from(residents)
    .innerJoin(units, eq(units.id, residents.unitId))
    .where(eq(residents.id, residentId));
  const row = rows[0];
  if (!row) {
    throw new ServiceError("RESIDENT_NOT_FOUND", "Resident not found", 404);
  }
  return {
    id: row.id,
    displayName: row.displayName,
    phoneE164: row.phoneE164,
    isActive: row.isActive,
    unitId: row.unitId,
    unitLabel: row.unitLabel,
    claimedAt: iso(row.claimedAt),
    deactivatedAt: isoOrNull(row.deactivatedAt),
  };
}

export async function listResidents(
  db: ResidentDb,
  opts: { unitId?: string; includeInactive?: boolean } = {},
): Promise<ResidentView[]> {
  const conditions = [];
  if (opts.unitId) conditions.push(eq(residents.unitId, opts.unitId));
  if (!opts.includeInactive) conditions.push(eq(residents.isActive, true));

  const rows = await db
    .select({
      id: residents.id,
      displayName: residents.displayName,
      phoneE164: residents.phoneE164,
      isActive: residents.isActive,
      unitId: residents.unitId,
      unitLabel: units.label,
      claimedAt: residents.claimedAt,
      deactivatedAt: residents.deactivatedAt,
    })
    .from(residents)
    .innerJoin(units, eq(units.id, residents.unitId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(units.labelNorm, residents.displayName);
  return rows.map((row) => ({
    id: row.id,
    displayName: row.displayName,
    phoneE164: row.phoneE164,
    isActive: row.isActive,
    unitId: row.unitId,
    unitLabel: row.unitLabel,
    claimedAt: iso(row.claimedAt),
    deactivatedAt: isoOrNull(row.deactivatedAt),
  }));
}

export async function deactivateResident(
  residentId: string,
  adminGuardId: string,
  db: ResidentDb,
): Promise<ResidentView> {
  const traceId = `trace-${randomUUID()}`;
  const now = new Date();

  const event = await db.transaction(async (tx) => {
    const updated = await tx
      .update(residents)
      .set({
        isActive: false,
        deactivatedAt: now,
        deactivatedByGuardId: adminGuardId,
        updatedAt: now,
      })
      .where(and(eq(residents.id, residentId), eq(residents.isActive, true)))
      .returning({ id: residents.id, unitId: residents.unitId });

    if (updated.length !== 1) {
      const exists = await tx
        .select({ id: residents.id })
        .from(residents)
        .where(eq(residents.id, residentId));
      if (exists.length === 0) {
        throw new ServiceError("RESIDENT_NOT_FOUND", "Resident not found", 404, undefined, traceId);
      }
      throw new ServiceError(
        "RESIDENT_ALREADY_INACTIVE",
        "Resident is already deactivated",
        409,
        undefined,
        traceId,
      );
    }

    // Rules this resident registered (household members, vehicles) stop
    // firing with their access; the vehicle path also checks is_active.
    const disabledRules = await tx
      .update(autoApprovalRules)
      .set({ active: false, updatedAt: now })
      .where(
        and(
          eq(autoApprovalRules.createdByResidentId, residentId),
          eq(autoApprovalRules.active, true),
        ),
      )
      .returning({ id: autoApprovalRules.id });

    return emitAuditEvent(
      "resident_deactivated",
      adminGuardId,
      traceId,
      { residentId, unitId: updated[0].unitId, disabledRuleCount: disabledRules.length },
      { tx },
    );
  });

  publishAuditEvent(event);
  return getResidentView(residentId, db);
}
