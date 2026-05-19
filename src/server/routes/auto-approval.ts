/**
 * GatePass — Auto-Approval Route Handlers
 *
 * Source: src/docs/specs/auto-approval.md §7 (endpoints), §8 (security).
 * Source: API-and-Interface-Design — single error shape, validation
 *         at the boundary, additive responses.
 * Source: Security-and-Hardening — admin role required at the middleware
 *         layer (requireRole), never trusted at the body/query layer.
 *
 * Three admin-only handlers (wired in app.ts):
 *
 *   POST /api/auto-approval-rules               requireAuth + requireRole(admin)
 *   GET  /api/auto-approval-rules               requireAuth + requireRole(admin, senior-guard)
 *   POST /api/auto-approval-rules/:id/deactivate requireAuth + requireRole(admin)
 *
 * The evaluator (POST /api/approvals short-circuit) is wired separately in
 * slice 4. These three endpoints exist only so an admin can seed/list/
 * deactivate rules; the evaluator is never invoked here.
 */

import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

import {
  SeedAutoApprovalRuleSchema,
  ListAutoApprovalRulesQuerySchema,
  RuleIdParamSchema,
  AutoApprovalErrorCodes,
  type AutoApprovalRuleResponse,
  type ListAutoApprovalRulesResponse,
} from "../validation/auto-approval-schemas";
import {
  seedAutoApprovalRule,
  listAutoApprovalRules,
  deactivateAutoApprovalRule,
} from "../services/auto-approval-service";
import { ServiceError } from "../services/errors";
import type { AuthenticatedRequest } from "../middleware/auth";

// ─── POST /api/auto-approval-rules ─────────────────────────────────────────

export async function handleSeedAutoApprovalRule(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = SeedAutoApprovalRuleSchema.safeParse(req.body);
    if (!parsed.success) {
      const traceId = `trace-${randomUUID()}`;
      const issue = parsed.error.issues[0];
      const field = issue?.path?.[0]?.toString();
      res.status(422).json({
        error: {
          code: AutoApprovalErrorCodes.RULE_INVALID_INPUT,
          message: issue?.message ?? "Invalid auto-approval rule input",
          field,
          traceId,
        },
      });
      return;
    }

    const guardId = (req as AuthenticatedRequest).guardId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (req as any).db;

    const view = await seedAutoApprovalRule(
      guardId,
      {
        visitorName: parsed.data.visitorName,
        host: parsed.data.host,
        unit: parsed.data.unit,
        plateRequired: parsed.data.plateRequired ?? null,
        expiresAt: new Date(parsed.data.expiresAt),
      },
      db,
    );

    const traceId = `trace-${randomUUID()}`;
    const body: AutoApprovalRuleResponse = { rule: view, traceId };
    res.status(201).json(body);
  } catch (err) {
    next(err);
  }
}

// ─── GET /api/auto-approval-rules ───────────────────────────────────────────

export async function handleListAutoApprovalRules(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = ListAutoApprovalRulesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const traceId = `trace-${randomUUID()}`;
      const issue = parsed.error.issues[0];
      const field = issue?.path?.[0]?.toString();
      res.status(422).json({
        error: {
          code: AutoApprovalErrorCodes.RULE_INVALID_INPUT,
          message: issue?.message ?? "Invalid auto-approval list query",
          field,
          traceId,
        },
      });
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (req as any).db;

    const rules = await listAutoApprovalRules(
      {
        host: parsed.data.host,
        unit: parsed.data.unit,
        includeInactive: parsed.data.includeInactive,
      },
      db,
    );

    const traceId = `trace-${randomUUID()}`;
    const body: ListAutoApprovalRulesResponse = { rules, traceId };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

// ─── POST /api/auto-approval-rules/:id/deactivate ──────────────────────────

export async function handleDeactivateAutoApprovalRule(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const params = RuleIdParamSchema.safeParse(req.params);
    if (!params.success) {
      const traceId = `trace-${randomUUID()}`;
      const issue = params.error.issues[0];
      res.status(422).json({
        error: {
          code: AutoApprovalErrorCodes.RULE_INVALID_INPUT,
          message: issue?.message ?? "Rule id must be a UUID",
          field: "id",
          traceId,
        },
      });
      return;
    }

    const guardId = (req as AuthenticatedRequest).guardId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (req as any).db;

    const view = await deactivateAutoApprovalRule(
      guardId,
      params.data.id,
      db,
    );

    const traceId = `trace-${randomUUID()}`;
    const body: AutoApprovalRuleResponse = { rule: view, traceId };
    res.status(200).json(body);
  } catch (err) {
    if (err instanceof ServiceError) {
      next(err);
      return;
    }
    next(err);
  }
}
