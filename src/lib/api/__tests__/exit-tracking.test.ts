/**
 * GatePass — Exit tracking API client tests.
 *
 * Source: src/docs/specs/exit-tracking.md §6
 * Source: src/lib/api/__tests__/shifts.test.ts (fetch-mock pattern).
 *
 * Each test stubs global fetch and asserts:
 *   - The correct URL and HTTP method are issued.
 *   - Authorization is attached on every call.
 *   - The discriminated ApiResult<T> is shaped correctly on success and
 *     on each contract-defined failure (404 / 409 / 403 / 500).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exitTrackingApi } from "../exit-tracking";
import { setAuthTokenGetter } from "../auth";

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const GUARD_ID = "22222222-2222-4222-8222-222222222222";
const ENTRY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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

// ─── recordExit ──────────────────────────────────────────────────────────────

describe("exitTrackingApi.recordExit", () => {
  it("POSTs /api/entries/:entryId/exit with Authorization", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, {
        exit: {
          id: "exit-1",
          entryId: ENTRY_ID,
          guardId: GUARD_ID,
          createdAt: "2024-06-01T10:30:00.000Z",
          traceId: "trace-abc",
        },
        traceId: "trace-abc",
      }),
    );

    const result = await exitTrackingApi.recordExit(ENTRY_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.exit.entryId).toBe(ENTRY_ID);
    expect(result.data.traceId).toBe("trace-abc");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(`/api/entries/${ENTRY_ID}/exit`);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer jwt-test-token",
    );
  });

  it("URL-encodes the entryId (defends against accidental special chars)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, {
        exit: {
          id: "exit-2",
          entryId: "id/with/slashes",
          guardId: GUARD_ID,
          createdAt: "2024-06-01T10:30:00.000Z",
          traceId: "trace-enc",
        },
        traceId: "trace-enc",
      }),
    );

    await exitTrackingApi.recordExit("id/with/slashes");

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("id%2Fwith%2Fslashes");
  });

  it("surfaces 404 EXIT_NO_OPEN_ENTRY without throwing", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(404, {
        error: {
          code: "EXIT_NO_OPEN_ENTRY",
          message: "No entry found for the provided ID",
          field: "entryId",
          traceId: "trace-404",
        },
      }),
    );

    const result = await exitTrackingApi.recordExit("nonexistent");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.status).toBe(404);
    expect(result.error.code).toBe("EXIT_NO_OPEN_ENTRY");
  });

  it("surfaces 409 EXIT_ALREADY_RECORDED without throwing", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: {
          code: "EXIT_ALREADY_RECORDED",
          message: "An exit has already been recorded",
          field: "entryId",
          traceId: "trace-409",
        },
      }),
    );

    const result = await exitTrackingApi.recordExit(ENTRY_ID);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.status).toBe(409);
    expect(result.error.code).toBe("EXIT_ALREADY_RECORDED");
  });

  it("surfaces 500 INTERNAL_ERROR without throwing", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(500, {
        error: {
          code: "INTERNAL_ERROR",
          message: "An unexpected error occurred",
          traceId: "trace-500",
        },
      }),
    );

    const result = await exitTrackingApi.recordExit(ENTRY_ID);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.status).toBe(500);
    expect(result.error.code).toBe("INTERNAL_ERROR");
  });
});

// ─── listOnPremise ───────────────────────────────────────────────────────────

describe("exitTrackingApi.listOnPremise", () => {
  it("GETs /api/entries/on-premise with Authorization", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        entries: [
          {
            id: ENTRY_ID,
            visitorName: "Maya Chen",
            host: "A. Okafor",
            unit: "18B",
            plate: "LND-482",
            method: "walk-in",
            guardId: GUARD_ID,
            createdAt: "2024-06-01T10:30:00.000Z",
          },
        ],
        count: 1,
        traceId: "trace-list",
      }),
    );

    const result = await exitTrackingApi.listOnPremise();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.entries).toHaveLength(1);
    expect(result.data.entries[0].visitorName).toBe("Maya Chen");
    expect(result.data.count).toBe(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/entries/on-premise");
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer jwt-test-token",
    );
  });

  it("surfaces 403 AUTH_FORBIDDEN when called with a guard token", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, {
        error: {
          code: "AUTH_FORBIDDEN",
          message: "Insufficient role",
          traceId: "trace-403",
        },
      }),
    );

    const result = await exitTrackingApi.listOnPremise();
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
          traceId: "trace-500b",
        },
      }),
    );

    const result = await exitTrackingApi.listOnPremise();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.status).toBe(500);
  });
});
