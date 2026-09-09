/**
 * PR E — dev-only affordances.
 *
 * "Simulate offline/online" and "Camera failed" fake a state a real guard
 * must never confuse with reality. In a dev build they must be unmissably
 * marked; in a production build they must not exist at all. The real
 * offline path is driven by the browser's connectivity events instead.
 */
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatePassApi } from "@/lib/api/gatepass";

const { AUTH } = vi.hoisted(() => ({
  AUTH: {
    status: "authenticated" as const,
    role: "guard" as const,
    me: {
      guardId: "11111111-1111-4111-8111-111111111111",
      role: "guard" as const,
      name: "N. Adeyemi",
      badgeNumber: "G-001",
      isActive: true,
      traceId: "trace-me",
    },
    identityVerified: true,
    loginAvailable: true,
    error: null,
    signIn: vi.fn(),
    signOut: vi.fn(),
    refresh: vi.fn(),
  },
}));

vi.mock("@/features/auth/AuthContext", () => ({
  useAuth: () => AUTH,
}));

function buildApi(overrides: Partial<GatePassApi> = {}): GatePassApi {
  const stub = vi.fn(async () => ({
    ok: false as const,
    status: 0,
    error: { code: "NETWORK_ERROR", message: "no api configured" },
  }));
  return {
    submitEntry: stub,
    validateQr: stub,
    validatePin: stub,
    syncEntries: stub,
    searchVisitors: stub,
    ...overrides,
  } as unknown as GatePassApi;
}

function setOnLine(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    get: () => value,
  });
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("../devTools");
  setOnLine(true);
  window.localStorage.clear();
});

describe("dev-only controls — development build", () => {
  it("marks both simulation controls with an unmissable DEV ONLY badge", async () => {
    const { GatePassApp } = await import("../GatePassApp");
    render(<GatePassApp controller={{ api: buildApi() }} />);

    const simulate = screen.getByRole("button", { name: /Simulate offline/i });
    expect(simulate).toHaveTextContent("DEV ONLY");
    expect(simulate).toHaveAttribute("data-testid", "dev-only-control");
    expect(simulate).toHaveAttribute(
      "title",
      expect.stringMatching(/Development-only control/i)
    );

    fireEvent.click(screen.getAllByRole("button", { name: /Scan QR/i })[0]);
    const camera = screen.getByRole("button", { name: /Camera failed/i });
    expect(camera).toHaveTextContent("DEV ONLY");
    expect(camera).toHaveAttribute("data-testid", "dev-only-control");
  });
});

describe("dev-only controls — production build", () => {
  it("ships neither control while keeping the real state UI intact", async () => {
    vi.doMock("../devTools", () => ({
      DEV_TOOLS_ENABLED: false,
      DEV_TOOLS_LABEL: "DEV ONLY",
    }));
    const { GatePassApp } = await import("../GatePassApp");
    render(<GatePassApp controller={{ api: buildApi() }} />);

    expect(
      screen.queryByRole("button", { name: /Simulate (offline|online)/i })
    ).toBeNull();
    expect(screen.queryByTestId("dev-only-control")).toBeNull();
    expect(screen.getByText("Gate station online")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: /Scan QR/i })[0]);
    expect(screen.queryByRole("button", { name: /Camera failed/i })).toBeNull();
    expect(screen.queryByTestId("dev-only-control")).toBeNull();
    expect(screen.getByRole("button", { name: /Validate QR/i })).toBeInTheDocument();
  });

  it("enters real offline mode from the browser's offline event and recovers on online", async () => {
    vi.doMock("../devTools", () => ({
      DEV_TOOLS_ENABLED: false,
      DEV_TOOLS_LABEL: "DEV ONLY",
    }));
    const { GatePassApp } = await import("../GatePassApp");
    render(<GatePassApp controller={{ api: buildApi() }} />);

    setOnLine(false);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByText("Offline guard mode")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/Offline mode active/i);

    setOnLine(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.getByText("Gate station online")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/Network restored/i);
  });
});

describe("useGatePassController — browser connectivity", () => {
  it("starts offline when the device reports no link at mount", async () => {
    setOnLine(false);
    const { useGatePassController } = await import("../useGatePassController");
    const hook = renderHook(() =>
      useGatePassController({
        identity: {
          guardId: "11111111-1111-4111-8111-111111111111",
          name: "N. Adeyemi",
          badgeNumber: "G-001",
          role: "guard",
        },
        api: buildApi(),
      })
    );
    expect(hook.result.current.state.network).toBe("offline");
  });

  it("queues a walk-in while the browser is offline and auto-syncs when it comes back", async () => {
    const syncEntries = vi.fn(async (input: { entries: { offlineId: string }[] }) => ({
      ok: true as const,
      status: 200,
      data: {
        results: input.entries.map((e) => ({
          offlineId: e.offlineId,
          status: "created",
          entry: {
            id: `srv-${e.offlineId}`,
            visitorName: "Ada Lovelace",
            host: "Bola",
            unit: "4A",
            plate: null,
            reason: "",
            method: "walk-in",
            guardId: "11111111-1111-4111-8111-111111111111",
            createdAt: new Date().toISOString(),
            status: "logged",
            syncState: "synced",
          },
        })),
        traceId: "trace-sync",
      },
    }));
    const submitEntry = vi.fn();
    const { useGatePassController } = await import("../useGatePassController");
    const hook = renderHook(() =>
      useGatePassController({
        identity: {
          guardId: "11111111-1111-4111-8111-111111111111",
          name: "N. Adeyemi",
          badgeNumber: "G-001",
          role: "guard",
        },
        api: buildApi({
          submitEntry,
          syncEntries: syncEntries as unknown as GatePassApi["syncEntries"],
        }),
      })
    );

    setOnLine(false);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    await act(async () => {
      hook.result.current.dispatch({ type: "NAVIGATE", mode: "walkin" });
      hook.result.current.dispatch({ type: "UPDATE_DRAFT", field: "visitorName", value: "Ada Lovelace" });
      hook.result.current.dispatch({ type: "UPDATE_DRAFT", field: "host", value: "Bola" });
      hook.result.current.dispatch({ type: "UPDATE_DRAFT", field: "unit", value: "4A" });
    });
    await act(async () => {
      await hook.result.current.submitEntry();
    });
    expect(submitEntry).not.toHaveBeenCalled();
    expect(hook.result.current.state.pendingSync).toHaveLength(1);

    setOnLine(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(syncEntries).toHaveBeenCalledTimes(1);
    expect(hook.result.current.state.pendingSync).toHaveLength(0);
  });

  it("still auto-syncs when the reconnect lands while another request is in flight", async () => {
    const syncEntries = vi.fn(async (input: { entries: { offlineId: string }[] }) => ({
      ok: true as const,
      status: 200,
      data: {
        results: input.entries.map((e) => ({
          offlineId: e.offlineId,
          status: "created",
          entry: {
            id: `srv-${e.offlineId}`,
            visitorName: "Ada Lovelace",
            host: "Bola",
            unit: "4A",
            plate: null,
            reason: "",
            method: "walk-in",
            guardId: "11111111-1111-4111-8111-111111111111",
            createdAt: new Date().toISOString(),
            status: "logged",
            syncState: "synced",
          },
        })),
        traceId: "trace-sync",
      },
    }));
    let settleScan: (() => void) | undefined;
    const validateQr = vi.fn(
      () =>
        new Promise((resolve) => {
          settleScan = () =>
            resolve({
              ok: false,
              status: 0,
              error: { code: "NETWORK_ERROR", message: "dropped" },
            });
        })
    );
    const { useGatePassController } = await import("../useGatePassController");
    const hook = renderHook(() =>
      useGatePassController({
        identity: {
          guardId: "11111111-1111-4111-8111-111111111111",
          name: "N. Adeyemi",
          badgeNumber: "G-001",
          role: "guard",
        },
        api: buildApi({
          syncEntries: syncEntries as unknown as GatePassApi["syncEntries"],
          validateQr: validateQr as unknown as GatePassApi["validateQr"],
        }),
      })
    );

    // Queue one entry through a transport failure while the browser still
    // reports online (a real link that cannot reach the backend).
    await act(async () => {
      hook.result.current.dispatch({ type: "NAVIGATE", mode: "walkin" });
      hook.result.current.dispatch({ type: "UPDATE_DRAFT", field: "visitorName", value: "Ada Lovelace" });
      hook.result.current.dispatch({ type: "UPDATE_DRAFT", field: "host", value: "Bola" });
      hook.result.current.dispatch({ type: "UPDATE_DRAFT", field: "unit", value: "4A" });
    });
    await act(async () => {
      await hook.result.current.submitEntry();
    });
    expect(hook.result.current.state.pendingSync).toHaveLength(1);
    expect(syncEntries).not.toHaveBeenCalled();

    // A scan goes in flight, then the link drops and comes back before the
    // scan settles.
    let scanPromise!: Promise<void>;
    act(() => {
      hook.result.current.dispatch({ type: "START_CAMERA" });
    });
    act(() => {
      scanPromise = hook.result.current.scanQr("qr-token-1");
    });
    expect(hook.result.current.state.inFlight).toBe(true);
    // Drop and restore the link while the scan is still pending.
    setOnLine(false);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    setOnLine(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(syncEntries).not.toHaveBeenCalled();

    await act(async () => {
      settleScan?.();
      await scanPromise;
    });
    expect(hook.result.current.state.inFlight).toBe(false);
    expect(syncEntries).toHaveBeenCalledTimes(1);
    expect(hook.result.current.state.pendingSync).toHaveLength(0);
  });
});
