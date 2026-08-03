/**
 * QrScanPanel — Feature 10 (Vehicle Verification, Stage 3) RTL tests.
 *
 * Source: src/docs/specs/vehicle-verification.md.
 *
 * The QR confirmation surface shows the pre-registered ("expected")
 * plate for the guard to compare against the plate they enter, and
 * renders a SOFT WARNING on mismatch. Acceptance criteria pinned here:
 *
 *   1. Expected plate is displayed when one is on file.
 *   2. No plate on file → informational note, no warning.
 *   3. Observed == expected (after normalisation) → match, no warning.
 *   4. Observed != expected → soft warning naming the discrepancy.
 *   5. The "Log entry" control stays enabled in every state — a mismatch
 *      never blocks continuation.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QrScanPanel } from "../components/GatePassPanels";
import type { GatePassActions } from "../components/GatePassPanels";
import { initialGatePassState } from "../gatepassReducer";
import type { GatePassState } from "../types";

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
  };
}

/** A QR-verified state with the given expected + observed plates. */
function qrState(
  expectedPlate: string | null,
  observedPlate: string,
): GatePassState {
  return {
    ...initialGatePassState,
    mode: "qr",
    qrState: "valid",
    expectedPlate,
    draft: {
      ...initialGatePassState.draft,
      visitorName: "QR Guest",
      host: "Resident verified",
      unit: "12A",
      plate: observedPlate,
      method: "qr",
      preApprovalId: "preapproval-1",
    },
  };
}

function renderPanel(state: GatePassState) {
  return render(
    <QrScanPanel state={state} dispatch={vi.fn()} actions={actionsStub()} />,
  );
}

describe("QrScanPanel — vehicle verification", () => {
  it("shows the expected plate when one is on file", () => {
    renderPanel(qrState("GR 1234-A", "GR 1234-A"));
    expect(screen.getByTestId("expected-plate")).toHaveTextContent("GR 1234-A");
  });

  it("shows an informational note (no warning) when no plate is on file", () => {
    renderPanel(qrState(null, ""));
    expect(screen.getByTestId("vehicle-verification")).toHaveTextContent(
      /no plate on file/i,
    );
    expect(screen.queryByTestId("expected-plate")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("plate-mismatch-warning"),
    ).not.toBeInTheDocument();
  });

  it("shows a match confirmation (no warning) when observed equals expected", () => {
    // Different formatting, same plate after normalisation.
    renderPanel(qrState("GR 1234-A", "gr1234a"));
    expect(screen.getByTestId("plate-match")).toBeInTheDocument();
    expect(
      screen.queryByTestId("plate-mismatch-warning"),
    ).not.toBeInTheDocument();
  });

  it("shows a soft warning when observed differs from expected", () => {
    renderPanel(qrState("GR 1234-A", "GR 9999-B"));
    const warning = screen.getByTestId("plate-mismatch-warning");
    expect(warning).toBeInTheDocument();
    expect(warning).toHaveAttribute("role", "alert");
    expect(warning).toHaveTextContent(/does not block entry/i);
  });

  it("keeps the Log entry control enabled on mismatch (never blocks)", () => {
    renderPanel(qrState("GR 1234-A", "GR 9999-B"));
    expect(screen.getByTestId("plate-mismatch-warning")).toBeInTheDocument();
    const logButton = screen.getByRole("button", { name: /log entry/i });
    expect(logButton).toBeEnabled();
  });
});
