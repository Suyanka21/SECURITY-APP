/**
 * Guard-facing watchlist warning — Feature 12 (Stage 5) RTL tests.
 *
 * Source: src/docs/specs/watchlist.md §1, §5.
 *
 * Acceptance criteria pinned here:
 *   1. A match renders an accessible alert carrying the STORED reason.
 *   2. The copy states explicitly that it does not block entry.
 *   3. Pre-log (QR/PIN) shows the supervisor-escalation controls.
 *   4. The "Log entry" control is never disabled by a match — the refusal
 *      is a supervisor requirement, not a system denial.
 *   5. Post-log (walk-in confirmation) shows the warning as a notice.
 *   6. No match → no warning at all (backward compatible).
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ConfirmationPanel,
  QrScanPanel,
} from "../components/GatePassPanels";
import type { GatePassActions } from "../components/GatePassPanels";
import { initialGatePassState } from "../gatepassReducer";
import type { GatePassState } from "../types";
import type { WatchlistMatchView } from "@/lib/api/types";

const MATCH: WatchlistMatchView = {
  matched: true,
  entryId: "wl-1",
  reason: "Barred after an altercation with staff on 2026-01-04.",
  matchedOn: "name+plate",
  requiresEscalation: true,
};

function actionsStub(): GatePassActions {
  return {
    submitEntry: vi.fn(async () => undefined),
    scanQr: vi.fn(async () => undefined),
    redeemPin: vi.fn(async () => undefined),
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
  } as unknown as GatePassActions;
}

function qrStateWith(match: WatchlistMatchView | null): GatePassState {
  return {
    ...initialGatePassState,
    mode: "qr",
    qrState: "valid",
    expectedPlate: "KJA-019",
    watchlistMatch: match,
    draft: {
      ...initialGatePassState.draft,
      visitorName: "Mara Osei",
      host: "Bola",
      unit: "4A",
      plate: "KJA-019",
      method: "qr",
      preApprovalId: "preapproval-1",
    },
  };
}

describe("WatchlistWarning on the QR/PIN confirmation surface", () => {
  it("renders an alert with the stored reason and the matched fields", () => {
    render(
      <QrScanPanel
        state={qrStateWith(MATCH)}
        dispatch={vi.fn()}
        actions={actionsStub()}
      />,
    );

    const warning = screen.getByTestId("watchlist-warning");
    expect(warning).toHaveAttribute("role", "alert");
    expect(warning).toHaveTextContent("WATCHLIST MATCH");
    expect(warning).toHaveTextContent(MATCH.reason);
    expect(warning).toHaveTextContent("name + plate");
  });

  it("states explicitly that a match does not block entry", () => {
    render(
      <QrScanPanel
        state={qrStateWith(MATCH)}
        dispatch={vi.fn()}
        actions={actionsStub()}
      />,
    );

    expect(screen.getByTestId("watchlist-warning")).toHaveTextContent(
      /does not automatically block entry/i,
    );
  });

  it("leaves the Log entry control enabled — the system never denies", () => {
    render(
      <QrScanPanel
        state={qrStateWith(MATCH)}
        dispatch={vi.fn()}
        actions={actionsStub()}
      />,
    );

    expect(screen.getByRole("button", { name: /log entry/i })).toBeEnabled();
  });

  it("dispatches the supervisor name and acknowledgement", () => {
    const dispatch = vi.fn();
    render(
      <QrScanPanel
        state={qrStateWith(MATCH)}
        dispatch={dispatch}
        actions={actionsStub()}
      />,
    );

    fireEvent.change(screen.getByTestId("watchlist-supervisor"), {
      target: { value: "Sgt. Amina" },
    });
    fireEvent.click(screen.getByTestId("watchlist-acknowledge"));

    expect(dispatch).toHaveBeenCalledWith({
      type: "WATCHLIST_ESCALATION_UPDATED",
      supervisor: "Sgt. Amina",
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "WATCHLIST_ESCALATION_UPDATED",
      acknowledged: true,
    });
  });

  it("renders nothing when the visitor is not watchlisted", () => {
    render(
      <QrScanPanel
        state={qrStateWith(null)}
        dispatch={vi.fn()}
        actions={actionsStub()}
      />,
    );

    expect(screen.queryByTestId("watchlist-warning")).toBeNull();
  });
});

describe("WatchlistWarning on the post-log confirmation panel", () => {
  function confirmedState(): GatePassState {
    return {
      ...initialGatePassState,
      mode: "confirmed",
      watchlistMatch: MATCH,
      lastEntry: {
        id: "entry-1",
        visitorName: "Mara Osei",
        host: "Bola",
        unit: "4A",
        plate: null,
        reason: "",
        method: "walk-in",
        guardId: "guard-west-04",
        createdAt: "2024-01-01T00:00:00.000Z",
        status: "logged",
        syncState: "synced",
      },
    };
  }

  it("shows the entry as recorded AND warns the guard to escalate", () => {
    render(
      <ConfirmationPanel
        state={confirmedState()}
        dispatch={vi.fn()}
        actions={actionsStub()}
      />,
    );

    expect(screen.getByTestId("confirmation-panel")).toBeInTheDocument();
    expect(screen.getByTestId("watchlist-warning")).toHaveTextContent(
      MATCH.reason,
    );
    expect(screen.getByTestId("watchlist-post-log-notice")).toHaveTextContent(
      /already been logged/i,
    );
  });
});
