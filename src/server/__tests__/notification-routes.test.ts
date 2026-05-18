// @vitest-environment node
/**
 * GatePass — Notification Route Handler Tests
 *
 * Source: src/docs/specs/notifications.md §7
 * Source: src/server/routes/notifications.ts
 *
 * Service-layer behavior is already covered in notification-service.test.ts.
 * These tests pin the ROUTE layer:
 *   - Validation rejection → structured 422
 *   - UUID param rejection → 422 + VALIDATION_ERROR
 *   - Service success → JSON body + correct status code
 *   - Service ServiceError → propagated via next() to the error handler
 *   - Retry kicks the dispatcher AFTER the HTTP response (best-effort)
 *
 * No live HTTP server: handlers are called directly with mock req/res/next.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";
import {
  handleListNotifications,
  handleRetryNotification,
} from "../routes/notifications";
import * as notifService from "../services/notifications/notification-service";
import { ServiceError } from "../services/errors";

// ─── Mock helpers ────────────────────────────────────────────────────────────

interface MockCtx {
  req: Request;
  res: Response;
  next: (err?: unknown) => void;
  getStatus(): number;
  getJson(): unknown;
  getNextErr(): unknown;
}

function makeCtx({
  query,
  params,
  guardId,
}: {
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  guardId?: string;
}): MockCtx {
  let statusCode = 200;
  let jsonBody: unknown = null;
  let nextErr: unknown = undefined;

  const req = {
    body: undefined,
    query: query ?? {},
    params: params ?? {},
    headers: {},
    guardId,
    db: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as Request;

  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: unknown) {
      jsonBody = payload;
      return res;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as Response;

  const next = (err?: unknown) => {
    nextErr = err;
  };

  return {
    req,
    res,
    next,
    getStatus: () => statusCode,
    getJson: () => jsonBody,
    getNextErr: () => nextErr,
  };
}

const APPROVAL_ID = "11111111-1111-4111-8111-111111111111";
const NOTIF_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: NOTIF_ID,
    approvalId: APPROVAL_ID,
    channel: "whatsapp" as const,
    targetPhone: "+15551230001",
    templateKey: "approval.magic_link",
    renderedBody: "Hello…",
    status: "queued" as const,
    attempts: 0,
    idempotencyKey: "k1",
    lastProviderResponseCode: null,
    lastProviderResponseExcerpt: null,
    lastErrorCode: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deliveredAt: null,
    failedAt: null,
    ...over,
  };
}

// ─── GET /api/notifications ─────────────────────────────────────────────────

describe("Route: GET /api/notifications", () => {
  it("returns 422 APPROVAL_ID_INVALID when approvalId is missing", async () => {
    const ctx = makeCtx({ query: {}, guardId: "guard-1" });
    await handleListNotifications(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(422);
    expect(ctx.getJson()).toMatchObject({
      error: {
        code: "APPROVAL_ID_INVALID",
        field: "approvalId",
        traceId: expect.stringMatching(/^trace-/),
      },
    });
  });

  it("returns 422 APPROVAL_ID_INVALID when approvalId is not a UUID", async () => {
    const ctx = makeCtx({
      query: { approvalId: "not-a-uuid" },
      guardId: "guard-1",
    });
    await handleListNotifications(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(422);
  });

  it("returns 200 with the rows mapped via toView", async () => {
    const row = makeRow({ status: "delivered", deliveredAt: new Date() });
    vi.spyOn(notifService, "listNotificationsForApproval").mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [row as any],
    );

    const ctx = makeCtx({
      query: { approvalId: APPROVAL_ID },
      guardId: "guard-1",
    });
    await handleListNotifications(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(200);
    const body = ctx.getJson() as {
      notifications: Array<Record<string, unknown>>;
      traceId: string;
    };
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0]).toMatchObject({
      id: NOTIF_ID,
      channel: "whatsapp",
      status: "delivered",
    });
    // PII discipline: rendered_body and idempotency_key must NOT leak.
    expect(body.notifications[0]).not.toHaveProperty("renderedBody");
    expect(body.notifications[0]).not.toHaveProperty("idempotencyKey");
    expect(body.traceId).toMatch(/^trace-/);
  });

  it("propagates ServiceError to next() (e.g. guard-mismatch → 403)", async () => {
    const err = new ServiceError(
      "NOTIFICATION_GUARD_MISMATCH",
      "not owner",
      403,
    );
    vi.spyOn(notifService, "listNotificationsForApproval").mockRejectedValue(err);

    const ctx = makeCtx({
      query: { approvalId: APPROVAL_ID },
      guardId: "guard-other",
    });
    await handleListNotifications(ctx.req, ctx.res, ctx.next);

    expect(ctx.getNextErr()).toBe(err);
  });
});

// ─── POST /api/notifications/:id/retry ──────────────────────────────────────

describe("Route: POST /api/notifications/:id/retry", () => {
  it("returns 422 VALIDATION_ERROR for a non-UUID id param", async () => {
    const ctx = makeCtx({ params: { id: "not-a-uuid" }, guardId: "guard-1" });
    await handleRetryNotification(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(422);
    expect(ctx.getJson()).toMatchObject({
      error: { code: "VALIDATION_ERROR", field: "id" },
    });
  });

  it("returns 202 + view body on success and fires-and-forgets the dispatcher", async () => {
    const row = makeRow({ status: "queued" });
    vi.spyOn(notifService, "retryNotification").mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      row as any,
    );
    const dispatchSpy = vi
      .spyOn(notifService, "dispatchNotification")
      .mockResolvedValue({
        notificationId: NOTIF_ID,
        finalStatus: "delivered",
        fallbackEnqueued: false,
      });

    const ctx = makeCtx({ params: { id: NOTIF_ID }, guardId: "guard-1" });
    await handleRetryNotification(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(202);
    const body = ctx.getJson() as {
      notification: Record<string, unknown>;
      traceId: string;
    };
    expect(body.notification).toMatchObject({
      id: NOTIF_ID,
      status: "queued",
    });
    // Dispatch was kicked (fire-and-forget). Microtask flush so the
    // catch chain finishes before the assertion.
    await new Promise((r) => setImmediate(r));
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it("propagates ServiceError to next() (RETRY_RATE_LIMITED → 429)", async () => {
    const err = new ServiceError(
      "RETRY_RATE_LIMITED",
      "too soon",
      429,
    );
    vi.spyOn(notifService, "retryNotification").mockRejectedValue(err);

    const ctx = makeCtx({ params: { id: NOTIF_ID }, guardId: "guard-1" });
    await handleRetryNotification(ctx.req, ctx.res, ctx.next);

    expect(ctx.getNextErr()).toBe(err);
  });

  it("propagates ServiceError to next() (NOTIFICATION_GUARD_MISMATCH → 403)", async () => {
    const err = new ServiceError(
      "NOTIFICATION_GUARD_MISMATCH",
      "not owner",
      403,
    );
    vi.spyOn(notifService, "retryNotification").mockRejectedValue(err);

    const ctx = makeCtx({ params: { id: NOTIF_ID }, guardId: "guard-2" });
    await handleRetryNotification(ctx.req, ctx.res, ctx.next);

    expect(ctx.getNextErr()).toBe(err);
  });

  it("propagates ServiceError to next() (NOTIFICATION_NOT_RETRYABLE → 409)", async () => {
    const err = new ServiceError(
      "NOTIFICATION_NOT_RETRYABLE",
      "already delivered",
      409,
    );
    vi.spyOn(notifService, "retryNotification").mockRejectedValue(err);

    const ctx = makeCtx({ params: { id: NOTIF_ID }, guardId: "guard-1" });
    await handleRetryNotification(ctx.req, ctx.res, ctx.next);

    expect(ctx.getNextErr()).toBe(err);
  });

  it("propagates ServiceError to next() (APPROVAL_TERMINAL → 410)", async () => {
    const err = new ServiceError(
      "APPROVAL_TERMINAL",
      "approval already decided",
      410,
    );
    vi.spyOn(notifService, "retryNotification").mockRejectedValue(err);

    const ctx = makeCtx({ params: { id: NOTIF_ID }, guardId: "guard-1" });
    await handleRetryNotification(ctx.req, ctx.res, ctx.next);

    expect(ctx.getNextErr()).toBe(err);
  });
});
