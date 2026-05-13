/**
 * GatePass — Notification Route Handlers
 *
 * Source: src/docs/specs/notifications.md §7 — endpoint contracts.
 * Source: API-and-Interface-Design — single error shape, validation
 *         at boundary.
 * Source: Security-and-Hardening — JWT auth on both endpoints,
 *         strict rate-limit on retry.
 *
 * Two handlers, two middleware stacks (wired in app.ts):
 *
 *   GET  /api/notifications          → requireAuth   (poll-friendly)
 *   POST /api/notifications/:id/retry → requireAuth + strictLimiter
 *
 * The POST endpoint to enqueue a delivery is NOT exposed directly —
 * notifications are always enqueued by createApprovalRequest as a
 * side effect of POST /api/approvals (see spec §5).
 */

import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import {
  ListNotificationsQuerySchema,
  NotificationIdParamSchema,
  NotificationErrorCodes,
  type NotificationsListResponse,
  type NotificationRetryResponse,
} from "../validation/notification-schemas";
import {
  listNotificationsForApproval,
  retryNotification,
  dispatchNotification,
  toView,
} from "../services/notifications/notification-service";
import { getNotificationProviders } from "../services/notifications/registry";
import { ServiceError } from "../services/errors";
import type { AuthenticatedRequest } from "../middleware/auth";

// ─── GET /api/notifications?approvalId=:id ──────────────────────────────────

/**
 * Returns every delivery row for a guard-owned approval.
 *
 * Source: spec §7.2.
 * - JWT-authenticated (auth middleware runs first, injects guardId).
 * - 422 if approvalId is missing or not a UUID.
 * - 403 if the calling guard does not own the approval.
 * - 404 if the approval does not exist.
 * - 200 otherwise — empty array is a valid response (approval had
 *   no phone, so legacy hand-copy path is in use).
 */
export async function handleListNotifications(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = ListNotificationsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const traceId = `trace-${randomUUID()}`;
      const issue = parsed.error.issues[0];
      res.status(422).json({
        error: {
          code: NotificationErrorCodes.APPROVAL_ID_INVALID,
          message: issue?.message ?? "approvalId is invalid",
          field: "approvalId",
          traceId,
        },
      });
      return;
    }

    const guardId = (req as AuthenticatedRequest).guardId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (req as any).db;

    const rows = await listNotificationsForApproval(
      db,
      parsed.data.approvalId,
      guardId,
    );

    const traceId = `trace-${randomUUID()}`;
    const body: NotificationsListResponse = {
      notifications: rows.map(toView),
      traceId,
    };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

// ─── POST /api/notifications/:id/retry ──────────────────────────────────────

/**
 * Guard-triggered manual retry. The dispatcher tick fires AFTER the
 * response is sent so the HTTP response is not coupled to delivery
 * outcome (B2). Throttled at 30s/row in the service.
 *
 * Source: spec §7.3.
 */
export async function handleRetryNotification(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const params = NotificationIdParamSchema.safeParse(req.params);
    if (!params.success) {
      const traceId = `trace-${randomUUID()}`;
      const issue = params.error.issues[0];
      res.status(422).json({
        error: {
          code: NotificationErrorCodes.VALIDATION_ERROR,
          message: issue?.message ?? "id is invalid",
          field: "id",
          traceId,
        },
      });
      return;
    }

    const guardId = (req as AuthenticatedRequest).guardId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (req as any).db;

    const reloaded = await retryNotification(db, params.data.id, { guardId });

    const traceId = `trace-${randomUUID()}`;
    const body: NotificationRetryResponse = {
      notification: toView(reloaded),
      traceId,
    };
    res.status(202).json(body);

    // Fire-and-forget the dispatcher AFTER the response. We do NOT
    // await here — delivery outcome is observable via subsequent GETs
    // (the polling loop in the controller). Any unexpected throw is
    // swallowed and logged so an exception in the dispatch cannot
    // crash the process.
    void dispatchNotification(db, params.data.id, {
      providers: getNotificationProviders(),
      systemGuardId: guardId,
    }).catch((dispatchErr) => {
      // The dispatcher already records every outcome in the row's
      // state. Any throw at this level is unexpected — log only.
      // eslint-disable-next-line no-console
      console.error("[NOTIFICATION] dispatch error", dispatchErr);
    });
  } catch (err) {
    // ServiceErrors are picked up by the central error handler so
    // each code maps to its documented status (404, 403, 409, 410, 429).
    if (err instanceof ServiceError) {
      next(err);
      return;
    }
    next(err);
  }
}
