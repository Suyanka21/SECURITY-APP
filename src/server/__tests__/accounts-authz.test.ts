// @vitest-environment node
/**
 * GatePass — Account-provisioning ROUTE AUTHORIZATION tests (Decision A1)
 *
 * Source: src/docs/adr/0001-...md §Decision 3 — only an authenticated admin may
 *         provision accounts. The generic requireRole tests live in
 *         require-role-middleware.test.ts; THIS file proves the exact stack the
 *         accounts route is wired with in app.ts actually gates it:
 *
 *             requireAuth → requireRole("admin") → handleProvisionAccount
 *
 * Hard contract proven here:
 *   - No Bearer token            → 401, handler never reached
 *   - Valid token, role=guard    → 403, handler never reached
 *   - Valid token, role=admin    → handler reached (201)
 *
 * We drive the middleware chain directly (legacy self-issued JWT mode, i.e.
 * SUPABASE_URL unset) so the test is deterministic and network-free.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { Request, Response, NextFunction } from "express";
import * as jwt from "jsonwebtoken";

// The service is mocked: authorization must be decided BEFORE any provisioning.
vi.mock("../services/account-service", () => ({
  provisionAccount: vi.fn().mockResolvedValue({
    view: {
      guardId: "guard-created",
      email: "new@gatepass.test",
      name: "New Guard",
      badgeNumber: "G-9",
      role: "guard",
      isActive: true,
    },
    temporaryPassword: undefined,
  }),
}));

import { requireAuth, requireRole, getJWTSecret } from "../middleware/auth";
import { handleProvisionAccount } from "../routes/accounts";
import { provisionAccount } from "../services/account-service";

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GUARD_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// Restore legacy (self-issued JWT) auth mode — no Supabase network verification.
const savedSupabaseUrl = process.env.SUPABASE_URL;
beforeAll(() => {
  delete process.env.SUPABASE_URL;
});
afterAll(() => {
  if (savedSupabaseUrl !== undefined) process.env.SUPABASE_URL = savedSupabaseUrl;
});

function tokenFor(guardId: string): string {
  return jwt.sign({ sub: guardId }, getJWTSecret(), {
    algorithm: "HS256",
    expiresIn: "5m",
  });
}

function dbReturning(row: { id: string; role: string; isActive: boolean } | null) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(row ? [row] : []),
      }),
    }),
  };
}

interface Harness {
  status: number;
  body: unknown;
  handlerReached: boolean;
}

/** Run the real accounts stack end-to-end for one simulated request. */
async function runAccountsStack({
  authHeader,
  db,
}: {
  authHeader?: string;
  db: unknown;
}): Promise<Harness> {
  const h: Harness = { status: 0, body: null, handlerReached: false };

  const req = {
    headers: authHeader ? { authorization: authHeader } : {},
    body: {
      name: "New Guard",
      badgeNumber: "G-9",
      email: "new@gatepass.test",
      role: "guard",
    },
    db,
  } as unknown as Request;

  const res = {
    status(code: number) {
      h.status = code;
      return res;
    },
    json(payload: unknown) {
      h.body = payload;
      return res;
    },
  } as unknown as Response;

  // Sequential middleware runner: proceed only when a middleware calls next()
  // with no error, exactly like Express.
  const chain: Array<
    (req: Request, res: Response, next: NextFunction) => unknown | Promise<unknown>
  > = [requireAuth, requireRole("admin"), handleProvisionAccount];

  for (let i = 0; i < chain.length; i++) {
    let proceeded = false;
    let errored: unknown = null;
    const next: NextFunction = ((err?: unknown) => {
      if (err) errored = err;
      else proceeded = true;
    }) as NextFunction;

    if (chain[i] === handleProvisionAccount) h.handlerReached = true;
    await chain[i](req, res, next);

    if (errored) throw errored;
    if (!proceeded) break; // middleware responded (e.g. 401/403) → stop
  }

  return h;
}

describe("POST /api/admin/accounts — route authorization", () => {
  it("rejects with 401 when no Bearer token is provided (handler never reached)", async () => {
    const h = await runAccountsStack({ db: dbReturning(null) });
    expect(h.status).toBe(401);
    expect(h.body).toMatchObject({ error: { code: "AUTH_TOKEN_MISSING" } });
    expect(h.handlerReached).toBe(false);
    expect(provisionAccount).not.toHaveBeenCalled();
  });

  it("rejects with 403 when the caller is an authenticated non-admin (guard)", async () => {
    const h = await runAccountsStack({
      authHeader: `Bearer ${tokenFor(GUARD_ID)}`,
      db: dbReturning({ id: GUARD_ID, role: "guard", isActive: true }),
    });
    expect(h.status).toBe(403);
    expect(h.body).toMatchObject({ error: { code: "AUTH_FORBIDDEN" } });
    expect(h.handlerReached).toBe(false);
    expect(provisionAccount).not.toHaveBeenCalled();
  });

  it("reaches the handler (201) when the caller is an active admin", async () => {
    const h = await runAccountsStack({
      authHeader: `Bearer ${tokenFor(ADMIN_ID)}`,
      db: dbReturning({ id: ADMIN_ID, role: "admin", isActive: true }),
    });
    expect(h.handlerReached).toBe(true);
    expect(h.status).toBe(201);
    expect(provisionAccount).toHaveBeenCalledTimes(1);
  });
});
