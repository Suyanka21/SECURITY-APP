// @vitest-environment node
/**
 * GatePass — GET /api/auth/me route tests.
 *
 * Source: src/server/routes/auth.ts
 * Source: src/docs/specs/auth-and-role-routing.md §7 — the client learns its
 *         role ONLY from the server, sourced from guards.role.
 *
 * Pins that the handler returns the DB-verified role for the guardId that
 * requireAuth injected, and fails closed when the row is gone.
 */

import { describe, it, expect } from "vitest";
import type { Request, Response } from "express";

import { handleGetMe } from "../routes/auth";

function makeDb(rows: unknown[]) {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
  };
}

function makeCtx(guardId: string, rows: unknown[]) {
  let statusCode = 200;
  let jsonBody: unknown = null;
  let nextErr: unknown = undefined;

  const req = {
    headers: {},
    params: {},
    query: {},
    guardId,
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

describe("GET /api/auth/me — handleGetMe", () => {
  it("returns the DB-verified role and identity for the authenticated guard", async () => {
    const ctx = makeCtx("guard-uuid-1", [
      {
        id: "guard-uuid-1",
        role: "admin",
        name: "Ada Admin",
        badgeNumber: "A-001",
        isActive: true,
      },
    ]);

    await handleGetMe(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(200);
    const body = ctx.getJson() as Record<string, unknown>;
    expect(body.guardId).toBe("guard-uuid-1");
    expect(body.role).toBe("admin");
    expect(body.name).toBe("Ada Admin");
    expect(body.badgeNumber).toBe("A-001");
    expect(body.isActive).toBe(true);
    expect(typeof body.traceId).toBe("string");
    expect(ctx.getNextErr()).toBeUndefined();
  });

  it("does not derive role from anything but the DB row", async () => {
    // Even though the guardId resolves, the role must come from the row.
    const ctx = makeCtx("guard-uuid-2", [
      {
        id: "guard-uuid-2",
        role: "guard",
        name: "Gary Guard",
        badgeNumber: "G-010",
        isActive: true,
      },
    ]);

    await handleGetMe(ctx.req, ctx.res, ctx.next);

    expect((ctx.getJson() as Record<string, unknown>).role).toBe("guard");
  });

  it("fails closed with 401 when no guard row exists", async () => {
    const ctx = makeCtx("missing-guard", []);

    await handleGetMe(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(401);
    const body = ctx.getJson() as { error: { code: string } };
    expect(body.error.code).toBe("AUTH_FAILED");
  });
});
