// @vitest-environment node
/**
 * GatePass — requireRole Middleware Tests
 *
 * Source: src/docs/specs/auto-approval.md §8 (security).
 * Source: src/server/middleware/auth.ts — requireRole().
 *
 * Hard contract:
 *   - 401 AUTH_REQUIRED   when req.guardId is missing
 *   - 500 INTERNAL_ERROR  when the DB handle is missing on the request
 *   - 401 AUTH_FAILED     when the guard row is not found
 *   - 403 AUTH_FORBIDDEN  when the guard exists but is inactive
 *   - 403 AUTH_FORBIDDEN  when the role is not in the allowed set
 *   - next() called       when the role IS in the allowed set and active
 *   - DB lookup fresh     — the role is read from DB on every call
 *                            (stale-role JWT cannot retain admin)
 */

import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { requireRole } from "../middleware/auth";

interface MockCtx {
  req: Request;
  res: Response;
  next: ReturnType<typeof vi.fn>;
  getStatus: () => number;
  getJson: () => unknown;
}

function makeCtx({
  guardId,
  db,
}: {
  guardId?: string;
  db?: unknown;
}): MockCtx {
  let statusCode = 0;
  let jsonBody: unknown = null;
  const next = vi.fn();

  const req = {
    guardId,
    db,
    headers: {},
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

  return {
    req,
    res,
    next,
    getStatus: () => statusCode,
    getJson: () => jsonBody,
  };
}

function makeDB(row: {
  id: string;
  role: "guard" | "senior-guard" | "admin";
  isActive: boolean;
}) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([row]),
      }),
    }),
  };
}

const GUARD_ID = "11111111-1111-4111-8111-111111111111";

describe("requireRole middleware", () => {
  it("401 when req.guardId is missing", async () => {
    const ctx = makeCtx({ guardId: undefined, db: {} });
    await requireRole("admin")(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(401);
    expect(ctx.getJson()).toMatchObject({
      error: { code: "AUTH_REQUIRED" },
    });
    expect(ctx.next).not.toHaveBeenCalled();
  });

  it("500 when req.db is missing", async () => {
    const ctx = makeCtx({ guardId: GUARD_ID, db: undefined });
    await requireRole("admin")(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(500);
    expect(ctx.getJson()).toMatchObject({
      error: { code: "INTERNAL_ERROR" },
    });
    expect(ctx.next).not.toHaveBeenCalled();
  });

  it("401 AUTH_FAILED when the guard row is not found", async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    };
    const ctx = makeCtx({ guardId: GUARD_ID, db });
    await requireRole("admin")(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(401);
    expect(ctx.getJson()).toMatchObject({
      error: { code: "AUTH_FAILED" },
    });
  });

  it("403 AUTH_FORBIDDEN when the guard is inactive", async () => {
    const db = makeDB({
      id: GUARD_ID,
      role: "admin",
      isActive: false,
    });
    const ctx = makeCtx({ guardId: GUARD_ID, db });
    await requireRole("admin")(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(403);
    expect(ctx.getJson()).toMatchObject({
      error: { code: "AUTH_FORBIDDEN" },
    });
  });

  it("403 AUTH_FORBIDDEN when the role is not in the allowed set", async () => {
    const db = makeDB({
      id: GUARD_ID,
      role: "guard",
      isActive: true,
    });
    const ctx = makeCtx({ guardId: GUARD_ID, db });
    await requireRole("admin")(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(403);
    expect(ctx.getJson()).toMatchObject({
      error: {
        code: "AUTH_FORBIDDEN",
        message: expect.stringContaining("'guard'"),
      },
    });
  });

  it("calls next() when the role IS in the allowed set", async () => {
    const db = makeDB({
      id: GUARD_ID,
      role: "admin",
      isActive: true,
    });
    const ctx = makeCtx({ guardId: GUARD_ID, db });
    await requireRole("admin")(ctx.req, ctx.res, ctx.next);
    expect(ctx.next).toHaveBeenCalledTimes(1);
    expect(ctx.getStatus()).toBe(0); // not set
  });

  it("accepts any role in the allowed set (senior-guard for list)", async () => {
    const db = makeDB({
      id: GUARD_ID,
      role: "senior-guard",
      isActive: true,
    });
    const ctx = makeCtx({ guardId: GUARD_ID, db });
    await requireRole("admin", "senior-guard")(ctx.req, ctx.res, ctx.next);
    expect(ctx.next).toHaveBeenCalledTimes(1);
  });

  it("500 INTERNAL_ERROR when the DB query throws", async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockRejectedValue(new Error("DB unreachable")),
        }),
      }),
    };
    const ctx = makeCtx({ guardId: GUARD_ID, db });
    await requireRole("admin")(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(500);
    expect(ctx.getJson()).toMatchObject({
      error: { code: "INTERNAL_ERROR" },
    });
  });
});
