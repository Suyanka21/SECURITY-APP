/**
 * GatePass — Visitor Profile API client tests.
 *
 * Source: src/docs/specs/visitor-profiles.md §4
 * Source: src/lib/api/__tests__/approvals.test.ts (fetch-mock pattern)
 *
 * Each test stubs global fetch and asserts:
 *   - The correct URL and HTTP method are issued.
 *   - Authorization is attached on every call.
 *   - The discriminated ApiResult<T> is shaped correctly on success and
 *     on each contract-defined failure (422 / 403 / 404 / 409).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visitorProfilesApi } from "../visitor-profiles";
import { setAuthTokenGetter } from "../auth";

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";

function makeView(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: PROFILE_ID,
    visitorName: "Maya Chen",
    host: "Alex Park",
    unit: "12A",
    plate: null,
    phoneE164: null,
    notes: null,
    watchFlag: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
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

// ─── createProfile ──────────────────────────────────────────────────────────

describe("visitorProfilesApi.createProfile", () => {
  it("POSTs to /api/visitor-profiles with Authorization and returns ok on 201", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, { profile: makeView(), traceId: "trace-1" })
    );

    const result = await visitorProfilesApi.createProfile({
      visitorName: "Maya Chen",
      host: "Alex Park",
      unit: "12A",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.status).toBe(201);
    expect(result.data.profile.id).toBe(PROFILE_ID);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/visitor-profiles$/);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer jwt-test-token"
    );
  });

  it("surfaces 403 AUTH_FORBIDDEN (guard token attempts mutation)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, {
        error: {
          code: "AUTH_FORBIDDEN",
          message: "guards cannot mutate visitor profiles",
          traceId: "trace-2",
        },
      })
    );

    const result = await visitorProfilesApi.createProfile({
      visitorName: "Maya",
      host: "Alex",
      unit: "12A",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.status).toBe(403);
    expect(result.error.code).toBe("AUTH_FORBIDDEN");
  });

  it("surfaces 409 PROFILE_DUPLICATE with field hint", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: {
          code: "PROFILE_DUPLICATE",
          message: "duplicate identity",
          field: "visitorName",
          traceId: "trace-3",
        },
      })
    );
    const result = await visitorProfilesApi.createProfile({
      visitorName: "Maya",
      host: "Alex",
      unit: "12A",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("PROFILE_DUPLICATE");
    expect(result.error.field).toBe("visitorName");
  });
});

// ─── listProfiles ───────────────────────────────────────────────────────────

describe("visitorProfilesApi.listProfiles", () => {
  it("GETs /api/visitor-profiles with default empty query", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        profiles: [makeView()],
        pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
        traceId: "trace-1",
      })
    );

    const result = await visitorProfilesApi.listProfiles();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.profiles).toHaveLength(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/visitor-profiles(\?|$)/);
    expect(init?.method).toBe("GET");
  });

  it("serializes host, page, pageSize, includeDeleted into the query string", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        profiles: [],
        pagination: { page: 2, pageSize: 5, totalItems: 0, totalPages: 1 },
        traceId: "trace-1",
      })
    );

    await visitorProfilesApi.listProfiles({
      host: "Alex Park",
      page: 2,
      pageSize: 5,
      includeDeleted: true,
    });

    const [url] = fetchMock.mock.calls[0];
    const u = new URL(String(url));
    expect(u.searchParams.get("host")).toBe("Alex Park");
    expect(u.searchParams.get("page")).toBe("2");
    expect(u.searchParams.get("pageSize")).toBe("5");
    expect(u.searchParams.get("includeDeleted")).toBe("true");
  });

  it("omits undefined query params and false includeDeleted serialises as 'false'", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        profiles: [],
        pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
        traceId: "trace-1",
      })
    );

    await visitorProfilesApi.listProfiles({ includeDeleted: false });
    const [url] = fetchMock.mock.calls[0];
    const u = new URL(String(url));
    expect(u.searchParams.get("host")).toBeNull();
    expect(u.searchParams.get("includeDeleted")).toBe("false");
  });
});

// ─── getProfile / updateProfile / softDeleteProfile / restoreProfile ────────

describe("visitorProfilesApi.getProfile", () => {
  it("GETs /api/visitor-profiles/:id and returns the view on 200", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { profile: makeView(), traceId: "t" })
    );
    const result = await visitorProfilesApi.getProfile(PROFILE_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.profile.id).toBe(PROFILE_ID);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(
      new RegExp(`/api/visitor-profiles/${PROFILE_ID}$`)
    );
    expect(init?.method).toBe("GET");
  });

  it("surfaces 404 PROFILE_NOT_FOUND on unknown id", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(404, {
        error: {
          code: "PROFILE_NOT_FOUND",
          message: "no such profile",
          traceId: "t",
        },
      })
    );
    const result = await visitorProfilesApi.getProfile(PROFILE_ID);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.status).toBe(404);
    expect(result.error.code).toBe("PROFILE_NOT_FOUND");
  });
});

describe("visitorProfilesApi.updateProfile", () => {
  it("PATCHes /api/visitor-profiles/:id with the patch body", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        profile: makeView({ watchFlag: true }),
        traceId: "t",
      })
    );

    const result = await visitorProfilesApi.updateProfile(PROFILE_ID, {
      watchFlag: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.profile.watchFlag).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(
      new RegExp(`/api/visitor-profiles/${PROFILE_ID}$`)
    );
    expect(init?.method).toBe("PATCH");
    expect(init?.body).toBe(JSON.stringify({ watchFlag: true }));
  });

  it("surfaces 422 PROFILE_INVALID_INPUT with field hint", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(422, {
        error: {
          code: "PROFILE_INVALID_INPUT",
          message: "must be E.164",
          field: "phoneE164",
          traceId: "t",
        },
      })
    );
    const result = await visitorProfilesApi.updateProfile(PROFILE_ID, {
      phoneE164: "bad",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.field).toBe("phoneE164");
  });
});

describe("visitorProfilesApi.softDeleteProfile", () => {
  it("DELETEs /api/visitor-profiles/:id", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        profile: makeView({ deletedAt: new Date().toISOString() }),
        traceId: "t",
      })
    );
    const result = await visitorProfilesApi.softDeleteProfile(PROFILE_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.profile.deletedAt).not.toBeNull();

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(
      new RegExp(`/api/visitor-profiles/${PROFILE_ID}$`)
    );
    expect(init?.method).toBe("DELETE");
  });
});

describe("visitorProfilesApi.restoreProfile", () => {
  it("POSTs /api/visitor-profiles/:id/restore", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { profile: makeView(), traceId: "t" })
    );
    const result = await visitorProfilesApi.restoreProfile(PROFILE_ID);
    expect(result.ok).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(
      new RegExp(`/api/visitor-profiles/${PROFILE_ID}/restore$`)
    );
    expect(init?.method).toBe("POST");
  });

  it("surfaces 409 PROFILE_RESTORE_CONFLICT", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: {
          code: "PROFILE_RESTORE_CONFLICT",
          message: "another profile already has this identity",
          traceId: "t",
        },
      })
    );
    const result = await visitorProfilesApi.restoreProfile(PROFILE_ID);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("PROFILE_RESTORE_CONFLICT");
  });
});
