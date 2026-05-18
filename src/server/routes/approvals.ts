/**
 * GatePass — Resident Approval Route Handlers
 *
 * Source: src/docs/specs/resident-approval-flow.md §7 — endpoint contracts.
 * Source: API-and-Interface-Design — single error shape, validation at boundary.
 * Source: Security-and-Hardening — token-auth on /decide, JWT on guard endpoints.
 *
 * Three handlers, three middleware stacks (set in app.ts):
 *
 *   POST /api/approvals             → requireAuth + strictLimiter
 *   GET  /api/approvals/:id/status  → requireAuth  (no strict — poll-friendly)
 *   POST /api/approvals/:id/decide  → strictLimiter only  (token in body IS auth)
 *
 * Handlers are exported individually (not via a Router) because Express mounts
 * routers under a single base path with shared middleware, but our three
 * routes need three different middleware stacks. Direct route registration
 * in app.ts keeps the wiring explicit and the auth boundary obvious.
 */

import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import {
  validateCreateApprovalRequest,
  validateDecideApprovalRequest,
  ApprovalErrorCodes,
} from "../validation/approval-schemas";
import {
  createApprovalRequest,
  getApprovalStatus,
  decideApprovalRequest,
} from "../services/approval-service";
import { dispatchNotification } from "../services/notifications/notification-service";
import { getNotificationProviders } from "../services/notifications/registry";
import type { AuthenticatedRequest } from "../middleware/auth";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const UUID_RX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates an :id path parameter is a UUID. Returns the value or sends a
 * structured 422 and returns null. Fail-fast at the route boundary — the
 * service should never see garbage path params.
 */
function requireUuidParam(
  raw: string | undefined,
  paramName: string,
  res: Response
): string | null {
  if (!raw || !UUID_RX.test(raw)) {
    const traceId = `trace-${randomUUID()}`;
    res.status(422).json({
      error: {
        code: ApprovalErrorCodes.VALIDATION_ERROR,
        message: `${paramName} must be a valid UUID`,
        field: paramName,
        traceId,
      },
    });
    return null;
  }
  return raw;
}

// ─── POST /api/approvals ────────────────────────────────────────────────────

/**
 * Guard initiates a resident-approval request.
 *
 * Source: spec §7.1.
 * - JWT-authenticated (auth middleware runs first, injects guardId).
 * - guardId NEVER comes from the body — always from the verified token.
 */
export async function handleCreateApproval(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const validation = validateCreateApprovalRequest(req.body);
    if (!validation.success) {
      const traceId = `trace-${randomUUID()}`;
      res.status(422).json({
        error: {
          code: validation.code,
          message: validation.message,
          ...(validation.field && { field: validation.field }),
          traceId,
        },
      });
      return;
    }

    const guardId = (req as AuthenticatedRequest).guardId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (req as any).db;

    const { response, statusCode, enqueuedNotification } =
      await createApprovalRequest(validation.data, guardId, db);
    res.status(statusCode).json(response);

    // Feature 2 — fire-and-forget dispatcher kick AFTER the HTTP response.
    // Source: src/docs/specs/notifications.md §5, B2 — delivery is
    // best-effort; the create call MUST NOT block on provider latency.
    // The dispatcher never throws (every outcome is persisted state),
    // so any reject here is unexpected and only logged.
    if (enqueuedNotification) {
      void dispatchNotification(db, enqueuedNotification.id, {
        providers: getNotificationProviders(),
        systemGuardId: guardId,
      }).catch((dispatchErr) => {
        // eslint-disable-next-line no-console
        console.error("[NOTIFICATION] dispatch error", dispatchErr);
      });
    }
  } catch (err) {
    next(err);
  }
}

// ─── GET /api/approvals/:id/status ──────────────────────────────────────────

/**
 * Guard polls the approval status. Lazy expiry is applied server-side so the
 * guard's UI never observes a stale pending row.
 *
 * Source: spec §7.2.
 */
export async function handleGetApprovalStatus(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const id = requireUuidParam(req.params.id, "id", res);
    if (!id) return;

    const guardId = (req as AuthenticatedRequest).guardId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (req as any).db;

    const { response, statusCode } = await getApprovalStatus(id, guardId, db);
    res.status(statusCode).json(response);
  } catch (err) {
    next(err);
  }
}

// ─── POST /api/approvals/:id/decide ─────────────────────────────────────────

/**
 * Resident submits approve/deny via the magic link.
 *
 * Source: spec §7.3.
 *
 * NO JWT required. The 256-bit token in the body is hashed and compared to
 * the SHA-256 stored on the row. The strict rate limiter in app.ts is the
 * primary defense against brute-force attempts (token entropy alone makes
 * brute-force impractical, but defense in depth costs nothing).
 *
 * The status code mapping is contract-defined:
 *   - 200 success (approval transitioned to approved or denied)
 *   - 401 token shape invalid OR token does not match stored hash
 *   - 404 approval id unknown
 *   - 409 approval already decided (replay protection — returns regardless of token)
 *   - 410 approval expired
 *   - 422 deny without reason
 */
export async function handleDecideApproval(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const id = requireUuidParam(req.params.id, "id", res);
    if (!id) return;

    const validation = validateDecideApprovalRequest(req.body);
    if (!validation.success) {
      const traceId = `trace-${randomUUID()}`;
      // Token-shape errors are auth failures (401); everything else is 422.
      const status =
        validation.code === ApprovalErrorCodes.APPROVAL_TOKEN_INVALID
          ? 401
          : 422;
      res.status(status).json({
        error: {
          code: validation.code,
          message: validation.message,
          ...(validation.field && { field: validation.field }),
          traceId,
        },
      });
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (req as any).db;
    const { token, decision, reason } = validation.data;

    const { response, statusCode } = await decideApprovalRequest(
      id,
      token,
      decision,
      reason,
      db
    );
    res.status(statusCode).json(response);
  } catch (err) {
    next(err);
  }
}
