// @vitest-environment node
/**
 * GatePass — Authentication Middleware Tests
 *
 * Source: TRUSTLESS-AUDIT-REPORT [C1] — "No authentication middleware exists"
 * Source: TRUSTLESS-AUDIT-REPORT [C3] — "Guard bypass via direct guardId injection"
 *
 * FAILURE CHECK verification:
 * - Can a caller impersonate another guard? → Tests 1-3 prove NO
 * - Can guardId still be injected manually? → Tests 4-5 prove NO
 */

import { describe, it, expect } from "vitest";
import { requireAuth, generateGuardToken, getJWTSecret } from "../middleware/auth";
import type { AuthenticatedRequest } from "../middleware/auth";
import type { Request, Response } from "express";
import * as jwt from "jsonwebtoken";

const GUARD_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

/**
 * Creates mock Express req/res/next for middleware testing.
 */
function createMockContext(headers: Record<string, string> = {}) {
  const req = {
    headers: {},
  } as unknown as Request;

  // Set headers (lowercase as Express normalizes them)
  Object.entries(headers).forEach(([key, value]) => {
    (req.headers as any)[key.toLowerCase()] = value;
  });

  let statusCode = 0;
  let jsonBody: any = null;
  let nextCalled = false;

  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(body: any) {
      jsonBody = body;
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
    getBody: () => jsonBody,
    wasNextCalled: () => nextCalled,
  };
}

// ─── Token Rejection Tests ───────────────────────────────────────────────────

describe("Auth Middleware — Token Rejection", () => {
  // Test 1: Missing Authorization header → 401
  it("rejects request with no Authorization header", () => {
    const { req, res, next, getStatus, getBody, wasNextCalled } = createMockContext();

    requireAuth(req, res, next);

    expect(getStatus()).toBe(401);
    expect(getBody().error.code).toBe("AUTH_TOKEN_MISSING");
    expect(getBody().error.traceId).toBeDefined();
    expect(wasNextCalled()).toBe(false);
  });

  // Test 2: Malformed Authorization header → 401
  it("rejects request with malformed Authorization header", () => {
    const { req, res, next, getStatus, getBody, wasNextCalled } = createMockContext({
      Authorization: "Basic abc123",
    });

    requireAuth(req, res, next);

    expect(getStatus()).toBe(401);
    expect(getBody().error.code).toBe("AUTH_TOKEN_MALFORMED");
    expect(wasNextCalled()).toBe(false);
  });

  // Test 3: Invalid JWT signature → 401
  it("rejects request with invalid JWT signature", () => {
    const badToken = jwt.sign({ sub: GUARD_ID }, "wrong-secret", { algorithm: "HS256" });
    const { req, res, next, getStatus, getBody, wasNextCalled } = createMockContext({
      Authorization: `Bearer ${badToken}`,
    });

    requireAuth(req, res, next);

    expect(getStatus()).toBe(401);
    expect(getBody().error.code).toBe("AUTH_TOKEN_INVALID");
    expect(wasNextCalled()).toBe(false);
  });

  // Test 4: Expired token → 401
  it("rejects request with expired JWT token", () => {
    const expiredToken = jwt.sign(
      { sub: GUARD_ID, exp: Math.floor(Date.now() / 1000) - 3600 },
      getJWTSecret(),
      { algorithm: "HS256" }
    );
    const { req, res, next, getStatus, getBody, wasNextCalled } = createMockContext({
      Authorization: `Bearer ${expiredToken}`,
    });

    requireAuth(req, res, next);

    expect(getStatus()).toBe(401);
    expect(getBody().error.code).toBe("AUTH_TOKEN_EXPIRED");
    expect(wasNextCalled()).toBe(false);
  });

  // Test 5: Token without sub claim → 403
  it("rejects token with missing sub (guardId) claim", () => {
    const noSubToken = jwt.sign({ role: "guard" }, getJWTSecret(), {
      algorithm: "HS256",
      expiresIn: "1h",
    });
    const { req, res, next, getStatus, getBody, wasNextCalled } = createMockContext({
      Authorization: `Bearer ${noSubToken}`,
    });

    requireAuth(req, res, next);

    expect(getStatus()).toBe(403);
    expect(getBody().error.code).toBe("AUTH_TOKEN_INVALID");
    expect(wasNextCalled()).toBe(false);
  });
});

// ─── Token Acceptance Tests ──────────────────────────────────────────────────

describe("Auth Middleware — Token Acceptance", () => {
  // Test 6: Valid token → next() called, guardId injected
  it("accepts valid token and injects guardId into request", () => {
    const token = generateGuardToken(GUARD_ID);
    const { req, res, next, getStatus, wasNextCalled } = createMockContext({
      Authorization: `Bearer ${token}`,
    });

    requireAuth(req, res, next);

    expect(wasNextCalled()).toBe(true);
    expect(getStatus()).toBe(0); // No error response sent
    expect((req as AuthenticatedRequest).guardId).toBe(GUARD_ID);
  });

  // Test 7: guardId comes from token, not from body
  // HARD RULE: "guardId must NEVER be accepted from request body"
  it("uses guardId from token even when body contains a different guardId", () => {
    const realGuardId = GUARD_ID;
    const fakeGuardId = "ffffffff-ffff-ffff-ffff-ffffffffffff";

    const token = generateGuardToken(realGuardId);
    const { req, res, next, wasNextCalled } = createMockContext({
      Authorization: `Bearer ${token}`,
    });

    // Simulate attacker injecting guardId in body
    (req as any).body = { guardId: fakeGuardId };

    requireAuth(req, res, next);

    expect(wasNextCalled()).toBe(true);
    // guardId on req is from the TOKEN, not the body
    expect((req as AuthenticatedRequest).guardId).toBe(realGuardId);
    expect((req as AuthenticatedRequest).guardId).not.toBe(fakeGuardId);
  });

  // Test 8: Each token produces the correct guardId
  it("injects different guardIds for different tokens", () => {
    const guard1 = "11111111-1111-1111-1111-111111111111";
    const guard2 = "22222222-2222-2222-2222-222222222222";

    const token1 = generateGuardToken(guard1);
    const token2 = generateGuardToken(guard2);

    const ctx1 = createMockContext({ Authorization: `Bearer ${token1}` });
    const ctx2 = createMockContext({ Authorization: `Bearer ${token2}` });

    requireAuth(ctx1.req, ctx1.res, ctx1.next);
    requireAuth(ctx2.req, ctx2.res, ctx2.next);

    expect((ctx1.req as AuthenticatedRequest).guardId).toBe(guard1);
    expect((ctx2.req as AuthenticatedRequest).guardId).toBe(guard2);
  });
});

// ─── Error Shape Tests ───────────────────────────────────────────────────────

describe("Auth Middleware — Error Shape", () => {
  // Test 9: All error responses follow contract §2 APIError shape
  it("returns contract-compliant error shape with traceId", () => {
    const { req, res, next, getBody } = createMockContext();

    requireAuth(req, res, next);

    const body = getBody();
    expect(body).toHaveProperty("error");
    expect(body.error).toHaveProperty("code");
    expect(body.error).toHaveProperty("message");
    expect(body.error).toHaveProperty("traceId");
    expect(typeof body.error.code).toBe("string");
    expect(typeof body.error.message).toBe("string");
    expect(body.error.traceId).toMatch(/^trace-/);
  });
});

// ─── Token Generation Tests ─────────────────────────────────────────────────

describe("Token Generation Utility", () => {
  // Test 10: generateGuardToken creates valid JWT
  it("generates a token that the middleware accepts", () => {
    const token = generateGuardToken(GUARD_ID);
    const { req, res, next, wasNextCalled } = createMockContext({
      Authorization: `Bearer ${token}`,
    });

    requireAuth(req, res, next);

    expect(wasNextCalled()).toBe(true);
    expect((req as AuthenticatedRequest).guardId).toBe(GUARD_ID);
  });

  // Test 11: Token expiration works
  it("generates tokens with configurable expiration", () => {
    // Generate a token that expires in 1 second
    const shortToken = generateGuardToken(GUARD_ID, "1s");

    // Verify it's a valid JWT structure
    const decoded = jwt.decode(shortToken) as any;
    expect(decoded.sub).toBe(GUARD_ID);
    expect(decoded.exp).toBeDefined();
    expect(decoded.iat).toBeDefined();
  });
});

// ─── [M2 FIX] Production JWT_SECRET Validation ──────────────────────────────
// Source: Trustless-System-Auditor — "Simulate missing JWT_SECRET in production"
// Source: Security-and-Hardening — "No fallback secrets in production"
// Source: Code-Review-and-Quality — "Fail loudly on misconfiguration"

describe("Auth — Production JWT_SECRET Fail-Fast", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore environment
    process.env = { ...originalEnv };
  });

  // Test 12: Missing JWT_SECRET in production → FATAL error
  it("throws fatal error when JWT_SECRET is missing in production", async () => {
    // Simulate production with no secret
    process.env.NODE_ENV = "production";
    delete process.env.JWT_SECRET;

    // Dynamic re-import triggers resolveJWTSecret() at module load
    await expect(async () => {
      // Clear module cache to force re-evaluation
      const modulePath = "../middleware/auth";
      // Use vi.importActual to bypass vitest caching and re-execute the module
      await import(/* @vite-ignore */ modulePath + "?nocache=" + Date.now());
    }).rejects.toThrow(/JWT_SECRET/);
  });

  // Test 13: Dev fallback secret in production → FATAL error
  it("throws fatal error when JWT_SECRET is set to dev fallback in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.JWT_SECRET = "gatepass-dev-secret-change-in-production";

    await expect(async () => {
      const modulePath = "../middleware/auth";
      await import(/* @vite-ignore */ modulePath + "?nocache2=" + Date.now());
    }).rejects.toThrow(/JWT_SECRET/);
  });

  // Test 14: Valid JWT_SECRET in production → no error
  it("accepts a proper JWT_SECRET in production without error", async () => {
    process.env.NODE_ENV = "production";
    process.env.JWT_SECRET = "a-real-strong-production-secret-32chars!";

    // Should NOT throw
    const mod = await import(/* @vite-ignore */ "../middleware/auth?nocache3=" + Date.now());
    expect(mod.getJWTSecret()).toBe("a-real-strong-production-secret-32chars!");
  });
});
