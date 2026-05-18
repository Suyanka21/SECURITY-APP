/**
 * GatePass — Approval API client tests.
 *
 * Source: src/docs/specs/resident-approval-flow.md §7
 * Source: src/lib/api/__tests__/client.test.ts (fetch-mock pattern)
 *
 * Each test stubs global fetch and asserts:
 *   - The correct URL and method are issued.
 *   - The Authorization header is (or is not) attached as expected.
 *   - The discriminated ApiResult is shaped correctly on success and on
 *     each contract-defined failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guardApprovalApi, residentApprovalApi } from "../approvals";
import { setAuthTokenGetter } from "../auth";

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const APPROVAL_ID = "11111111-1111-4111-8111-111111111111";
const RAW_TOKEN = "a".repeat(64);

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

// ─── guardApprovalApi.createApproval ─────────────────────────────────

describe("guardApprovalApi.createApproval", () => {
  it("POSTs to /api/approvals with Authorization header and returns ok on 201", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, {
        approvalId: APPROVAL_ID,
        magicLinkUrl: `http://localhost:5173/approve/${APPROVAL_ID}?token=${RAW_TOKEN}`,
        expiresAt: new Date().toISOString(),
        traceId: "trace-1",
      })
    );

    const result = await guardApprovalApi.createApproval({
      offlineId: APPROVAL_ID,
      draft: {
        visitorName: "Maya",
        host: "Host",
        unit: "1A",
        method: "walk-in",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.status).toBe(201);
    expect(result.data.approvalId).toBe(APPROVAL_ID);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/approvals$/);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer jwt-test-token"
    );
  });

  it("surfaces 409 APPROVAL_DUPLICATE as ok=false with the structured error body", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: {
          code: "APPROVAL_DUPLICATE",
          message: "duplicate offlineId",
          field: "offlineId",
          traceId: "trace-2",
        },
      })
    );

    const result = await guardApprovalApi.createApproval({
      offlineId: APPROVAL_ID,
      draft: { visitorName: "M", host: "H", unit: "1A", method: "walk-in" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.status).toBe(409);
    expect(result.error.code).toBe("APPROVAL_DUPLICATE");
    expect(result.error.field).toBe("offlineId");
  });

  it("surfaces 403 GUARD_SESSION_EXPIRED so the controller can prompt re-auth", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, {
        error: {
          code: "GUARD_SESSION_EXPIRED",
          message: "guard inactive",
          traceId: "trace-3",
        },
      })
    );

    const result = await guardApprovalApi.createApproval({
      offlineId: APPROVAL_ID,
      draft: { visitorName: "M", host: "H", unit: "1A", method: "walk-in" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("GUARD_SESSION_EXPIRED");
  });
});

// ─── guardApprovalApi.getApprovalStatus ──────────────────────────────

describe("guardApprovalApi.getApprovalStatus", () => {
  it("GETs /api/approvals/:id/status with the id URL-encoded", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        approval: {
          id: APPROVAL_ID,
          offlineId: APPROVAL_ID,
          visitorName: "Maya",
          host: "Host",
          unit: "1A",
          plate: null,
          reason: "",
          method: "walk-in",
          requestedByGuardId: "guard-1",
          status: "pending",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          decidedAt: null,
          deniedReason: null,
          entryId: null,
          traceId: "trace-4",
        },
        traceId: "trace-4",
      })
    );

    const result = await guardApprovalApi.getApprovalStatus(APPROVAL_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.approval.status).toBe("pending");

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(
      new RegExp(`/api/approvals/${APPROVAL_ID}/status$`)
    );
  });

  it("returns ok=false with APPROVAL_GUARD_MISMATCH on 403", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, {
        error: {
          code: "APPROVAL_GUARD_MISMATCH",
          message: "wrong guard",
          traceId: "trace-5",
        },
      })
    );

    const result = await guardApprovalApi.getApprovalStatus(APPROVAL_ID);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("APPROVAL_GUARD_MISMATCH");
  });
});

// ─── residentApprovalApi.decideApproval ──────────────────────────────

describe("residentApprovalApi.decideApproval", () => {
  it("POSTs to /api/approvals/:id/decide with token + decision in the body", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        approval: {
          id: APPROVAL_ID,
          offlineId: APPROVAL_ID,
          visitorName: "Maya",
          host: "Host",
          unit: "1A",
          plate: null,
          reason: "",
          method: "walk-in",
          requestedByGuardId: "guard-1",
          status: "approved",
          expiresAt: new Date().toISOString(),
          decidedAt: new Date().toISOString(),
          deniedReason: null,
          entryId: "entry-1",
          traceId: "trace-6",
        },
        entry: {
          id: "entry-1",
          visitorName: "Maya",
          host: "Host",
          unit: "1A",
          plate: null,
          reason: "",
          method: "walk-in",
          guardId: "guard-1",
          createdAt: new Date().toISOString(),
          status: "logged",
          syncState: "synced",
        },
        traceId: "trace-6",
      })
    );

    const result = await residentApprovalApi.decideApproval(APPROVAL_ID, {
      token: RAW_TOKEN,
      decision: "approve",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.approval.status).toBe("approved");
    expect(result.data.entry?.id).toBe("entry-1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(
      new RegExp(`/api/approvals/${APPROVAL_ID}/decide$`)
    );
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({ token: RAW_TOKEN, decision: "approve" });
  });

  it("surfaces 401 APPROVAL_TOKEN_INVALID without retrying", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, {
        error: {
          code: "APPROVAL_TOKEN_INVALID",
          message: "bad token",
          traceId: "trace-7",
        },
      })
    );

    const result = await residentApprovalApi.decideApproval(APPROVAL_ID, {
      token: "0".repeat(64),
      decision: "approve",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.status).toBe(401);
    expect(result.error.code).toBe("APPROVAL_TOKEN_INVALID");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces 410 APPROVAL_EXPIRED so the UI can render the expired-link page", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(410, {
        error: {
          code: "APPROVAL_EXPIRED",
          message: "expired",
          traceId: "trace-8",
        },
      })
    );

    const result = await residentApprovalApi.decideApproval(APPROVAL_ID, {
      token: RAW_TOKEN,
      decision: "approve",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.status).toBe(410);
    expect(result.error.code).toBe("APPROVAL_EXPIRED");
  });

  it("surfaces 409 APPROVAL_ALREADY_DECIDED for replay attempts", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: {
          code: "APPROVAL_ALREADY_DECIDED",
          message: "already approved",
          traceId: "trace-9",
        },
      })
    );

    const result = await residentApprovalApi.decideApproval(APPROVAL_ID, {
      token: RAW_TOKEN,
      decision: "approve",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.status).toBe(409);
    expect(result.error.code).toBe("APPROVAL_ALREADY_DECIDED");
  });
});
