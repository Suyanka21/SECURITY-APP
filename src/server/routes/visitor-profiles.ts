/**
 * GatePass — Visitor Profile Route Handlers
 *
 * Source: src/docs/specs/visitor-profiles.md §4 (API surface), §6 (security).
 * Source: API-and-Interface-Design — single error shape, validation
 *         at the boundary, additive responses.
 * Source: Security-and-Hardening — admin/senior role required at the
 *         middleware layer (requireRole), never trusted at the body layer.
 *
 * Six handlers (wired in app.ts):
 *
 *   POST   /api/visitor-profiles                requireAuth + requireRole(admin, senior-guard)
 *   GET    /api/visitor-profiles                requireAuth (any role)
 *   GET    /api/visitor-profiles/:id            requireAuth (any role)
 *   PATCH  /api/visitor-profiles/:id            requireAuth + requireRole(admin, senior-guard)
 *   DELETE /api/visitor-profiles/:id            requireAuth + requireRole(admin, senior-guard)
 *   POST   /api/visitor-profiles/:id/restore    requireAuth + requireRole(admin, senior-guard)
 */

import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

import {
  CreateVisitorProfileSchema,
  UpdateVisitorProfileSchema,
  ListVisitorProfilesQuerySchema,
  VisitorProfileIdParamSchema,
  VisitorProfileErrorCodes,
  type VisitorProfileResponse,
  type ListVisitorProfilesResponse,
} from "../validation/visitor-profile-schemas";
import {
  createVisitorProfile,
  updateVisitorProfile,
  listVisitorProfiles,
  getVisitorProfile,
  softDeleteVisitorProfile,
  restoreVisitorProfile,
} from "../services/visitor-profile-service";
import type { AuthenticatedRequest } from "../middleware/auth";

// ─── Validation error helper ────────────────────────────────────────────────

function send422(
  res: Response,
  message: string,
  field: string | undefined,
  traceId: string
) {
  res.status(422).json({
    error: {
      code: VisitorProfileErrorCodes.PROFILE_INVALID_INPUT,
      message,
      field,
      traceId,
    },
  });
}

// ─── POST /api/visitor-profiles ─────────────────────────────────────────────

export async function handleCreateVisitorProfile(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const traceId = `trace-${randomUUID()}`;
    const parsed = CreateVisitorProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path?.[0]?.toString();
      send422(
        res,
        issue?.message ?? "Invalid visitor profile input",
        field,
        traceId
      );
      return;
    }

    const guardId = (req as AuthenticatedRequest).guardId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (req as any).db;

    const view = await createVisitorProfile(
      guardId,
      {
        visitorName: parsed.data.visitorName,
        host: parsed.data.host,
        unit: parsed.data.unit,
        plate: parsed.data.plate ?? null,
        phoneE164: parsed.data.phoneE164 ?? null,
        notes: parsed.data.notes ?? null,
        watchFlag: parsed.data.watchFlag,
      },
      db
    );

    const body: VisitorProfileResponse = { profile: view, traceId };
    res.status(201).json(body);
  } catch (err) {
    next(err);
  }
}

// ─── GET /api/visitor-profiles ──────────────────────────────────────────────

export async function handleListVisitorProfiles(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const traceId = `trace-${randomUUID()}`;
    const parsed = ListVisitorProfilesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path?.[0]?.toString();
      send422(
        res,
        issue?.message ?? "Invalid list query",
        field,
        traceId
      );
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (req as any).db;

    const result = await listVisitorProfiles(
      {
        host: parsed.data.host,
        unit: parsed.data.unit,
        q: parsed.data.q,
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
        includeDeleted: parsed.data.includeDeleted,
      },
      db
    );

    const body: ListVisitorProfilesResponse = {
      profiles: result.profiles,
      pagination: result.pagination,
      traceId,
    };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

// ─── GET /api/visitor-profiles/:id ──────────────────────────────────────────

export async function handleGetVisitorProfile(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const traceId = `trace-${randomUUID()}`;
    const params = VisitorProfileIdParamSchema.safeParse(req.params);
    if (!params.success) {
      send422(res, "id must be a UUID", "id", traceId);
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (req as any).db;
    const view = await getVisitorProfile(params.data.id, db);

    const body: VisitorProfileResponse = { profile: view, traceId };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

// ─── PATCH /api/visitor-profiles/:id ────────────────────────────────────────

export async function handleUpdateVisitorProfile(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const traceId = `trace-${randomUUID()}`;
    const params = VisitorProfileIdParamSchema.safeParse(req.params);
    if (!params.success) {
      send422(res, "id must be a UUID", "id", traceId);
      return;
    }
    const parsed = UpdateVisitorProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path?.[0]?.toString();
      send422(
        res,
        issue?.message ?? "Invalid patch",
        field,
        traceId
      );
      return;
    }

    const guardId = (req as AuthenticatedRequest).guardId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (req as any).db;

    const view = await updateVisitorProfile(
      guardId,
      params.data.id,
      parsed.data,
      db
    );

    const body: VisitorProfileResponse = { profile: view, traceId };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

// ─── DELETE /api/visitor-profiles/:id ───────────────────────────────────────

export async function handleSoftDeleteVisitorProfile(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const traceId = `trace-${randomUUID()}`;
    const params = VisitorProfileIdParamSchema.safeParse(req.params);
    if (!params.success) {
      send422(res, "id must be a UUID", "id", traceId);
      return;
    }

    const guardId = (req as AuthenticatedRequest).guardId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (req as any).db;

    const view = await softDeleteVisitorProfile(guardId, params.data.id, db);

    const body: VisitorProfileResponse = { profile: view, traceId };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

// ─── POST /api/visitor-profiles/:id/restore ─────────────────────────────────

export async function handleRestoreVisitorProfile(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const traceId = `trace-${randomUUID()}`;
    const params = VisitorProfileIdParamSchema.safeParse(req.params);
    if (!params.success) {
      send422(res, "id must be a UUID", "id", traceId);
      return;
    }

    const guardId = (req as AuthenticatedRequest).guardId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (req as any).db;

    const view = await restoreVisitorProfile(guardId, params.data.id, db);

    const body: VisitorProfileResponse = { profile: view, traceId };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}
