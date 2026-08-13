// @vitest-environment node
/**
 * GatePass — Watchlist ROUTE tests (Feature 12 / Stage 5)
 *
 * Source: src/docs/specs/watchlist.md §3
 *
 * Two contracts are proven here:
 *  1. AUTHORIZATION — the exact stack app.ts wires the watchlist with:
 *         requireAuth → requireRole("admin","senior-guard") → handler
 *     A plain guard must never reach a handler; an admin must.
 *  2. BOUNDARY VALIDATION — a blank/oversized reason is rejected at the route
 *     with a 422 before any service call, and identity comes from the token.
 *
 * Legacy self-issued JWT mode (SUPABASE_URL unset) keeps this network-free.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import * as jwt from "jsonwebtoken";

vi.mock("../services/watchlist-service", () => ({
  createWatchlistEntry: vi.fn().mockResolvedValue({
    entry: { id: "wl-1", reason: "Trespass" },
    traceId: "trace-1",
  }),
  listWatchlistEntries: vi
    .fn()
    .mockResolvedValue({ entries: [], overdueCount: 0, traceId: "trace-1" }),
  reviewWatchlistEntry: vi
    .fn()
    .mockResolvedValue({ entry: { id: "wl-1" }, traceId: "trace-1" }),
  removeWatchlistEntry: vi
    .fn()
    .mockResolvedValue({ entry: { id: "wl-1" }, traceId: "trace-1" }),
}));

import { requireAuth, requireRole, getJWTSecret } from "../middleware/auth";
import {
  handleCreateWatchlistEntry,
  handleListWatchlistEntries,
  handleRemoveWatchlistEntry,
  handleReviewWatchlistEntry,
} from "../routes/watchlist";
import {
  createWatchlistEntry,
  listWatchlistEntries,
  removeWatchlistEntry,
  reviewWatchlistEntry,
} from "../services/watchlist-service";
import { WATCHLIST_REASON_MAX } from "../validation/watchlist-schemas";

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SENIOR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const GUARD_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WL_ID = "33333333-3333-3333-3333-333333333333";

const savedSupabaseUrl = process.env.SUPABASE_URL;
beforeAll(() => {
  delete process.env.SUPABASE_URL;
});
afterAll(() => {
  if (savedSupabaseUrl !== undefined) process.env.SUPABASE_URL = savedSupabaseUrl;
});

beforeEach(() => {
  vi.clearAllMocks();
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

type Handler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => unknown | Promise<unknown>;

interface Harness {
  status: number;
  body: unknown;
  handlerReached: boolean;
}

async function runWatchlistStack({
  handler,
  authHeader,
  db,
  body,
  params,
  query,
}: {
  handler: Handler;
  authHeader?: string;
  db: unknown;
  body?: unknown;
  params?: Record<string, string>;
  query?: Record<string, string>;
}): Promise<Harness> {
  const h: Harness = { status: 0, body: null, handlerReached: false };

  const req = {
    headers: authHeader ? { authorization: authHeader } : {},
    body: body ?? {},
    params: params ?? {},
    query: query ?? {},
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

  const chain: Handler[] = [
    requireAuth,
    requireRole("admin", "senior-guard"),
    handler,
  ];

  for (let i = 0; i < chain.length; i++) {
    let proceeded = false;
    let errored: unknown = null;
    const next: NextFunction = ((err?: unknown) => {
      if (err) errored = err;
      else proceeded = true;
    }) as NextFunction;

    if (chain[i] === handler) h.handlerReached = true;
    await chain[i](req, res, next);

    if (errored) throw errored;
    if (!proceeded) break;
  }

  return h;
}

const VALID_CREATE = { subjectName: "John Doe", reason: "Attempted forced entry" };

describe("watchlist routes — authorization", () => {
  it("rejects an unauthenticated caller with 401 and never reaches the handler", async () => {
    const h = await runWatchlistStack({
      handler: handleCreateWatchlistEntry,
      db: dbReturning(null),
      body: VALID_CREATE,
    });

    expect(h.status).toBe(401);
    expect(h.body).toMatchObject({ error: { code: "AUTH_TOKEN_MISSING" } });
    expect(h.handlerReached).toBe(false);
    expect(createWatchlistEntry).not.toHaveBeenCalled();
  });

  it("rejects a plain guard with 403 — watchlist management is admin/senior-guard only", async () => {
    for (const handler of [
      handleCreateWatchlistEntry,
      handleListWatchlistEntries,
      handleReviewWatchlistEntry,
      handleRemoveWatchlistEntry,
    ]) {
      const h = await runWatchlistStack({
        handler,
        authHeader: `Bearer ${tokenFor(GUARD_ID)}`,
        db: dbReturning({ id: GUARD_ID, role: "guard", isActive: true }),
        body: VALID_CREATE,
        params: { id: WL_ID },
      });

      expect(h.status).toBe(403);
      expect(h.body).toMatchObject({ error: { code: "AUTH_FORBIDDEN" } });
      expect(h.handlerReached).toBe(false);
    }

    expect(createWatchlistEntry).not.toHaveBeenCalled();
    expect(listWatchlistEntries).not.toHaveBeenCalled();
    expect(reviewWatchlistEntry).not.toHaveBeenCalled();
    expect(removeWatchlistEntry).not.toHaveBeenCalled();
  });

  it("lets an admin create an entry (201) and derives the guard id from the token", async () => {
    const h = await runWatchlistStack({
      handler: handleCreateWatchlistEntry,
      authHeader: `Bearer ${tokenFor(ADMIN_ID)}`,
      db: dbReturning({ id: ADMIN_ID, role: "admin", isActive: true }),
      // A hostile body cannot choose who the entry is attributed to.
      body: { ...VALID_CREATE, addedByGuardId: "someone-else" },
    });

    expect(h.status).toBe(201);
    expect(createWatchlistEntry).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createWatchlistEntry).mock.calls[0][1]).toBe(ADMIN_ID);
  });

  it("lets a senior-guard manage the watchlist too", async () => {
    const h = await runWatchlistStack({
      handler: handleListWatchlistEntries,
      authHeader: `Bearer ${tokenFor(SENIOR_ID)}`,
      db: dbReturning({ id: SENIOR_ID, role: "senior-guard", isActive: true }),
    });

    expect(h.status).toBe(200);
    expect(listWatchlistEntries).toHaveBeenCalledTimes(1);
  });
});

describe("watchlist routes — boundary validation", () => {
  async function asAdmin(handler: Handler, opts: Partial<Parameters<typeof runWatchlistStack>[0]>) {
    return runWatchlistStack({
      handler,
      authHeader: `Bearer ${tokenFor(ADMIN_ID)}`,
      db: dbReturning({ id: ADMIN_ID, role: "admin", isActive: true }),
      ...opts,
    });
  }

  it("rejects a missing reason with 422 before touching the service", async () => {
    const h = await asAdmin(handleCreateWatchlistEntry, {
      body: { subjectName: "John Doe" },
    });

    expect(h.status).toBe(422);
    expect(h.body).toMatchObject({
      error: { code: "WATCHLIST_INVALID_INPUT", field: "reason" },
    });
    expect(createWatchlistEntry).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only reason — a blank reason is not a reason", async () => {
    const h = await asAdmin(handleCreateWatchlistEntry, {
      body: { subjectName: "John Doe", reason: "    " },
    });

    expect(h.status).toBe(422);
    expect(createWatchlistEntry).not.toHaveBeenCalled();
  });

  it("rejects an oversized reason at the boundary rather than at the DB CHECK", async () => {
    const h = await asAdmin(handleCreateWatchlistEntry, {
      body: { subjectName: "John Doe", reason: "x".repeat(WATCHLIST_REASON_MAX + 1) },
    });

    expect(h.status).toBe(422);
    expect(createWatchlistEntry).not.toHaveBeenCalled();
  });

  it("rejects a missing subject name", async () => {
    const h = await asAdmin(handleCreateWatchlistEntry, {
      body: { reason: "Trespass" },
    });

    expect(h.status).toBe(422);
    expect(h.body).toMatchObject({ error: { field: "subjectName" } });
  });

  it("rejects a non-UUID id on review/remove", async () => {
    for (const handler of [handleReviewWatchlistEntry, handleRemoveWatchlistEntry]) {
      const h = await asAdmin(handler, {
        params: { id: "not-a-uuid" },
        body: { removedReason: "Cleared" },
      });
      expect(h.status).toBe(422);
      expect(h.body).toMatchObject({ error: { field: "id" } });
    }
  });

  it("requires a removal reason on delete — removals must stay explainable", async () => {
    const h = await asAdmin(handleRemoveWatchlistEntry, {
      params: { id: WL_ID },
      body: {},
    });

    expect(h.status).toBe(422);
    expect(h.body).toMatchObject({ error: { field: "removedReason" } });
    expect(removeWatchlistEntry).not.toHaveBeenCalled();
  });

  it("accepts an empty PATCH body as a plain re-confirmation", async () => {
    const h = await asAdmin(handleReviewWatchlistEntry, {
      params: { id: WL_ID },
      body: {},
    });

    expect(h.status).toBe(200);
    expect(reviewWatchlistEntry).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reviewWatchlistEntry).mock.calls[0][2]).toBe(ADMIN_ID);
  });

  it("passes the needsReview filter through as a boolean", async () => {
    await asAdmin(handleListWatchlistEntries, {
      query: { status: "active", needsReview: "true" },
    });

    expect(vi.mocked(listWatchlistEntries).mock.calls[0][0]).toEqual({
      status: "active",
      needsReview: true,
    });
  });
});
