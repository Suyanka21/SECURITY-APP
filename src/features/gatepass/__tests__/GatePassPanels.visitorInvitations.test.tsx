/**
 * VisitorInvitationsAdminPanel — Feature 6 Slice 7 RTL tests.
 *
 * Source: src/docs/specs/guest-qr-ticket.md §7 (UI), §A6/A8 (security).
 *
 * Acceptance criteria pinned here:
 *   1. Idle state renders the form; the Issue button is disabled
 *      until the three required fields (name, host, unit) are filled.
 *   2. Submitting calls actions.issueVisitorInvitation with the exact
 *      trimmed payload (plate omitted when empty).
 *   3. While submitting, the inputs and button are disabled (no
 *      double-submit possible).
 *   4. On 'issued', the success card renders with the visitor name,
 *      pass URL, expiresAt, AND the QR <svg>. The form is hidden.
 *   5. On 'failed' (default-deny: 403 AUTH_FORBIDDEN), the form stays
 *      visible, the error banner shows the code + message + traceId,
 *      and the success card is NOT rendered.
 *   6. "Issue another" calls actions.resetVisitorInvitation and clears
 *      every input back to empty.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VisitorInvitationsAdminPanel } from "../components/GatePassPanels";
import type { GatePassActions } from "../components/GatePassPanels";
import { initialGatePassState } from "../gatepassReducer";
import type { GatePassError, GatePassState } from "../types";
import type { VisitorInvitationIssuedView } from "@/lib/api/types";

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
  };
}

const ISSUED: VisitorInvitationIssuedView = {
  id: "00000000-0000-4000-8000-0000000000ff",
  qrToken: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefg",
  passUrl:
    "https://example.com/pass/ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefg",
  expiresAt: "2024-02-02T00:00:00.000Z",
  issuedAt: "2024-02-01T00:00:00.000Z",
  visitorName: "Maya Chen",
  host: "A. Okafor",
  unit: "18B",
  plate: "LND-482",
};

function renderPanel(
  partial: Partial<GatePassState["visitorInvitations"]> = {},
  actions: GatePassActions = actionsStub(),
) {
  const state: GatePassState = {
    ...initialGatePassState,
    visitorInvitations: {
      status: "idle",
      ...partial,
    } as GatePassState["visitorInvitations"],
  };
  return {
    actions,
    ...render(
      <VisitorInvitationsAdminPanel
        state={state}
        dispatch={vi.fn()}
        actions={actions}
      />,
    ),
  };
}

describe("VisitorInvitationsAdminPanel (Feature 6)", () => {
  it("renders the form in idle state with the submit button disabled until required fields are filled", () => {
    renderPanel();
    expect(screen.getByTestId("visitor-invitation-form")).toBeInTheDocument();
    const submit = screen.getByTestId("visitor-invitation-submit");
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByTestId("visitor-invitation-visitorName"), {
      target: { value: "Maya Chen" },
    });
    fireEvent.change(screen.getByTestId("visitor-invitation-host"), {
      target: { value: "A. Okafor" },
    });
    expect(submit).toBeDisabled(); // unit missing
    fireEvent.change(screen.getByTestId("visitor-invitation-unit"), {
      target: { value: "18B" },
    });
    expect(submit).not.toBeDisabled();
  });

  it("submits with the trimmed payload (plate omitted when empty)", () => {
    const { actions } = renderPanel();

    fireEvent.change(screen.getByTestId("visitor-invitation-visitorName"), {
      target: { value: "  Maya Chen  " },
    });
    fireEvent.change(screen.getByTestId("visitor-invitation-host"), {
      target: { value: "A. Okafor" },
    });
    fireEvent.change(screen.getByTestId("visitor-invitation-unit"), {
      target: { value: "18B" },
    });
    fireEvent.submit(screen.getByTestId("visitor-invitation-form"));

    expect(actions.issueVisitorInvitation).toHaveBeenCalledTimes(1);
    expect(actions.issueVisitorInvitation).toHaveBeenCalledWith({
      visitorName: "Maya Chen",
      host: "A. Okafor",
      unit: "18B",
      // plate intentionally undefined — never sent as an empty string.
    });
  });

  it("disables every input + the submit button while submitting (no double-submit)", () => {
    renderPanel({ status: "submitting" });
    expect(screen.getByTestId("visitor-invitation-visitorName")).toBeDisabled();
    expect(screen.getByTestId("visitor-invitation-host")).toBeDisabled();
    expect(screen.getByTestId("visitor-invitation-unit")).toBeDisabled();
    expect(screen.getByTestId("visitor-invitation-plate")).toBeDisabled();
    const submit = screen.getByTestId("visitor-invitation-submit");
    expect(submit).toBeDisabled();
    expect(submit).toHaveTextContent("Issuing");
  });

  it("renders the success card on 'issued' with the QR + pass URL + visitor details, and hides the form", () => {
    renderPanel({ status: "issued", lastIssued: ISSUED });

    expect(screen.getByTestId("visitor-invitation-issued")).toBeInTheDocument();
    expect(
      screen.getByText(/Pass issued for Maya Chen/i),
    ).toBeInTheDocument();
    // QR PNG rendered client-side (spec §A8) — verified by presence of <svg>.
    const qrWrapper = screen.getByTestId("visitor-invitation-qr");
    expect(qrWrapper.querySelector("svg")).not.toBeNull();
    expect(screen.getByTestId("visitor-invitation-pass-url")).toHaveTextContent(
      ISSUED.passUrl,
    );
    // Form must be gone — the QR is shown ONCE.
    expect(screen.queryByTestId("visitor-invitation-form")).toBeNull();
  });

  it("default-denies a 403 AUTH_FORBIDDEN: error banner + form stays, no success card", () => {
    const error: GatePassError = {
      code: "AUTH_FORBIDDEN",
      message: "Guard tokens cannot issue visitor invitations.",
      traceId: "trace-abc",
    };
    renderPanel({ status: "failed", lastError: error });

    // Form is still present.
    expect(screen.getByTestId("visitor-invitation-form")).toBeInTheDocument();
    // Success card MUST NOT be reachable on a failed status.
    expect(screen.queryByTestId("visitor-invitation-issued")).toBeNull();
    // Banner shows the explicit code + message + traceId.
    const banner = screen.getByTestId("visitor-invitation-error");
    expect(banner).toHaveTextContent("AUTH_FORBIDDEN");
    expect(banner).toHaveTextContent(
      "Guard tokens cannot issue visitor invitations.",
    );
    expect(banner).toHaveTextContent("trace-abc");
  });

  it("'Issue another' calls resetVisitorInvitation + clears every input", () => {
    const actions = actionsStub();
    const { rerender } = renderPanel(
      { status: "issued", lastIssued: ISSUED },
      actions,
    );

    fireEvent.click(screen.getByTestId("visitor-invitation-reset"));
    expect(actions.resetVisitorInvitation).toHaveBeenCalledTimes(1);

    // Simulate the reducer transitioning back to idle.
    const idleState: GatePassState = {
      ...initialGatePassState,
      visitorInvitations: { status: "idle" },
    };
    rerender(
      <VisitorInvitationsAdminPanel
        state={idleState}
        dispatch={vi.fn()}
        actions={actions}
      />,
    );

    expect(screen.getByTestId("visitor-invitation-visitorName")).toHaveValue("");
    expect(screen.getByTestId("visitor-invitation-host")).toHaveValue("");
    expect(screen.getByTestId("visitor-invitation-unit")).toHaveValue("");
    expect(screen.getByTestId("visitor-invitation-plate")).toHaveValue("");
  });
});
