// @vitest-environment node
/**
 * GatePass — Visitor Profile Route Handler Tests
 *
 * Source: src/docs/specs/visitor-profiles.md §4 (API surface).
 * Source: src/server/routes/visitor-profiles.ts
 *
 * Service-layer behavior is covered in visitor-profile-service.test.ts.
 * These tests pin the ROUTE layer:
 *   - Validation rejection → structured 422 with field + traceId
 *   - Service success → 201/200 + view body + traceId
 *   - Service ServiceError → propagated via next() to error handler
 *   - UUID param rejection → 422 with field='id'
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";
import {
  handleCreateVisitorProfile,
  handleListVisitorProfiles,
  handleGetVisitorProfile,
  handleUpdateVisitorProfile,
  handleSoftDeleteVisitorProfile,
  handleRestoreVisitorProfile,
} from "../routes/visitor-profiles";
import * as service from "../services/visitor-profile-service";
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

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const GUARD_ID = "22222222-2222-4222-8222-222222222222";

function makeView(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: PROFILE_ID,
    visitorName: "Maya Chen",
    host: "Alex Park",
    unit: "12A",
    plate: null,
    phoneE164: null,
    notes: null,
    watchFlag: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
    ...over,
  };
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

// ─── POST /api/visitor-profiles ──────────────────────────────────────────────

describe("Route: POST /api/visitor-profiles", () => {
  it("returns 422 PROFILE_INVALID_INPUT when visitorName is missing", async () => {
    const ctx = makeCtx({
      body: { host: "Alex Park", unit: "12A" },
      guardId: GUARD_ID,
    });
    await handleCreateVisitorProfile(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(422);
    expect(ctx.getJson()).toMatchObject({
      error: {
        code: "PROFILE_INVALID_INPUT",
        field: "visitorName",
        traceId: expect.stringMatching(/^trace-/),
      },
    });
  });

  it("returns 422 when phoneE164 is malformed", async () => {
    const ctx = makeCtx({
      body: {
        visitorName: "Maya",
        host: "Alex",
        unit: "12A",
        phoneE164: "not-a-phone",
      },
      guardId: GUARD_ID,
    });
    await handleCreateVisitorProfile(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(422);
    expect(ctx.getJson()).toMatchObject({
      error: { code: "PROFILE_INVALID_INPUT", field: "phoneE164" },
    });
  });

  it("returns 201 with the profile view on success", async () => {
    const view = makeView();
    vi.spyOn(service, "createVisitorProfile").mockResolvedValue(view);

    const ctx = makeCtx({
      body: {
        visitorName: "Maya Chen",
        host: "Alex Park",
        unit: "12A",
      },
      guardId: GUARD_ID,
    });
    await handleCreateVisitorProfile(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(201);
    const body = ctx.getJson() as { profile: typeof view; traceId: string };
    expect(body.profile.id).toBe(PROFILE_ID);
    expect(body.traceId).toMatch(/^trace-/);
  });

  it("propagates ServiceError to next() (PROFILE_DUPLICATE → 409)", async () => {
    const err = new ServiceError(
      "PROFILE_DUPLICATE",
      "Already exists",
      409
    );
    vi.spyOn(service, "createVisitorProfile").mockRejectedValue(err);

    const ctx = makeCtx({
      body: {
        visitorName: "Maya",
        host: "Alex",
        unit: "12A",
      },
      guardId: GUARD_ID,
    });
    await handleCreateVisitorProfile(ctx.req, ctx.res, ctx.next);
    expect(ctx.getNextErr()).toBe(err);
  });
});

// ─── GET /api/visitor-profiles ───────────────────────────────────────────────

describe("Route: GET /api/visitor-profiles", () => {
  it("returns 200 with the pagination envelope on success", async () => {
    vi.spyOn(service, "listVisitorProfiles").mockResolvedValue({
      profiles: [makeView()],
      pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
    });

    const ctx = makeCtx({ guardId: GUARD_ID });
    await handleListVisitorProfiles(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(200);
    const body = ctx.getJson() as {
      profiles: unknown[];
      pagination: { page: number };
      traceId: string;
    };
    expect(body.profiles).toHaveLength(1);
    expect(body.pagination.page).toBe(1);
    expect(body.traceId).toMatch(/^trace-/);
  });

  it("passes parsed query through to the service", async () => {
    const spy = vi
      .spyOn(service, "listVisitorProfiles")
      .mockResolvedValue({
        profiles: [],
        pagination: { page: 2, pageSize: 5, totalItems: 0, totalPages: 1 },
      });

    const ctx = makeCtx({
      query: {
        host: "Alex Park",
        page: "2",
        pageSize: "5",
        includeDeleted: "true",
      },
      guardId: GUARD_ID,
    });
    await handleListVisitorProfiles(ctx.req, ctx.res, ctx.next);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "Alex Park",
        page: 2,
        pageSize: 5,
        includeDeleted: true,
      }),
      expect.anything()
    );
  });

  it("returns 422 when page is not numeric", async () => {
    const ctx = makeCtx({
      query: { page: "abc" },
      guardId: GUARD_ID,
    });
    await handleListVisitorProfiles(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(422);
  });
});

// ─── GET /api/visitor-profiles/:id ───────────────────────────────────────────

describe("Route: GET /api/visitor-profiles/:id", () => {
  it("returns 422 when id is not a UUID", async () => {
    const ctx = makeCtx({
      params: { id: "not-a-uuid" },
      guardId: GUARD_ID,
    });
    await handleGetVisitorProfile(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(422);
    expect(ctx.getJson()).toMatchObject({
      error: { code: "PROFILE_INVALID_INPUT", field: "id" },
    });
  });

  it("returns 200 with the profile view", async () => {
    vi.spyOn(service, "getVisitorProfile").mockResolvedValue(makeView());
    const ctx = makeCtx({
      params: { id: PROFILE_ID },
      guardId: GUARD_ID,
    });
    await handleGetVisitorProfile(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(200);
    const body = ctx.getJson() as { profile: { id: string }; traceId: string };
    expect(body.profile.id).toBe(PROFILE_ID);
  });

  it("propagates 404 ServiceError via next()", async () => {
    const err = new ServiceError("PROFILE_NOT_FOUND", "missing", 404);
    vi.spyOn(service, "getVisitorProfile").mockRejectedValue(err);
    const ctx = makeCtx({
      params: { id: PROFILE_ID },
      guardId: GUARD_ID,
    });
    await handleGetVisitorProfile(ctx.req, ctx.res, ctx.next);
    expect(ctx.getNextErr()).toBe(err);
  });
});

// ─── PATCH /api/visitor-profiles/:id ─────────────────────────────────────────

describe("Route: PATCH /api/visitor-profiles/:id", () => {
  it("returns 422 when id is not a UUID", async () => {
    const ctx = makeCtx({
      params: { id: "not-a-uuid" },
      body: { watchFlag: true },
      guardId: GUARD_ID,
    });
    await handleUpdateVisitorProfile(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(422);
  });

  it("returns 422 when body contains an unknown field", async () => {
    const ctx = makeCtx({
      params: { id: PROFILE_ID },
      body: { junk: "x" },
      guardId: GUARD_ID,
    });
    await handleUpdateVisitorProfile(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(422);
  });

  it("returns 200 with the patched profile", async () => {
    vi.spyOn(service, "updateVisitorProfile").mockResolvedValue(
      makeView({ watchFlag: true })
    );
    const ctx = makeCtx({
      params: { id: PROFILE_ID },
      body: { watchFlag: true },
      guardId: GUARD_ID,
    });
    await handleUpdateVisitorProfile(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(200);
    const body = ctx.getJson() as { profile: { watchFlag: boolean } };
    expect(body.profile.watchFlag).toBe(true);
  });
});

// ─── DELETE /api/visitor-profiles/:id ────────────────────────────────────────

describe("Route: DELETE /api/visitor-profiles/:id", () => {
  it("returns 200 with the soft-deleted view", async () => {
    const view = makeView({ deletedAt: new Date().toISOString() });
    vi.spyOn(service, "softDeleteVisitorProfile").mockResolvedValue(view);

    const ctx = makeCtx({
      params: { id: PROFILE_ID },
      guardId: GUARD_ID,
    });
    await handleSoftDeleteVisitorProfile(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(200);
    const body = ctx.getJson() as { profile: { deletedAt: string | null } };
    expect(body.profile.deletedAt).not.toBeNull();
  });

  it("returns 422 when id is not a UUID", async () => {
    const ctx = makeCtx({
      params: { id: "bad" },
      guardId: GUARD_ID,
    });
    await handleSoftDeleteVisitorProfile(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(422);
  });

  it("propagates 404 ServiceError via next()", async () => {
    const err = new ServiceError("PROFILE_NOT_FOUND", "missing", 404);
    vi.spyOn(service, "softDeleteVisitorProfile").mockRejectedValue(err);
    const ctx = makeCtx({
      params: { id: PROFILE_ID },
      guardId: GUARD_ID,
    });
    await handleSoftDeleteVisitorProfile(ctx.req, ctx.res, ctx.next);
    expect(ctx.getNextErr()).toBe(err);
  });
});

// ─── POST /api/visitor-profiles/:id/restore ──────────────────────────────────

describe("Route: POST /api/visitor-profiles/:id/restore", () => {
  it("returns 200 with the restored profile", async () => {
    vi.spyOn(service, "restoreVisitorProfile").mockResolvedValue(makeView());
    const ctx = makeCtx({
      params: { id: PROFILE_ID },
      guardId: GUARD_ID,
    });
    await handleRestoreVisitorProfile(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(200);
  });

  it("propagates PROFILE_RESTORE_CONFLICT ServiceError", async () => {
    const err = new ServiceError(
      "PROFILE_RESTORE_CONFLICT",
      "already taken",
      409
    );
    vi.spyOn(service, "restoreVisitorProfile").mockRejectedValue(err);
    const ctx = makeCtx({
      params: { id: PROFILE_ID },
      guardId: GUARD_ID,
    });
    await handleRestoreVisitorProfile(ctx.req, ctx.res, ctx.next);
    expect(ctx.getNextErr()).toBe(err);
  });
});
