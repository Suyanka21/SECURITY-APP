/**
 * pendingSync durability.
 *
 * The offline queue used to live only in reducer state. Anything that unmounted
 * the guard console — a session expiring, a failed /api/auth/me on wake, a
 * reload — destroyed every queued walk-in with no signal to anyone, even though
 * those visitors may already be inside the estate. These tests pin the two
 * loss paths the audit identified and prove the queue comes back, announced,
 * for the same guard only.
 */

import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useGatePassController } from "../useGatePassController";
import {
  PENDING_SYNC_STORAGE_KEY,
  readPendingSync,
} from "../pendingSyncStore";
import type { GatePassApi } from "@/lib/api/gatepass";
import type { ApiResult, SyncBatchResponse } from "@/lib/api/types";
import { AuthProvider, useAuth } from "@/features/auth/AuthContext";
import type { AuthMe } from "@/lib/api/me";

// ---- auth mocks (session-expiry path) -------------------------------------

const { meMock, sessionUserId } = vi.hoisted(() => ({
  meMock: vi.fn(),
  sessionUserId: { current: null as string | null },
}));

vi.mock("@/lib/api/me", () => ({
  authApi: { me: () => meMock() },
}));

vi.mock("@/lib/api/auth", () => ({
  setAuthToken: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  isSupabaseConfigured: () => true,
  getSupabaseClient: () => ({
    auth: {
      getSession: async () => ({
        data: {
          session: sessionUserId.current
            ? { access_token: "token", user: { id: sessionUserId.current } }
            : null,
        },
      }),
      onAuthStateChange: () => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      }),
      signOut: async () => ({ error: null }),
    },
  }),
}));

const USER = "9f2c1f8e-0000-4000-8000-000000000001";

const GUARD_ME: AuthMe = {
  guardId: "11111111-1111-4111-8111-111111111111",
  role: "guard",
  name: "N. Adeyemi",
  badgeNumber: "G-001",
  isActive: true,
  traceId: "trace-me",
};

const IDENTITY = {
  guardId: GUARD_ME.guardId,
  name: GUARD_ME.name,
  badgeNumber: GUARD_ME.badgeNumber,
  role: GUARD_ME.role,
};

const OTHER_GUARD = {
  guardId: "22222222-2222-4222-8222-222222222222",
  name: "K. Mensah",
  badgeNumber: "G-002",
  role: "guard",
};

// ---- api mocks ------------------------------------------------------------

interface MockApi extends GatePassApi {
  submitEntry: ReturnType<typeof vi.fn>;
  validateQr: ReturnType<typeof vi.fn>;
  validatePin: ReturnType<typeof vi.fn>;
  syncEntries: ReturnType<typeof vi.fn>;
  searchVisitors: ReturnType<typeof vi.fn>;
}

function makeApi(): MockApi {
  return {
    submitEntry: vi.fn(),
    validateQr: vi.fn(),
    validatePin: vi.fn(),
    syncEntries: vi.fn(),
    searchVisitors: vi.fn(),
  } as unknown as MockApi;
}

function fail(status: number, code: string): ApiResult<never> {
  return { ok: false, status, error: { code, message: code } };
}

function buildController(api: MockApi, identity = IDENTITY) {
  let counter = 0;
  const generateId = () => {
    counter += 1;
    return `00000000-0000-4000-8000-${counter.toString().padStart(12, "0")}`;
  };
  return renderHook(() =>
    useGatePassController({
      identity,
      api,
      now: () => new Date("2024-01-01T00:00:00Z"),
      generateId,
    }),
  );
}

type Hook = ReturnType<typeof buildController>;

async function queueOfflineWalkIn(hook: Hook, visitorName = "Ada Lovelace") {
  await act(async () => {
    hook.result.current.setNetwork("offline");
  });
  await act(async () => {
    hook.result.current.dispatch({ type: "NAVIGATE", mode: "walkin" });
    hook.result.current.dispatch({
      type: "UPDATE_DRAFT",
      field: "visitorName",
      value: visitorName,
    });
    hook.result.current.dispatch({
      type: "UPDATE_DRAFT",
      field: "host",
      value: "Bola",
    });
    hook.result.current.dispatch({
      type: "UPDATE_DRAFT",
      field: "unit",
      value: "4A",
    });
  });
  await act(async () => {
    await hook.result.current.submitEntry();
  });
  expect(hook.result.current.state.pendingSync).toHaveLength(1);
  return hook.result.current.state.pendingSync[0];
}

describe("pendingSync durability", () => {
  beforeEach(() => {
    window.localStorage.clear();
    meMock.mockReset();
    sessionUserId.current = USER;
  });

  afterEach(async () => {
    await act(async () => {});
  });

  it("persists an offline walk-in to local storage the moment it is queued", async () => {
    const api = makeApi();
    const hook = buildController(api);
    const queued = await queueOfflineWalkIn(hook);

    const stored = readPendingSync(IDENTITY.guardId);
    expect(stored).toHaveLength(1);
    expect(stored[0].offlineId).toBe(queued.offlineId);
    expect(stored[0].visitorName).toBe("Ada Lovelace");
    expect(stored[0].syncState).toBe("queued");
  });

  it("survives the exact unmount path: console unmounts with a queued entry, remounts, entry is restored and announced", async () => {
    const api = makeApi();
    const first = buildController(api);
    const queued = await queueOfflineWalkIn(first);

    // The console is torn down (Index swapped to LoginScreen, a reload, …).
    first.unmount();

    // Before the fix the entry was gone here. Storage still has it:
    expect(window.localStorage.getItem(PENDING_SYNC_STORAGE_KEY)).not.toBeNull();

    const second = buildController(api);
    await waitFor(() => {
      expect(second.result.current.state.pendingSync).toHaveLength(1);
    });
    const restored = second.result.current.state.pendingSync[0];
    expect(restored.offlineId).toBe(queued.offlineId);
    expect(restored.visitorName).toBe("Ada Lovelace");
    expect(restored.guardId).toBe(IDENTITY.guardId);

    // The visitor is also back in the visible entries list.
    expect(
      second.result.current.state.entries.some(
        (e) => e.offlineId === queued.offlineId,
      ),
    ).toBe(true);

    // Never silent: the guard is told and the audit records it.
    expect(second.result.current.state.banner?.tone).toBe("warning");
    expect(second.result.current.state.banner?.message).toMatch(
      /1 offline entry is still waiting to sync from an earlier session/,
    );
    expect(second.result.current.state.audit[0]).toMatch(
      /restored 1 unsynced entry/,
    );
  });

  it("does not hand one guard's queue to a different guard", async () => {
    const api = makeApi();
    const first = buildController(api);
    await queueOfflineWalkIn(first);
    first.unmount();

    const other = buildController(api, OTHER_GUARD);
    await act(async () => {});
    expect(other.result.current.state.pendingSync).toHaveLength(0);
    expect(other.result.current.state.banner?.tone).not.toBe("warning");

    // The original guard's queue is untouched by the other guard's session.
    other.unmount();
    expect(readPendingSync(IDENTITY.guardId)).toHaveLength(1);
  });

  it("keeps the queue in storage when sync fails, and clears it only after a successful sync", async () => {
    const api = makeApi();
    api.syncEntries.mockResolvedValueOnce(fail(500, "INTERNAL_ERROR"));
    const hook = buildController(api);
    const queued = await queueOfflineWalkIn(hook);

    await act(async () => {
      hook.result.current.setNetwork("online");
    });
    await waitFor(() => {
      expect(hook.result.current.state.lastError?.code).toBe("INTERNAL_ERROR");
    });
    expect(hook.result.current.state.pendingSync).toHaveLength(1);
    expect(readPendingSync(IDENTITY.guardId)).toHaveLength(1);

    const synced: ApiResult<SyncBatchResponse> = {
      ok: true,
      status: 200,
      data: {
        results: [
          { offlineId: queued.offlineId!, serverId: "server-A", status: "synced" },
        ],
        syncedCount: 1,
        duplicateCount: 0,
        rejectedCount: 1,
        traceId: "trace-sync",
      } as unknown as SyncBatchResponse,
    };
    api.syncEntries.mockResolvedValueOnce(synced);
    await act(async () => {
      await hook.result.current.syncPending();
    });

    expect(hook.result.current.state.pendingSync).toHaveLength(0);
    expect(readPendingSync(IDENTITY.guardId)).toHaveLength(0);
    expect(window.localStorage.getItem(PENDING_SYNC_STORAGE_KEY)).toBeNull();
  });

  it("does not restore an entry that a later mount has already synced", async () => {
    const api = makeApi();
    const first = buildController(api);
    const queued = await queueOfflineWalkIn(first);
    first.unmount();

    const second = buildController(api);
    await waitFor(() => {
      expect(second.result.current.state.pendingSync).toHaveLength(1);
    });
    api.syncEntries.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        results: [
          { offlineId: queued.offlineId!, serverId: "server-A", status: "synced" },
        ],
        syncedCount: 1,
        duplicateCount: 0,
        rejectedCount: 0,
        traceId: "trace-sync",
      } as unknown as SyncBatchResponse,
    });
    await act(async () => {
      await second.result.current.syncPending();
    });
    expect(second.result.current.state.pendingSync).toHaveLength(0);
    second.unmount();

    const third = buildController(api);
    await act(async () => {});
    expect(third.result.current.state.pendingSync).toHaveLength(0);
    expect(third.result.current.state.banner?.tone).not.toBe("warning");
  });
});

// ---- unrelated loss-of-session path: natural session expiry ---------------

function ConsoleProbe({ api }: { api: MockApi }) {
  const { me } = useAuth();
  const identity = me
    ? {
        guardId: me.guardId,
        name: me.name,
        badgeNumber: me.badgeNumber,
        role: me.role,
      }
    : undefined;
  const controller = useGatePassController({
    identity,
    api,
    now: () => new Date("2024-01-01T00:00:00Z"),
  });
  const { state, dispatch } = controller;
  return (
    <div>
      <span data-testid="pending">{state.pendingSync.length}</span>
      <span data-testid="banner">{state.banner?.message ?? "-"}</span>
      <button
        onClick={() => {
          controller.setNetwork("offline");
          dispatch({ type: "NAVIGATE", mode: "walkin" });
          dispatch({ type: "UPDATE_DRAFT", field: "visitorName", value: "Ada Lovelace" });
          dispatch({ type: "UPDATE_DRAFT", field: "host", value: "Bola" });
          dispatch({ type: "UPDATE_DRAFT", field: "unit", value: "4A" });
        }}
      >
        prepare
      </button>
      <button onClick={() => void controller.submitEntry()}>submit</button>
    </div>
  );
}

/** Mirrors Index.tsx gating: the console mounts only while authenticated as a guard. */
function Gate({ api }: { api: MockApi }) {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="status">{auth.status}</span>
      <button onClick={() => void auth.refresh()}>refresh</button>
      {auth.status === "authenticated" && auth.role === "guard" ? (
        <ConsoleProbe api={api} />
      ) : (
        <span data-testid="login">login</span>
      )}
    </div>
  );
}

describe("pendingSync durability across natural session expiry", () => {
  beforeEach(() => {
    window.localStorage.clear();
    meMock.mockReset();
    sessionUserId.current = USER;
  });

  afterEach(async () => {
    await act(async () => {});
  });

  it("queued entries survive the session expiring (401 → login) and reappear once the guard signs back in", async () => {
    const api = makeApi();
    meMock.mockResolvedValue({ ok: true, status: 200, data: GUARD_ME });
    render(
      <AuthProvider>
        <Gate api={api} />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("authenticated"),
    );

    await act(async () => {
      screen.getByText("prepare").click();
    });
    await act(async () => {
      screen.getByText("submit").click();
    });
    await waitFor(() =>
      expect(screen.getByTestId("pending")).toHaveTextContent("1"),
    );

    // Mid-shift the session expires for real: the server answers 401.
    meMock.mockResolvedValue(fail(401, "AUTH_UNAUTHENTICATED"));
    await act(async () => {
      screen.getByText("refresh").click();
    });
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("unauthenticated"),
    );
    // Console is gone…
    expect(screen.queryByTestId("pending")).toBeNull();
    // …but the visitor record is not.
    expect(readPendingSync(GUARD_ME.guardId)).toHaveLength(1);

    // The guard signs back in.
    meMock.mockResolvedValue({ ok: true, status: 200, data: GUARD_ME });
    await act(async () => {
      screen.getByText("refresh").click();
    });
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("authenticated"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("pending")).toHaveTextContent("1"),
    );
    expect(screen.getByTestId("banner")).toHaveTextContent(
      /still waiting to sync from an earlier session/,
    );
  });
});
