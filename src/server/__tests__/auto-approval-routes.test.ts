// @vitest-environment node
/**
 * GatePass — Auto-Approval Route Handler Tests
 *
 * Source: src/docs/specs/auto-approval.md §7 (endpoints), §8 (security).
 * Source: src/server/routes/auto-approval.ts
 *
 * Service-layer behavior is covered in auto-approval-service.test.ts.
 * These tests pin the ROUTE layer:
 *   - Validation rejection → structured 422 with field + traceId
 *   - Service success → 201/200 + view body + traceId
 *   - Service ServiceError → propagated via next() to the error handler
 *   - UUID param rejection → 422 with field='id'
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";
import {
  handleSeedAutoApprovalRule,
  handleListAutoApprovalRules,
  handleDeactivateAutoApprovalRule,
} from "../routes/auto-approval";
import * as service from "../services/auto-approval-service";
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
  query,
  params,
  guardId,
}: {
  body?: unknown;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  guardId?: string;
}): MockCtx {
  let statusCode = 200;
  let jsonBody: unknown = null;
  let nextErr: unknown = undefined;

  const req = {
    body,
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

const RULE_ID = "11111111-1111-4111-8111-111111111111";
const GUARD_ID = "22222222-2222-4222-8222-222222222222";

function makeView(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: RULE_ID,
    visitorName: "Maya Chen",
    host: "Alex Park",
    unit: "12A",
    plateRequired: null,
    active: true,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastMatchedAt: null,
    matchCount: 0,
    ...over,
  };
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

// ─── POST /api/auto-approval-rules ──────────────────────────────────────────

describe("Route: POST /api/auto-approval-rules", () => {
  it("returns 422 RULE_INVALID_INPUT when visitorName is missing", async () => {
    const ctx = makeCtx({
      body: {
        host: "Alex Park",
        unit: "12A",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
      guardId: GUARD_ID,
    });
    await handleSeedAutoApprovalRule(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(422);
    expect(ctx.getJson()).toMatchObject({
      error: {
        code: "RULE_INVALID_INPUT",
        field: "visitorName",
        traceId: expect.stringMatching(/^trace-/),
      },
    });
  });

  it("returns 422 when expiresAt is not ISO 8601", async () => {
    const ctx = makeCtx({
      body: {
        visitorName: "Maya Chen",
        host: "Alex Park",
        unit: "12A",
        expiresAt: "not-a-date",
      },
      guardId: GUARD_ID,
    });
    await handleSeedAutoApprovalRule(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(422);
    expect(ctx.getJson()).toMatchObject({
      error: { code: "RULE_INVALID_INPUT", field: "expiresAt" },
    });
  });

  it("returns 201 with the rule view on success", async () => {
    const view = makeView();
    vi.spyOn(service, "seedAutoApprovalRule").mockResolvedValue(view);

    const ctx = makeCtx({
      body: {
        visitorName: "Maya Chen",
        host: "Alex Park",
        unit: "12A",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
      guardId: GUARD_ID,
    });
    await handleSeedAutoApprovalRule(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(201);
    const body = ctx.getJson() as { rule: typeof view; traceId: string };
    expect(body.rule.id).toBe(RULE_ID);
    expect(body.rule).not.toHaveProperty("createdByGuardId");
    expect(body.traceId).toMatch(/^trace-/);
  });

  it("propagates ServiceError to next() (RULE_DUPLICATE → 409)", async () => {
    const err = new ServiceError(
      "RULE_DUPLICATE",
      "An active rule already exists",
      409,
    );
    vi.spyOn(service, "seedAutoApprovalRule").mockRejectedValue(err);

    const ctx = makeCtx({
      body: {
        visitorName: "Maya Chen",
        host: "Alex Park",
        unit: "12A",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
      guardId: GUARD_ID,
    });
    await handleSeedAutoApprovalRule(ctx.req, ctx.res, ctx.next);

    expect(ctx.getNextErr()).toBe(err);
  });
});

// ─── GET /api/auto-approval-rules ───────────────────────────────────────────

describe("Route: GET /api/auto-approval-rules", () => {
  it("returns 200 with the active rules by default", async () => {
    const rules = [makeView()];
    vi.spyOn(service, "listAutoApprovalRules").mockResolvedValue(rules);

    const ctx = makeCtx({ query: {}, guardId: GUARD_ID });
    await handleListAutoApprovalRules(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(200);
    const body = ctx.getJson() as { rules: unknown[]; traceId: string };
    expect(body.rules).toHaveLength(1);
    expect(body.traceId).toMatch(/^trace-/);
  });

  it("passes includeInactive=true through correctly", async () => {
    const spy = vi
      .spyOn(service, "listAutoApprovalRules")
      .mockResolvedValue([]);
    const ctx = makeCtx({
      query: { includeInactive: "true" },
      guardId: GUARD_ID,
    });
    await handleListAutoApprovalRules(ctx.req, ctx.res, ctx.next);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ includeInactive: true }),
      expect.anything(),
    );
  });

  it("returns 422 when query.host is too long", async () => {
    const ctx = makeCtx({
      query: { host: "x".repeat(121) },
      guardId: GUARD_ID,
    });
    await handleListAutoApprovalRules(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(422);
  });
});

// ─── POST /api/auto-approval-rules/:id/deactivate ──────────────────────────

describe("Route: POST /api/auto-approval-rules/:id/deactivate", () => {
  it("returns 422 when :id is not a UUID", async () => {
    const ctx = makeCtx({
      params: { id: "not-a-uuid" },
      guardId: GUARD_ID,
    });
    await handleDeactivateAutoApprovalRule(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(422);
    expect(ctx.getJson()).toMatchObject({
      error: { code: "RULE_INVALID_INPUT", field: "id" },
    });
  });

  it("returns 200 with the deactivated view on success", async () => {
    const view = makeView({ active: false });
    vi.spyOn(service, "deactivateAutoApprovalRule").mockResolvedValue(view);

    const ctx = makeCtx({
      params: { id: RULE_ID },
      guardId: GUARD_ID,
    });
    await handleDeactivateAutoApprovalRule(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(200);
    const body = ctx.getJson() as { rule: typeof view; traceId: string };
    expect(body.rule.active).toBe(false);
  });

  it("propagates ServiceError to next() (NOT_FOUND → 404)", async () => {
    const err = new ServiceError("NOT_FOUND", "Rule not found", 404);
    vi.spyOn(service, "deactivateAutoApprovalRule").mockRejectedValue(err);

    const ctx = makeCtx({
      params: { id: RULE_ID },
      guardId: GUARD_ID,
    });
    await handleDeactivateAutoApprovalRule(ctx.req, ctx.res, ctx.next);
    expect(ctx.getNextErr()).toBe(err);
  });
});
