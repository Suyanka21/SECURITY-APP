// @vitest-environment node
/**
 * GatePass — R4a S1: GET /api/admin/units/:id/registrations route layer.
 *
 * Source: src/docs/specs/resident-admin-panels.md §5 S1.
 * Role gating, unit scoping and the raw-response phone check run against
 * real Postgres in integration/resident-admin-panels.integration.test.ts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { handleListUnitRegistrations } from "../routes/residents";
import * as registrationService from "../services/unit-registration-service";
import { ServiceError } from "../services/errors";

const UNIT_ID = "33333333-3333-4333-8333-333333333333";

function ctx(params: Record<string, string>) {
  let status = 200;
  let json: unknown = null;
  let nextErr: unknown;
  const req = { params, query: {}, body: undefined, db: {} } as unknown as Request;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(payload: unknown) {
      json = payload;
      return res;
    },
  } as unknown as Response;
  return {
    req,
    res,
    next: (err?: unknown) => {
      nextErr = err;
    },
    status: () => status,
    json: () => json,
    nextErr: () => nextErr,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("GET /api/admin/units/:id/registrations", () => {
  it("422 RESIDENT_INVALID_INPUT, field id, when :id is not a UUID; the service is not called", async () => {
    const spy = vi.spyOn(registrationService, "listUnitRegistrationsForAdmin");
    const c = ctx({ id: "not-a-uuid" });
    await handleListUnitRegistrations(c.req, c.res, c.next);
    expect(c.status()).toBe(422);
    expect(c.json()).toMatchObject({ error: { code: "RESIDENT_INVALID_INPUT", field: "id" } });
    expect(spy).not.toHaveBeenCalled();
  });

  it("propagates 404 UNIT_NOT_FOUND to the error handler", async () => {
    const err = new ServiceError("UNIT_NOT_FOUND", "Unit not found", 404);
    vi.spyOn(registrationService, "listUnitRegistrationsForAdmin").mockRejectedValue(err);
    const c = ctx({ id: UNIT_ID });
    await handleListUnitRegistrations(c.req, c.res, c.next);
    expect(c.nextErr()).toBe(err);
  });

  it("200 { registrations, count } for the requested unit, with no phone key", async () => {
    const row: registrationService.AdminRegistrationView = {
      id: "reg-1",
      kind: "vehicle",
      label: "Family car",
      plate: "KDA 123A",
      residentId: "res-1",
      residentDisplayName: "Amina",
      status: "disabled",
      ruleId: "rule-1",
      ruleActive: false,
      expiresAt: "2026-09-01T00:00:00.000Z",
      createdAt: "2026-06-01T00:00:00.000Z",
      removedAt: null,
      block: {
        blockedAt: "2026-06-02T00:00:00.000Z",
        blockedBy: "Admin One",
        reason: "Reported incident",
        clearedAt: null,
        clearedBy: null,
        clearReason: null,
      },
    };
    const spy = vi.spyOn(registrationService, "listUnitRegistrationsForAdmin").mockResolvedValue([row]);
    const c = ctx({ id: UNIT_ID });
    await handleListUnitRegistrations(c.req, c.res, c.next);
    expect(spy.mock.calls[0][0]).toBe(UNIT_ID);
    expect(c.status()).toBe(200);
    expect(c.json()).toEqual({ registrations: [row], count: 1 });
    expect(JSON.stringify(c.json())).not.toMatch(/phone/i);
  });
});
