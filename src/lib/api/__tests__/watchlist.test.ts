/**
 * GatePass — Watchlist API client tests (Feature 12 / Stage 5).
 *
 * Source: src/docs/specs/watchlist.md §3
 * Source: src/lib/api/__tests__/exit-tracking.test.ts (fetch-mock pattern).
 *
 * Pinned here:
 *   - Correct URL + method per operation, Authorization always attached.
 *   - guardId is NEVER in a request body — the server derives identity.
 *   - The removal reason travels in the DELETE body.
 *   - needsReview is only sent when the filter is on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchlistApi } from "../watchlist";
import { setAuthTokenGetter } from "../auth";

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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

function lastCall(): [string, RequestInit] {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("fetch was not called");
  return [String(call[0]), (call[1] ?? {}) as RequestInit];
}

describe("watchlistApi.list", () => {
  it("GETs /api/watchlist with the status filter and Authorization", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { entries: [], count: 0, overdueCount: 0, traceId: "t" }),
    );

    const result = await watchlistApi.list({ status: "active" });

    const [url, init] = lastCall();
    expect(url).toContain("/api/watchlist");
    expect(url).toContain("status=active");
    expect(url).not.toContain("needsReview");
    expect(init.method ?? "GET").toBe("GET");
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Bearer jwt-test-token",
    );
    expect(result.ok).toBe(true);
  });

  it("only sends needsReview when the filter is on", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { entries: [], count: 0, overdueCount: 1, traceId: "t" }),
    );

    await watchlistApi.list({ status: "all", needsReview: true });

    expect(lastCall()[0]).toContain("needsReview=true");
  });
});

describe("watchlistApi.create", () => {
  it("POSTs the subject and reason without any guard identity", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, { entry: { id: ENTRY_ID }, traceId: "t" }),
    );

    await watchlistApi.create({
      subjectName: "Mara Osei",
      reason: "Barred after an altercation.",
    });

    const [url, init] = lastCall();
    expect(url).toContain("/api/watchlist");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      subjectName: "Mara Osei",
      reason: "Barred after an altercation.",
    });
    expect(body).not.toHaveProperty("guardId");
  });

  it("returns a typed error on a rejected reason", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(422, {
        error: {
          code: "WATCHLIST_INVALID_INPUT",
          message: "Reason is required",
          field: "reason",
          traceId: "t",
        },
      }),
    );

    const result = await watchlistApi.create({
      subjectName: "Mara Osei",
      reason: "",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("WATCHLIST_INVALID_INPUT");
      expect(result.error.field).toBe("reason");
    }
  });
});

describe("watchlistApi.review", () => {
  it("PATCHes the entry with an empty body by default", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { entry: { id: ENTRY_ID }, traceId: "t" }),
    );

    await watchlistApi.review(ENTRY_ID);

    const [url, init] = lastCall();
    expect(url).toContain(`/api/watchlist/${ENTRY_ID}`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({});
  });
});

describe("watchlistApi.remove", () => {
  it("DELETEs with the mandatory removal reason in the body", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { entry: { id: ENTRY_ID }, traceId: "t" }),
    );

    await watchlistApi.remove(ENTRY_ID, {
      removedReason: "Dispute resolved with the resident.",
    });

    const [url, init] = lastCall();
    expect(url).toContain(`/api/watchlist/${ENTRY_ID}`);
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(String(init.body))).toEqual({
      removedReason: "Dispute resolved with the resident.",
    });
  });

  it("surfaces a 409 on an already-removed entry", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: {
          code: "WATCHLIST_ALREADY_REMOVED",
          message: "Entry is already removed.",
          traceId: "t",
        },
      }),
    );

    const result = await watchlistApi.remove(ENTRY_ID, {
      removedReason: "Duplicate entry.",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("WATCHLIST_ALREADY_REMOVED");
    }
  });
});
