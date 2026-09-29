// @vitest-environment node
/**
 * GatePass — resident auth middleware, Supabase mode.
 *
 * Source: src/server/middleware/resident-auth.ts
 * Source: src/docs/specs/resident-portal.md §2.3 / §5
 *
 * Same JWKS verifier as staff (mocked here, as in
 * auth-supabase-middleware.test.ts); the token's `sub` is resolved against
 * residents.supabase_user_id — never against guards — and both the resident
 * and its unit must be active. Guard/admin tokens therefore cannot satisfy a
 * resident route, and (proven alongside) a resident token cannot satisfy
 * requireAuth because it has no guards.supabase_user_id link.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";

vi.mock("../auth/supabase-jwt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/supabase-jwt")>();
  return {
    ...actual,
    isSupabaseAuthConfigured: () => true,
    verifySupabaseToken: vi.fn(),
  };
});

import {
  requireResidentAuth,
  requireSupabaseUser,
} from "../middleware/resident-auth";
import type {
  ResidentRequest,
  SupabaseUserRequest,
} from "../middleware/resident-auth";
import { requireAuth } from "../middleware/auth";
import * as supabaseJwt from "../auth/supabase-jwt";

const verifyMock = vi.mocked(supabaseJwt.verifySupabaseToken);

interface JoinedRow {
  residentId: string;
  supabaseUserId: string;
  displayName: string;
  phoneE164: string;
  residentActive: boolean;
  unitId: string;
  unitLabel: string;
  unitActive: boolean;
}

/** select().from().innerJoin().where() and select().from().where() both resolve to `rows`. */
function makeDb(rows: unknown[], fail = false) {
  const where = () => (fail ? Promise.reject(new Error("db down")) : Promise.resolve(rows));
  return {
    select: () => ({
      from: () => ({
        where,
        innerJoin: () => ({ where }),
      }),
    }),
  };
}

function makeCtx(authHeader: string | undefined, rows: unknown[], opts: { fail?: boolean; noDb?: boolean } = {}) {
  let statusCode = 200;
  let jsonBody: unknown = null;
  let nextCalled = false;

  const req = {
    headers: authHeader ? { authorization: authHeader } : {},
    params: {},
    query: {},
    body: {},
    ...(opts.noDb ? {} : { db: makeDb(rows, opts.fail) }),
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

  return {
    req,
    res,
    next: () => {
      nextCalled = true;
    },
    getStatus: () => statusCode,
    getCode: () => (jsonBody as { error: { code: string } }).error.code,
    wasNextCalled: () => nextCalled,
  };
}

const ACTIVE: JoinedRow = {
  residentId: "res-1",
  supabaseUserId: "sb-user-1",
  displayName: "Amina",
  phoneE164: "+254700000001",
  residentActive: true,
  unitId: "unit-1",
  unitLabel: "18B",
  unitActive: true,
};

describe("requireSupabaseUser — Supabase mode", () => {
  beforeEach(() => verifyMock.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it("injects the verified sub and E.164 phone, without touching the DB", async () => {
    verifyMock.mockResolvedValue({ sub: "sb-user-9", phone: "+254711111111" });
    const ctx = makeCtx("Bearer t", [], { noDb: true });
    await requireSupabaseUser(ctx.req, ctx.res, ctx.next);
    expect(ctx.wasNextCalled()).toBe(true);
    const r = ctx.req as SupabaseUserRequest;
    expect(r.supabaseUserId).toBe("sb-user-9");
    expect(r.supabasePhone).toBe("+254711111111");
  });

  it("401 AUTH_TOKEN_MISSING / AUTH_TOKEN_EXPIRED / AUTH_TOKEN_INVALID", async () => {
    const missing = makeCtx(undefined, []);
    await requireSupabaseUser(missing.req, missing.res, missing.next);
    expect(missing.getStatus()).toBe(401);
    expect(missing.getCode()).toBe("AUTH_TOKEN_MISSING");

    verifyMock.mockRejectedValue(Object.assign(new Error("x"), { code: "ERR_JWT_EXPIRED" }));
    const expired = makeCtx("Bearer t", []);
    await requireSupabaseUser(expired.req, expired.res, expired.next);
    expect(expired.getStatus()).toBe(401);
    expect(expired.getCode()).toBe("AUTH_TOKEN_EXPIRED");

    verifyMock.mockRejectedValue(Object.assign(new Error("x"), { code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" }));
    const bad = makeCtx("Bearer t", []);
    await requireSupabaseUser(bad.req, bad.res, bad.next);
    expect(bad.getStatus()).toBe(401);
    expect(bad.getCode()).toBe("AUTH_TOKEN_INVALID");
    expect(bad.wasNextCalled()).toBe(false);
  });
});

describe("requireResidentAuth — Supabase mode", () => {
  beforeEach(() => verifyMock.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it("maps sub → residents.supabase_user_id and injects DB-derived identity + unit", async () => {
    verifyMock.mockResolvedValue({ sub: "sb-user-1", phone: "+254700000001" });
    const ctx = makeCtx("Bearer t", [ACTIVE]);
    await requireResidentAuth(ctx.req, ctx.res, ctx.next);
    expect(ctx.wasNextCalled()).toBe(true);
    expect((ctx.req as ResidentRequest).resident).toEqual({
      residentId: "res-1",
      supabaseUserId: "sb-user-1",
      displayName: "Amina",
      phoneE164: "+254700000001",
      unitId: "unit-1",
      unitLabel: "18B",
    });
  });

  it("a verified user with no resident row (e.g. a guard/admin) → 403 AUTH_NO_RESIDENT_LINK", async () => {
    verifyMock.mockResolvedValue({ sub: "sb-guard-user", email: "guard@estate.test" });
    const ctx = makeCtx("Bearer staff-token", []);
    await requireResidentAuth(ctx.req, ctx.res, ctx.next);
    expect(ctx.wasNextCalled()).toBe(false);
    expect(ctx.getStatus()).toBe(403);
    expect(ctx.getCode()).toBe("AUTH_NO_RESIDENT_LINK");
  });

  it("inactive resident → 403 RESIDENT_INACTIVE", async () => {
    verifyMock.mockResolvedValue({ sub: "sb-user-1" });
    const ctx = makeCtx("Bearer t", [{ ...ACTIVE, residentActive: false }]);
    await requireResidentAuth(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(403);
    expect(ctx.getCode()).toBe("RESIDENT_INACTIVE");
    expect(ctx.wasNextCalled()).toBe(false);
  });

  it("active resident on an inactive unit → 403 UNIT_INACTIVE", async () => {
    verifyMock.mockResolvedValue({ sub: "sb-user-1" });
    const ctx = makeCtx("Bearer t", [{ ...ACTIVE, unitActive: false }]);
    await requireResidentAuth(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(403);
    expect(ctx.getCode()).toBe("UNIT_INACTIVE");
    expect(ctx.wasNextCalled()).toBe(false);
  });

  it("fails closed on DB lookup failure and on a missing DB handle (500 INTERNAL_ERROR)", async () => {
    verifyMock.mockResolvedValue({ sub: "sb-user-1" });
    const failing = makeCtx("Bearer t", [], { fail: true });
    await requireResidentAuth(failing.req, failing.res, failing.next);
    expect(failing.getStatus()).toBe(500);
    expect(failing.getCode()).toBe("INTERNAL_ERROR");
    expect(failing.wasNextCalled()).toBe(false);

    const noDb = makeCtx("Bearer t", [], { noDb: true });
    await requireResidentAuth(noDb.req, noDb.res, noDb.next);
    expect(noDb.getStatus()).toBe(500);
    expect(noDb.wasNextCalled()).toBe(false);
  });

  it("never reads the DB when the token itself is refused", async () => {
    verifyMock.mockRejectedValue(Object.assign(new Error("x"), { code: "ERR_JWT_EXPIRED" }));
    const ctx = makeCtx("Bearer t", [ACTIVE]);
    await requireResidentAuth(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(401);
    expect(ctx.wasNextCalled()).toBe(false);
  });
});

describe("cross-role: a resident's Supabase token against staff requireAuth", () => {
  beforeEach(() => verifyMock.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it("is refused with 403 AUTH_NO_GUARD_LINK — residents are not rows in guards", async () => {
    verifyMock.mockResolvedValue({ sub: "sb-user-1", phone: "+254700000001" });
    // guards.supabase_user_id lookup finds nothing for a resident user.
    const ctx = makeCtx("Bearer resident-token", []);
    await requireAuth(ctx.req, ctx.res, ctx.next);
    expect(ctx.wasNextCalled()).toBe(false);
    expect(ctx.getStatus()).toBe(403);
    expect(ctx.getCode()).toBe("AUTH_NO_GUARD_LINK");
  });
});
