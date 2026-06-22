/**
 * DeliveryAdminPanel — Feature 8 slice 7 RTL tests.
 *
 * Source: src/docs/specs/delivery-management.md §5 (UI surface).
 * The panel renders state.deliveryManagement and calls into
 * actions.{submitDelivery, loadDeliveries, resetDeliveryForm}. It
 * never touches the API directly. Eight acceptance criteria:
 *
 *   1. Empty state shows "No deliveries recorded yet."
 *   2. Delivery rows render with all columns (rider, unit, category,
 *      plate, method, time).
 *   3. Refresh button disabled while loading=true.
 *   4. "New delivery" button opens the quick-entry form.
 *   5. Submitting the form calls actions.submitDelivery with correct
 *      payload.
 *   6. Success banner shows rider name + category after submit.
 *   7. Error banner with code + message surfaces on form-level error.
 *   8. Cancel closes the form and calls resetDeliveryForm.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DeliveryAdminPanel } from "../components/GatePassPanels";
import type { GatePassActions } from "../components/GatePassPanels";
import { initialGatePassState } from "../gatepassReducer";
import type { GatePassState, DeliveryManagementState } from "../types";
import type { DeliveryListEntryView, DeliveryEntryView } from "@/lib/api/types";

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
    submitDelivery: vi.fn(async () => undefined),
    loadDeliveries: vi.fn(async () => undefined),
    resetDeliveryForm: vi.fn(),
  };
}

const DELIVERY_LIST_ENTRY: DeliveryListEntryView = {
  id: "del-001",
  visitorName: "Jumia Rider",
  host: "Reception",
  unit: "18B",
  plate: null,
  deliveryCategory: "parcel",
  method: "walk-in",
  guardId: "guard-01",
  createdAt: "2024-06-01T09:30:00.000Z",
};

const DELIVERY_ENTRY: DeliveryEntryView = {
  id: "del-001",
  visitorName: "Jumia Rider",
  host: "Reception",
  unit: "18B",
  plate: "KDA-123",
  reason: "",
  method: "walk-in",
  guardId: "guard-01",
  createdAt: "2024-06-01T09:30:00.000Z",
  status: "logged",
  syncState: "synced",
  entryKind: "delivery",
  deliveryCategory: "parcel",
};

function buildState(overrides: Partial<DeliveryManagementState> = {}): GatePassState {
  return {
    ...initialGatePassState,
    deliveryManagement: {
      ...initialGatePassState.deliveryManagement,
      ...overrides,
    },
  };
}

function renderPanel(state: GatePassState, actions: GatePassActions) {
  return render(
    <DeliveryAdminPanel
      state={state}
      dispatch={vi.fn()}
      actions={actions}
    />,
  );
}

describe("DeliveryAdminPanel", () => {
  it("renders empty state when no deliveries exist", () => {
    const actions = actionsStub();
    renderPanel(buildState(), actions);
    expect(screen.getByTestId("delivery-empty")).toHaveTextContent(
      "No deliveries recorded yet.",
    );
  });

  it("renders delivery rows with all columns", () => {
    const actions = actionsStub();
    renderPanel(buildState({ entries: [DELIVERY_LIST_ENTRY] }), actions);
    const row = screen.getByTestId("delivery-row-del-001");
    expect(within(row).getByText("Jumia Rider")).toBeInTheDocument();
    expect(within(row).getByText("18B")).toBeInTheDocument();
    expect(within(row).getByText("parcel")).toBeInTheDocument();
    expect(within(row).getByText("walk-in")).toBeInTheDocument();
    expect(within(row).getByText("2024-06-01T09:30:00.000Z")).toBeInTheDocument();
  });

  it("disables Refresh button while loading=true", () => {
    const actions = actionsStub();
    renderPanel(buildState({ loading: true }), actions);
    const btn = screen.getByTestId("delivery-refresh");
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent("Loading…");
  });

  it("opens form when 'New delivery' is clicked", () => {
    const actions = actionsStub();
    renderPanel(buildState(), actions);
    expect(screen.queryByTestId("delivery-form")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("delivery-new-btn"));
    expect(screen.getByTestId("delivery-form")).toBeInTheDocument();
  });

  it("calls submitDelivery with correct payload on form submit", () => {
    const actions = actionsStub();
    renderPanel(buildState(), actions);
    fireEvent.click(screen.getByTestId("delivery-new-btn"));

    fireEvent.change(screen.getByTestId("delivery-rider-name"), {
      target: { value: "Uber Driver" },
    });
    fireEvent.change(screen.getByTestId("delivery-unit"), {
      target: { value: "4C" },
    });
    fireEvent.change(screen.getByTestId("delivery-plate"), {
      target: { value: "KBZ-999" },
    });
    fireEvent.change(screen.getByTestId("delivery-category"), {
      target: { value: "ride" },
    });
    fireEvent.click(screen.getByTestId("delivery-submit"));

    expect(actions.submitDelivery).toHaveBeenCalledTimes(1);
    const call = (actions.submitDelivery as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.visitorName).toBe("Uber Driver");
    expect(call.unit).toBe("4C");
    expect(call.plate).toBe("KBZ-999");
    expect(call.entryKind).toBe("delivery");
    expect(call.deliveryCategory).toBe("ride");
  });

  it("shows success banner with rider name and category after submit", () => {
    const actions = actionsStub();
    renderPanel(buildState({ lastEntry: DELIVERY_ENTRY }), actions);
    const banner = screen.getByTestId("delivery-success");
    expect(banner).toHaveTextContent("Delivery logged");
    expect(banner).toHaveTextContent("Jumia Rider");
    expect(banner).toHaveTextContent("parcel");
  });

  it("surfaces form-level error with code and message (no-silent-success)", () => {
    const actions = actionsStub();
    const { rerender } = renderPanel(buildState(), actions);

    // Open the form.
    fireEvent.click(screen.getByTestId("delivery-new-btn"));
    expect(screen.getByTestId("delivery-form")).toBeInTheDocument();

    // Re-render the SAME component tree with an error in state.
    // Using the same render root preserves the local showForm state.
    rerender(
      <DeliveryAdminPanel
        state={buildState({
          lastError: {
            code: "DELIVERY_CATEGORY_REQUIRED",
            message: "Delivery entries require a category",
          },
        })}
        dispatch={vi.fn()}
        actions={actions}
      />,
    );

    // Assert: in-form error banner is visible with the correct code and message.
    const errorBanner = screen.getByTestId("delivery-form-error");
    expect(errorBanner).toBeInTheDocument();
    expect(errorBanner).toHaveTextContent("DELIVERY_CATEGORY_REQUIRED");
    expect(errorBanner).toHaveTextContent("Delivery entries require a category");
  });

  it("surfaces list-level error when not in form mode", () => {
    const actions = actionsStub();
    renderPanel(
      buildState({
        lastError: {
          code: "AUTH_FORBIDDEN",
          message: "Insufficient role",
          traceId: "trace-403",
        },
      }),
      actions,
    );
    const banner = screen.getByTestId("delivery-list-error");
    expect(banner).toHaveTextContent("AUTH_FORBIDDEN: Insufficient role");
    expect(banner).toHaveTextContent("trace-403");
  });

  it("cancel closes the form and calls resetDeliveryForm", () => {
    const actions = actionsStub();
    renderPanel(buildState(), actions);
    fireEvent.click(screen.getByTestId("delivery-new-btn"));
    expect(screen.getByTestId("delivery-form")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("delivery-cancel"));
    expect(screen.queryByTestId("delivery-form")).not.toBeInTheDocument();
    expect(actions.resetDeliveryForm).toHaveBeenCalledTimes(1);
  });
});
