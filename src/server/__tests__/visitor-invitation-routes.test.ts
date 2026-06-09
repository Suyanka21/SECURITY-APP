// @vitest-environment node
/**
 * GatePass — Visitor Invitation Route Handler Tests (Feature 6)
 *
 * Source: src/docs/specs/guest-qr-ticket.md §6 (Backend — Endpoints).
 * Source: src/server/routes/visitor-invitations.ts
 *
 * Service-layer behavior is covered in visitor-invitation-service.test.ts.
 * These tests pin the ROUTE layer:
 *   - Validation rejection → structured 422 with field + traceId
 *   - Service success → 201/200 + body + traceId
 *   - Service ServiceError → mapped to contract error shape
 *   - Malformed preview token → 404 (NOT 422, to avoid leaking format vs. miss)
 *   - Missing auth on issue → 401 (belt + braces, requireAuth runs upstream)
 *
 * Default-deny invariants:
 *   - INSERT failure → next(err); response stays 200/0 (error handler decides)
 *   - Preview never mutates and never leaks internal fields
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";

import {
  handleIssueVisitorInvitation,
  handlePreviewVisitorInvitation,
} from "../routes/visitor-invitations";
import * as service from "../services/visitor-invitation-service";
import { ServiceError } from "../services/errors";
import { VisitorInvitationErrorCodes } from "../validation/visitor-invitation-schemas";

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
    query: {},
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

const ACTOR_ID = "33333333-3333-4333-8333-333333333333";
const INVITATION_ID = "44444444-4444-4444-8444-444444444444";
const RAW_TOKEN = "TEST_RAW_TOKEN_FORTY_THREE_CHARS_ABCDEFGHIJ";

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

// ─── POST /api/visitor-invitations ───────────────────────────────────────────

describe("Route: POST /api/visitor-invitations", () => {
  it("R-I1: returns 422 INVITATION_INVALID_INPUT when visitorName is missing", async () => {
    const ctx = makeCtx({
      body: { host: "A. Okafor", unit: "18B" },
      guardId: ACTOR_ID,
    });
    await handleIssueVisitorInvitation(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(422);
    expect(ctx.getJson()).toMatchObject({
      error: {
        code: "INVITATION_INVALID_INPUT",
        field: "visitorName",
        traceId: expect.stringMatching(/^trace-/),
      },
    });
  });

  it("R-I2: returns 422 when ttlHours exceeds the max ceiling", async () => {
    const ctx = makeCtx({
      body: {
        visitorName: "Maya Chen",
        host: "A. Okafor",
        unit: "18B",
        ttlHours: 9999,
      },
      guardId: ACTOR_ID,
    });
    await handleIssueVisitorInvitation(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(422);
    expect(ctx.getJson()).toMatchObject({
      error: { code: "INVITATION_INVALID_INPUT", field: "ttlHours" },
    });
  });

  it("R-I3: happy path → 201 with invitation body + traceId", async () => {
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    vi.spyOn(service, "issueVisitorInvitation").mockResolvedValueOnce({
      response: {
        invitation: {
          id: INVITATION_ID,
          qrToken: RAW_TOKEN,
          passUrl: `https://gate.example.com/pass/${RAW_TOKEN}`,
          expiresAt,
          issuedAt: new Date().toISOString(),
          visitorName: "Maya Chen",
          host: "A. Okafor",
          unit: "18B",
          plate: null,
        },
        traceId: "trace-mock-service",
      },
      statusCode: 201,
    });

    const ctx = makeCtx({
      body: { visitorName: "Maya Chen", host: "A. Okafor", unit: "18B" },
      guardId: ACTOR_ID,
    });
    await handleIssueVisitorInvitation(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(201);
    expect(ctx.getJson()).toMatchObject({
      invitation: {
        id: INVITATION_ID,
        qrToken: RAW_TOKEN,
        passUrl: expect.stringContaining(RAW_TOKEN),
        expiresAt,
      },
      traceId: "trace-mock-service",
    });
    expect(service.issueVisitorInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        visitorName: "Maya Chen",
        host: "A. Okafor",
        unit: "18B",
      }),
      ACTOR_ID,
      expect.anything(),
    );
  });

  it("R-I4: missing guardId (auth bypass) → 401 AUTH_REQUIRED (no service call)", async () => {
    const spy = vi.spyOn(service, "issueVisitorInvitation");
    const ctx = makeCtx({
      body: { visitorName: "Maya Chen", host: "A. Okafor", unit: "18B" },
      guardId: undefined,
    });
    await handleIssueVisitorInvitation(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(401);
    expect(ctx.getJson()).toMatchObject({
      error: {
        code: "AUTH_REQUIRED",
        traceId: expect.stringMatching(/^trace-/),
      },
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("R-I5: service ServiceError propagates to next() (error handler decides)", async () => {
    vi.spyOn(service, "issueVisitorInvitation").mockRejectedValueOnce(
      new ServiceError(
        VisitorInvitationErrorCodes.INTERNAL_ERROR,
        "DB unreachable",
        500,
      ),
    );

    const ctx = makeCtx({
      body: { visitorName: "Maya Chen", host: "A. Okafor", unit: "18B" },
      guardId: ACTOR_ID,
    });
    await handleIssueVisitorInvitation(ctx.req, ctx.res, ctx.next);

    expect(ctx.getNextErr()).toBeInstanceOf(ServiceError);
    expect((ctx.getNextErr() as ServiceError).code).toBe(
      VisitorInvitationErrorCodes.INTERNAL_ERROR,
    );
  });
});

// ─── GET /api/visitor-invitations/:token/preview ─────────────────────────────

describe("Route: GET /api/visitor-invitations/:token/preview", () => {
  it("R-P1: malformed token → 404 INVITATION_NOT_FOUND (does NOT leak format error)", async () => {
    const spy = vi.spyOn(service, "previewVisitorInvitation");
    const ctx = makeCtx({ params: { token: "too-short" } });
    await handlePreviewVisitorInvitation(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(404);
    expect(ctx.getJson()).toMatchObject({
      error: {
        code: "INVITATION_NOT_FOUND",
        traceId: expect.stringMatching(/^trace-/),
      },
    });
    // No service call — invalid format MUST NOT hit the DB.
    expect(spy).not.toHaveBeenCalled();
  });

  it("R-P2: happy path → 200 with ONLY safe display fields", async () => {
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    vi.spyOn(service, "previewVisitorInvitation").mockResolvedValueOnce({
      response: {
        invitation: {
          visitorName: "Maya Chen",
          host: "A. Okafor",
          unit: "18B",
          plate: "LND-482",
          expiresAt,
        },
      },
      statusCode: 200,
    });

    const ctx = makeCtx({ params: { token: RAW_TOKEN } });
    await handlePreviewVisitorInvitation(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(200);
    const body = ctx.getJson() as Record<string, unknown>;
    expect(body.invitation).toEqual({
      visitorName: "Maya Chen",
      host: "A. Okafor",
      unit: "18B",
      plate: "LND-482",
      expiresAt,
    });
    // No internal fields leak through the route layer either.
    expect(body.invitation).not.toHaveProperty("id");
    expect(body.invitation).not.toHaveProperty("qrTokenHash");
    expect(body.invitation).not.toHaveProperty("isUsed");
  });

  it("R-P3: service INVITATION_NOT_FOUND → 404 with contract shape + traceId", async () => {
    vi.spyOn(service, "previewVisitorInvitation").mockRejectedValueOnce(
      new ServiceError(
        VisitorInvitationErrorCodes.INVITATION_NOT_FOUND,
        "No invitation matches this pass link",
        404,
      ),
    );

    const ctx = makeCtx({ params: { token: RAW_TOKEN } });
    await handlePreviewVisitorInvitation(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(404);
    expect(ctx.getJson()).toMatchObject({
      error: {
        code: "INVITATION_NOT_FOUND",
        traceId: expect.stringMatching(/^trace-/),
      },
    });
  });

  it("R-P4: service INVITATION_EXPIRED → 410 (default-deny on stale tokens)", async () => {
    vi.spyOn(service, "previewVisitorInvitation").mockRejectedValueOnce(
      new ServiceError(
        VisitorInvitationErrorCodes.INVITATION_EXPIRED,
        "This invitation has expired",
        410,
      ),
    );

    const ctx = makeCtx({ params: { token: RAW_TOKEN } });
    await handlePreviewVisitorInvitation(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(410);
    expect(ctx.getJson()).toMatchObject({
      error: { code: "INVITATION_EXPIRED" },
    });
  });

  it("R-P5: service INVITATION_CONSUMED → 410 (default-deny on replay)", async () => {
    vi.spyOn(service, "previewVisitorInvitation").mockRejectedValueOnce(
      new ServiceError(
        VisitorInvitationErrorCodes.INVITATION_CONSUMED,
        "This invitation has already been used",
        410,
      ),
    );

    const ctx = makeCtx({ params: { token: RAW_TOKEN } });
    await handlePreviewVisitorInvitation(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(410);
    expect(ctx.getJson()).toMatchObject({
      error: { code: "INVITATION_CONSUMED" },
    });
  });

  it("R-P6: non-ServiceError from service propagates to next() (no leak)", async () => {
    vi.spyOn(service, "previewVisitorInvitation").mockRejectedValueOnce(
      new Error("kaboom"),
    );

    const ctx = makeCtx({ params: { token: RAW_TOKEN } });
    await handlePreviewVisitorInvitation(ctx.req, ctx.res, ctx.next);

    // The route MUST NOT send 500 with details. The error handler does that.
    expect(ctx.getNextErr()).toBeInstanceOf(Error);
    expect((ctx.getNextErr() as Error).message).toBe("kaboom");
  });
});
