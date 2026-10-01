/**
 * GatePass — Resident Portal route handlers (PR R1: units, residents, claim).
 *
 * Source: src/docs/specs/resident-portal.md §3.
 *
 * Admin (requireAuth + requireRole("admin"), wired in app.ts):
 *   POST   /api/admin/units                    create unit
 *   GET    /api/admin/units                    list units (?includeInactive=true)
 *   POST   /api/admin/units/:id/deactivate     deactivate unit (+ residents, + open passes)
 *   POST   /api/admin/units/:id/claim-codes    issue one-shot claim code (raw code shown once)
 *   GET    /api/admin/residents                list residents (?unitId=, ?includeInactive=true)
 *   POST   /api/admin/residents/:id/deactivate deactivate resident
 *
 * Resident:
 *   POST   /api/resident/claim   requireSupabaseUser — redeem a claim code
 *   GET    /api/resident/me      requireResidentAuth — identity + unit
 *   POST   /api/resident/passes  requireResidentAuth — issue a visitor pass for own unit
 *   GET    /api/resident/registrations            own household members / vehicles
 *   POST   /api/resident/registrations            register a person or vehicle
 *   DELETE /api/resident/registrations/:id        remove own registration
 *   POST   /api/resident/registrations/:id/renew  extend own registration 90 days
 *
 * Identity, unit and phone come from the verified token / DB rows, never
 * from the body.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "crypto";

import type { AuthenticatedRequest } from "../middleware/auth";
import type { ResidentRequest, SupabaseUserRequest } from "../middleware/resident-auth";
import {
  claimUnit,
  createUnit,
  deactivateResident,
  deactivateUnit,
  issueClaimCode,
  listResidents,
  listUnits,
  type ResidentDb,
} from "../services/resident-service";
import { issueResidentPass } from "../services/resident-pass-service";
import {
  createRegistration,
  listRegistrations,
  removeRegistration,
  renewRegistration,
  RESIDENT_RENEW_PROMPT_DAYS,
} from "../services/unit-registration-service";
import {
  ClaimUnitSchema,
  CreateRegistrationSchema,
  CreateUnitSchema,
  IssueClaimCodeSchema,
  ListResidentsQuerySchema,
  ListUnitsQuerySchema,
  RegistrationParamsSchema,
  ResidentErrorCodes,
  ResidentIssuePassSchema,
  ResidentParamsSchema,
  UnitParamsSchema,
} from "../validation/resident-schemas";

function getDb(req: Request): ResidentDb {
  return (req as Request & { db: ResidentDb }).db;
}

function invalidInput(res: Response, message: string, field: string | undefined): void {
  res.status(422).json({
    error: {
      code: ResidentErrorCodes.RESIDENT_INVALID_INPUT,
      message,
      ...(field && { field }),
      traceId: `trace-${randomUUID()}`,
    },
  });
}

function firstIssue(error: { issues: { message: string; path: (string | number)[] }[] }) {
  const issue = error.issues[0];
  return { message: issue?.message ?? "Invalid input", field: issue?.path?.[0]?.toString() };
}

// ─── Admin: units ────────────────────────────────────────────────────────────

export async function handleCreateUnit(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = CreateUnitSchema.safeParse(req.body);
    if (!body.success) {
      const { message, field } = firstIssue(body.error);
      invalidInput(res, message, field);
      return;
    }
    const guardId = (req as AuthenticatedRequest).guardId;
    const unit = await createUnit(body.data, guardId, getDb(req));
    res.status(201).json({ unit });
  } catch (err) {
    next(err);
  }
}

export async function handleListUnits(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = ListUnitsQuerySchema.safeParse(req.query ?? {});
    if (!query.success) {
      const { message, field } = firstIssue(query.error);
      invalidInput(res, message, field);
      return;
    }
    const unitsList = await listUnits(getDb(req), { includeInactive: query.data.includeInactive });
    res.status(200).json({ units: unitsList, count: unitsList.length });
  } catch (err) {
    next(err);
  }
}

export async function handleDeactivateUnit(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const params = UnitParamsSchema.safeParse(req.params);
    if (!params.success) {
      const { message, field } = firstIssue(params.error);
      invalidInput(res, message, field);
      return;
    }
    const guardId = (req as AuthenticatedRequest).guardId;
    const result = await deactivateUnit(params.data.id, guardId, getDb(req));
    const { expiredPassCount, deactivatedResidentCount, disabledRuleCount, ...unit } = result;
    res.status(200).json({ unit, expiredPassCount, deactivatedResidentCount, disabledRuleCount });
  } catch (err) {
    next(err);
  }
}

export async function handleIssueClaimCode(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const params = UnitParamsSchema.safeParse(req.params);
    if (!params.success) {
      const { message, field } = firstIssue(params.error);
      invalidInput(res, message, field);
      return;
    }
    const body = IssueClaimCodeSchema.safeParse(req.body ?? {});
    if (!body.success) {
      const { message, field } = firstIssue(body.error);
      invalidInput(res, message, field);
      return;
    }
    const guardId = (req as AuthenticatedRequest).guardId;
    const issued = await issueClaimCode(
      { unitId: params.data.id, ttlHours: body.data.ttlHours },
      guardId,
      getDb(req),
    );
    res.status(201).json({ claimCode: issued });
  } catch (err) {
    next(err);
  }
}

// ─── Admin: residents ────────────────────────────────────────────────────────

export async function handleListResidents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = ListResidentsQuerySchema.safeParse(req.query ?? {});
    if (!query.success) {
      const { message, field } = firstIssue(query.error);
      invalidInput(res, message, field);
      return;
    }
    const list = await listResidents(getDb(req), {
      unitId: query.data.unitId,
      includeInactive: query.data.includeInactive,
    });
    res.status(200).json({ residents: list, count: list.length });
  } catch (err) {
    next(err);
  }
}

export async function handleDeactivateResident(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const params = ResidentParamsSchema.safeParse(req.params);
    if (!params.success) {
      const { message, field } = firstIssue(params.error);
      invalidInput(res, message, field);
      return;
    }
    const guardId = (req as AuthenticatedRequest).guardId;
    const resident = await deactivateResident(params.data.id, guardId, getDb(req));
    res.status(200).json({ resident });
  } catch (err) {
    next(err);
  }
}

// ─── Resident ────────────────────────────────────────────────────────────────

export async function handleClaimUnit(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = ClaimUnitSchema.safeParse(req.body);
    if (!body.success) {
      const { message, field } = firstIssue(body.error);
      invalidInput(res, message, field);
      return;
    }
    const { supabaseUserId, supabasePhone } = req as SupabaseUserRequest;
    const resident = await claimUnit(
      {
        supabaseUserId,
        phoneE164: supabasePhone,
        code: body.data.code,
        displayName: body.data.displayName,
      },
      getDb(req),
    );
    res.status(201).json({ resident });
  } catch (err) {
    next(err);
  }
}

export function handleResidentMe(req: Request, res: Response): void {
  const { resident } = req as ResidentRequest;
  res.status(200).json({
    resident: {
      id: resident.residentId,
      displayName: resident.displayName,
      phoneE164: resident.phoneE164,
      unitId: resident.unitId,
      unitLabel: resident.unitLabel,
    },
  });
}

export async function handleIssueResidentPass(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = ResidentIssuePassSchema.safeParse(req.body);
    if (!body.success) {
      const { message, field } = firstIssue(body.error);
      invalidInput(res, message, field);
      return;
    }
    const { resident } = req as ResidentRequest;
    const result = await issueResidentPass(body.data, resident, getDb(req));
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

// ─── Resident: household members, workers, vehicles (R3) ────────────────────

export async function handleListRegistrations(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { resident } = req as ResidentRequest;
    const registrations = await listRegistrations(resident, getDb(req));
    res.status(200).json({
      registrations,
      count: registrations.length,
      renewPromptDays: RESIDENT_RENEW_PROMPT_DAYS,
    });
  } catch (err) {
    next(err);
  }
}

export async function handleCreateRegistration(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = CreateRegistrationSchema.safeParse(req.body);
    if (!body.success) {
      const { message, field } = firstIssue(body.error);
      invalidInput(res, message, field);
      return;
    }
    const { resident } = req as ResidentRequest;
    const registration = await createRegistration(body.data, resident, getDb(req));
    res.status(201).json({ registration });
  } catch (err) {
    next(err);
  }
}

export async function handleRemoveRegistration(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const params = RegistrationParamsSchema.safeParse(req.params);
    if (!params.success) {
      const { message, field } = firstIssue(params.error);
      invalidInput(res, message, field);
      return;
    }
    const { resident } = req as ResidentRequest;
    const removed = await removeRegistration(params.data.id, resident, getDb(req));
    res.status(200).json({ registration: removed });
  } catch (err) {
    next(err);
  }
}

export async function handleRenewRegistration(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const params = RegistrationParamsSchema.safeParse(req.params);
    if (!params.success) {
      const { message, field } = firstIssue(params.error);
      invalidInput(res, message, field);
      return;
    }
    const { resident } = req as ResidentRequest;
    const registration = await renewRegistration(params.data.id, resident, getDb(req));
    res.status(200).json({ registration });
  } catch (err) {
    next(err);
  }
}

// ─── Routers ─────────────────────────────────────────────────────────────────

export const adminUnitsRouter = Router();
adminUnitsRouter.post("/", handleCreateUnit);
adminUnitsRouter.get("/", handleListUnits);
adminUnitsRouter.post("/:id/deactivate", handleDeactivateUnit);
adminUnitsRouter.post("/:id/claim-codes", handleIssueClaimCode);

export const adminResidentsRouter = Router();
adminResidentsRouter.get("/", handleListResidents);
adminResidentsRouter.post("/:id/deactivate", handleDeactivateResident);
