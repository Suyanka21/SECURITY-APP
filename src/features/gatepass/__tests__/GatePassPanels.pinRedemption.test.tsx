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
import {
  AwaitingApprovalPanel,
  ErrorPanel,
  QrScanPanel,
} from "../components/GatePassPanels";
import type { GatePassActions } from "../components/GatePassPanels";
import { initialGatePassState } from "../gatepassReducer";
import type { GatePassState, PendingApproval } from "../types";

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
    expect(screen.queryByTestId("qr-locked-banner")).toBeNull();
  });

  it("tells the guard the QR path is Locked too when qrState=locked", () => {
    renderPanel(panelState({ qrState: "locked" }));
    const banner = screen.getByTestId("qr-locked-banner");
    expect(banner).toHaveAttribute("role", "alert");
    expect(banner).toHaveTextContent(/^Locked/);
    expect(banner).toHaveTextContent(/too many incorrect PIN attempts/i);
    // The QR button must not offer a re-scan that will only be refused.
    expect(screen.getByRole("button", { name: /validate qr/i })).toBeDisabled();
  });
});

/**
 * ErrorPanel — a failed redemption sets mode="error", which replaces the
 * scan panel entirely, so this is the screen the guard actually reads
 * after 5 wrong PINs. It must name the lockout instead of reporting a
 * generic block (runtime verification of Stage 6 fix 3 found the generic
 * "Entry blocked" heading here).
 */
describe("ErrorPanel — locked pass", () => {
  function renderError(state: GatePassState) {
    render(<ErrorPanel state={state} dispatch={vi.fn()} />);
  }

  it("says Locked and explains a re-scan cannot help", () => {
    renderError(
      panelState({
        mode: "error",
        qrState: "locked",
        banner: { tone: "danger", message: "This pass is locked." },
      }),
    );
    expect(screen.getByTestId("error-panel-title")).toHaveTextContent("Locked");
    expect(screen.getByTestId("error-panel-locked-note")).toHaveTextContent(
      /re-scanning will not help/i,
    );
  });

  it("keeps the generic heading for every other refusal", () => {
    renderError(
      panelState({
        mode: "error",
        qrState: "invalid",
        banner: { tone: "danger", message: "Pass not recognised." },
      }),
    );
    expect(screen.getByTestId("error-panel-title")).toHaveTextContent(
      "Entry blocked",
    );
    expect(screen.queryByTestId("error-panel-locked-note")).toBeNull();
  });
});

/**
 * AwaitingApprovalPanel — a resumed approval has no magic link, because the
 * single-use token is deliberately never persisted on the gate device. The
 * panel must say so and must not render controls that copy/open nothing.
 */
describe("AwaitingApprovalPanel — resumed approval has no link", () => {
  const approval: PendingApproval = {
    id: "11111111-1111-4111-8111-111111111111",
    draft: {
      visitorName: "Ada Lovelace",
      host: "Bola",
      unit: "4A",
      plate: null,
      reason: "",
      method: "walk-in",
    },
    magicLinkUrl: "",
    expiresAt: "2024-01-01T00:05:00Z",
    status: "pending",
    traceId: "trace-resume",
  };

  it("explains the link is not shown again and renders no dead controls", () => {
    render(
      <AwaitingApprovalPanel
        state={panelState({ mode: "approval", pendingApproval: approval })}
        dispatch={vi.fn()}
        actions={actionsStub()}
      />,
    );
    expect(
      screen.getByTestId("approval-magic-link-unavailable"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("approval-magic-link")).toBeNull();
    expect(screen.queryByRole("button", { name: /copy link/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /open/i })).toBeNull();
  });

  it("still renders the link and controls for a fresh approval", () => {
    render(
      <AwaitingApprovalPanel
        state={panelState({
          mode: "approval",
          pendingApproval: {
            ...approval,
            magicLinkUrl: "http://localhost:5173/approve/x?token=abc",
          },
        })}
        dispatch={vi.fn()}
        actions={actionsStub()}
      />,
    );
    expect(screen.getByTestId("approval-magic-link")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /copy link/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open/i })).toBeInTheDocument();
  });
});
