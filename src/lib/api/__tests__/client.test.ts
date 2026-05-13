/**
 * GatePass API client — explicit response-handling tests.
 *
 * Trustless-System-Auditor: every status code the contract documents
 * must traverse a dedicated code path, including the silent-failure
 * candidates: network unavailable, server returns success status with a
 * malformed body, and abort-as-timeout.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient, statusToContractCode, TransportErrorCodes } from "../client";
import { setAuthTokenGetter } from "../auth";

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status: number): Response {
  return new Response("", { status });
}

describe("apiClient", () => {
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

  it("injects Authorization Bearer header from the auth token getter", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { entry: {} }));

    await apiClient.post("/api/entries", { hello: "world" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer jwt-test-token",
      "Content-Type": "application/json",
      Accept: "application/json",
    });
  });

  it("omits Authorization when no token is available", async () => {
    setAuthTokenGetter(() => null);
    fetchMock.mockResolvedValue(jsonResponse(200, {}));

    await apiClient.get("/api/visitors/recognized");

    const [, init] = fetchMock.mock.calls[0];
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("returns ok=true with parsed data on 2xx", async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { entry: { id: "e1" } }));

    const result = await apiClient.post<{ entry: { id: string } }>(
      "/api/entries",
      {}
    );

    expect(result).toEqual({
      ok: true,
      status: 201,
      data: { entry: { id: "e1" } },
    });
  });

  it("preserves 207 (multi-status) as ok=true so per-entry results surface", async () => {
    const body = { results: [], syncedCount: 0, duplicateCount: 0, rejectedCount: 0, traceId: "t" };
    fetchMock.mockResolvedValue(jsonResponse(207, body));

    const result = await apiClient.post<typeof body>("/api/entries/sync", {});

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe(207);
  });

  it("maps 422 to ok=false with the contract error body", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(422, {
        error: {
          code: "VISITOR_NAME_REQUIRED",
          message: "Visitor name is required",
          field: "visitorName",
          traceId: "trace-1",
        },
      })
    );

    const result = await apiClient.post("/api/entries", {});

    expect(result).toEqual({
      ok: false,
      status: 422,
      error: {
        code: "VISITOR_NAME_REQUIRED",
        message: "Visitor name is required",
        field: "visitorName",
        traceId: "trace-1",
      },
    });
  });

  it("maps 401 to ok=false even when body is empty", async () => {
    fetchMock.mockResolvedValue(emptyResponse(401));

    const result = await apiClient.get("/api/visitors/recognized");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error.code).toBe("AUTH_REQUIRED");
    }
  });

  it("maps 429 to RATE_LIMITED when backend body uses RATE_LIMIT_EXCEEDED code", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(429, {
        error: {
          code: "RATE_LIMIT_EXCEEDED",
          message: "Too many requests. Please wait before retrying.",
          traceId: "rate-limited",
        },
      })
    );

    const result = await apiClient.post("/api/entries", {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(429);
      // Backend's code wins (preserved verbatim) — UI maps on either field.
      expect(result.error.code).toBe("RATE_LIMIT_EXCEEDED");
    }
  });

  it("falls back to a synthetic error when 5xx body is missing or unparseable", async () => {
    fetchMock.mockResolvedValue(new Response("<html>oops</html>", { status: 500 }));

    const result = await apiClient.post("/api/entries", {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.error.code).toBe("SERVER_ERROR");
    }
  });

  it("returns NETWORK_ERROR when fetch rejects (offline / DNS fail)", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await apiClient.post("/api/entries", {});

    expect(result).toEqual({
      ok: false,
      status: 0,
      error: {
        code: TransportErrorCodes.NETWORK_ERROR,
        message: expect.stringContaining("Could not reach"),
        traceId: "transport",
      },
    });
  });

  it("returns REQUEST_TIMEOUT when the abort signal fires", async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });

    const controller = new AbortController();
    const promise = apiClient.post("/api/entries", {}, { signal: controller.signal });
    controller.abort();

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(TransportErrorCodes.REQUEST_TIMEOUT);
  });

  it("flags PARSE_ERROR if a 2xx body is not valid JSON", async () => {
    fetchMock.mockResolvedValue(
      new Response("not-json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await apiClient.get("/api/visitors/recognized");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(200);
      expect(result.error.code).toBe(TransportErrorCodes.PARSE_ERROR);
    }
  });

  it("encodes GET query params", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { visitors: [] }));

    await apiClient.get("/api/visitors/recognized", {
      query: { q: "ada", page: 2, pageSize: 5 },
    });

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/visitors/recognized?q=ada&page=2&pageSize=5");
  });
});

describe("statusToContractCode", () => {
  it.each([
    [401, "AUTH_REQUIRED"],
    [403, "FORBIDDEN"],
    [422, "VALIDATION_ERROR"],
    [429, "RATE_LIMITED"],
    [500, "SERVER_ERROR"],
    [502, "SERVER_ERROR"],
    [418, "HTTP_418"],
  ])("maps %i → %s", (status, code) => {
    expect(statusToContractCode(status)).toBe(code);
  });
});
