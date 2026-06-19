// @vitest-environment node
/**
 * GatePass — Delivery Management Route Handler Tests
 *
 * Source: src/docs/specs/delivery-management.md §4
 * Source: src/server/routes/deliveries.ts
 *
 * Service-layer behaviour is covered in delivery-service.test.ts.
 * These tests pin the ROUTE layer:
 *   - Validation rejection → 422 + field + traceId
 *   - Service success → 201 (create) / 200 (list)
 *   - Service ServiceError → structured error response
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";

import {
  handleCreateDeliveryEntry,
  handleListDeliveries,
} from "../routes/deliveries";
import * as service from "../services/delivery-service";
import { ServiceError } from "../services/errors";

// ─── Mock helpers ────────────────────────────────────────────────────────────

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
  params,
  guardId,
}: {
  body?: Record<string, unknown>;
  params?: Record<string, string>;
  guardId?: string;
}): MockCtx {
  let statusCode = 200;
  let jsonBody: unknown = null;
  let nextErr: unknown = undefined;

  const req = {
    body: body ?? {},
    params: params ?? {},
    query: {},
    headers: {},
    guardId,
    db: {},
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

// ─── Tests: handleCreateDeliveryEntry ────────────────────────────────────────

describe("handleCreateDeliveryEntry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 422 when entryKind is missing", async () => {
    const ctx = makeCtx({
      body: {
        visitorName: "Jumia Rider",
        unit: "18B",
        createdAt: new Date().toISOString(),
        deliveryCategory: "parcel",
      },
      guardId: "guard-01",
    });

    await handleCreateDeliveryEntry(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(422);
    const json = ctx.getJson() as any;
    expect(json.error.code).toBe("INVALID_ENTRY_KIND");
    expect(json.error.traceId).toMatch(/^trace-/);
  });

  it("returns 422 when entryKind=delivery but deliveryCategory missing", async () => {
    const ctx = makeCtx({
      body: {
        visitorName: "Bolt Driver",
        unit: "07C",
        createdAt: new Date().toISOString(),
        entryKind: "delivery",
      },
      guardId: "guard-01",
    });

    await handleCreateDeliveryEntry(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(422);
    const json = ctx.getJson() as any;
    expect(json.error.code).toBe("DELIVERY_CATEGORY_REQUIRED");
    expect(json.error.field).toBe("deliveryCategory");
  });

  it("returns 201 on valid delivery entry", async () => {
    const mockResponse = {
      response: {
        entry: {
          id: "entry-123",
          visitorName: "Jumia Rider",
          host: "Reception",
          unit: "18B",
          plate: null,
          reason: "",
          method: "walk-in",
          guardId: "guard-01",
          createdAt: new Date().toISOString(),
          status: "logged" as const,
          syncState: "synced" as const,
          entryKind: "delivery" as const,
          deliveryCategory: "parcel" as const,
        },
        traceId: "trace-test",
      },
      statusCode: 201,
    };

    vi.spyOn(service, "createDeliveryEntry").mockResolvedValue(mockResponse);

    const ctx = makeCtx({
      body: {
        visitorName: "Jumia Rider",
        unit: "18B",
        createdAt: new Date().toISOString(),
        entryKind: "delivery",
        deliveryCategory: "parcel",
      },
      guardId: "guard-01",
    });

    await handleCreateDeliveryEntry(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(201);
    const json = ctx.getJson() as any;
    expect(json.entry.entryKind).toBe("delivery");
    expect(json.entry.deliveryCategory).toBe("parcel");
  });

  it("returns ServiceError as structured error response", async () => {
    vi.spyOn(service, "createDeliveryEntry").mockRejectedValue(
      new ServiceError("GUARD_SESSION_EXPIRED", "Guard not found", 403, "guardId"),
    );

    const ctx = makeCtx({
      body: {
        visitorName: "Rider",
        unit: "18B",
        createdAt: new Date().toISOString(),
        entryKind: "delivery",
        deliveryCategory: "parcel",
      },
      guardId: "guard-01",
    });

    await handleCreateDeliveryEntry(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(403);
    const json = ctx.getJson() as any;
    expect(json.error.code).toBe("GUARD_SESSION_EXPIRED");
    expect(json.error.field).toBe("guardId");
  });

  it("forwards non-ServiceError to next()", async () => {
    const genericErr = new Error("DB connection lost");
    vi.spyOn(service, "createDeliveryEntry").mockRejectedValue(genericErr);

    const ctx = makeCtx({
      body: {
        visitorName: "Rider",
        unit: "18B",
        createdAt: new Date().toISOString(),
        entryKind: "delivery",
        deliveryCategory: "parcel",
      },
      guardId: "guard-01",
    });

    await handleCreateDeliveryEntry(ctx.req, ctx.res, ctx.next);

    expect(ctx.getNextErr()).toBe(genericErr);
  });

  it("returns 422 when visitor sends deliveryCategory", async () => {
    const ctx = makeCtx({
      body: {
        visitorName: "John",
        unit: "18B",
        createdAt: new Date().toISOString(),
        entryKind: "visitor",
        deliveryCategory: "parcel",
      },
      guardId: "guard-01",
    });

    await handleCreateDeliveryEntry(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(422);
    const json = ctx.getJson() as any;
    expect(json.error.code).toBe("DELIVERY_CATEGORY_REQUIRED");
  });

  it("returns 422 for invalid deliveryCategory value", async () => {
    const ctx = makeCtx({
      body: {
        visitorName: "Rider",
        unit: "18B",
        createdAt: new Date().toISOString(),
        entryKind: "delivery",
        deliveryCategory: "weapons",
      },
      guardId: "guard-01",
    });

    await handleCreateDeliveryEntry(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(422);
    const json = ctx.getJson() as any;
    expect(json.error.code).toBe("DELIVERY_CATEGORY_REQUIRED");
  });
});

// ─── Tests: handleListDeliveries ─────────────────────────────────────────────

describe("handleListDeliveries", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 200 with delivery entries", async () => {
    const mockResult = {
      entries: [
        {
          id: "d-001",
          visitorName: "Jumia Rider",
          host: "Reception",
          unit: "18B",
          plate: null,
          deliveryCategory: "parcel" as const,
          method: "walk-in",
          guardId: "guard-01",
          createdAt: "2024-06-01T09:30:00.000Z",
        },
      ],
      count: 1,
      traceId: "trace-list-test",
    };

    vi.spyOn(service, "listDeliveries").mockResolvedValue(mockResult);

    const ctx = makeCtx({ guardId: "guard-01" });

    await handleListDeliveries(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(200);
    const json = ctx.getJson() as any;
    expect(json.entries).toHaveLength(1);
    expect(json.entries[0].deliveryCategory).toBe("parcel");
    expect(json.count).toBe(1);
    expect(json.traceId).toBe("trace-list-test");
  });

  it("forwards service errors to next()", async () => {
    const err = new Error("Query failed");
    vi.spyOn(service, "listDeliveries").mockRejectedValue(err);

    const ctx = makeCtx({ guardId: "guard-01" });

    await handleListDeliveries(ctx.req, ctx.res, ctx.next);

    expect(ctx.getNextErr()).toBe(err);
  });
});
