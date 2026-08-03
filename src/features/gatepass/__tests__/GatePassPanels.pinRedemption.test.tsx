/**
 * QrScanPanel — Feature 11 (One-Time PIN Backup, Stage 4) RTL tests.
 *
 * Source: src/docs/specs/one-time-pin-backup.md.
 *
 * The QR scan surface offers a PIN backup: the guard redeems the SAME
 * pass with its pass reference + a 6-digit PIN when the QR cannot be
 * scanned. Acceptance criteria pinned here:
 *
 *   1. The pass-reference + PIN inputs are rendered on the scan panel.
 *   2. "Redeem by PIN" calls actions.redeemPin with the entered values.
 *   3. qrState=locked renders the lockout banner (role=alert) and
 *      disables the redeem button so a locked pass can't be retried.
 *   4. The redeem button is disabled while a request is in flight.
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
  } as unknown as GatePassActions;
}

function panelState(partial: Partial<GatePassState> = {}): GatePassState {
  return { ...initialGatePassState, mode: "qr", ...partial };
}

function renderPanel(state: GatePassState, actions = actionsStub()) {
  render(<QrScanPanel state={state} dispatch={vi.fn()} actions={actions} />);
  return actions;
}

describe("QrScanPanel — PIN backup redemption (Feature 11)", () => {
  it("renders the pass reference + 6-digit PIN inputs", () => {
    renderPanel(panelState());
    expect(screen.getByTestId("pin-pass-ref-input")).toBeInTheDocument();
    expect(screen.getByTestId("pin-value-input")).toBeInTheDocument();
  });

  it("calls redeemPin with the entered reference + PIN when the button is clicked", () => {
    const actions = renderPanel(
      panelState({ pinPassRef: "AB12CD34", pinValue: "042195" }),
    );
    fireEvent.click(screen.getByTestId("pin-redeem-button"));
    expect(actions.redeemPin).toHaveBeenCalledWith("AB12CD34", "042195");
  });

  it("shows the lockout banner and disables redeem when qrState=locked", () => {
    renderPanel(panelState({ qrState: "locked" }));
    const banner = screen.getByTestId("pin-locked-banner");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveAttribute("role", "alert");
    expect(screen.getByTestId("pin-redeem-button")).toBeDisabled();
  });

  it("disables the redeem button while a request is in flight", () => {
    renderPanel(panelState({ inFlight: true, qrState: "scanning" }));
    expect(screen.getByTestId("pin-redeem-button")).toBeDisabled();
  });

  it("does not render the lockout banner in the normal idle state", () => {
    renderPanel(panelState());
    expect(screen.queryByTestId("pin-locked-banner")).toBeNull();
    expect(screen.getByTestId("pin-redeem-button")).toBeEnabled();
  });
});
