// @vitest-environment node
/**
 * GatePass — Exit Tracking Route Handler Tests
 *
 * Source: src/docs/specs/exit-tracking.md §6 (API surface).
 * Source: src/server/routes/exit-tracking.ts
 *
 * Service-layer behaviour is covered in exit-tracking-service.test.ts.
 * These tests pin the ROUTE layer:
 *   - Validation rejection (bad UUID) → 422 + field + traceId
 *   - Service success → 201 (record exit) / 200 (on-premise list)
 *   - Service ServiceError → propagated via next()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";

import {
  handleRecordExit,
  handleListOnPremise,
} from "../routes/exit-tracking";
import * as service from "../services/exit-tracking-service";
import { ServiceError } from "../services/errors";
import type { RecordExitResponse, ListOnPremiseResponse } from "../validation/exit-tracking-schemas";

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
  params,
  query,
  guardId,
}: {
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  guardId?: string;
}): MockCtx {
  let statusCode = 200;
  let jsonBody: unknown = null;
  let nextErr: unknown = undefined;

  const req = {
    params: params ?? {},
    query: query ?? {},
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
const ENTRY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

// ─── POST /api/entries/:entryId/exit ────────────────────────────────────────

describe("Route: POST /api/entries/:entryId/exit", () => {
  it("returns 422 EXIT_ENTRY_ID_INVALID when entryId is not a valid UUID", async () => {
    const ctx = makeCtx({
      params: { entryId: "not-a-uuid" },
      guardId: GUARD_ID,
    });
    await handleRecordExit(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(422);
    expect(ctx.getJson()).toMatchObject({
      error: {
        code: "EXIT_ENTRY_ID_INVALID",
        field: "entryId",
        traceId: expect.stringMatching(/^trace-/),
      },
    });
  });

  it("returns 201 with exit record on success", async () => {
    const exitResult = {
      exit: {
        id: "exit-id-1",
        entryId: ENTRY_ID,
        guardId: GUARD_ID,
        traceId: "trace-abc",
        createdAt: "2024-06-01T10:30:00.000Z",
      },
      traceId: "trace-abc",
    };
    vi.spyOn(service, "recordExit").mockResolvedValue(exitResult);

    const ctx = makeCtx({
      params: { entryId: ENTRY_ID },
      guardId: GUARD_ID,
    });
    await handleRecordExit(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(201);
    const body = ctx.getJson() as RecordExitResponse;
    expect(body.exit.id).toBe("exit-id-1");
    expect(body.exit.entryId).toBe(ENTRY_ID);
    expect(body.exit.guardId).toBe(GUARD_ID);
    expect(body.traceId).toBe("trace-abc");
  });

  it("extracts guardId from the authenticated request (not body)", async () => {
    const exitResult = {
      exit: {
        id: "exit-id-2",
        entryId: ENTRY_ID,
        guardId: GUARD_ID,
        traceId: "trace-def",
        createdAt: "2024-06-01T10:30:00.000Z",
      },
      traceId: "trace-def",
    };
    const spy = vi.spyOn(service, "recordExit").mockResolvedValue(exitResult);

    const ctx = makeCtx({
      params: { entryId: ENTRY_ID },
      guardId: GUARD_ID,
    });
    await handleRecordExit(ctx.req, ctx.res, ctx.next);

    expect(spy).toHaveBeenCalledWith(ENTRY_ID, GUARD_ID, expect.anything());
  });

  it("forwards ServiceError (404 EXIT_NO_OPEN_ENTRY) via next()", async () => {
    vi.spyOn(service, "recordExit").mockRejectedValue(
      new ServiceError("EXIT_NO_OPEN_ENTRY", "No entry found", 404, "entryId"),
    );

    const ctx = makeCtx({
      params: { entryId: ENTRY_ID },
      guardId: GUARD_ID,
    });
    await handleRecordExit(ctx.req, ctx.res, ctx.next);

    const err = ctx.getNextErr() as ServiceError;
    expect(err).toBeInstanceOf(ServiceError);
    expect(err.code).toBe("EXIT_NO_OPEN_ENTRY");
    expect(err.statusCode).toBe(404);
  });

  it("forwards ServiceError (409 EXIT_ALREADY_RECORDED) via next()", async () => {
    vi.spyOn(service, "recordExit").mockRejectedValue(
      new ServiceError(
        "EXIT_ALREADY_RECORDED",
        "Already recorded",
        409,
        "entryId",
      ),
    );

    const ctx = makeCtx({
      params: { entryId: ENTRY_ID },
      guardId: GUARD_ID,
    });
    await handleRecordExit(ctx.req, ctx.res, ctx.next);

    const err = ctx.getNextErr() as ServiceError;
    expect(err).toBeInstanceOf(ServiceError);
    expect(err.code).toBe("EXIT_ALREADY_RECORDED");
    expect(err.statusCode).toBe(409);
  });

  it("forwards unexpected errors via next()", async () => {
    vi.spyOn(service, "recordExit").mockRejectedValue(
      new Error("unexpected boom"),
    );

    const ctx = makeCtx({
      params: { entryId: ENTRY_ID },
      guardId: GUARD_ID,
    });
    await handleRecordExit(ctx.req, ctx.res, ctx.next);

    expect(ctx.getNextErr()).toBeInstanceOf(Error);
  });
});

// ─── GET /api/entries/on-premise ────────────────────────────────────────────

describe("Route: GET /api/entries/on-premise", () => {
  it("returns 200 with entries list on success", async () => {
    const onPremiseResult = {
      entries: [
        {
          id: ENTRY_ID,
          visitorName: "Maya Chen",
          host: "A. Okafor",
          unit: "18B",
          plate: "LND-482",
          method: "walk-in",
          guardId: GUARD_ID,
          createdAt: "2024-06-01T10:30:00.000Z",
        },
      ],
      count: 1,
      traceId: "trace-ghi",
    };
    vi.spyOn(service, "listOnPremise").mockResolvedValue(onPremiseResult);

    const ctx = makeCtx({ guardId: GUARD_ID });
    await handleListOnPremise(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(200);
    const body = ctx.getJson() as ListOnPremiseResponse;
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].visitorName).toBe("Maya Chen");
    expect(body.count).toBe(1);
    expect(body.traceId).toBe("trace-ghi");
  });

  it("returns 200 with empty entries when none are on-premise", async () => {
    vi.spyOn(service, "listOnPremise").mockResolvedValue({
      entries: [],
      count: 0,
      traceId: "trace-empty",
    });

    const ctx = makeCtx({ guardId: GUARD_ID });
    await handleListOnPremise(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(200);
    const body = ctx.getJson() as ListOnPremiseResponse;
    expect(body.entries).toEqual([]);
    expect(body.count).toBe(0);
  });

  it("forwards unexpected errors via next()", async () => {
    vi.spyOn(service, "listOnPremise").mockRejectedValue(
      new Error("db crashed"),
    );

    const ctx = makeCtx({ guardId: GUARD_ID });
    await handleListOnPremise(ctx.req, ctx.res, ctx.next);

    expect(ctx.getNextErr()).toBeInstanceOf(Error);
  });
});
