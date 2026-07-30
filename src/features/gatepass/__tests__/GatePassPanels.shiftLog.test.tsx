/**
 * ShiftLogPanel — Feature 5 slice 7 RTL tests.
 *
 * Source: src/docs/specs/shift-log-aggregation.md §6 (UI surface),
 * §7 (frontend reducer contract). The panel renders state.shifts and
 * calls into actions.{setShiftsQuery, loadShifts}. It never touches the
 * API directly. Six acceptance criteria are pinned here:
 *
 *   1. The default-window window label renders ISO-8601 strings the
 *      server actually computed over (no "today" shorthand — the
 *      displayed window must match the response, not the request).
 *   2. Rows render with the deterministic counter columns (entries,
 *      qr, walkIn, override, auto, denied, expired) so an admin can
 *      spot a guard with anomalous numbers at a glance.
 *   3. The Refresh button is disabled while loading=true so a fast
 *      double-click cannot fire two overlapping requests.
 *   4. A failed list call surfaces the error code + message in a
 *      destructive banner; it does NOT silently empty the table. This
 *      is the no-silent-success contract.
 *   5. Submitting the form calls loadShifts with the admin's pending
 *      filter (including the optional guardId).
 *   6. An empty result set renders an explicit "No shifts" empty-state
 *      row instead of just a blank table body.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ShiftLogPanel } from "../components/GatePassPanels";
import type { GatePassActions } from "../components/GatePassPanels";
import { initialGatePassState } from "../gatepassReducer";
import type { GatePassError, GatePassState } from "../types";
import type { ShiftSummaryView } from "@/lib/api/types";

function actionsStub(): GatePassActions {
  return {
    submitEntry: vi.fn(async () => undefined),
    scanQr: vi.fn(async () => undefined),
    syncPending: vi.fn(async () => undefined),
    searchVisitors: vi.fn(async () => undefined),
    requestApproval: vi.fn(async () => undefined),
    setNetwork: vi.fn(),
    retryNotification: vi.fn(async () => undefined),
    loadVisitorProfiles: vi.fn(async () => undefined),
    createVisitorProfile: vi.fn(async () => undefined),
    updateVisitorProfile: vi.fn(async () => undefined),
    softDeleteVisitorProfile: vi.fn(async () => undefined),
    restoreVisitorProfile: vi.fn(async () => undefined),
    toggleVisitorProfilesIncludeDeleted: vi.fn(),
    setShiftsQuery: vi.fn(),
    loadShifts: vi.fn(async () => undefined),
    issueVisitorInvitation: vi.fn(async () => undefined),
    resetVisitorInvitation: vi.fn(),
    loadOnPremise: vi.fn(async () => undefined),
    recordExit: vi.fn(async () => undefined),
    addEntryNote: vi.fn(async () => undefined),
  };
}

const GUARD_A_ID = "22222222-2222-4222-8222-222222222222";
const GUARD_B_ID = "33333333-3333-4333-8333-333333333333";

function makeRow(
  over: Partial<ShiftSummaryView> = {},
  totalsOver: Partial<ShiftSummaryView["totals"]> = {},
): ShiftSummaryView {
  return {
    guardId: GUARD_A_ID,
    guardName: "A. Okafor",
    badgeNumber: "G-1042",
    totals: {
      entries: 4,
      qr: 2,
      walkIn: 1,
      override: 1,
      recognized: 0,
      auto: 0,
      approvalsDenied: 0,
      approvalsExpired: 0,
      autoApprovalsMatched: 0,
      overrideAuthorized: 0,
      ...totalsOver,
    },
    ...over,
  };
}

function stateWith(
  rows: ShiftSummaryView[],
  over: Partial<GatePassState["shifts"]> = {},
): GatePassState {
  return {
    ...initialGatePassState,
    mode: "admin",
    shifts: {
      query: {},
      rows,
      loading: false,
      ...over,
    },
  };
}

describe("ShiftLogPanel — Feature 5 admin UI", () => {
  it("renders the window label from the server-computed window (not the user's request)", () => {
    const state = stateWith([], {
      window: {
        fromIso: "2024-02-01T00:00:00.000Z",
        toIso: "2024-02-01T08:00:00.000Z",
      },
    });
    render(
      <ShiftLogPanel
        state={state}
        dispatch={vi.fn()}
        actions={actionsStub()}
      />,
    );
    const label = screen.getByTestId("shift-log-window-label");
    expect(label.textContent).toContain("2024-02-01T00:00:00.000Z");
    expect(label.textContent).toContain("2024-02-01T08:00:00.000Z");
  });

  it("renders one row per guard with the deterministic counter columns", () => {
    const rows: ShiftSummaryView[] = [
      makeRow(
        { guardId: GUARD_A_ID, guardName: "A. Okafor", badgeNumber: "G-1042" },
        {
          entries: 4,
          qr: 2,
          walkIn: 1,
          override: 1,
          auto: 0,
          approvalsDenied: 1,
          approvalsExpired: 0,
        },
      ),
      // Source: src/server/services/shift-log-service.ts:147-172 —
      // incrementMethod() always bumps `entries` alongside the per-method
      // counter, so `entries === qr + walkIn + override + recognized + auto`
      // for any row built from known method types. Both fixtures must
      // honour that invariant or the harness lies about what the real
      // service can produce.
      makeRow(
        { guardId: GUARD_B_ID, guardName: "M. Sato", badgeNumber: "G-1099" },
        {
          entries: 10, // 5 + 2 + 0 + 0 + 3
          qr: 5,
          walkIn: 2,
          override: 0,
          auto: 3,
          approvalsDenied: 0,
          approvalsExpired: 2,
        },
      ),
    ];
    render(
      <ShiftLogPanel
        state={stateWith(rows)}
        dispatch={vi.fn()}
        actions={actionsStub()}
      />,
    );
    const rowA = within(screen.getByTestId(`shift-log-row-${GUARD_A_ID}`));
    expect(rowA.getByText("A. Okafor")).toBeTruthy();
    expect(rowA.getByText("G-1042")).toBeTruthy();
    expect(rowA.getAllByText("4")).toHaveLength(1); // entries cell
    expect(rowA.getAllByText("1")).toHaveLength(3); // walkIn, override, denied

    const rowB = within(screen.getByTestId(`shift-log-row-${GUARD_B_ID}`));
    expect(rowB.getByText("M. Sato")).toBeTruthy();
    expect(rowB.getByText("G-1099")).toBeTruthy();
    expect(rowB.getByText("10")).toBeTruthy(); // entries cell — invariant
    expect(rowB.getAllByText("5")).toHaveLength(1); // qr
    expect(rowB.getByText("3")).toBeTruthy(); // auto
    expect(rowB.getAllByText("2")).toHaveLength(2); // walkIn AND expired
  });

  it("disables the Refresh button while loading=true (no double-fire on a fast double-click)", () => {
    const actions = actionsStub();
    render(
      <ShiftLogPanel
        state={stateWith([], { loading: true })}
        dispatch={vi.fn()}
        actions={actions}
      />,
    );
    const btn = screen.getByTestId("shift-log-refresh") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain("Loading");
    // Even when the user attempts a click, the disabled button does
    // not submit the surrounding form, so loadShifts must NOT fire.
    fireEvent.click(btn);
    expect(actions.loadShifts).not.toHaveBeenCalled();
  });

  it("surfaces a list failure in a destructive banner and KEEPS the previously-loaded rows", () => {
    const rows = [makeRow()];
    const lastError: GatePassError = {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
      traceId: "trace-xyz",
    };
    render(
      <ShiftLogPanel
        state={stateWith(rows, { lastError })}
        dispatch={vi.fn()}
        actions={actionsStub()}
      />,
    );
    const banner = screen.getByTestId("shift-log-error");
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.textContent).toContain("INTERNAL_ERROR");
    expect(banner.textContent).toContain("An unexpected error occurred");
    expect(banner.textContent).toContain("trace-xyz");
    // No silent wipe: the rows are still in the table.
    expect(screen.getByTestId(`shift-log-row-${GUARD_A_ID}`)).toBeTruthy();
    expect(screen.queryByTestId("shift-log-empty")).toBeNull();
  });

  it("submitting the form calls loadShifts with the admin's pending filter (incl. guardId)", () => {
    const actions = actionsStub();
    render(
      <ShiftLogPanel
        state={stateWith([])}
        dispatch={vi.fn()}
        actions={actions}
      />,
    );
    fireEvent.change(screen.getByTestId("shift-log-from"), {
      target: { value: "2024-01-15T00:00:00.000Z" },
    });
    fireEvent.change(screen.getByTestId("shift-log-to"), {
      target: { value: "2024-01-16T00:00:00.000Z" },
    });
    fireEvent.change(screen.getByTestId("shift-log-guard"), {
      target: { value: GUARD_A_ID },
    });
    fireEvent.click(screen.getByTestId("shift-log-refresh"));
    expect(actions.loadShifts).toHaveBeenCalledTimes(1);
    expect(actions.loadShifts).toHaveBeenCalledWith({
      fromIso: "2024-01-15T00:00:00.000Z",
      toIso: "2024-01-16T00:00:00.000Z",
      guardId: GUARD_A_ID,
    });
  });

  it("renders an explicit empty-state row when there are no shifts in the window", () => {
    render(
      <ShiftLogPanel
        state={stateWith([])}
        dispatch={vi.fn()}
        actions={actionsStub()}
      />,
    );
    const empty = screen.getByTestId("shift-log-empty");
    expect(empty.textContent).toContain("No shifts in this window.");
    // Sanity: no guard rows rendered.
    expect(screen.queryByTestId(`shift-log-row-${GUARD_A_ID}`)).toBeNull();
  });
});
