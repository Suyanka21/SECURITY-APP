/**
 * GatePass — Resident Portal validation schemas (PR R1).
 *
 * Source: src/docs/specs/resident-portal.md §3.
 *
 * The client never supplies identity, unit, host or phone. A resident's
 * claim body is only { code, displayName }; the admin's unit/claim-code
 * bodies are only { label } / { ttlHours }. Everything else is server-owned.
 */

import { z } from "zod";
import {
  DEFAULT_CLAIM_CODE_TTL_HOURS,
  MAX_CLAIM_CODE_TTL_HOURS,
} from "../services/resident-service";

export const ResidentErrorCodes = {
  RESIDENT_INVALID_INPUT: "RESIDENT_INVALID_INPUT",
} as const;

export const UNIT_LABEL_MAX = 32;
export const RESIDENT_NAME_MAX = 120;

export const CreateUnitSchema = z.object({
  label: z
    .string({ required_error: "Unit label is required" })
    .trim()
    .min(1, "Unit label is required")
    .max(UNIT_LABEL_MAX, `Unit label must be at most ${UNIT_LABEL_MAX} characters`),
});

export const ListUnitsQuerySchema = z.object({
  includeInactive: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

export const UnitParamsSchema = z.object({
  id: z.string().uuid("Unit id must be a UUID"),
});

export const IssueClaimCodeSchema = z.object({
  ttlHours: z
    .number()
    .int()
    .min(1)
    .max(MAX_CLAIM_CODE_TTL_HOURS, `ttlHours must be at most ${MAX_CLAIM_CODE_TTL_HOURS}`)
    .optional()
    .default(DEFAULT_CLAIM_CODE_TTL_HOURS),
});

export const ListResidentsQuerySchema = z.object({
  unitId: z.string().uuid().optional(),
  includeInactive: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

export const ResidentParamsSchema = z.object({
  id: z.string().uuid("Resident id must be a UUID"),
});

export const ClaimUnitSchema = z.object({
  code: z
    .string({ required_error: "Claim code is required" })
    .trim()
    .min(8, "Claim code is 8 characters")
    .max(12, "Claim code is 8 characters"),
  displayName: z
    .string({ required_error: "Your name is required" })
    .trim()
    .min(1, "Your name is required")
    .max(RESIDENT_NAME_MAX, `Name must be at most ${RESIDENT_NAME_MAX} characters`),
});
