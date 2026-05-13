// @vitest-environment node
/**
 * GatePass — Approval Route Handler Tests
 *
 * Source: src/docs/specs/resident-approval-flow.md §7
 * Source: src/server/routes/approvals.ts
 *
 * The service layer (covered in approval-service.test.ts) already proves
 * the business logic. These tests prove the ROUTE layer:
 *   - Validation rejection → structured 422 (or 401 for token shape)
 *   - UUID param rejection → 422 + VALIDATION_ERROR
 *   - Service success → JSON body + correct status code
 *   - Service ServiceError → propagated via next() to the error handler
 *
 * No live HTTP server: handlers are called directly with mock req/res/next
 * (matches auth-middleware.test.ts pattern; supertest is not a project dep).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import {
  handleCreateApproval,
  handleGetApprovalStatus,
  handleDecideApproval,
} from "../routes/approvals";
import * as service from "../services/approval-service";
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
  body,
  params,
  guardId,
}: {
  body?: unknown;
  params?: Record<string, string>;
  guardId?: string;
}): MockCtx {
  let statusCode = 200;
  let jsonBody: unknown = null;
  let nextErr: unknown = undefined;

  const req = {
    body,
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

const VALID_ID = "11111111-1111-4111-8111-111111111111";
const VALID_TOKEN = "a".repeat(64);

beforeEach(() => {
  vi.restoreAllMocks();
});

// ─── POST /api/approvals ────────────────────────────────────────────────────

describe("Route: POST /api/approvals", () => {
  it("returns 422 with structured error when body is missing", async () => {
    const ctx = makeCtx({ body: undefined, guardId: "guard-1" });
    await handleCreateApproval(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(422);
    expect(ctx.getJson()).toMatchObject({
      error: {
        code: expect.stringMatching(/^(APPROVAL_REQUEST_INVALID|VALIDATION_ERROR)$/),
        traceId: expect.stringMatching(/^trace-/),
      },
    });
  });

  it("returns 422 with field when draft.visitorName is missing", async () => {
    const ctx = makeCtx({
      body: {
        offlineId: VALID_ID,
        draft: {
          host: "Host",
          unit: "1A",
          method: "walk-in",
        },
      },
      guardId: "guard-1",
    });
    await handleCreateApproval(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(422);
    const body = ctx.getJson() as { error: { field?: string; code: string } };
    expect(body.error.field).toBeDefined();
  });

  it("delegates to service.createApprovalRequest with body + guardId from req", async () => {
    const spy = vi
      .spyOn(service, "createApprovalRequest")
      .mockResolvedValue({
        response: {
          approvalId: VALID_ID,
          magicLinkUrl: "http://example/approve/x?token=y",
          expiresAt: new Date().toISOString(),
          traceId: "trace-1",
        },
        statusCode: 201,
      });

    const ctx = makeCtx({
      body: {
        offlineId: VALID_ID,
        draft: {
          visitorName: "Maya",
          host: "Host",
          unit: "1A",
          method: "walk-in",
        },
      },
      guardId: "guard-1",
    });
    await handleCreateApproval(ctx.req, ctx.res, ctx.next);

    expect(spy).toHaveBeenCalledTimes(1);
    const [, guardArg] = spy.mock.calls[0];
    expect(guardArg).toBe("guard-1");
    expect(ctx.getStatus()).toBe(201);
  });

  it("passes ServiceError to next() so the error handler can render it", async () => {
    const err = new ServiceError(
      "APPROVAL_DUPLICATE",
      "dup",
      409,
      "offlineId"
    );
    vi.spyOn(service, "createApprovalRequest").mockRejectedValue(err);

    const ctx = makeCtx({
      body: {
        offlineId: VALID_ID,
        draft: {
          visitorName: "Maya",
          host: "Host",
          unit: "1A",
          method: "walk-in",
        },
      },
      guardId: "guard-1",
    });
    await handleCreateApproval(ctx.req, ctx.res, ctx.next);

    expect(ctx.getNextErr()).toBe(err);
  });
});

// ─── GET /api/approvals/:id/status ──────────────────────────────────────────

describe("Route: GET /api/approvals/:id/status", () => {
  it("returns 422 VALIDATION_ERROR for non-UUID id param", async () => {
    const ctx = makeCtx({ params: { id: "not-a-uuid" }, guardId: "guard-1" });
    await handleGetApprovalStatus(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(422);
    expect(ctx.getJson()).toMatchObject({
      error: { code: "VALIDATION_ERROR", field: "id" },
    });
  });

  it("delegates to service.getApprovalStatus with id + guardId", async () => {
    const spy = vi.spyOn(service, "getApprovalStatus").mockResolvedValue({
      response: {
        approval: {
          id: VALID_ID,
          offlineId: VALID_ID,
          visitorName: "Maya",
          host: "Host",
          unit: "1A",
          plate: null,
          reason: "",
          method: "walk-in",
          requestedByGuardId: "guard-1",
          status: "pending",
          expiresAt: new Date().toISOString(),
          decidedAt: null,
          deniedReason: null,
          entryId: null,
          traceId: "trace-1",
        },
        traceId: "trace-1",
      },
      statusCode: 200,
    });

    const ctx = makeCtx({ params: { id: VALID_ID }, guardId: "guard-1" });
    await handleGetApprovalStatus(ctx.req, ctx.res, ctx.next);

    expect(spy).toHaveBeenCalledWith(VALID_ID, "guard-1", expect.anything());
    expect(ctx.getStatus()).toBe(200);
  });

  it("passes ServiceError (e.g. APPROVAL_NOT_FOUND) to next()", async () => {
    const err = new ServiceError("APPROVAL_NOT_FOUND", "missing", 404);
    vi.spyOn(service, "getApprovalStatus").mockRejectedValue(err);

    const ctx = makeCtx({ params: { id: VALID_ID }, guardId: "guard-1" });
    await handleGetApprovalStatus(ctx.req, ctx.res, ctx.next);

    expect(ctx.getNextErr()).toBe(err);
  });
});

// ─── POST /api/approvals/:id/decide ─────────────────────────────────────────

describe("Route: POST /api/approvals/:id/decide", () => {
  it("returns 422 VALIDATION_ERROR for non-UUID id param", async () => {
    const ctx = makeCtx({
      params: { id: "garbage" },
      body: { token: VALID_TOKEN, decision: "approve" },
    });
    await handleDecideApproval(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(422);
    expect(ctx.getJson()).toMatchObject({
      error: { code: "VALIDATION_ERROR", field: "id" },
    });
  });

  it("returns 401 APPROVAL_TOKEN_INVALID for wrong-shape token at the validation layer", async () => {
    const ctx = makeCtx({
      params: { id: VALID_ID },
      body: { token: "short", decision: "approve" },
    });
    await handleDecideApproval(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(401);
    expect(ctx.getJson()).toMatchObject({
      error: { code: "APPROVAL_TOKEN_INVALID" },
    });
  });

  it("returns 422 APPROVAL_DENY_REASON_REQUIRED when decision=deny without reason", async () => {
    const ctx = makeCtx({
      params: { id: VALID_ID },
      body: { token: VALID_TOKEN, decision: "deny" },
    });
    await handleDecideApproval(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(422);
    expect(ctx.getJson()).toMatchObject({
      error: { code: "APPROVAL_DENY_REASON_REQUIRED", field: "reason" },
    });
  });

  it("delegates to service.decideApprovalRequest with id + token + decision", async () => {
    const spy = vi
      .spyOn(service, "decideApprovalRequest")
      .mockResolvedValue({
        response: {
          approval: {
            id: VALID_ID,
            offlineId: VALID_ID,
            visitorName: "Maya",
            host: "Host",
            unit: "1A",
            plate: null,
            reason: "",
            method: "walk-in",
            requestedByGuardId: "guard-1",
            status: "denied",
            expiresAt: new Date().toISOString(),
            decidedAt: new Date().toISOString(),
            deniedReason: "not expected",
            entryId: null,
            traceId: "trace-1",
          },
          entry: null,
          traceId: "trace-1",
        },
        statusCode: 200,
      });

    const ctx = makeCtx({
      params: { id: VALID_ID },
      body: {
        token: VALID_TOKEN,
        decision: "deny",
        reason: "not expected",
      },
    });
    await handleDecideApproval(ctx.req, ctx.res, ctx.next);

    expect(spy).toHaveBeenCalledWith(
      VALID_ID,
      VALID_TOKEN,
      "deny",
      "not expected",
      expect.anything()
    );
    expect(ctx.getStatus()).toBe(200);
  });

  it("passes ServiceError (e.g. APPROVAL_EXPIRED 410) to next()", async () => {
    const err = new ServiceError("APPROVAL_EXPIRED", "expired", 410);
    vi.spyOn(service, "decideApprovalRequest").mockRejectedValue(err);

    const ctx = makeCtx({
      params: { id: VALID_ID },
      body: { token: VALID_TOKEN, decision: "approve" },
    });
    await handleDecideApproval(ctx.req, ctx.res, ctx.next);

    expect(ctx.getNextErr()).toBe(err);
  });
});
