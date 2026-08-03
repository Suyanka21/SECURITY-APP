// @vitest-environment node
/**
 * GatePass — One-Time PIN Route Handler Tests (Feature 11 / Stage 4)
 *
 * Source: src/server/routes/pin.ts
 *
 * The service layer (pin-service.test.ts) proves the redemption logic.
 * These tests pin the ROUTE boundary:
 *   RP1  malformed passRef → 400 PIN_MALFORMED + traceId
 *   RP2  malformed pin → 400 PIN_MALFORMED
 *   RP3  bad scannedAt → 422 VALIDATION_ERROR
 *   RP4  guardId comes from req (JWT), NEVER the body ([C3] invariant)
 *   RP5  service ServiceError is propagated via next() to the error handler
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

import { handlePinValidate } from "../routes/pin";
import * as service from "../services/pin-service";
import { ServiceError } from "../services/entry-service";

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

const GUARD_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

beforeEach(() => vi.restoreAllMocks());

describe("Route: POST /api/entries/pin/validate", () => {
  it("RP1: returns 400 PIN_MALFORMED for a bad pass reference", async () => {
    const ctx = makeCtx({
      body: { passRef: "bad!", pin: "123456", scannedAt: new Date().toISOString() },
      guardId: GUARD_ID,
    });
    await handlePinValidate(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(400);
    expect(ctx.getJson()).toMatchObject({
      error: { code: "PIN_MALFORMED", field: "passRef", traceId: expect.stringMatching(/^trace-/) },
    });
  });

  it("RP2: returns 400 PIN_MALFORMED for a non 6-digit PIN", async () => {
    const ctx = makeCtx({
      body: { passRef: "AB12CD34", pin: "12ab56", scannedAt: new Date().toISOString() },
      guardId: GUARD_ID,
    });
    await handlePinValidate(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(400);
    expect(ctx.getJson()).toMatchObject({ error: { code: "PIN_MALFORMED", field: "pin" } });
  });

  it("RP3: returns 422 VALIDATION_ERROR for a bad scannedAt", async () => {
    const ctx = makeCtx({
      body: { passRef: "AB12CD34", pin: "123456", scannedAt: "not-a-date" },
      guardId: GUARD_ID,
    });
    await handlePinValidate(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(422);
    expect(ctx.getJson()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  it("RP4: guardId is taken from the request (JWT), never the body", async () => {
    const spy = vi
      .spyOn(service, "validatePinRedemption")
      .mockResolvedValue({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        response: { outcome: "valid" } as any,
        statusCode: 200,
      });

    const ctx = makeCtx({
      body: {
        passRef: "AB12CD34",
        pin: "123456",
        scannedAt: new Date().toISOString(),
        // A hostile client tries to inject a different guardId — must be ignored.
        guardId: "attacker-supplied-guard-id",
      },
      guardId: GUARD_ID,
    });
    await handlePinValidate(ctx.req, ctx.res, ctx.next);

    expect(spy).toHaveBeenCalledTimes(1);
    const passedInput = spy.mock.calls[0][0];
    expect(passedInput.guardId).toBe(GUARD_ID);
    expect(ctx.getStatus()).toBe(200);
  });

  it("RP5: a service ServiceError is propagated via next()", async () => {
    vi.spyOn(service, "validatePinRedemption").mockRejectedValue(
      new ServiceError("PIN_LOCKED", "locked", 423, "pin")
    );
    const ctx = makeCtx({
      body: { passRef: "AB12CD34", pin: "123456", scannedAt: new Date().toISOString() },
      guardId: GUARD_ID,
    });
    await handlePinValidate(ctx.req, ctx.res, ctx.next);
    expect(ctx.getNextErr()).toBeInstanceOf(ServiceError);
    expect((ctx.getNextErr() as ServiceError).code).toBe("PIN_LOCKED");
  });
});
