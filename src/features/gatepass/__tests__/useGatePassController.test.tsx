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
import {
  sanitizePhoneInput,
  useGatePassController,
} from "../useGatePassController";
import type { GatePassApi } from "@/lib/api/gatepass";
import type { guardApprovalApi } from "@/lib/api/approvals";
import type { guardNotificationsApi } from "@/lib/api/notifications";
import type {
  ApiResult,
  ApprovalRequestView,
  ApprovalStatusResponse,
  CreateApprovalResponse,
  CreateEntryResponse,
  NotificationsListResponse,
  NotificationRetryResponse,
  NotificationView,
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

    // buildController seeds a deterministic UUID generator that issues
    // 00000000-0000-4000-8000-00000000000N for each offline entry. The
    // sync mock above keys its rejected result off `stub-1`/`stub-2` so
    // we can assert which offlineId came back rejected. Rewire the two
    // queued entries' offlineIds (via SYNC_COMPLETED with empty results
    // — purely a state edit, no API call fires) so they match the mock's
    // canned response when the real sync runs below. This keeps the mock
    // independent of the test-side ID generator's exact format.
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

// ─── Resident approval flow ────────────────────────────────────────────
// Source: src/docs/specs/resident-approval-flow.md §7, §11

interface MockApprovalApi {
  createApproval: ReturnType<typeof vi.fn>;
  getApprovalStatus: ReturnType<typeof vi.fn>;
}

function makeApprovalApi(): MockApprovalApi {
  return {
    createApproval: vi.fn(),
    getApprovalStatus: vi.fn(),
  };
}

function buildControllerWithApproval(
  api: MockApi,
  approvalApi: MockApprovalApi,
  pollIntervalMs = 10
) {
  let counter = 0;
  const generateId = () => {
    counter += 1;
    return `00000000-0000-4000-8000-${counter.toString().padStart(12, "0")}`;
  };
  return renderHook(() =>
    useGatePassController({
      api,
      approvalApi: approvalApi as unknown as typeof guardApprovalApi,
      now: () => new Date("2024-01-01T00:00:00Z"),
      generateId,
      approvalPollIntervalMs: pollIntervalMs,
    })
  );
}

function approvalView(overrides: Partial<ApprovalRequestView> = {}): ApprovalRequestView {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    offlineId: "00000000-0000-4000-8000-000000000001",
    visitorName: "Ada Lovelace",
    host: "Bola",
    unit: "4A",
    plate: null,
    reason: "",
    method: "walk-in",
    requestedByGuardId: "guard-west-04",
    status: "pending",
    expiresAt: new Date("2024-01-01T00:05:00Z").toISOString(),
    decidedAt: null,
    deniedReason: null,
    entryId: null,
    traceId: "trace-status",
    ...overrides,
  };
}

const CREATE_APPROVAL_OK: CreateApprovalResponse = {
  approvalId: "11111111-1111-4111-8111-111111111111",
  magicLinkUrl:
    "http://localhost:5173/approve/11111111-1111-4111-8111-111111111111?token=" +
    "a".repeat(64),
  expiresAt: new Date("2024-01-01T00:05:00Z").toISOString(),
  traceId: "trace-create",
};

describe("useGatePassController.requestApproval", () => {
  let api: MockApi;
  let approvalApi: MockApprovalApi;

  beforeEach(() => {
    api = makeApi();
    approvalApi = makeApprovalApi();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks pre-flight when the draft is incomplete (no network call made)", async () => {
    const hook = buildControllerWithApproval(api, approvalApi);
    // Don't fill the draft — should fail validation client-side.
    await act(async () => {
      await hook.result.current.requestApproval();
    });
    expect(approvalApi.createApproval).not.toHaveBeenCalled();
    expect(hook.result.current.state.mode).toBe("error");
    expect(hook.result.current.state.lastError?.code).toBe("VISITOR_NAME_REQUIRED");
  });

  it("blocks when offline (cannot magic-link a resident without the network)", async () => {
    const hook = buildControllerWithApproval(api, approvalApi);
    await fillValidDraft(hook);
    await act(async () => {
      hook.result.current.setNetwork("offline");
    });
    await act(async () => {
      await hook.result.current.requestApproval();
    });
    expect(approvalApi.createApproval).not.toHaveBeenCalled();
    expect(hook.result.current.state.lastError?.code).toBe("NETWORK_ERROR");
  });

  it("blocks when the draft method is not walk-in (QR/override go through their own paths)", async () => {
    const hook = buildControllerWithApproval(api, approvalApi);
    await fillValidDraft(hook);
    await act(async () => {
      hook.result.current.dispatch({
        type: "UPDATE_DRAFT",
        field: "method",
        value: "override",
      });
    });
    await act(async () => {
      await hook.result.current.requestApproval();
    });
    expect(approvalApi.createApproval).not.toHaveBeenCalled();
    expect(hook.result.current.state.lastError?.code).toBe("APPROVAL_NOT_APPLICABLE");
  });

  it("on 201 success stores the approval and enters awaiting-approval", async () => {
    approvalApi.createApproval.mockResolvedValue(ok(CREATE_APPROVAL_OK, 201));
    // Make the very first poll a still-pending response so the test
    // doesn't accidentally land in a terminal state.
    approvalApi.getApprovalStatus.mockResolvedValue(
      ok({ approval: approvalView(), traceId: "t" } as ApprovalStatusResponse)
    );
    const hook = buildControllerWithApproval(api, approvalApi);
    await fillValidDraft(hook);

    await act(async () => {
      await hook.result.current.requestApproval();
    });

    expect(approvalApi.createApproval).toHaveBeenCalledTimes(1);
    const payload = approvalApi.createApproval.mock.calls[0][0];
    expect(payload).toMatchObject({
      offlineId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      draft: {
        visitorName: "Ada Lovelace",
        host: "Bola",
        unit: "4A",
        method: "walk-in",
      },
    });
    await waitFor(() => {
      expect(hook.result.current.state.mode).toBe("awaiting-approval");
    });
    expect(hook.result.current.state.pendingApproval?.id).toBe(
      CREATE_APPROVAL_OK.approvalId
    );
    expect(hook.result.current.state.pendingApproval?.magicLinkUrl).toBe(
      CREATE_APPROVAL_OK.magicLinkUrl
    );
  });

  it("surfaces 409 APPROVAL_DUPLICATE without entering awaiting-approval", async () => {
    approvalApi.createApproval.mockResolvedValue(
      fail(409, "APPROVAL_DUPLICATE", "An approval is already pending for this entry")
    );
    const hook = buildControllerWithApproval(api, approvalApi);
    await fillValidDraft(hook);

    await act(async () => {
      await hook.result.current.requestApproval();
    });

    expect(hook.result.current.state.mode).toBe("error");
    expect(hook.result.current.state.lastError?.code).toBe("APPROVAL_DUPLICATE");
    expect(hook.result.current.state.pendingApproval).toBeUndefined();
  });

  it("surfaces 403 GUARD_SESSION_EXPIRED so the guard re-authenticates instead of retrying", async () => {
    approvalApi.createApproval.mockResolvedValue(
      fail(403, "GUARD_SESSION_EXPIRED", "Re-authenticate to continue")
    );
    const hook = buildControllerWithApproval(api, approvalApi);
    await fillValidDraft(hook);

    await act(async () => {
      await hook.result.current.requestApproval();
    });

    expect(hook.result.current.state.lastError?.code).toBe("GUARD_SESSION_EXPIRED");
    expect(hook.result.current.state.pendingApproval).toBeUndefined();
  });
});

// ─── Feature 3 — Auto-approval short-circuit ───────────────────────────────
// Source: src/docs/specs/auto-approval.md §5 + §6 — when the backend
// responds with autoApproved=true, the controller must dispatch
// APPROVAL_AUTO_APPROVED (NOT APPROVAL_REQUEST_SUCCEEDED) so the UI never
// observes a transient awaiting-approval state. Malformed auto-approval
// responses MUST fall back to APPROVAL_REQUEST_FAILED — never silently
// progress.
describe("useGatePassController.requestApproval — auto-approval", () => {
  let api: MockApi;
  let approvalApi: MockApprovalApi;

  beforeEach(() => {
    api = makeApi();
    approvalApi = makeApprovalApi();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function autoApprovedResponse(
    overrides: Partial<CreateApprovalResponse> = {}
  ): CreateApprovalResponse {
    return {
      approvalId: "22222222-2222-4222-8222-222222222222",
      magicLinkUrl:
        "http://localhost:5173/approve/22222222-2222-4222-8222-222222222222?token=" +
        "b".repeat(64),
      expiresAt: new Date("2024-01-01T00:05:00Z").toISOString(),
      traceId: "trace-auto",
      autoApproved: true,
      entry: {
        id: "entry-auto-1",
        visitorName: "Ada Lovelace",
        host: "Bola",
        unit: "4A",
        plate: null,
        reason: "",
        method: "auto",
        guardId: "guard-west-04",
        createdAt: new Date("2024-01-01T00:00:00Z").toISOString(),
        status: "logged",
        syncState: "synced",
      },
      matchedRule: {
        id: "rule-1",
        visitorName: "Ada Lovelace",
        host: "Bola",
        unit: "4A",
      },
      ...overrides,
    };
  }

  it("dispatches APPROVAL_AUTO_APPROVED on autoApproved=true, lands directly in 'confirmed'", async () => {
    approvalApi.createApproval.mockResolvedValue(
      ok(autoApprovedResponse(), 201)
    );
    const hook = buildControllerWithApproval(api, approvalApi);
    await fillValidDraft(hook);

    await act(async () => {
      await hook.result.current.requestApproval();
    });

    const s = hook.result.current.state;
    expect(s.mode).toBe("confirmed");
    expect(s.pendingApproval).toBeUndefined();
    expect(s.lastEntry?.id).toBe("entry-auto-1");
    expect(s.lastEntry?.method).toBe("auto");
    expect(s.entries[0].id).toBe("entry-auto-1");
    expect(s.banner.tone).toBe("success");
    expect(s.banner.message).toContain("Auto-approved");
    expect(s.audit[0]).toContain("auto_approval_matched");
  });

  it("does NOT start the polling stream when auto-approved (no pending row exists)", async () => {
    approvalApi.createApproval.mockResolvedValue(
      ok(autoApprovedResponse(), 201)
    );
    const hook = buildControllerWithApproval(api, approvalApi);
    await fillValidDraft(hook);

    await act(async () => {
      await hook.result.current.requestApproval();
    });

    // No status poll should be triggered — mode is 'confirmed', not 'awaiting-approval'.
    await new Promise((r) => setTimeout(r, 30));
    expect(approvalApi.getApprovalStatus).not.toHaveBeenCalled();
  });

  it("falls back to APPROVAL_REQUEST_FAILED when autoApproved=true but entry is missing", async () => {
    // Source: spec §5 trustless contract — a malformed autoApproved=true
    // payload must NEVER silently land in 'confirmed' on this device.
    approvalApi.createApproval.mockResolvedValue(
      ok(
        autoApprovedResponse({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          entry: null as any,
        }),
        201
      )
    );
    const hook = buildControllerWithApproval(api, approvalApi);
    await fillValidDraft(hook);

    await act(async () => {
      await hook.result.current.requestApproval();
    });

    const s = hook.result.current.state;
    expect(s.mode).toBe("error");
    expect(s.lastError?.code).toBe("AUTO_APPROVAL_MALFORMED");
    expect(s.entries).toHaveLength(0);
  });

  it("falls back to APPROVAL_REQUEST_FAILED when autoApproved=true but matchedRule is missing", async () => {
    approvalApi.createApproval.mockResolvedValue(
      ok(
        autoApprovedResponse({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          matchedRule: null as any,
        }),
        201
      )
    );
    const hook = buildControllerWithApproval(api, approvalApi);
    await fillValidDraft(hook);

    await act(async () => {
      await hook.result.current.requestApproval();
    });

    const s = hook.result.current.state;
    expect(s.mode).toBe("error");
    expect(s.lastError?.code).toBe("AUTO_APPROVAL_MALFORMED");
  });

  it("falls back to APPROVAL_REQUEST_FAILED when autoApproved=true but entry.method !== 'auto'", async () => {
    // A server returning method='walk-in' with autoApproved=true is a
    // serious bug — the controller refuses to log it on the device.
    approvalApi.createApproval.mockResolvedValue(
      ok(
        autoApprovedResponse({
          entry: {
            ...autoApprovedResponse().entry!,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            method: "walk-in" as any,
          },
        }),
        201
      )
    );
    const hook = buildControllerWithApproval(api, approvalApi);
    await fillValidDraft(hook);

    await act(async () => {
      await hook.result.current.requestApproval();
    });

    const s = hook.result.current.state;
    expect(s.mode).toBe("error");
    expect(s.lastError?.code).toBe("AUTO_APPROVAL_MALFORMED");
  });

  it("autoApproved=false (or absent) still follows the manual pending-approval flow", async () => {
    // Manual flow must remain UNCHANGED — backward compatibility.
    approvalApi.createApproval.mockResolvedValue(
      ok(
        // No autoApproved key at all
        {
          approvalId: "11111111-1111-4111-8111-111111111111",
          magicLinkUrl:
            "http://localhost:5173/approve/11111111-1111-4111-8111-111111111111?token=" +
            "a".repeat(64),
          expiresAt: new Date("2024-01-01T00:05:00Z").toISOString(),
          traceId: "trace-manual",
        },
        201
      )
    );
    // Once we enter 'awaiting-approval', the poll effect calls
    // getApprovalStatus on a timer. Return a stable pending view so
    // the loop is a no-op (no terminal transition) during this test.
    approvalApi.getApprovalStatus.mockResolvedValue(
      ok(
        {
          approval: approvalView({ status: "pending" }),
          traceId: "trace-poll",
        },
        200
      )
    );
    const hook = buildControllerWithApproval(api, approvalApi);
    await fillValidDraft(hook);

    await act(async () => {
      await hook.result.current.requestApproval();
    });

    const s = hook.result.current.state;
    expect(s.mode).toBe("awaiting-approval");
    expect(s.pendingApproval?.id).toBe(
      "11111111-1111-4111-8111-111111111111"
    );
    expect(s.entries).toHaveLength(0);
  });
});

describe("useGatePassController approval polling", () => {
  let api: MockApi;
  let approvalApi: MockApprovalApi;

  beforeEach(() => {
    api = makeApi();
    approvalApi = makeApprovalApi();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("polls /status while pending and dispatches APPROVAL_RESOLVED on approve+entry", async () => {
    approvalApi.createApproval.mockResolvedValue(ok(CREATE_APPROVAL_OK, 201));
    // First poll: still pending. Second poll: approved with entryId.
    approvalApi.getApprovalStatus
      .mockResolvedValueOnce(
        ok({ approval: approvalView(), traceId: "t1" } as ApprovalStatusResponse)
      )
      .mockResolvedValue(
        ok({
          approval: approvalView({
            status: "approved",
            decidedAt: new Date("2024-01-01T00:01:00Z").toISOString(),
            entryId: "entry-from-approval",
          }),
          traceId: "t2",
        } as ApprovalStatusResponse)
      );

    const hook = buildControllerWithApproval(api, approvalApi);
    await fillValidDraft(hook);
    await act(async () => {
      await hook.result.current.requestApproval();
    });

    // Wait for the resolved state — happens once the polling effect
    // observes the approved status. With a 10ms interval and immediate
    // first poll, this resolves quickly.
    await waitFor(() => {
      expect(hook.result.current.state.mode).toBe("confirmed");
    }, { timeout: 1000 });
    expect(hook.result.current.state.lastEntry?.id).toBe("entry-from-approval");
    expect(hook.result.current.state.entries[0].id).toBe("entry-from-approval");
    expect(hook.result.current.state.pendingApproval).toBeUndefined();
  });

  it("dispatches APPROVAL_DENIED with the resident's reason on a denied status", async () => {
    approvalApi.createApproval.mockResolvedValue(ok(CREATE_APPROVAL_OK, 201));
    approvalApi.getApprovalStatus.mockResolvedValue(
      ok({
        approval: approvalView({
          status: "denied",
          decidedAt: new Date("2024-01-01T00:01:00Z").toISOString(),
          deniedReason: "Not expected today",
        }),
        traceId: "t",
      } as ApprovalStatusResponse)
    );

    const hook = buildControllerWithApproval(api, approvalApi);
    await fillValidDraft(hook);
    await act(async () => {
      await hook.result.current.requestApproval();
    });

    await waitFor(() => {
      expect(hook.result.current.state.lastError?.code).toBe("APPROVAL_DENIED");
    }, { timeout: 1000 });
    expect(hook.result.current.state.mode).toBe("error");
    expect(hook.result.current.state.banner.message).toContain(
      "Not expected today"
    );
    expect(hook.result.current.state.pendingApproval).toBeUndefined();
  });

  it("dispatches APPROVAL_EXPIRED when the server flips status to expired (lazy expiry)", async () => {
    approvalApi.createApproval.mockResolvedValue(ok(CREATE_APPROVAL_OK, 201));
    approvalApi.getApprovalStatus.mockResolvedValue(
      ok({
        approval: approvalView({ status: "expired" }),
        traceId: "t",
      } as ApprovalStatusResponse)
    );

    const hook = buildControllerWithApproval(api, approvalApi);
    await fillValidDraft(hook);
    await act(async () => {
      await hook.result.current.requestApproval();
    });

    await waitFor(() => {
      expect(hook.result.current.state.lastError?.code).toBe("APPROVAL_EXPIRED");
    }, { timeout: 1000 });
    expect(hook.result.current.state.mode).toBe("error");
    expect(hook.result.current.state.pendingApproval).toBeUndefined();
  });

  it("ignores transient network errors during polling (keeps polling, doesn't silently resolve)", async () => {
    approvalApi.createApproval.mockResolvedValue(ok(CREATE_APPROVAL_OK, 201));
    // First poll: network error (status=0). Subsequent polls: still
    // pending. The controller must not enter error/confirmed.
    approvalApi.getApprovalStatus
      .mockResolvedValueOnce({
        ok: false,
        status: 0,
        error: {
          code: "NETWORK_ERROR",
          message: "offline",
          traceId: "t-net",
        },
      } as ApiResult<ApprovalStatusResponse>)
      .mockResolvedValue(
        ok({ approval: approvalView(), traceId: "t-pending" } as ApprovalStatusResponse)
      );

    const hook = buildControllerWithApproval(api, approvalApi);
    await fillValidDraft(hook);
    await act(async () => {
      await hook.result.current.requestApproval();
    });

    // Should remain in awaiting-approval after the transient blip.
    await waitFor(() => {
      expect(approvalApi.getApprovalStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
    }, { timeout: 1000 });
    expect(hook.result.current.state.mode).toBe("awaiting-approval");
    expect(hook.result.current.state.pendingApproval).toBeDefined();
  });

  it("surfaces non-transient poll errors as APPROVAL_REQUEST_FAILED", async () => {
    approvalApi.createApproval.mockResolvedValue(ok(CREATE_APPROVAL_OK, 201));
    approvalApi.getApprovalStatus.mockResolvedValue(
      fail(500, "INTERNAL_ERROR", "Database unavailable")
    );

    const hook = buildControllerWithApproval(api, approvalApi);
    await fillValidDraft(hook);
    await act(async () => {
      await hook.result.current.requestApproval();
    });

    await waitFor(() => {
      expect(hook.result.current.state.mode).toBe("error");
    }, { timeout: 1000 });
    expect(hook.result.current.state.lastError?.code).toBe("INTERNAL_ERROR");
    expect(hook.result.current.state.pendingApproval).toBeUndefined();
  });
});

// ─── Notifications (Feature 2) ─────────────────────────────────────────
// Source: src/docs/specs/notifications.md §5 (two-stream policy), §7
// (HTTP surface), §9 (reducer state machine).

interface MockNotificationsApi {
  getNotifications: ReturnType<typeof vi.fn>;
  retryNotification: ReturnType<typeof vi.fn>;
}

function makeNotificationsApi(): MockNotificationsApi {
  return {
    getNotifications: vi.fn(),
    retryNotification: vi.fn(),
  };
}

function buildControllerWithNotifications(
  api: MockApi,
  approvalApi: MockApprovalApi,
  notificationsApi: MockNotificationsApi,
  approvalPollIntervalMs = 10,
  notificationsPollIntervalMs = 10,
) {
  let counter = 0;
  const generateId = () => {
    counter += 1;
    return `00000000-0000-4000-8000-${counter.toString().padStart(12, "0")}`;
  };
  return renderHook(() =>
    useGatePassController({
      api,
      approvalApi: approvalApi as unknown as typeof guardApprovalApi,
      notificationsApi:
        notificationsApi as unknown as typeof guardNotificationsApi,
      now: () => new Date("2024-01-01T00:00:00Z"),
      generateId,
      approvalPollIntervalMs,
      notificationsPollIntervalMs,
    }),
  );
}

function notificationView(
  overrides: Partial<NotificationView> = {},
): NotificationView {
  return {
    id: "nnnnnnnn-nnnn-4nnn-8nnn-nnnnnnnnnnnn",
    approvalId: "11111111-1111-4111-8111-111111111111",
    channel: "whatsapp",
    status: "queued",
    attempts: 0,
    targetPhone: "+15551230001",
    templateKey: "approval.magic_link",
    lastErrorCode: null,
    lastProviderResponseCode: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    deliveredAt: null,
    failedAt: null,
    ...overrides,
  };
}

describe("useGatePassController.requestApproval — hostPhoneE164 plumbing", () => {
  let api: MockApi;
  let approvalApi: MockApprovalApi;
  let notificationsApi: MockNotificationsApi;

  beforeEach(() => {
    api = makeApi();
    approvalApi = makeApprovalApi();
    notificationsApi = makeNotificationsApi();
    notificationsApi.getNotifications.mockResolvedValue(
      ok({
        notifications: [],
        traceId: "trace-n",
      } as NotificationsListResponse),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards a valid E.164 phone to createApproval", async () => {
    approvalApi.createApproval.mockResolvedValue(ok(CREATE_APPROVAL_OK, 201));
    approvalApi.getApprovalStatus.mockResolvedValue(
      ok({ approval: approvalView(), traceId: "t" } as ApprovalStatusResponse),
    );
    const hook = buildControllerWithNotifications(
      api,
      approvalApi,
      notificationsApi,
    );
    await fillValidDraft(hook);
    await act(async () => {
      await hook.result.current.requestApproval("+15551230001");
    });
    expect(approvalApi.createApproval).toHaveBeenCalledTimes(1);
    const payload = approvalApi.createApproval.mock.calls[0][0];
    expect(payload.hostPhoneE164).toBe("+15551230001");
  });

  it("omits hostPhoneE164 when not provided (backward-compat)", async () => {
    approvalApi.createApproval.mockResolvedValue(ok(CREATE_APPROVAL_OK, 201));
    approvalApi.getApprovalStatus.mockResolvedValue(
      ok({ approval: approvalView(), traceId: "t" } as ApprovalStatusResponse),
    );
    const hook = buildControllerWithNotifications(
      api,
      approvalApi,
      notificationsApi,
    );
    await fillValidDraft(hook);
    await act(async () => {
      await hook.result.current.requestApproval();
    });
    const payload = approvalApi.createApproval.mock.calls[0][0];
    expect("hostPhoneE164" in payload).toBe(false);
  });

  it("rejects a non-E.164 phone client-side without calling the API", async () => {
    const hook = buildControllerWithNotifications(
      api,
      approvalApi,
      notificationsApi,
    );
    await fillValidDraft(hook);
    await act(async () => {
      await hook.result.current.requestApproval("555-123-0001");
    });
    expect(approvalApi.createApproval).not.toHaveBeenCalled();
    expect(hook.result.current.state.lastError?.code).toBe(
      "HOST_PHONE_INVALID",
    );
    expect(hook.result.current.state.lastError?.field).toBe("hostPhoneE164");
  });
});

describe("useGatePassController.notifications — polling stream", () => {
  let api: MockApi;
  let approvalApi: MockApprovalApi;
  let notificationsApi: MockNotificationsApi;

  beforeEach(() => {
    api = makeApi();
    approvalApi = makeApprovalApi();
    notificationsApi = makeNotificationsApi();
    approvalApi.createApproval.mockResolvedValue(ok(CREATE_APPROVAL_OK, 201));
    approvalApi.getApprovalStatus.mockResolvedValue(
      ok({ approval: approvalView(), traceId: "t" } as ApprovalStatusResponse),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("polls /notifications once the approval is awaiting decision and dispatches NOTIFICATIONS_LOADED", async () => {
    const view = notificationView({ id: "n-1", status: "queued" });
    notificationsApi.getNotifications.mockResolvedValue(
      ok({
        notifications: [view],
        traceId: "trace-n",
      } as NotificationsListResponse),
    );

    const hook = buildControllerWithNotifications(
      api,
      approvalApi,
      notificationsApi,
    );
    await fillValidDraft(hook);
    await act(async () => {
      await hook.result.current.requestApproval("+15551230001");
    });

    await waitFor(() => {
      expect(notificationsApi.getNotifications).toHaveBeenCalled();
    });

    await waitFor(() => {
      const rows =
        hook.result.current.state.notifications.byApprovalId[
          CREATE_APPROVAL_OK.approvalId
        ];
      expect(rows).toBeDefined();
      expect(rows).toHaveLength(1);
      expect(rows![0].id).toBe("n-1");
    });
  });

  it("non-transient list failure surfaces NOTIFICATIONS_FAILED without touching pendingApproval", async () => {
    notificationsApi.getNotifications.mockResolvedValue(
      fail(500, "INTERNAL_ERROR", "boom"),
    );

    const hook = buildControllerWithNotifications(
      api,
      approvalApi,
      notificationsApi,
    );
    await fillValidDraft(hook);
    await act(async () => {
      await hook.result.current.requestApproval("+15551230001");
    });

    await waitFor(() => {
      expect(
        hook.result.current.state.notifications.lastError?.code,
      ).toBe("INTERNAL_ERROR");
    });
    // The approval status stream must NOT be affected by a notifications
    // failure — pendingApproval still exists, mode still awaiting.
    expect(hook.result.current.state.mode).toBe("awaiting-approval");
    expect(hook.result.current.state.pendingApproval?.id).toBe(
      CREATE_APPROVAL_OK.approvalId,
    );
  });

  it("transient transport blip (status=0) does NOT dispatch NOTIFICATIONS_FAILED", async () => {
    notificationsApi.getNotifications.mockResolvedValue(
      fail(0, "NETWORK_ERROR", "offline"),
    );

    const hook = buildControllerWithNotifications(
      api,
      approvalApi,
      notificationsApi,
    );
    await fillValidDraft(hook);
    await act(async () => {
      await hook.result.current.requestApproval("+15551230001");
    });

    await waitFor(() => {
      expect(notificationsApi.getNotifications).toHaveBeenCalled();
    });
    // The loading flag was set by the LOADING dispatch on each tick, but
    // no FAILED dispatch means lastError stays undefined.
    expect(
      hook.result.current.state.notifications.lastError,
    ).toBeUndefined();
  });

  it("retryNotification dispatches START → SUCCEEDED on a 202 response", async () => {
    const initial = notificationView({ id: "n-1", attempts: 1, status: "failed" });
    notificationsApi.getNotifications.mockResolvedValue(
      ok({
        notifications: [initial],
        traceId: "t",
      } as NotificationsListResponse),
    );
    const after = notificationView({ id: "n-1", attempts: 2, status: "queued" });
    notificationsApi.retryNotification.mockResolvedValue(
      ok({
        notification: after,
        traceId: "trace-retry",
      } as NotificationRetryResponse, 202),
    );

    const hook = buildControllerWithNotifications(
      api,
      approvalApi,
      notificationsApi,
    );
    await fillValidDraft(hook);
    await act(async () => {
      await hook.result.current.requestApproval("+15551230001");
    });
    await waitFor(() => {
      expect(
        hook.result.current.state.notifications.byApprovalId[
          CREATE_APPROVAL_OK.approvalId
        ],
      ).toHaveLength(1);
    });

    await act(async () => {
      await hook.result.current.retryNotification("n-1");
    });

    const row =
      hook.result.current.state.notifications.byApprovalId[
        CREATE_APPROVAL_OK.approvalId
      ]![0];
    expect(row.attempts).toBe(2);
    expect(row.retryInFlight).toBeUndefined();
    expect(notificationsApi.retryNotification).toHaveBeenCalledWith(
      "n-1",
    );
    // Slice 8: the controller stamps a cooldown using its injected
    // clock so the UI can disable Resend for ~30s. The fixture clock
    // returns 2024-01-01T00:00:00Z, so cooldown = +30_000ms.
    expect(row.retryCooldownUntilMs).toBe(
      new Date("2024-01-01T00:00:00Z").getTime() + 30_000,
    );
  });

  it("retryNotification records retryError on the row when the server refuses", async () => {
    const initial = notificationView({ id: "n-1", attempts: 1, status: "failed" });
    notificationsApi.getNotifications.mockResolvedValue(
      ok({
        notifications: [initial],
        traceId: "t",
      } as NotificationsListResponse),
    );
    notificationsApi.retryNotification.mockResolvedValue(
      fail(429, "RETRY_RATE_LIMITED", "Wait a moment"),
    );

    const hook = buildControllerWithNotifications(
      api,
      approvalApi,
      notificationsApi,
    );
    await fillValidDraft(hook);
    await act(async () => {
      await hook.result.current.requestApproval("+15551230001");
    });
    await waitFor(() => {
      expect(
        hook.result.current.state.notifications.byApprovalId[
          CREATE_APPROVAL_OK.approvalId
        ],
      ).toHaveLength(1);
    });

    await act(async () => {
      await hook.result.current.retryNotification("n-1");
    });

    const row =
      hook.result.current.state.notifications.byApprovalId[
        CREATE_APPROVAL_OK.approvalId
      ]![0];
    expect(row.retryError?.code).toBe("RETRY_RATE_LIMITED");
    expect(row.retryInFlight).toBe(false);
  });

  it("stops polling notifications once the approval reaches a terminal state", async () => {
    const view = notificationView({ id: "n-1", status: "queued" });
    notificationsApi.getNotifications.mockResolvedValue(
      ok({
        notifications: [view],
        traceId: "trace-n",
      } as NotificationsListResponse),
    );

    const hook = buildControllerWithNotifications(
      api,
      approvalApi,
      notificationsApi,
    );
    await fillValidDraft(hook);
    await act(async () => {
      await hook.result.current.requestApproval("+15551230001");
    });
    await waitFor(() => {
      expect(notificationsApi.getNotifications).toHaveBeenCalled();
    });

    // Server now flips approval to denied — APPROVAL_DENIED clears the
    // pendingApproval, which deactivates this effect.
    approvalApi.getApprovalStatus.mockResolvedValue(
      ok({
        approval: approvalView({
          status: "denied",
          deniedReason: "Not now",
        }),
        traceId: "t",
      } as ApprovalStatusResponse),
    );

    await waitFor(() => {
      expect(hook.result.current.state.mode).toBe("error");
    });
    const callsAtDenial = notificationsApi.getNotifications.mock.calls.length;
    // Wait a few polling intervals — no new notification calls should land
    // after the approval is denied.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(notificationsApi.getNotifications.mock.calls.length).toBe(
      callsAtDenial,
    );
    // And the notifications slice for this approval has been dropped.
    expect(
      hook.result.current.state.notifications.byApprovalId[
        CREATE_APPROVAL_OK.approvalId
      ],
    ).toBeUndefined();
  });
});

// ─── Slice 8: phone sanitization + cooldown plumbing ────────────────
// Source: spec notifications.md §6 (retry rate-limit) + §7.1
// (hostPhoneE164 wire) + §11 (resident-facing hints, "guards type
// what they see in their phone's contact list").

describe("sanitizePhoneInput", () => {
  it("strips spaces, hyphens, parens, and dots from common human formats", () => {
    expect(sanitizePhoneInput("+1 (555) 123-0001")).toBe("+15551230001");
    expect(sanitizePhoneInput("+1.555.123.0001")).toBe("+15551230001");
    expect(sanitizePhoneInput("+1-555-123-0001")).toBe("+15551230001");
    expect(sanitizePhoneInput("  +15551230001  ")).toBe("+15551230001");
  });

  it("does NOT add digits or a leading '+'", () => {
    // The downstream regex requires "+<country>...". Sanitizer leaves
    // a missing "+" alone so the validator rejects it instead of the
    // sanitizer silently mangling a typo into a passing-looking value.
    expect(sanitizePhoneInput("15551230001")).toBe("15551230001");
    expect(sanitizePhoneInput("(555) 123-0001")).toBe("5551230001");
  });

  it("leaves an empty string and a single '+' alone", () => {
    expect(sanitizePhoneInput("")).toBe("");
    expect(sanitizePhoneInput("+")).toBe("+");
  });
});

describe("useGatePassController.requestApproval — slice 8 sanitization", () => {
  let api: MockApi;
  let approvalApi: MockApprovalApi;
  let notificationsApi: MockNotificationsApi;
  beforeEach(() => {
    api = makeApi();
    approvalApi = makeApprovalApi();
    notificationsApi = makeNotificationsApi();
    approvalApi.createApproval.mockResolvedValue(
      ok(CREATE_APPROVAL_OK, 201),
    );
    // The polling effect starts as soon as the controller enters
    // awaiting-approval. Without a default resolved value, the
    // setInterval callback would throw on `result.ok`. Pin both
    // streams to safe defaults so the slice-8 sanitization tests
    // can focus on createApproval payload assertions.
    approvalApi.getApprovalStatus.mockResolvedValue(
      ok({
        approval: {
          id: CREATE_APPROVAL_OK.approvalId,
          offlineId: "00000000-0000-4000-8000-000000000001",
          visitorName: "Ada",
          host: "Bola",
          unit: "4A",
          plate: null,
          reason: "",
          method: "walk-in" as const,
          requestedByGuardId: "guard-west-04",
          status: "pending" as const,
          expiresAt: "2024-01-01T00:05:00.000Z",
          decidedAt: null,
          deniedReason: null,
          entryId: null,
          traceId: "t",
        },
        traceId: "t",
      } as ApprovalStatusResponse),
    );
    notificationsApi.getNotifications.mockResolvedValue(
      ok({ notifications: [], traceId: "t" } as NotificationsListResponse),
    );
  });

  it("accepts a phone with spaces and parens by sanitizing before validation", async () => {
    const hook = buildControllerWithNotifications(
      api,
      approvalApi,
      notificationsApi,
    );
    await fillValidDraft(hook);
    await act(async () => {
      await hook.result.current.requestApproval("+1 (555) 123-0001");
    });
    expect(approvalApi.createApproval).toHaveBeenCalledTimes(1);
    const payload = approvalApi.createApproval.mock.calls[0][0];
    // Sanitization happens client-side BEFORE the wire — server never
    // sees the human-readable form.
    expect(payload.hostPhoneE164).toBe("+15551230001");
  });

  it("still rejects a value that is invalid AFTER sanitization (no silent rewrite)", async () => {
    const hook = buildControllerWithNotifications(
      api,
      approvalApi,
      notificationsApi,
    );
    await fillValidDraft(hook);
    await act(async () => {
      // Missing the leading "+" — sanitizer doesn't add one. The
      // regex rejects the result.
      await hook.result.current.requestApproval("(555) 123-0001");
    });
    expect(approvalApi.createApproval).not.toHaveBeenCalled();
    expect(hook.result.current.state.lastError?.code).toBe(
      "HOST_PHONE_INVALID",
    );
  });
});
