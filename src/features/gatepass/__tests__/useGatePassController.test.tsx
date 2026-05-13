/**
 * useGatePassController — side-effect tests.
 *
 * These guarantee the trustless rules the spec demands:
 *   - if API fails → UI must show an actionable error (no silent success)
 *   - if sync partially fails → user sees which entries failed
 *   - offline submit → entry is queued, not lost
 *   - network restore → queued entries automatically reconcile
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGatePassController } from "../useGatePassController";
import type { GatePassApi } from "@/lib/api/gatepass";
import type {
  ApiResult,
  CreateEntryResponse,
  QrValidateResponse,
  RecognizedVisitorsResponse,
  SyncBatchResponse,
} from "@/lib/api/types";

function ok<T>(data: T, status = 200): ApiResult<T> {
  return { ok: true, status, data };
}

function fail(
  status: number,
  code: string,
  message: string,
  field?: string
): ApiResult<never> {
  return {
    ok: false,
    status,
    error: { code, message, field, traceId: `trace-${code}` },
  };
}

interface MockApi extends GatePassApi {
  submitEntry: ReturnType<typeof vi.fn>;
  validateQr: ReturnType<typeof vi.fn>;
  syncEntries: ReturnType<typeof vi.fn>;
  searchVisitors: ReturnType<typeof vi.fn>;
}

function makeApi(): MockApi {
  return {
    submitEntry: vi.fn(),
    validateQr: vi.fn(),
    syncEntries: vi.fn(),
    searchVisitors: vi.fn(),
  } as unknown as MockApi;
}

const SERVER_ENTRY: CreateEntryResponse = {
  entry: {
    id: "server-1",
    visitorName: "Ada Lovelace",
    host: "Bola",
    unit: "4A",
    plate: null,
    reason: "",
    method: "walk-in",
    guardId: "guard-west-04",
    createdAt: new Date("2024-01-01T00:00:00Z").toISOString(),
    status: "logged",
    syncState: "synced",
  },
  traceId: "trace-ok",
};

function buildController(api: MockApi) {
  let counter = 0;
  const generateId = () => {
    counter += 1;
    return `00000000-0000-4000-8000-${counter.toString().padStart(12, "0")}`;
  };
  return renderHook(() =>
    useGatePassController({
      api,
      now: () => new Date("2024-01-01T00:00:00Z"),
      generateId,
    })
  );
}

async function fillValidDraft(
  result: ReturnType<typeof buildController>
): Promise<void> {
  await act(async () => {
    result.result.current.dispatch({ type: "NAVIGATE", mode: "walkin" });
    result.result.current.dispatch({
      type: "UPDATE_DRAFT",
      field: "visitorName",
      value: "Ada Lovelace",
    });
    result.result.current.dispatch({
      type: "UPDATE_DRAFT",
      field: "host",
      value: "Bola",
    });
    result.result.current.dispatch({
      type: "UPDATE_DRAFT",
      field: "unit",
      value: "4A",
    });
  });
}

describe("useGatePassController.submitEntry", () => {
  let api: MockApi;

  beforeEach(() => {
    api = makeApi();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls POST /entries on the configured API and reflects the server entry", async () => {
    api.submitEntry.mockResolvedValue(ok(SERVER_ENTRY, 201));
    const hook = buildController(api);
    await fillValidDraft(hook);

    await act(async () => {
      await hook.result.current.submitEntry();
    });

    expect(api.submitEntry).toHaveBeenCalledTimes(1);
    const [payload] = api.submitEntry.mock.calls[0];
    expect(payload).toMatchObject({
      visitorName: "Ada Lovelace",
      host: "Bola",
      unit: "4A",
      method: "walk-in",
    });
    // offlineId is included so the backend can dedupe on retry.
    expect(payload.offlineId).toMatch(/^[0-9a-f-]{36}$/);

    expect(hook.result.current.state.mode).toBe("confirmed");
    expect(hook.result.current.state.entries).toHaveLength(1);
    expect(hook.result.current.state.entries[0].id).toBe("server-1");
  });

  it("never advances to confirmed on 422 and surfaces the backend's field + message", async () => {
    api.submitEntry.mockResolvedValue(
      fail(422, "UNIT_REQUIRED", "Unit is required", "unit")
    );
    const hook = buildController(api);
    await fillValidDraft(hook);

    await act(async () => {
      await hook.result.current.submitEntry();
    });

    expect(hook.result.current.state.mode).toBe("error");
    expect(hook.result.current.state.lastError?.code).toBe("UNIT_REQUIRED");
    expect(hook.result.current.state.lastError?.field).toBe("unit");
    expect(hook.result.current.state.entries).toHaveLength(0);
  });

  it("surfaces 401 explicitly so the guard knows to re-authenticate", async () => {
    api.submitEntry.mockResolvedValue(
      fail(401, "AUTH_TOKEN_MISSING", "Authentication required")
    );
    const hook = buildController(api);
    await fillValidDraft(hook);

    await act(async () => {
      await hook.result.current.submitEntry();
    });

    expect(hook.result.current.state.mode).toBe("error");
    expect(hook.result.current.state.lastError?.code).toBe("AUTH_TOKEN_MISSING");
    expect(hook.result.current.state.banner.message).toContain("Authentication required");
  });

  it("surfaces 429 as a warning so the guard can wait, not bypass", async () => {
    api.submitEntry.mockResolvedValue(
      fail(429, "RATE_LIMIT_EXCEEDED", "Too many requests")
    );
    const hook = buildController(api);
    await fillValidDraft(hook);

    await act(async () => {
      await hook.result.current.submitEntry();
    });

    expect(hook.result.current.state.banner.tone).toBe("warning");
    expect(hook.result.current.state.lastError?.code).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("surfaces 500 explicitly without claiming the entry was logged", async () => {
    api.submitEntry.mockResolvedValue(
      fail(500, "INTERNAL_ERROR", "An unexpected error occurred")
    );
    const hook = buildController(api);
    await fillValidDraft(hook);

    await act(async () => {
      await hook.result.current.submitEntry();
    });

    expect(hook.result.current.state.mode).toBe("error");
    expect(hook.result.current.state.entries).toHaveLength(0);
  });

  it("queues the entry locally when the network is offline and never hits the API", async () => {
    const hook = buildController(api);
    await fillValidDraft(hook);
    await act(async () => {
      hook.result.current.setNetwork("offline");
    });

    await act(async () => {
      await hook.result.current.submitEntry();
    });

    expect(api.submitEntry).not.toHaveBeenCalled();
    expect(hook.result.current.state.pendingSync).toHaveLength(1);
    expect(hook.result.current.state.pendingSync[0].syncState).toBe("queued");
    expect(hook.result.current.state.entries[0].syncState).toBe("queued");
  });

  it("queues the entry locally when the request fails at the transport layer (status=0)", async () => {
    api.submitEntry.mockResolvedValue(
      fail(0, "NETWORK_ERROR", "Could not reach the GatePass backend.")
    );
    const hook = buildController(api);
    await fillValidDraft(hook);

    await act(async () => {
      await hook.result.current.submitEntry();
    });

    expect(hook.result.current.state.pendingSync).toHaveLength(1);
    expect(hook.result.current.state.pendingSync[0].syncState).toBe("queued");
  });

  it("rejects submissions that fail client-side validation without touching the API", async () => {
    const hook = buildController(api);

    await act(async () => {
      await hook.result.current.submitEntry();
    });

    expect(api.submitEntry).not.toHaveBeenCalled();
    expect(hook.result.current.state.mode).toBe("error");
    expect(hook.result.current.state.lastError?.code).toBe("VISITOR_NAME_REQUIRED");
  });
});

describe("useGatePassController.scanQr", () => {
  let api: MockApi;

  beforeEach(() => {
    api = makeApi();
  });

  it("dispatches QR_SCAN_SUCCEEDED with the backend visitor on a valid token", async () => {
    const response: QrValidateResponse = {
      outcome: "valid",
      visitor: {
        name: "QR Guest",
        host: "Resident verified",
        unit: "12A",
        plate: null,
        preApprovalId: "preapproval-1",
      },
      expiresAt: "2099-01-01T00:00:00Z",
      traceId: "trace-qr",
    };
    api.validateQr.mockResolvedValue(ok(response));
    const hook = buildController(api);

    await act(async () => {
      await hook.result.current.scanQr("qr-token-123");
    });

    expect(api.validateQr).toHaveBeenCalledWith({
      qrToken: "qr-token-123",
      scannedAt: expect.any(String),
    });
    expect(hook.result.current.state.qrState).toBe("valid");
    expect(hook.result.current.state.draft.preApprovalId).toBe("preapproval-1");
  });

  it("maps QR_REPLAYED (409) to qrState=replayed and shows the backend message", async () => {
    api.validateQr.mockResolvedValue(
      fail(409, "QR_REPLAYED", "This QR code has already been used")
    );
    const hook = buildController(api);

    await act(async () => {
      await hook.result.current.scanQr("qr-token-replayed");
    });

    expect(hook.result.current.state.qrState).toBe("replayed");
    expect(hook.result.current.state.mode).toBe("error");
    expect(hook.result.current.state.banner.message).toContain("already been used");
  });

  it("rejects empty tokens locally as QR_MALFORMED without an API call", async () => {
    const hook = buildController(api);

    await act(async () => {
      await hook.result.current.scanQr("   ");
    });

    expect(api.validateQr).not.toHaveBeenCalled();
    expect(hook.result.current.state.lastError?.code).toBe("QR_MALFORMED");
  });

  it("refuses to validate QR while offline so the guard cannot wave anyone through", async () => {
    const hook = buildController(api);
    await act(async () => {
      hook.result.current.setNetwork("offline");
    });

    await act(async () => {
      await hook.result.current.scanQr("qr-token-anything");
    });

    expect(api.validateQr).not.toHaveBeenCalled();
    expect(hook.result.current.state.qrState).toBe("invalid");
    expect(hook.result.current.state.lastError?.code).toBe("NETWORK_ERROR");
  });
});

describe("useGatePassController.syncPending", () => {
  let api: MockApi;

  beforeEach(() => {
    api = makeApi();
  });

  async function queueTwo(hook: ReturnType<typeof buildController>) {
    await fillValidDraft(hook);
    await act(async () => {
      hook.result.current.setNetwork("offline");
    });
    await act(async () => {
      await hook.result.current.submitEntry();
    });
    await act(async () => {
      hook.result.current.dispatch({
        type: "UPDATE_DRAFT",
        field: "visitorName",
        value: "Rejected Guest",
      });
      hook.result.current.dispatch({ type: "RESET_FLOW" });
      hook.result.current.dispatch({ type: "NAVIGATE", mode: "walkin" });
      hook.result.current.dispatch({
        type: "UPDATE_DRAFT",
        field: "visitorName",
        value: "Rejected Guest",
      });
      hook.result.current.dispatch({
        type: "UPDATE_DRAFT",
        field: "host",
        value: "Resident",
      });
      hook.result.current.dispatch({
        type: "UPDATE_DRAFT",
        field: "unit",
        value: "9C",
      });
    });
    await act(async () => {
      await hook.result.current.submitEntry();
    });
  }

  it("surfaces partial-sync results so the guard sees which entries failed", async () => {
    // Stub network sync to NOT auto-fire while we set up two queued entries.
    // We then go online and call syncPending explicitly.
    api.syncEntries.mockResolvedValueOnce({
      ok: true,
      status: 207,
      data: {
        results: [
          {
            offlineId: "stub-1",
            serverId: "server-A",
            status: "synced",
          },
          {
            offlineId: "stub-2",
            serverId: "",
            status: "rejected",
            error: {
              code: "OVERRIDE_REASON_TOO_SHORT",
              message: "Override reason is missing",
            },
          },
        ],
        syncedCount: 1,
        duplicateCount: 0,
        rejectedCount: 1,
        traceId: "trace-sync",
      } satisfies SyncBatchResponse,
    });

    const hook = buildController(api);
    await queueTwo(hook);

    // The mock API returns server-side offlineIds we didn't generate, so
    // rewire the queue entries to match what the mock will respond with.
    await act(async () => {
      hook.result.current.dispatch({
        type: "SYNC_COMPLETED",
        results: [],
        keptInQueue: hook.result.current.state.pendingSync.map((e, idx) => ({
          ...e,
          offlineId: `stub-${idx + 1}`,
          id: `stub-${idx + 1}`,
        })),
        newlySynced: [],
      });
    });

    // Now go back online and trigger sync.
    await act(async () => {
      hook.result.current.setNetwork("online");
    });

    await waitFor(() => {
      expect(api.syncEntries).toHaveBeenCalled();
    });

    await waitFor(() => {
      const s = hook.result.current.state;
      expect(s.pendingSync).toHaveLength(1);
      expect(s.pendingSync[0].syncState).toBe("failed");
      expect(s.pendingSync[0].lastError?.code).toBe("OVERRIDE_REASON_TOO_SHORT");
      expect(s.lastSyncResults).toHaveLength(2);
      expect(s.banner.message).toContain("rejected");
    });
  });

  it("reports SYNC_FAILED when offline and never silently no-ops", async () => {
    const hook = buildController(api);
    await fillValidDraft(hook);
    await act(async () => {
      hook.result.current.setNetwork("offline");
    });

    await act(async () => {
      await hook.result.current.syncPending();
    });

    expect(hook.result.current.state.lastError?.code).toBe("NETWORK_ERROR");
    expect(hook.result.current.state.banner.message).toContain("Still offline");
  });

  it("surfaces a 500 sync failure without dropping the queued entries", async () => {
    api.syncEntries.mockResolvedValue(
      fail(500, "INTERNAL_ERROR", "An unexpected error occurred")
    );
    const hook = buildController(api);
    await fillValidDraft(hook);
    await act(async () => {
      hook.result.current.setNetwork("offline");
    });
    await act(async () => {
      await hook.result.current.submitEntry();
    });

    await act(async () => {
      hook.result.current.setNetwork("online");
    });

    await waitFor(() => {
      expect(hook.result.current.state.lastError?.code).toBe("INTERNAL_ERROR");
    });
    // Queue is intact — entries are not silently dropped on server failure.
    expect(hook.result.current.state.pendingSync).toHaveLength(1);
  });
});

describe("useGatePassController.searchVisitors", () => {
  let api: MockApi;

  beforeEach(() => {
    api = makeApi();
  });

  it("calls /api/visitors/recognized and replaces the visitor list", async () => {
    const response: RecognizedVisitorsResponse = {
      visitors: [
        {
          id: "rec-1",
          name: "Maya Chen",
          host: "A. Okafor",
          unit: "18B",
          plate: "LND-482",
          lastSeen: "2024-01-01T00:00:00Z",
          recognition: "pre-approved",
        },
      ],
      pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
      traceId: "trace-vis",
    };
    api.searchVisitors.mockResolvedValue(ok(response));
    const hook = buildController(api);

    await act(async () => {
      await hook.result.current.searchVisitors("maya");
    });

    expect(api.searchVisitors).toHaveBeenCalledWith({
      q: "maya",
      page: 1,
      pageSize: 20,
    });
    expect(hook.result.current.state.recognizedVisitors).toHaveLength(1);
    expect(hook.result.current.state.recognizedVisitors[0].id).toBe("rec-1");
  });

  it("surfaces 401 as VISITORS_FAILED so the search UI doesn't fall back to stale data silently", async () => {
    api.searchVisitors.mockResolvedValue(
      fail(401, "AUTH_TOKEN_MISSING", "Authentication required")
    );
    const hook = buildController(api);

    await act(async () => {
      await hook.result.current.searchVisitors("anything");
    });

    expect(hook.result.current.state.searchLoading).toBe(false);
    expect(hook.result.current.state.lastError?.code).toBe("AUTH_TOKEN_MISSING");
  });
});
