// @vitest-environment node
/**
 * GatePass — requireAuth Supabase-mode tests.
 *
 * Source: src/server/middleware/auth.ts (requireAuthSupabase branch)
 * Source: src/docs/adr/0001-...md — the token authenticates a Supabase user;
 *         the guard id is resolved via guards.supabase_user_id, and role is
 *         read later from guards.role — never from the token.
 *
 * The Supabase JWT verifier is mocked so these tests exercise the middleware's
 * mapping/branching logic without a live JWKS. A separate concern (the actual
 * ES256/JWKS verification) lives in supabase-jwt.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";

// Mock the Supabase verifier module BEFORE importing the middleware.
vi.mock("../auth/supabase-jwt", () => ({
  isSupabaseAuthConfigured: () => true,
  verifySupabaseToken: vi.fn(),
}));

import { requireAuth } from "../middleware/auth";
import type { AuthenticatedRequest } from "../middleware/auth";
import * as supabaseJwt from "../auth/supabase-jwt";

const verifyMock = supabaseJwt.verifySupabaseToken as unknown as ReturnType<
  typeof vi.fn
>;

function makeDb(rows: unknown[]) {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
  };
}

function makeCtx(authHeader: string | undefined, rows: unknown[]) {
  let statusCode = 200;
  let jsonBody: unknown = null;
  let nextCalled = false;

  const req = {
    headers: authHeader ? { authorization: authHeader } : {},
    params: {},
    query: {},
    db: makeDb(rows),
  } as unknown as Request;

  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: unknown) {
      jsonBody = payload;
      return res;
    },
  } as unknown as Response;

  const next = () => {
    nextCalled = true;
  };

  return {
    req,
    res,
    next,
    getStatus: () => statusCode,
    getJson: () => jsonBody,
    wasNextCalled: () => nextCalled,
  };
}

describe("requireAuth — Supabase mode", () => {
  beforeEach(() => {
    verifyMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps a verified Supabase user to the linked guard id and calls next()", async () => {
    verifyMock.mockResolvedValue({ sub: "supabase-uuid-1" });
    const ctx = makeCtx("Bearer good-token", [{ id: "guard-canonical-1" }]);

    await requireAuth(ctx.req, ctx.res, ctx.next);

    expect(ctx.wasNextCalled()).toBe(true);
    expect((ctx.req as AuthenticatedRequest).guardId).toBe("guard-canonical-1");
  });

  it("rejects a Supabase user with no linked guard row (403 AUTH_NO_GUARD_LINK)", async () => {
    verifyMock.mockResolvedValue({ sub: "supabase-uuid-unlinked" });
    const ctx = makeCtx("Bearer good-token", []);

    await requireAuth(ctx.req, ctx.res, ctx.next);

    expect(ctx.wasNextCalled()).toBe(false);
    expect(ctx.getStatus()).toBe(403);
    expect((ctx.getJson() as { error: { code: string } }).error.code).toBe(
      "AUTH_NO_GUARD_LINK",
    );
  });

  it("rejects an expired token with 401 AUTH_TOKEN_EXPIRED", async () => {
    verifyMock.mockRejectedValue(
      Object.assign(new Error("expired"), { code: "ERR_JWT_EXPIRED" }),
    );
    const ctx = makeCtx("Bearer expired-token", []);

    await requireAuth(ctx.req, ctx.res, ctx.next);

    expect(ctx.wasNextCalled()).toBe(false);
    expect(ctx.getStatus()).toBe(401);
    expect((ctx.getJson() as { error: { code: string } }).error.code).toBe(
      "AUTH_TOKEN_EXPIRED",
    );
  });

  it("rejects a tampered/invalid token with 401 AUTH_TOKEN_INVALID", async () => {
    verifyMock.mockRejectedValue(
      Object.assign(new Error("bad sig"), {
        code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
      }),
    );
    const ctx = makeCtx("Bearer tampered", []);

    await requireAuth(ctx.req, ctx.res, ctx.next);

    expect(ctx.wasNextCalled()).toBe(false);
    expect(ctx.getStatus()).toBe(401);
    expect((ctx.getJson() as { error: { code: string } }).error.code).toBe(
      "AUTH_TOKEN_INVALID",
    );
  });

  it("still rejects a missing Authorization header (401 AUTH_TOKEN_MISSING)", async () => {
    const ctx = makeCtx(undefined, []);

    await requireAuth(ctx.req, ctx.res, ctx.next);

    expect(ctx.wasNextCalled()).toBe(false);
    expect(ctx.getStatus()).toBe(401);
    expect((ctx.getJson() as { error: { code: string } }).error.code).toBe(
      "AUTH_TOKEN_MISSING",
    );
  });
});
