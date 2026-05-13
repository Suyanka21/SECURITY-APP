/**
 * GatePass — QR Validation Service
 *
 * Source: gatepass-api-contract.md §3.1 — POST /api/entries/qr/validate
 * Security: SHA-256 hash lookup, replay prevention, expiry checks.
 *
 * Decision flow:
 * 1. Hash raw QR token (never store raw tokens)
 * 2. Look up authorization_decisions by qr_token_hash
 * 3. Check: not found → QR_NOT_FOUND
 * 4. Check: already used → QR_REPLAYED (replay attack)
 * 5. Check: expired → QR_EXPIRED
 * 6. Mark as used: is_used=true, used_at=now, used_by_guard_id
 * 7. Return visitor data
 */

import { eq } from "drizzle-orm";
import { createHash, randomUUID } from "crypto";
import { guards, authorizationDecisions } from "@/db/schema";
import { ServiceError } from "./entry-service";
import { QrErrorCodes } from "../validation/qr-schemas";
import type { QrValidateInput, QrValidateResponse } from "../validation/qr-schemas";
import type { DrizzleDB } from "./entry-service";
import { emitAuditEvent } from "./audit-logger";

/**
 * Validates a QR token and returns the pre-approval data.
 *
 * Source: contract §3.1
 * Security: Never stores or logs raw QR tokens — SHA-256 hash only.
 *
 * Hard rules enforced:
 * - Every QR scan produces a stored decision (authorization_decisions updated)
 * - Replay attacks prevented via is_used flag
 * - Expired QR codes rejected at validation layer
 */
export async function validateQrToken(
  input: QrValidateInput,
  db: DrizzleDB
): Promise<{ response: QrValidateResponse; statusCode: number }> {
  const traceId = `trace-${randomUUID()}`;

  // Step 1: Verify guard exists and is active
  // Source: contract §3.1 — "Must resolve to active guard session"
  const guard = await (db as any)
    .select({ id: guards.id, isActive: guards.isActive })
    .from(guards)
    .where(eq(guards.id, input.guardId))
    .limit(1);

  if (!guard || guard.length === 0 || !guard[0].isActive) {
    await emitAuditEvent("qr_scan_rejected", input.guardId, traceId, {
      reason: "GUARD_SESSION_EXPIRED",
      qrTokenHash: "[not-computed]",
    });
    throw new ServiceError(
      QrErrorCodes.GUARD_SESSION_EXPIRED,
      "Guard identity not found or session expired",
      403,
      "guardId"
    );
  }

  // Step 2: Hash the QR token — NEVER store or compare raw tokens
  // Source: Security-and-Hardening skill — "Hash sensitive tokens"
  const qrTokenHash = hashQrToken(input.qrToken);

  // Step 3: Look up authorization_decisions by hash
  const approval = await (db as any)
    .select()
    .from(authorizationDecisions)
    .where(eq(authorizationDecisions.qrTokenHash, qrTokenHash))
    .limit(1);

  if (!approval || approval.length === 0) {
    await emitAuditEvent("qr_scan_rejected", input.guardId, traceId, {
      reason: "QR_NOT_FOUND",
      qrTokenHash,
    });
    throw new ServiceError(
      QrErrorCodes.QR_NOT_FOUND,
      "QR token does not match any pre-approval record",
      404,
      "qrToken"
    );
  }

  const record = approval[0];

  // Step 4: Check if already used — replay attack prevention
  // Source: contract §3.1 — "409 QR_REPLAYED: Token already used"
  if (record.isUsed) {
    await emitAuditEvent("qr_scan_rejected", input.guardId, traceId, {
      reason: "QR_REPLAYED",
      qrTokenHash,
      previouslyUsedBy: record.usedByGuardId,
      previouslyUsedAt: record.usedAt,
    });
    throw new ServiceError(
      QrErrorCodes.QR_REPLAYED,
      "This QR code has already been used — possible replay attack",
      409,
      "qrToken"
    );
  }

  // Step 5: Check expiry
  // Source: contract §3.1 — "410 QR_EXPIRED: Token past expiresAt window"
  const expiresAt = new Date(record.expiresAt);
  if (expiresAt < new Date()) {
    await emitAuditEvent("qr_scan_rejected", input.guardId, traceId, {
      reason: "QR_EXPIRED",
      qrTokenHash,
      expiredAt: expiresAt.toISOString(),
    });
    throw new ServiceError(
      QrErrorCodes.QR_EXPIRED,
      "This QR code has expired",
      410,
      "qrToken"
    );
  }

  // Step 6: Mark as used — decision recorded
  // Hard rule: "every decision must produce a stored AuthorizationDecision"
  const now = new Date();
  await (db as any)
    .update(authorizationDecisions)
    .set({
      isUsed: true,
      usedAt: now,
      usedByGuardId: input.guardId,
    })
    .where(eq(authorizationDecisions.id, record.id));

  // Step 7: Emit success audit event
  // Source: contract §5 — "qr_scan_succeeded" event
  await emitAuditEvent("qr_scan_succeeded", input.guardId, traceId, {
    qrTokenHash,
    preApprovalId: record.id,
    visitorName: record.visitorName,
    unit: record.unit,
  });

  // Step 8: Return structured response
  // Source: contract §3.1 — QrValidateResponse
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

/**
 * Hashes a raw QR token using SHA-256.
 * Source: Security-and-Hardening skill — "Hash tokens before storage/comparison"
 */
export function hashQrToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}
