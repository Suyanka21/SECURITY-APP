// @vitest-environment node
/**
 * GatePass — Shift Log Route Handler Tests
 *
 * Source: src/docs/specs/shift-log-aggregation.md §4 (API surface).
 * Source: src/server/routes/shifts.ts
 *
 * Service-layer behaviour is covered in shift-log-service.test.ts.
 * These tests pin the ROUTE layer:
 *   - Validation rejection (bad ISO, non-UUID guardId) → 422 + field + traceId
 *   - Service success → 200 + body { window, shifts, traceId }
 *   - Service ServiceError (window invalid, too large) → propagated via next()
 *   - Default window applied when fromIso/toIso are omitted
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";

import { handleListShifts } from "../routes/shifts";
import * as service from "../services/shift-log-service";
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
  guardId,
}: {
  query?: Record<string, unknown>;
  guardId?: string;
}): MockCtx {
  let statusCode = 200;
  let jsonBody: unknown = null;
  let nextErr: unknown = undefined;

  const req = {
    query: query ?? {},
    params: {},
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

const GUARD_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

// ─── GET /api/admin/shifts ──────────────────────────────────────────────────

describe("Route: GET /api/admin/shifts", () => {
  it("returns 422 SHIFT_WINDOW_INVALID when fromIso is not an ISO-8601 UTC string", async () => {
    const ctx = makeCtx({
      query: { fromIso: "2024-01-15" },
      guardId: GUARD_ID,
    });
    await handleListShifts(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(422);
    expect(ctx.getJson()).toMatchObject({
      error: {
        code: "SHIFT_WINDOW_INVALID",
        field: "fromIso",
        traceId: expect.stringMatching(/^trace-/),
      },
    });
  });

  it("returns 422 when guardId is not a UUID", async () => {
    const ctx = makeCtx({
      query: { guardId: "not-a-uuid" },
      guardId: GUARD_ID,
    });
    await handleListShifts(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(422);
    expect(ctx.getJson()).toMatchObject({
      error: {
        code: "SHIFT_WINDOW_INVALID",
        field: "guardId",
      },
    });
  });

  it("returns 200 with the service result when query is valid", async () => {
    const mockResult = {
      window: {
        fromIso: "2024-01-15T00:00:00.000Z",
        toIso: "2024-01-16T00:00:00.000Z",
      },
      shifts: [
        {
          guardId: GUARD_ID,
          guardName: "A. Okafor",
          badgeNumber: "G-1042",
          totals: {
            entries: 1,
            qr: 1,
            walkIn: 0,
            override: 0,
            recognized: 0,
            auto: 0,
            approvalsDenied: 0,
            approvalsExpired: 0,
            autoApprovalsMatched: 0,
            overrideAuthorized: 0,
          },
        },
      ],
    };
    vi.spyOn(service, "listShifts").mockResolvedValueOnce(mockResult);

    const ctx = makeCtx({
      query: {
        fromIso: "2024-01-15T00:00:00.000Z",
        toIso: "2024-01-16T00:00:00.000Z",
      },
      guardId: GUARD_ID,
    });
    await handleListShifts(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(200);
    expect(ctx.getJson()).toMatchObject({
      window: mockResult.window,
      shifts: mockResult.shifts,
      traceId: expect.stringMatching(/^trace-/),
    });
  });

  it("defaults the window to today (UTC midnight → now) when fromIso/toIso omitted", async () => {
    const spy = vi.spyOn(service, "listShifts").mockResolvedValueOnce({
      window: { fromIso: "x", toIso: "y" },
      shifts: [],
    });

    const ctx = makeCtx({ guardId: GUARD_ID });
    await handleListShifts(ctx.req, ctx.res, ctx.next);

    expect(spy).toHaveBeenCalledTimes(1);
    const arg = spy.mock.calls[0][0];
    // Both bounds must be ISO-8601 Zulu and fromIso must be midnight UTC.
    expect(arg.fromIso).toMatch(
      /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/
    );
    expect(arg.toIso).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
    expect(ctx.getStatus()).toBe(200);
  });

  it("propagates a ServiceError from the service through next() unchanged", async () => {
    const err = new ServiceError(
      "SHIFT_WINDOW_TOO_LARGE",
      "Window too wide",
      422
    );
    vi.spyOn(service, "listShifts").mockRejectedValueOnce(err);

    const ctx = makeCtx({
      query: {
        fromIso: "2024-01-01T00:00:00.000Z",
        toIso: "2024-02-02T00:00:00.000Z",
      },
      guardId: GUARD_ID,
    });
    await handleListShifts(ctx.req, ctx.res, ctx.next);

    expect(ctx.getNextErr()).toBe(err);
  });

  it("forwards an optional guardId to the service unchanged", async () => {
    const spy = vi.spyOn(service, "listShifts").mockResolvedValueOnce({
      window: { fromIso: "x", toIso: "y" },
      shifts: [],
    });

    const ctx = makeCtx({
      query: {
        fromIso: "2024-01-15T00:00:00.000Z",
        toIso: "2024-01-16T00:00:00.000Z",
        guardId: GUARD_ID,
      },
      guardId: GUARD_ID,
    });
    await handleListShifts(ctx.req, ctx.res, ctx.next);

    expect(spy.mock.calls[0][0]).toMatchObject({ guardId: GUARD_ID });
  });
});
