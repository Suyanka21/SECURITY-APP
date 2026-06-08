/**
 * GatePass — Shift log API client tests.
 *
 * Source: src/docs/specs/shift-log-aggregation.md §4
 * Source: src/lib/api/__tests__/visitor-profiles.test.ts (fetch-mock pattern).
 *
 * Each test stubs global fetch and asserts:
 *   - The correct URL and HTTP method are issued.
 *   - Authorization is attached on every call.
 *   - The discriminated ApiResult<T> is shaped correctly on success and
 *     on each contract-defined failure (422 / 403 / 500).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shiftsApi } from "../shifts";
import { setAuthTokenGetter } from "../auth";

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const GUARD_ID = "22222222-2222-4222-8222-222222222222";

function makeShift(over: Partial<Record<string, unknown>> = {}) {
  return {
    guardId: GUARD_ID,
    guardName: "A. Okafor",
    badgeNumber: "G-1042",
    totals: {
      entries: 1,
      qr: 1,
      walkIn: 0,
      override: 0,
      recognized: 0,
      auto: 0,
      approvalsDenied: 0,
      approvalsExpired: 0,
      autoApprovalsMatched: 0,
      overrideAuthorized: 0,
    },
    ...over,
  };
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

// ─── listShifts ──────────────────────────────────────────────────────────────

describe("shiftsApi.listShifts", () => {
  it("GETs /api/admin/shifts with Authorization on the default empty query", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        window: {
          fromIso: "2024-01-15T00:00:00.000Z",
          toIso: "2024-01-15T18:00:00.000Z",
        },
        shifts: [makeShift()],
        traceId: "trace-1",
      })
    );

    const result = await shiftsApi.listShifts();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.shifts).toHaveLength(1);
    expect(result.data.window.fromIso).toMatch(/Z$/);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/admin\/shifts(\?|$)/);
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer jwt-test-token"
    );
  });

  it("serialises fromIso, toIso, and guardId into the query string", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        window: {
          fromIso: "2024-01-15T00:00:00.000Z",
          toIso: "2024-01-16T00:00:00.000Z",
        },
        shifts: [],
        traceId: "trace-2",
      })
    );

    await shiftsApi.listShifts({
      fromIso: "2024-01-15T00:00:00.000Z",
      toIso: "2024-01-16T00:00:00.000Z",
      guardId: GUARD_ID,
    });

    const [url] = fetchMock.mock.calls[0];
    const qs = String(url).split("?")[1] ?? "";
    expect(qs).toContain("fromIso=2024-01-15T00%3A00%3A00.000Z");
    expect(qs).toContain("toIso=2024-01-16T00%3A00%3A00.000Z");
    expect(qs).toContain(`guardId=${GUARD_ID}`);
  });

  it("surfaces 422 SHIFT_WINDOW_INVALID without throwing", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(422, {
        error: {
          code: "SHIFT_WINDOW_INVALID",
          message: "fromIso must be strictly earlier than toIso.",
          field: "fromIso",
          traceId: "trace-3",
        },
      })
    );

    const result = await shiftsApi.listShifts({
      fromIso: "2024-01-16T00:00:00.000Z",
      toIso: "2024-01-15T00:00:00.000Z",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.status).toBe(422);
    expect(result.error.code).toBe("SHIFT_WINDOW_INVALID");
    expect(result.error.field).toBe("fromIso");
  });

  it("surfaces 403 AUTH_FORBIDDEN when called with a guard token", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, {
        error: {
          code: "AUTH_FORBIDDEN",
          message: "Insufficient role",
          traceId: "trace-4",
        },
      })
    );

    const result = await shiftsApi.listShifts({
      fromIso: "2024-01-15T00:00:00.000Z",
      toIso: "2024-01-16T00:00:00.000Z",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.status).toBe(403);
    expect(result.error.code).toBe("AUTH_FORBIDDEN");
  });

  it("surfaces 500 INTERNAL_ERROR without throwing", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(500, {
        error: {
          code: "INTERNAL_ERROR",
          message: "An unexpected error occurred",
          traceId: "trace-5",
        },
      })
    );

    const result = await shiftsApi.listShifts();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.status).toBe(500);
    expect(result.error.code).toBe("INTERNAL_ERROR");
  });
});
