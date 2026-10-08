/**
 * GatePass — resident household members, workers and vehicles
 * (Resident Portal R3, capabilities 2 and 3).
 *
 * Source: src/docs/specs/resident-portal.md §3.4, §11.
 *
 * A registration is a resident-owned unit_registrations row that owns one
 * visitor_profiles row and one auto_approval_rules row it created, so the
 * existing evaluate() does the matching:
 *   - person:  rule (name, resident's name as host, unit) — exact match, as
 *              for every other rule;
 *   - vehicle: rule pinned to the plate; evaluate() also matches it on
 *              unit + plate alone (resident-vehicle path).
 *
 * Host and unit come from the locked resident / unit rows, never the body.
 * Residents never set notes, watch_flag or staff attribution. Every write
 * (registration, profile, rule, audit row) commits in one transaction; the
 * audit event is published to the in-memory log/stdout only after commit.
 * Lock order matches resident-pass-service: unit, then resident.
 */

import { randomUUID } from "crypto";
import { and, eq, isNotNull, isNull, ne, sql, type SQL } from "drizzle-orm";

import * as schema from "@/db/schema";
import type { ResidentIdentity } from "../middleware/resident-auth";
import { emitAuditEvent, emitResidentAuditEvent, publishAuditEvent, type AuditEvent } from "./audit-logger";
import { ServiceError } from "./errors";
import { ResidentPassErrorCodes } from "./resident-pass-service";
import { normalizeUnitLabel, uniqueViolationConstraint, type ResidentDb } from "./resident-service";

const { autoApprovalRules, residents, unitRegistrations, units, visitorProfiles } = schema;

type Tx = Parameters<Parameters<ResidentDb["transaction"]>[0]>[0];

export const RESIDENT_RULE_TTL_DAYS = 90;
export const RESIDENT_RENEW_PROMPT_DAYS = 14;
export const RESIDENT_MAX_REGISTRATIONS_PER_UNIT = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

export const RegistrationErrorCodes = {
  REGISTRATION_NOT_FOUND: "REGISTRATION_NOT_FOUND",
  REGISTRATION_DUPLICATE: "REGISTRATION_DUPLICATE",
  REGISTRATION_LIMIT_REACHED: "REGISTRATION_LIMIT_REACHED",
  REGISTRATION_DISABLED: "REGISTRATION_DISABLED",
  REGISTRATION_BLOCKED: "REGISTRATION_BLOCKED",
  REGISTRATION_NOT_BLOCKED: "REGISTRATION_NOT_BLOCKED",
} as const;

export type RegistrationKind = "person" | "vehicle";

export type CreateRegistrationInput =
  | { kind: "person"; label: string }
  | { kind: "vehicle"; label: string; plate: string };

export type RegistrationStatus = "active" | "renew_due" | "expired" | "disabled";

export interface RegistrationView {
  id: string;
  kind: RegistrationKind;
  label: string;
  plate: string | null;
  status: RegistrationStatus;
  expiresAt: string;
  createdAt: string;
}

interface RegistrationJoinRow {
  id: string;
  kind: string;
  label: string;
  plate: string | null;
  createdAt: Date;
  expiresAt: Date;
  active: boolean;
}

export function registrationStatus(
  active: boolean,
  expiresAt: Date,
  now: Date,
): RegistrationStatus {
  if (!active) return "disabled";
  const remaining = expiresAt.getTime() - now.getTime();
  if (remaining <= 0) return "expired";
  if (remaining < RESIDENT_RENEW_PROMPT_DAYS * DAY_MS) return "renew_due";
  return "active";
}

function toView(row: RegistrationJoinRow, now: Date): RegistrationView {
  return {
    id: row.id,
    kind: row.kind === "vehicle" ? "vehicle" : "person",
    label: row.label,
    plate: row.plate,
    status: registrationStatus(row.active, row.expiresAt, now),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Name written into visitor_profiles / auto_approval_rules for the registration. */
export function registrationVisitorName(input: CreateRegistrationInput): string {
  return input.kind === "vehicle" ? `${input.label} (${input.plate})` : input.label;
}

/**
 * Matches registrations of the same subject: same normalized plate for a
 * vehicle, same normalized name for a person. This is the key a staff block
 * is enforced on, so it survives the blocked row being removed.
 */
function sameSubject(kind: RegistrationKind, label: string, plate: string | null): SQL {
  return kind === "vehicle"
    ? sql`${unitRegistrations.plateNorm} = upper(regexp_replace(coalesce(${plate}, ''), '[^0-9A-Za-z]', '', 'g'))`
    : sql`${unitRegistrations.labelNorm} = lower(regexp_replace(btrim(${label}), '\\s+', ' ', 'g'))`;
}

const activeBlock = and(isNotNull(unitRegistrations.blockedAt), isNull(unitRegistrations.blockClearedAt));

function duplicate(message: string, traceId: string): ServiceError {
  return new ServiceError(
    RegistrationErrorCodes.REGISTRATION_DUPLICATE,
    message,
    409,
    undefined,
    traceId,
  );
}

function notFound(traceId: string): ServiceError {
  return new ServiceError(
    RegistrationErrorCodes.REGISTRATION_NOT_FOUND,
    "Registration not found",
    404,
    undefined,
    traceId,
  );
}

async function lockUnitAndResident(
  tx: Tx,
  resident: ResidentIdentity,
  traceId: string,
  unitLock: "update" | "share",
): Promise<{ unitLabel: string; displayName: string }> {
  const lockedUnit = (
    await tx
      .select({ label: units.label, isActive: units.isActive })
      .from(units)
      .where(eq(units.id, resident.unitId))
      .for(unitLock)
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
  return { unitLabel: lockedUnit.label, displayName: lockedResident.displayName };
}

export async function createRegistration(
  input: CreateRegistrationInput,
  resident: ResidentIdentity,
  db: ResidentDb,
  now: () => Date = () => new Date(),
): Promise<RegistrationView> {
  const traceId = `trace-${randomUUID()}`;
  const plate = input.kind === "vehicle" ? input.plate : null;
  const visitorName = registrationVisitorName(input);

  try {
    const { view, event } = await db.transaction(async (tx) => {
      const { unitLabel, displayName } = await lockUnitAndResident(tx, resident, traceId, "update");

      const blocked = await tx
        .select({ id: unitRegistrations.id })
        .from(unitRegistrations)
        .where(
          and(
            eq(unitRegistrations.unitId, resident.unitId),
            eq(unitRegistrations.kind, input.kind),
            activeBlock,
            sameSubject(input.kind, input.label, plate),
          ),
        )
        .limit(1);
      if (blocked.length > 0) {
        throw new ServiceError(
          RegistrationErrorCodes.REGISTRATION_BLOCKED,
          input.kind === "vehicle"
            ? "Estate management has blocked this vehicle for your unit. Contact them to have it unblocked."
            : "Estate management has blocked this person for your unit. Contact them to have it unblocked.",
          409,
          undefined,
          traceId,
        );
      }

      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(unitRegistrations)
        .where(and(eq(unitRegistrations.unitId, resident.unitId), isNull(unitRegistrations.deletedAt)));
      if (count >= RESIDENT_MAX_REGISTRATIONS_PER_UNIT) {
        throw new ServiceError(
          RegistrationErrorCodes.REGISTRATION_LIMIT_REACHED,
          `Your unit already has ${RESIDENT_MAX_REGISTRATIONS_PER_UNIT} registrations. Remove one first.`,
          409,
          undefined,
          traceId,
        );
      }

      if (input.kind === "vehicle") {
        const clash = await tx
          .select({ id: unitRegistrations.id })
          .from(unitRegistrations)
          .where(
            and(
              eq(unitRegistrations.unitId, resident.unitId),
              eq(unitRegistrations.kind, "vehicle"),
              isNull(unitRegistrations.deletedAt),
              sql`${unitRegistrations.plateNorm} = upper(regexp_replace(${input.plate}, '[^0-9A-Za-z]', '', 'g'))`,
            ),
          );
        if (clash.length > 0) {
          throw duplicate("This vehicle is already registered for your unit.", traceId);
        }
      }

      const nameLower = visitorName.toLowerCase();
      const hostLower = displayName.toLowerCase();
      const unitNorm = normalizeUnitLabel(unitLabel);
      const profileClash = await tx
        .select({ id: visitorProfiles.id })
        .from(visitorProfiles)
        .where(
          and(
            sql`lower(${visitorProfiles.visitorName}) = ${nameLower}`,
            sql`lower(${visitorProfiles.host}) = ${hostLower}`,
            sql`lower(trim(${visitorProfiles.unit})) = ${unitNorm}`,
            isNull(visitorProfiles.deletedAt),
          ),
        );
      const ruleClash = await tx
        .select({ id: autoApprovalRules.id })
        .from(autoApprovalRules)
        .where(
          and(
            sql`lower(${autoApprovalRules.visitorName}) = ${nameLower}`,
            sql`lower(${autoApprovalRules.host}) = ${hostLower}`,
            sql`lower(trim(${autoApprovalRules.unit})) = ${unitNorm}`,
            eq(autoApprovalRules.active, true),
          ),
        );
      if (profileClash.length > 0 || ruleClash.length > 0) {
        throw duplicate(`"${visitorName}" is already registered for your unit.`, traceId);
      }

      const nowDate = now();
      const expiresAt = new Date(nowDate.getTime() + RESIDENT_RULE_TTL_DAYS * DAY_MS);

      const [profile] = await tx
        .insert(visitorProfiles)
        .values({
          visitorName,
          host: displayName,
          unit: unitLabel,
          plate,
          createdByResidentId: resident.residentId,
          createdAt: nowDate,
          updatedAt: nowDate,
        })
        .returning({ id: visitorProfiles.id });

      const [rule] = await tx
        .insert(autoApprovalRules)
        .values({
          visitorName,
          host: displayName,
          unit: unitLabel,
          plateRequired: plate,
          createdByResidentId: resident.residentId,
          active: true,
          expiresAt,
          createdAt: nowDate,
          updatedAt: nowDate,
        })
        .returning({ id: autoApprovalRules.id });

      const [registration] = await tx
        .insert(unitRegistrations)
        .values({
          unitId: resident.unitId,
          residentId: resident.residentId,
          kind: input.kind,
          label: input.label,
          plate,
          visitorProfileId: profile.id,
          autoApprovalRuleId: rule.id,
          createdAt: nowDate,
          updatedAt: nowDate,
        })
        .returning();

      const audit = await emitResidentAuditEvent(
        "resident_registration_created",
        resident.residentId,
        traceId,
        {
          registrationId: registration.id,
          kind: input.kind,
          label: input.label,
          plate,
          unitId: resident.unitId,
          unit: unitLabel,
          host: displayName,
          visitorProfileId: profile.id,
          autoApprovalRuleId: rule.id,
          expiresAt: expiresAt.toISOString(),
        },
        { tx },
      );

      return {
        view: toView({ ...registration, expiresAt, active: true }, nowDate),
        event: audit,
      };
    });

    publishAuditEvent(event);
    return view;
  } catch (err) {
    if (uniqueViolationConstraint(err) !== null) {
      throw duplicate(`"${visitorName}" is already registered for your unit.`, traceId);
    }
    throw err;
  }
}

export async function listRegistrations(
  resident: ResidentIdentity,
  db: ResidentDb,
  now: () => Date = () => new Date(),
): Promise<RegistrationView[]> {
  const rows = await db
    .select({
      id: unitRegistrations.id,
      kind: unitRegistrations.kind,
      label: unitRegistrations.label,
      plate: unitRegistrations.plate,
      createdAt: unitRegistrations.createdAt,
      expiresAt: autoApprovalRules.expiresAt,
      active: autoApprovalRules.active,
    })
    .from(unitRegistrations)
    .innerJoin(autoApprovalRules, eq(autoApprovalRules.id, unitRegistrations.autoApprovalRuleId))
    .where(
      and(
        eq(unitRegistrations.residentId, resident.residentId),
        eq(unitRegistrations.unitId, resident.unitId),
        isNull(unitRegistrations.deletedAt),
      ),
    )
    .orderBy(unitRegistrations.kind, unitRegistrations.createdAt);
  const nowDate = now();
  return rows.map((row) => toView(row, nowDate));
}

/**
 * Removes a resident's own registration: soft-deletes its profile and
 * switches off its rule in the same transaction. Another resident's (or
 * another unit's) registration is indistinguishable from a missing one.
 */
export async function removeRegistration(
  registrationId: string,
  resident: ResidentIdentity,
  db: ResidentDb,
  now: () => Date = () => new Date(),
): Promise<{ id: string }> {
  const traceId = `trace-${randomUUID()}`;

  const event = await db.transaction(async (tx) => {
    const [registration] = await tx
      .select()
      .from(unitRegistrations)
      .where(
        and(
          eq(unitRegistrations.id, registrationId),
          eq(unitRegistrations.residentId, resident.residentId),
          isNull(unitRegistrations.deletedAt),
        ),
      )
      .for("update");
    if (!registration) throw notFound(traceId);

    const nowDate = now();
    await tx
      .update(visitorProfiles)
      .set({ deletedAt: nowDate, deletedByResidentId: resident.residentId, updatedAt: nowDate })
      .where(and(eq(visitorProfiles.id, registration.visitorProfileId), isNull(visitorProfiles.deletedAt)));
    await tx
      .update(autoApprovalRules)
      .set({ active: false, updatedAt: nowDate })
      .where(eq(autoApprovalRules.id, registration.autoApprovalRuleId));
    await tx
      .update(unitRegistrations)
      .set({ deletedAt: nowDate, updatedAt: nowDate })
      .where(eq(unitRegistrations.id, registration.id));

    return emitResidentAuditEvent(
      "resident_registration_removed",
      resident.residentId,
      traceId,
      {
        registrationId: registration.id,
        kind: registration.kind,
        label: registration.label,
        plate: registration.plate,
        unitId: registration.unitId,
        unit: resident.unitLabel,
        visitorProfileId: registration.visitorProfileId,
        autoApprovalRuleId: registration.autoApprovalRuleId,
      },
      { tx },
    );
  });

  publishAuditEvent(event);
  return { id: registrationId };
}

/**
 * Extends a resident's own registration by RESIDENT_RULE_TTL_DAYS from now.
 * A rule switched off by staff (or by deactivation) stays off.
 */
export async function renewRegistration(
  registrationId: string,
  resident: ResidentIdentity,
  db: ResidentDb,
  now: () => Date = () => new Date(),
): Promise<RegistrationView> {
  const traceId = `trace-${randomUUID()}`;

  const { view, event } = await db.transaction(async (tx) => {
    await lockUnitAndResident(tx, resident, traceId, "share");

    const [registration] = await tx
      .select()
      .from(unitRegistrations)
      .where(
        and(
          eq(unitRegistrations.id, registrationId),
          eq(unitRegistrations.residentId, resident.residentId),
          isNull(unitRegistrations.deletedAt),
        ),
      )
      .for("update");
    if (!registration) throw notFound(traceId);

    const [rule] = await tx
      .select({ active: autoApprovalRules.active })
      .from(autoApprovalRules)
      .where(eq(autoApprovalRules.id, registration.autoApprovalRuleId))
      .for("update");
    if (!rule?.active) {
      throw new ServiceError(
        RegistrationErrorCodes.REGISTRATION_DISABLED,
        "Estate management has switched this registration off. Contact them to restore it.",
        409,
        undefined,
        traceId,
      );
    }

    const nowDate = now();
    const expiresAt = new Date(nowDate.getTime() + RESIDENT_RULE_TTL_DAYS * DAY_MS);
    await tx
      .update(autoApprovalRules)
      .set({ expiresAt, updatedAt: nowDate })
      .where(eq(autoApprovalRules.id, registration.autoApprovalRuleId));
    await tx
      .update(unitRegistrations)
      .set({ updatedAt: nowDate })
      .where(eq(unitRegistrations.id, registration.id));

    const audit = await emitResidentAuditEvent(
      "resident_registration_renewed",
      resident.residentId,
      traceId,
      {
        registrationId: registration.id,
        kind: registration.kind,
        unitId: registration.unitId,
        autoApprovalRuleId: registration.autoApprovalRuleId,
        expiresAt: expiresAt.toISOString(),
      },
      { tx },
    );
    return { view: toView({ ...registration, expiresAt, active: true }, nowDate), event: audit };
  });

  publishAuditEvent(event);
  return view;
}

// ─── Staff block ─────────────────────────────────────────────────────────────

type AutoApprovalRuleRow = typeof autoApprovalRules.$inferSelect;

/**
 * Admin switch-off of a resident-created rule. In one transaction: the rule
 * goes inactive, its registration is marked blocked by staff, and any other
 * live registration of the same subject in the unit has its rule switched
 * off too. While the block stands, createRegistration() refuses the same
 * plate/name for that unit. Idempotent: no audit when nothing changes.
 */
export async function blockResidentRule(
  guardId: string,
  ruleId: string,
  reason: string | null,
  db: ResidentDb,
  now: () => Date = () => new Date(),
): Promise<AutoApprovalRuleRow> {
  const traceId = `auto-approval-${ruleId}`;

  const { rule, events } = await db.transaction(async (tx) => {
    const [link] = await tx
      .select({ unitId: unitRegistrations.unitId })
      .from(unitRegistrations)
      .where(eq(unitRegistrations.autoApprovalRuleId, ruleId));
    if (link) {
      await tx.select({ id: units.id }).from(units).where(eq(units.id, link.unitId)).for("update");
    }

    const [current] = await tx
      .select()
      .from(autoApprovalRules)
      .where(eq(autoApprovalRules.id, ruleId))
      .for("update");
    if (!current) {
      throw new ServiceError("NOT_FOUND", "Auto-approval rule not found", 404, undefined, traceId);
    }

    const nowDate = now();
    const emitted: AuditEvent[] = [];
    let next = current;
    if (current.active) {
      [next] = await tx
        .update(autoApprovalRules)
        .set({ active: false, updatedAt: nowDate })
        .where(eq(autoApprovalRules.id, ruleId))
        .returning();
      emitted.push(
        await emitAuditEvent(
          "auto_approval_rule_deactivated",
          guardId,
          traceId,
          { ruleId, visitorName: current.visitorName, host: current.host, unit: current.unit },
          { tx },
        ),
      );
    }

    const [registration] = await tx
      .select()
      .from(unitRegistrations)
      .where(eq(unitRegistrations.autoApprovalRuleId, ruleId))
      .for("update");
    if (registration && !(registration.blockedAt && !registration.blockClearedAt)) {
      await tx
        .update(unitRegistrations)
        .set({
          blockedAt: nowDate,
          blockedByGuardId: guardId,
          blockReason: reason,
          blockClearedAt: null,
          blockClearedByGuardId: null,
          blockClearReason: null,
          updatedAt: nowDate,
        })
        .where(eq(unitRegistrations.id, registration.id));

      const siblings = await tx
        .select({ ruleId: unitRegistrations.autoApprovalRuleId })
        .from(unitRegistrations)
        .where(
          and(
            eq(unitRegistrations.unitId, registration.unitId),
            eq(unitRegistrations.kind, registration.kind),
            ne(unitRegistrations.id, registration.id),
            isNull(unitRegistrations.deletedAt),
            sameSubject(registration.kind === "vehicle" ? "vehicle" : "person", registration.label, registration.plate),
          ),
        );
      for (const sibling of siblings) {
        await tx
          .update(autoApprovalRules)
          .set({ active: false, updatedAt: nowDate })
          .where(and(eq(autoApprovalRules.id, sibling.ruleId), eq(autoApprovalRules.active, true)));
      }

      emitted.push(
        await emitAuditEvent(
          "resident_registration_blocked",
          guardId,
          traceId,
          {
            registrationId: registration.id,
            ruleId,
            unitId: registration.unitId,
            kind: registration.kind,
            reasonProvided: reason !== null,
            siblingRulesDisabled: siblings.map((x) => x.ruleId),
          },
          { tx },
        ),
      );
    }

    return { rule: next, events: emitted };
  });

  events.forEach(publishAuditEvent);
  return rule;
}

export interface RegistrationBlockClearedView {
  ruleId: string;
  registrationId: string;
  blockClearedAt: string;
}

/**
 * Admin lifts a staff block so the unit may register that subject again.
 * The switched-off rule stays off; the resident registers afresh.
 */
export async function clearResidentRuleBlock(
  guardId: string,
  ruleId: string,
  reason: string,
  db: ResidentDb,
  now: () => Date = () => new Date(),
): Promise<RegistrationBlockClearedView> {
  const traceId = `auto-approval-${ruleId}`;

  const { view, event } = await db.transaction(async (tx) => {
    const [registration] = await tx
      .select()
      .from(unitRegistrations)
      .where(eq(unitRegistrations.autoApprovalRuleId, ruleId))
      .for("update");
    if (!registration) throw notFound(traceId);
    if (!registration.blockedAt || registration.blockClearedAt) {
      throw new ServiceError(
        RegistrationErrorCodes.REGISTRATION_NOT_BLOCKED,
        "This registration is not blocked.",
        409,
        undefined,
        traceId,
      );
    }

    const nowDate = now();
    await tx
      .update(unitRegistrations)
      .set({
        blockClearedAt: nowDate,
        blockClearedByGuardId: guardId,
        blockClearReason: reason,
        updatedAt: nowDate,
      })
      .where(eq(unitRegistrations.id, registration.id));

    const audit = await emitAuditEvent(
      "resident_registration_block_cleared",
      guardId,
      traceId,
      {
        registrationId: registration.id,
        ruleId,
        unitId: registration.unitId,
        kind: registration.kind,
        blockedByGuardId: registration.blockedByGuardId,
      },
      { tx },
    );
    return {
      view: { ruleId, registrationId: registration.id, blockClearedAt: nowDate.toISOString() },
      event: audit,
    };
  });

  publishAuditEvent(event);
  return view;
}
