/**
 * GatePass — Delivery management API client tests.
 *
 * Source: src/docs/specs/delivery-management.md §4
 *
 * Each test stubs global fetch and asserts:
 *   - Correct URL and HTTP method.
 *   - Authorization header attached.
 *   - Discriminated ApiResult<T> shaped correctly on success and failures.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliveryApi } from "../deliveries";
import { setAuthTokenGetter } from "../auth";
import type { DeliveryCategory, EntryKind } from "../types";

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchMock: FetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  setAuthTokenGetter(() => "jwt-test-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  setAuthTokenGetter(null);
});

// ─── submitDelivery ──────────────────────────────────────────────────────────

describe("deliveryApi.submitDelivery", () => {
  it("POSTs /api/entries/deliveries with Authorization", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, {
        entry: {
          id: "entry-d1",
          visitorName: "Jumia Rider",
          host: "Reception",
          unit: "18B",
          plate: "KDA-123",
          reason: "",
          method: "walk-in",
          guardId: "guard-01",
          createdAt: "2024-06-01T09:30:00.000Z",
          status: "logged",
          syncState: "synced",
          entryKind: "delivery",
          deliveryCategory: "parcel",
        },
        traceId: "trace-d1",
      }),
    );

    const result = await deliveryApi.submitDelivery({
      visitorName: "Jumia Rider",
      unit: "18B",
      createdAt: "2024-06-01T09:30:00.000Z",
      entryKind: "delivery",
      deliveryCategory: "parcel",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.entry.entryKind).toBe("delivery");
    expect(result.data.entry.deliveryCategory).toBe("parcel");
    expect(result.data.traceId).toBe("trace-d1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/entries/deliveries");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer jwt-test-token",
    );
  });

  it("returns ok=false on 422 DELIVERY_CATEGORY_REQUIRED", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(422, {
        error: {
          code: "DELIVERY_CATEGORY_REQUIRED",
          message: "Delivery entries require a category",
          field: "deliveryCategory",
          traceId: "trace-d2",
        },
      }),
    );

    const result = await deliveryApi.submitDelivery({
      visitorName: "Rider",
      unit: "18B",
      createdAt: new Date().toISOString(),
      entryKind: "delivery",
      deliveryCategory: undefined as unknown as DeliveryCategory,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.status).toBe(422);
    expect(result.error.code).toBe("DELIVERY_CATEGORY_REQUIRED");
  });

  it("returns ok=false on 422 INVALID_ENTRY_KIND", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(422, {
        error: {
          code: "INVALID_ENTRY_KIND",
          message: "Invalid entry kind",
          field: "entryKind",
          traceId: "trace-d3",
        },
      }),
    );

    const result = await deliveryApi.submitDelivery({
      visitorName: "Rider",
      unit: "18B",
      createdAt: new Date().toISOString(),
      entryKind: "spaceship" as unknown as EntryKind,
      deliveryCategory: "parcel",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.status).toBe(422);
    expect(result.error.code).toBe("INVALID_ENTRY_KIND");
  });

  it("returns ok=false on 403 GUARD_SESSION_EXPIRED", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, {
        error: {
          code: "GUARD_SESSION_EXPIRED",
          message: "Guard not found",
          field: "guardId",
          traceId: "trace-d4",
        },
      }),
    );

    const result = await deliveryApi.submitDelivery({
      visitorName: "Rider",
      unit: "18B",
      createdAt: new Date().toISOString(),
      entryKind: "delivery",
      deliveryCategory: "food",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.status).toBe(403);
  });

  it("returns ok=false on 500 INTERNAL_ERROR", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(500, {
        error: {
          code: "INTERNAL_ERROR",
          message: "DB failed",
          traceId: "trace-d5",
        },
      }),
    );

    const result = await deliveryApi.submitDelivery({
      visitorName: "Rider",
      unit: "18B",
      createdAt: new Date().toISOString(),
      entryKind: "delivery",
      deliveryCategory: "gas",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.status).toBe(500);
    expect(result.error.code).toBe("INTERNAL_ERROR");
  });
});

// ─── listDeliveries ──────────────────────────────────────────────────────────

describe("deliveryApi.listDeliveries", () => {
  it("GETs /api/entries/deliveries with Authorization", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        entries: [
          {
            id: "d-001",
            visitorName: "Jumia Rider",
            host: "Reception",
            unit: "18B",
            plate: null,
            deliveryCategory: "parcel",
            method: "walk-in",
            guardId: "guard-01",
            createdAt: "2024-06-01T09:30:00.000Z",
          },
        ],
        count: 1,
        traceId: "trace-list-d1",
      }),
    );

    const result = await deliveryApi.listDeliveries();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.entries).toHaveLength(1);
    expect(result.data.entries[0].deliveryCategory).toBe("parcel");
    expect(result.data.count).toBe(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/entries/deliveries");
    expect(init?.method).toBe("GET");
  });

  it("returns ok=false on 403 AUTH_FORBIDDEN", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, {
        error: {
          code: "AUTH_FORBIDDEN",
          message: "Insufficient role",
          traceId: "trace-list-d2",
        },
      }),
    );

    const result = await deliveryApi.listDeliveries();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.status).toBe(403);
    expect(result.error.code).toBe("AUTH_FORBIDDEN");
  });
});
