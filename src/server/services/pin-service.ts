/**
 * GatePass — One-Time PIN Backup Service (Feature 11 / Stage 4)
 *
 * Source: src/docs/specs/one-time-pin-backup.md §§5–6
 * Security: the raw PIN is NEVER stored or logged. Only
 *           HMAC-SHA256(PIN_PEPPER, "<decisionId>:<pin>") is persisted, so a
 *           DB leak cannot be brute-forced offline without the server pepper,
 *           and the per-record id salts each hash.
 *
 * Two responsibilities:
 *   1. Crypto primitives + generators used at invitation issue
 *      (generatePin / generatePassRef / hashPin).
 *   2. validatePinRedemption() — the guard redemption path. Mirrors
 *      qr-service.validateQrToken: guard identity from the verified JWT,
 *      shared authorization_decisions record, replay/expiry/lock checks,
 *      per-pass limiter, and audit on every branch.
 */

import { and, eq } from "drizzle-orm";
import { createHmac, randomInt, randomUUID, timingSafeEqual } from "crypto";

import { guards, authorizationDecisions } from "@/db/schema";
import { ServiceError } from "./entry-service";
import type { DrizzleDB } from "./entry-service";
import type { QrValidateResponse } from "../validation/qr-schemas";
import { PinErrorCodes } from "../validation/pin-schemas";
import type { PinValidateInput } from "../validation/pin-schemas";
import { emitAuditEvent } from "./audit-logger";

// ─── Limiter policy (HARD constants — not env-driven) ────────────────────────
// Source: spec §6 — "3–5 wrong guesses in a short window". We use 5 attempts
// and a 15-minute lock window: strict enough to defeat a 10^6 online brute
// force, lenient enough that an honest guard fat-fingering a digit is not
// permanently locked out of a legitimate visitor's pass.

export const MAX_PIN_ATTEMPTS = 5;
export const LOCK_WINDOW_MS = 15 * 60 * 1000;

// Crockford base32 alphabet (excludes I L O U). Used for the pass reference.
const PASS_REF_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PASS_REF_LENGTH = 8;

// ─── Crypto primitives ───────────────────────────────────────────────────────

/**
 * Resolves the server-side PIN pepper. Fails loud if unset — there is NO
 * insecure fallback secret (Security-and-Hardening — "never hardcode a
 * secret"). Operators set PIN_PEPPER in env; tests set it explicitly.
 */
export function resolvePinPepper(): string {
  const pepper = process.env.PIN_PEPPER;
  if (!pepper || pepper.length < 16) {
    throw new ServiceError(
      "INTERNAL_ERROR",
      "PIN backup is misconfigured (PIN_PEPPER missing)",
      500
    );
  }
  return pepper;
}

/** Generates a cryptographically random 6-digit PIN (leading zeros kept). */
export function generatePin(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/** Generates an 8-char Crockford-base32 pass reference (non-secret). */
export function generatePassRef(): string {
  let out = "";
  for (let i = 0; i < PASS_REF_LENGTH; i += 1) {
    out += PASS_REF_ALPHABET[randomInt(0, PASS_REF_ALPHABET.length)];
  }
  return out;
}

/**
 * Derives the stored PIN hash. Salted with the per-record id and peppered
 * with the server secret. Returned as lowercase hex.
 */
export function hashPin(decisionId: string, pin: string): string {
  return createHmac("sha256", resolvePinPepper())
    .update(`${decisionId}:${pin}`)
    .digest("hex");
}

/**
 * Constant-time comparison of a candidate PIN against the stored hash.
 * Never throws on length mismatch — returns false.
 */
export function verifyPin(
  decisionId: string,
  pin: string,
  storedHash: string | null
): boolean {
  if (!storedHash) return false;
  const candidate = hashPin(decisionId, pin);
  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

// ─── Redemption row shape ────────────────────────────────────────────────────

interface PinRow {
  id: string;
  visitorName: string;
  host: string;
  unit: string;
  plate: string | null;
  expiresAt: Date;
  isUsed: boolean;
  usedAt: Date | null;
  usedByGuardId: string | null;
  passRef: string | null;
  pinHash: string | null;
  pinFailedAttempts: number;
  pinLockedUntil: Date | null;
}

interface PinRedeemInput extends PinValidateInput {
  /** Guard ID injected from the verified JWT (requireAuth), NOT the body. */
  guardId: string;
}

// ─── Redeem ──────────────────────────────────────────────────────────────────

/**
 * Redeems a pass by pass reference + 6-digit PIN.
 *
 * Source: spec §6 decision flow. Default-deny: every rejection path audits
 * and throws a ServiceError; the PIN itself is never in any audit payload.
 *
 * Ordering (used → locked → expired → verify) is deliberate: a locked pass
 * is reported as locked BEFORE the PIN is checked, so a correct PIN cannot
 * shortcut an active lockout.
 */
export async function validatePinRedemption(
  input: PinRedeemInput,
  db: DrizzleDB
): Promise<{ response: QrValidateResponse; statusCode: number }> {
  const traceId = `trace-${randomUUID()}`;

  // Step 1: guard must exist and be active (mirrors qr-service).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const guard = await (db as any)
    .select({ id: guards.id, isActive: guards.isActive })
    .from(guards)
    .where(eq(guards.id, input.guardId))
    .limit(1);

  if (!guard || guard.length === 0 || !guard[0].isActive) {
    await emitAuditEvent("pin_failed", input.guardId, traceId, {
      reason: "GUARD_SESSION_EXPIRED",
      passRef: input.passRef,
    });
    throw new ServiceError(
      PinErrorCodes.GUARD_SESSION_EXPIRED,
      "Guard identity not found or session expired",
      403,
      "guardId"
    );
  }

  // Step 2: look up the pass by its (non-secret) reference.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (await (db as any)
    .select()
    .from(authorizationDecisions)
    .where(eq(authorizationDecisions.passRef, input.passRef))
    .limit(1)) as PinRow[];

  if (!rows || rows.length === 0) {
    // No pass to lock — a wrong reference is a failed attempt but cannot be
    // attributed to a record. Per-pass lockout still protects PIN guessing.
    await emitAuditEvent("pin_failed", input.guardId, traceId, {
      reason: "PIN_NOT_FOUND",
      passRef: input.passRef,
    });
    throw new ServiceError(
      PinErrorCodes.PIN_NOT_FOUND,
      "No pass matches this reference",
      404,
      "passRef"
    );
  }

  const record = rows[0];
  const now = new Date();
  // Timestamps come back as Date from Drizzle, but coerce defensively so a
  // string (e.g. from a serialised fixture) is handled identically.
  const expiresAt = new Date(record.expiresAt);
  const lockedUntil = record.pinLockedUntil
    ? new Date(record.pinLockedUntil)
    : null;

  // Step 3: already consumed (by QR or an earlier PIN redemption).
  if (record.isUsed) {
    await emitAuditEvent("pin_failed", input.guardId, traceId, {
      reason: "PIN_REPLAYED",
      preApprovalId: record.id,
      passRef: input.passRef,
    });
    throw new ServiceError(
      PinErrorCodes.PIN_REPLAYED,
      "This pass has already been used",
      409,
      "pin"
    );
  }

  // Step 4: locked? Checked BEFORE the PIN is verified.
  if (lockedUntil && lockedUntil.getTime() > now.getTime()) {
    await emitAuditEvent("pin_failed", input.guardId, traceId, {
      reason: "LOCKED",
      preApprovalId: record.id,
      passRef: input.passRef,
      lockedUntil: lockedUntil.toISOString(),
    });
    throw new ServiceError(
      PinErrorCodes.PIN_LOCKED,
      "This pass is locked after too many incorrect PIN attempts",
      423,
      "pin"
    );
  }

  // Step 5: expired? PIN expiry == QR expiry (same column).
  if (expiresAt.getTime() <= now.getTime()) {
    await emitAuditEvent("pin_failed", input.guardId, traceId, {
      reason: "PIN_EXPIRED",
      preApprovalId: record.id,
      passRef: input.passRef,
      expiredAt: expiresAt.toISOString(),
    });
    throw new ServiceError(
      PinErrorCodes.PIN_EXPIRED,
      "This pass has expired",
      410,
      "pin"
    );
  }

  // Step 6: legacy row with no PIN on file — treat as not found so the
  // response never leaks that a pass exists but has no PIN.
  if (!record.pinHash) {
    await emitAuditEvent("pin_failed", input.guardId, traceId, {
      reason: "PIN_NOT_FOUND",
      preApprovalId: record.id,
      passRef: input.passRef,
    });
    throw new ServiceError(
      PinErrorCodes.PIN_NOT_FOUND,
      "No pass matches this reference",
      404,
      "passRef"
    );
  }

  // Step 7: verify the PIN in constant time.
  if (!verifyPin(record.id, input.pin, record.pinHash)) {
    const attempts = record.pinFailedAttempts + 1;
    const willLock = attempts >= MAX_PIN_ATTEMPTS;
    const lockedUntil = willLock
      ? new Date(now.getTime() + LOCK_WINDOW_MS)
      : null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any)
      .update(authorizationDecisions)
      .set({
        pinFailedAttempts: attempts,
        ...(willLock ? { pinLockedUntil: lockedUntil } : {}),
      })
      .where(eq(authorizationDecisions.id, record.id));

    const attemptsRemaining = Math.max(0, MAX_PIN_ATTEMPTS - attempts);

    await emitAuditEvent("pin_failed", input.guardId, traceId, {
      reason: "PIN_INVALID",
      preApprovalId: record.id,
      passRef: input.passRef,
      attemptsRemaining,
    });

    if (willLock && lockedUntil) {
      await emitAuditEvent("pin_locked", input.guardId, traceId, {
        preApprovalId: record.id,
        passRef: input.passRef,
        lockedUntil: lockedUntil.toISOString(),
      });
      throw new ServiceError(
        PinErrorCodes.PIN_LOCKED,
        "This pass is locked after too many incorrect PIN attempts",
        423,
        "pin"
      );
    }

    throw new ServiceError(
      PinErrorCodes.PIN_INVALID,
      `Incorrect PIN — ${attemptsRemaining} attempt(s) remaining before lockout`,
      401,
      "pin"
    );
  }

  // Step 8: success — consume the SHARED record (invalidates the QR too),
  // reset the failure counter. The update is guarded on `is_used = false`
  // and RETURNs the affected rows so a QR scan (or a second PIN redemption)
  // racing on the same record can't double-consume: exactly one writer wins
  // the conditional update; the loser sees zero rows and is rejected as a
  // replay. Source: spec §6 — "using either invalidates both".
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const consumed = (await (db as any)
    .update(authorizationDecisions)
    .set({
      isUsed: true,
      usedAt: now,
      usedByGuardId: input.guardId,
      pinFailedAttempts: 0,
    })
    .where(
      and(
        eq(authorizationDecisions.id, record.id),
        eq(authorizationDecisions.isUsed, false)
      )
    )
    .returning({ id: authorizationDecisions.id })) as { id: string }[];

  if (!consumed || consumed.length === 0) {
    // Lost the race — another redemption consumed this record first.
    await emitAuditEvent("pin_failed", input.guardId, traceId, {
      reason: "PIN_REPLAYED",
      preApprovalId: record.id,
      passRef: input.passRef,
    });
    throw new ServiceError(
      PinErrorCodes.PIN_REPLAYED,
      "This pass has already been used",
      409,
      "pin"
    );
  }

  await emitAuditEvent("pin_redeemed", input.guardId, traceId, {
    preApprovalId: record.id,
    passRef: input.passRef,
    visitorName: record.visitorName,
    unit: record.unit,
  });

  // Step 9: same response shape as the QR path so the client reuses the
  // scan-confirmation screen (incl. Feature 10 vehicle verification).
  const response: QrValidateResponse = {
    outcome: "valid",
    visitor: {
      name: record.visitorName,
      host: record.host,
      unit: record.unit,
      plate: record.plate ?? null,
      preApprovalId: record.id,
    },
    expiresAt: expiresAt.toISOString(),
    traceId,
  };

  return { response, statusCode: 200 };
}
