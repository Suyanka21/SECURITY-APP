/**
 * GatePass — resident-issued visitor passes (Resident Portal R2, capability 1).
 *
 * Source: src/docs/specs/resident-portal.md §4.
 *
 * A resident mints the same single-use pass the staff route mints (same
 * authorization_decisions row, same /pass/:token preview, same guard QR/PIN
 * redemption). What differs is who decides the fields:
 *   - host and unit come from the resident's DB row, never from the body;
 *   - TTL is capped at RESIDENT_MAX_PASS_TTL_HOURS;
 *   - at most RESIDENT_MAX_OPEN_PASSES_PER_UNIT unused, unexpired
 *     resident-issued passes may exist per unit.
 *
 * Everything runs in one transaction that locks the unit row FOR UPDATE:
 * concurrent issues for the same unit serialize on it (so the cap cannot be
 * raced past), and deactivateUnit (also FOR UPDATE) cannot interleave between
 * the active check and the insert. The resident row is share-locked so a
 * concurrent deactivateResident cannot either. The pass row and its
 * qr_invitation_issued audit row commit together; the audit event is
 * published to the in-memory log/stdout only after commit.
 */

import { randomUUID } from "crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";

import * as schema from "@/db/schema";
import type { ResidentIdentity } from "../middleware/resident-auth";
import type { IssueInvitationResponse } from "../validation/visitor-invitation-schemas";
import { emitResidentAuditEvent, publishAuditEvent } from "./audit-logger";
import { ServiceError } from "./errors";
import { generatePassRef, generatePin, hashPin } from "./pin-service";
import { hashQrToken } from "./qr-service";
import { normalizeUnitLabel, uniqueViolationConstraint, type ResidentDb } from "./resident-service";
import { buildPassUrl, mintRawToken } from "./visitor-invitation-service";

const { authorizationDecisions, residents, units } = schema;

export const RESIDENT_DEFAULT_PASS_TTL_HOURS = 24;
export const RESIDENT_MAX_PASS_TTL_HOURS = 48;
export const RESIDENT_MAX_OPEN_PASSES_PER_UNIT = 10;

const PASS_REF_CONSTRAINT = "authorization_decisions_pass_ref_unique";
const MAX_PASS_REF_ATTEMPTS = 4;

export const ResidentPassErrorCodes = {
  RESIDENT_INACTIVE: "RESIDENT_INACTIVE",
  UNIT_INACTIVE: "UNIT_INACTIVE",
  RESIDENT_PASS_LIMIT_REACHED: "RESIDENT_PASS_LIMIT_REACHED",
} as const;

export interface ResidentPassInput {
  visitorName: string;
  plate: string | null;
  ttlHours: number;
}

export async function issueResidentPass(
  input: ResidentPassInput,
  resident: ResidentIdentity,
  db: ResidentDb,
): Promise<IssueInvitationResponse> {
  const traceId = `trace-${randomUUID()}`;
  const ttlHours = Math.min(
    Math.max(Math.trunc(input.ttlHours), 1),
    RESIDENT_MAX_PASS_TTL_HOURS,
  );

  const rawToken = mintRawToken();
  const qrTokenHash = hashQrToken(rawToken);
  const decisionId = randomUUID();
  const rawPin = generatePin();
  const pinHash = hashPin(decisionId, rawPin);

  const { row, passRef, event } = await db.transaction(async (tx) => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);

    const lockedUnit = (
      await tx
        .select({ label: units.label, isActive: units.isActive })
        .from(units)
        .where(eq(units.id, resident.unitId))
        .for("update")
    )[0];
    if (!lockedUnit?.isActive) {
      throw new ServiceError(
        ResidentPassErrorCodes.UNIT_INACTIVE,
        "Your unit is no longer active. Contact estate management.",
        403,
        undefined,
        traceId,
      );
    }

    const lockedResident = (
      await tx
        .select({
          displayName: residents.displayName,
          unitId: residents.unitId,
          isActive: residents.isActive,
        })
        .from(residents)
        .where(eq(residents.id, resident.residentId))
        .for("share")
    )[0];
    if (!lockedResident?.isActive || lockedResident.unitId !== resident.unitId) {
      throw new ServiceError(
        ResidentPassErrorCodes.RESIDENT_INACTIVE,
        "Your resident access is no longer active. Contact estate management.",
        403,
        undefined,
        traceId,
      );
    }

    const [{ open }] = await tx
      .select({ open: sql<number>`count(*)::int` })
      .from(authorizationDecisions)
      .where(
        and(
          isNotNull(authorizationDecisions.issuedByResidentId),
          sql`lower(trim(${authorizationDecisions.unit})) = ${normalizeUnitLabel(lockedUnit.label)}`,
          eq(authorizationDecisions.isUsed, false),
          sql`${authorizationDecisions.expiresAt} > ${now}`,
        ),
      );
    if (open >= RESIDENT_MAX_OPEN_PASSES_PER_UNIT) {
      throw new ServiceError(
        ResidentPassErrorCodes.RESIDENT_PASS_LIMIT_REACHED,
        `Your unit already has ${RESIDENT_MAX_OPEN_PASSES_PER_UNIT} open passes. Wait for one to be used or expire.`,
        409,
        undefined,
        traceId,
      );
    }

    let ref = generatePassRef();
    for (let attempt = 1; ; attempt += 1) {
      try {
        // Savepoint per attempt: a pass_ref collision must not abort the
        // outer transaction holding the unit lock.
        const inserted = await tx.transaction((sp) =>
          sp
            .insert(authorizationDecisions)
            .values({
              id: decisionId,
              visitorName: input.visitorName,
              host: lockedResident.displayName,
              unit: lockedUnit.label,
              plate: input.plate,
              qrTokenHash,
              expiresAt,
              isUsed: false,
              passRef: ref,
              pinHash,
              pinFailedAttempts: 0,
              issuedByResidentId: resident.residentId,
            })
            .returning(),
        );

        const audit = await emitResidentAuditEvent(
          "qr_invitation_issued",
          resident.residentId,
          traceId,
          {
            invitationId: decisionId,
            qrTokenHash,
            expiresAt: expiresAt.toISOString(),
            ttlHours,
            visitorName: input.visitorName,
            host: lockedResident.displayName,
            unit: lockedUnit.label,
            unitId: resident.unitId,
            issuedBy: "resident",
          },
          { tx },
        );
        return { row: inserted[0], passRef: ref, event: audit };
      } catch (err) {
        if (
          uniqueViolationConstraint(err) === PASS_REF_CONSTRAINT &&
          attempt < MAX_PASS_REF_ATTEMPTS
        ) {
          ref = generatePassRef();
          continue;
        }
        throw err;
      }
    }
  });

  publishAuditEvent(event);

  return {
    invitation: {
      id: row.id,
      qrToken: rawToken,
      passUrl: buildPassUrl(rawToken),
      passRef,
      pin: rawPin,
      visitorName: row.visitorName,
      host: row.host,
      unit: row.unit,
      plate: row.plate,
      expiresAt: row.expiresAt.toISOString(),
      issuedAt: row.createdAt.toISOString(),
    },
    traceId,
  };
}
