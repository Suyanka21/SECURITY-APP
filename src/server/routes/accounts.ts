/**
 * GatePass — Admin Account-Provisioning Route Handler (Decision A1)
 *
 * Source: src/docs/adr/0001-...md — A1: only an authenticated admin can
 *         provision accounts; the role is server-controlled.
 * Source: src/server/routes/auto-approval.ts — route conventions (zod at the
 *         boundary, single error shape, ServiceError → next()).
 * Source: Security-and-Hardening — the role is enforced by requireRole("admin")
 *         middleware in app.ts, never trusted from the body.
 *
 * One handler (wired in app.ts):
 *   POST /api/admin/accounts   requireAuth + strictLimiter + requireRole("admin")
 */

import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

import {
  ProvisionAccountSchema,
  AccountErrorCodes,
  type ProvisionAccountResponse,
} from "../validation/account-schemas";
import { provisionAccount } from "../services/account-service";
import type { AuthenticatedRequest } from "../middleware/auth";

// ─── POST /api/admin/accounts ────────────────────────────────────────────────

export async function handleProvisionAccount(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = ProvisionAccountSchema.safeParse(req.body);
    if (!parsed.success) {
      const traceId = `trace-${randomUUID()}`;
      const issue = parsed.error.issues[0];
      const field = issue?.path?.[0]?.toString();
      res.status(422).json({
        error: {
          code: AccountErrorCodes.ACCOUNT_INVALID_INPUT,
          message: issue?.message ?? "Invalid account input",
          field,
          traceId,
        },
      });
      return;
    }

    const actingAdminGuardId = (req as AuthenticatedRequest).guardId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (req as any).db;

    const { view, temporaryPassword } = await provisionAccount(
      actingAdminGuardId,
      {
        email: parsed.data.email,
        name: parsed.data.name,
        badgeNumber: parsed.data.badgeNumber,
        role: parsed.data.role,
        password: parsed.data.password,
      },
      db,
    );

    const traceId = `trace-${randomUUID()}`;
    const body: ProvisionAccountResponse = {
      account: view,
      traceId,
      ...(temporaryPassword ? { temporaryPassword } : {}),
    };
    res.status(201).json(body);
  } catch (err) {
    next(err);
  }
}
