/**
 * GatePass — Visitor invitation API client tests (Feature 6).
 *
 * Source: src/docs/specs/guest-qr-ticket.md §6
 * Source: src/lib/api/__tests__/visitor-profiles.test.ts (fetch-mock pattern).
 *
 * Each test stubs global fetch and asserts:
 *   - Correct URL + HTTP method.
 *   - Authorization is attached for the issue path (private endpoint).
 *   - The discriminated ApiResult<T> is shaped correctly on success and
 *     on each contract-defined failure (422 / 403 / 404 / 410).
 *   - Default-deny: preview NEVER lands in `ok: true` for stale tokens
 *     (expired / consumed) — they MUST surface as 410 + error code.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visitorInvitationsApi } from "../visitor-invitations";
import { setAuthTokenGetter } from "../auth";

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const INVITATION_ID = "55555555-5555-4555-8555-555555555555";
const RAW_TOKEN = "TEST_RAW_TOKEN_FORTY_THREE_CHARS_ABCDEFGHIJ";

function makeIssuedView() {
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  return {
    id: INVITATION_ID,
    qrToken: RAW_TOKEN,
    passUrl: `https://gate.example.com/pass/${RAW_TOKEN}`,
    expiresAt,
    issuedAt: new Date().toISOString(),
    visitorName: "Maya Chen",
    host: "A. Okafor",
    unit: "18B",
    plate: null,
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

// ─── issueInvitation ─────────────────────────────────────────────────────────

describe("visitorInvitationsApi.issueInvitation", () => {
  it("C-I1: POSTs to /api/visitor-invitations with Authorization and returns ok on 201", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, { invitation: makeIssuedView(), traceId: "trace-1" }),
    );

    const result = await visitorInvitationsApi.issueInvitation({
      visitorName: "Maya Chen",
      host: "A. Okafor",
      unit: "18B",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.status).toBe(201);
    expect(result.data.invitation.id).toBe(INVITATION_ID);
    expect(result.data.invitation.qrToken).toBe(RAW_TOKEN);
    expect(result.data.invitation.passUrl).toContain(RAW_TOKEN);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/visitor-invitations$/);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer jwt-test-token",
    );
  });

  it("C-I2: surfaces 422 INVITATION_INVALID_INPUT", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(422, {
        error: {
          code: "INVITATION_INVALID_INPUT",
          message: "visitorName is required",
          field: "visitorName",
          traceId: "trace-422",
        },
      }),
    );

    const result = await visitorInvitationsApi.issueInvitation({
      visitorName: "",
      host: "A. Okafor",
      unit: "18B",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected !ok");
    expect(result.status).toBe(422);
    expect(result.error.code).toBe("INVITATION_INVALID_INPUT");
    expect(result.error.field).toBe("visitorName");
  });

  it("C-I3: surfaces 403 AUTH_FORBIDDEN (guard token attempts to mint)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, {
        error: {
          code: "AUTH_FORBIDDEN",
          message: "Guard tokens cannot issue visitor invitations",
          traceId: "trace-403",
        },
      }),
    );

    const result = await visitorInvitationsApi.issueInvitation({
      visitorName: "Maya Chen",
      host: "A. Okafor",
      unit: "18B",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected !ok");
    expect(result.status).toBe(403);
    expect(result.error.code).toBe("AUTH_FORBIDDEN");
  });
});

// ─── previewInvitation ───────────────────────────────────────────────────────

describe("visitorInvitationsApi.previewInvitation", () => {
  it("C-P1: GETs /api/visitor-invitations/:token/preview and returns ok on 200", async () => {
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        invitation: {
          visitorName: "Maya Chen",
          host: "A. Okafor",
          unit: "18B",
          plate: "LND-482",
          expiresAt,
        },
      }),
    );

    const result = await visitorInvitationsApi.previewInvitation(RAW_TOKEN);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.status).toBe(200);
    expect(result.data.invitation).toEqual({
      visitorName: "Maya Chen",
      host: "A. Okafor",
      unit: "18B",
      plate: "LND-482",
      expiresAt,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(
      new RegExp(`/api/visitor-invitations/${RAW_TOKEN}/preview$`),
    );
    expect(init?.method ?? "GET").toBe("GET");
  });

  it("C-P2: URL-encodes the token (defends against accidental special chars)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { invitation: {} }));
    // base64url tokens never include "/" or "+" or "=" but guard the surface
    await visitorInvitationsApi.previewInvitation("not/legal+token=");
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("not%2Flegal%2Btoken%3D");
  });

  it("C-P3: surfaces 404 INVITATION_NOT_FOUND (single shape for unknown/malformed)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(404, {
        error: {
          code: "INVITATION_NOT_FOUND",
          message: "No invitation matches this pass link",
          traceId: "trace-404",
        },
      }),
    );

    const result = await visitorInvitationsApi.previewInvitation(RAW_TOKEN);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected !ok");
    expect(result.status).toBe(404);
    expect(result.error.code).toBe("INVITATION_NOT_FOUND");
  });

  it("C-P4: surfaces 410 INVITATION_EXPIRED (default-deny on stale tokens)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(410, {
        error: {
          code: "INVITATION_EXPIRED",
          message: "This invitation has expired",
          traceId: "trace-410-expired",
        },
      }),
    );

    const result = await visitorInvitationsApi.previewInvitation(RAW_TOKEN);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected !ok");
    expect(result.status).toBe(410);
    expect(result.error.code).toBe("INVITATION_EXPIRED");
  });

  it("C-P5: surfaces 410 INVITATION_CONSUMED (default-deny on replay)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(410, {
        error: {
          code: "INVITATION_CONSUMED",
          message: "This invitation has already been used",
          traceId: "trace-410-consumed",
        },
      }),
    );

    const result = await visitorInvitationsApi.previewInvitation(RAW_TOKEN);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected !ok");
    expect(result.status).toBe(410);
    expect(result.error.code).toBe("INVITATION_CONSUMED");
  });
});
