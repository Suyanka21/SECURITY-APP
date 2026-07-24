// @vitest-environment node
/**
 * GatePass — Admin Account-Provisioning Route Handler Tests
 *
 * Source: src/docs/adr/0001-...md — Decision A1.
 * Source: src/server/routes/accounts.ts
 *
 * Service behavior is covered in account-service.test.ts. These pin the ROUTE:
 *   - zod validation rejection → structured 422 with field + traceId
 *   - success → 201 + { account, traceId } (+ temporaryPassword passthrough)
 *   - ServiceError from the service → propagated via next()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";
import { handleProvisionAccount } from "../routes/accounts";
import * as service from "../services/account-service";
import { ServiceError } from "../services/errors";

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
  guardId,
}: {
  body?: unknown;
  guardId?: string;
}): MockCtx {
  let statusCode = 200;
  let jsonBody: unknown = null;
  let nextErr: unknown = undefined;

  const req = {
    body,
    query: {},
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

const ADMIN_GUARD_ID = "22222222-2222-4222-8222-222222222222";

const VALID_BODY = {
  email: "new.guard@gatepass.test",
  name: "New Guard",
  badgeNumber: "G-777",
  role: "guard",
};

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("Route: POST /api/admin/accounts", () => {
  it("returns 422 ACCOUNT_INVALID_INPUT when role is not allowed", async () => {
    const ctx = makeCtx({
      body: { ...VALID_BODY, role: "superuser" },
      guardId: ADMIN_GUARD_ID,
    });
    await handleProvisionAccount(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(422);
    expect(ctx.getJson()).toMatchObject({
      error: {
        code: "ACCOUNT_INVALID_INPUT",
        field: "role",
        traceId: expect.stringMatching(/^trace-/),
      },
    });
  });

  it("returns 422 when email is malformed", async () => {
    const ctx = makeCtx({
      body: { ...VALID_BODY, email: "not-an-email" },
      guardId: ADMIN_GUARD_ID,
    });
    await handleProvisionAccount(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(422);
    expect(ctx.getJson()).toMatchObject({
      error: { code: "ACCOUNT_INVALID_INPUT", field: "email" },
    });
  });

  it("rejects unknown fields (strict schema)", async () => {
    const ctx = makeCtx({
      body: { ...VALID_BODY, isAdmin: true },
      guardId: ADMIN_GUARD_ID,
    });
    await handleProvisionAccount(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(422);
  });

  it("returns 201 with the account view + temporaryPassword on success", async () => {
    vi.spyOn(service, "provisionAccount").mockResolvedValue({
      view: {
        guardId: "new-guard-id",
        email: "new.guard@gatepass.test",
        name: "New Guard",
        badgeNumber: "G-777",
        role: "guard",
        isActive: true,
      },
      temporaryPassword: "Gp!generated9",
    });

    const ctx = makeCtx({ body: VALID_BODY, guardId: ADMIN_GUARD_ID });
    await handleProvisionAccount(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(201);
    const body = ctx.getJson() as {
      account: { guardId: string; role: string };
      temporaryPassword?: string;
      traceId: string;
    };
    expect(body.account.guardId).toBe("new-guard-id");
    expect(body.account.role).toBe("guard");
    expect(body.temporaryPassword).toBe("Gp!generated9");
    expect(body.traceId).toMatch(/^trace-/);
  });

  it("omits temporaryPassword when the service did not generate one", async () => {
    vi.spyOn(service, "provisionAccount").mockResolvedValue({
      view: {
        guardId: "g2",
        email: "a@b.test",
        name: "A B",
        badgeNumber: "G-1",
        role: "admin",
        isActive: true,
      },
    });
    const ctx = makeCtx({
      body: { ...VALID_BODY, role: "admin", password: "supersecretpw123" },
      guardId: ADMIN_GUARD_ID,
    });
    await handleProvisionAccount(ctx.req, ctx.res, ctx.next);
    const body = ctx.getJson() as { temporaryPassword?: string };
    expect(body.temporaryPassword).toBeUndefined();
  });

  it("propagates a ServiceError to next() (ACCOUNT_DUPLICATE → 409)", async () => {
    const err = new ServiceError(
      "ACCOUNT_DUPLICATE",
      "A guard with this badge number already exists",
      409,
      "badgeNumber",
    );
    vi.spyOn(service, "provisionAccount").mockRejectedValue(err);
    const ctx = makeCtx({ body: VALID_BODY, guardId: ADMIN_GUARD_ID });
    await handleProvisionAccount(ctx.req, ctx.res, ctx.next);
    expect(ctx.getNextErr()).toBe(err);
  });
});
