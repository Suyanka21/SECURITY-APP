import {
  AdminShell,
  AwaitingApprovalPanel,
  ConfirmationPanel,
  DeliveryAdminPanel,
  ErrorPanel,
  GuardHome,
  OnPremisePanel,
  OverridePanel,
  QrScanPanel,
  SearchPanel,
  ShiftLogPanel,
  StatusBanner,
  VisitorInvitationsAdminPanel,
  VisitorsAdminPanel,
  WalkInPanel,
} from "./components/GatePassPanels";
import { useGatePassController } from "./useGatePassController";
import type { GatePassControllerOptions } from "./useGatePassController";

/**
 * Top-level shell. Owns the controller (state + side effects) and
 * routes the current mode to the matching panel. Panels receive both
 * `dispatch` (UI-only actions) and `actions` (network-bound).
 */
export function GatePassApp(props: { controller?: GatePassControllerOptions } = {}) {
  const controller = useGatePassController(props.controller);
  const { state, dispatch } = controller;
  const actions = {
    submitEntry: controller.submitEntry,
    scanQr: controller.scanQr,
    syncPending: controller.syncPending,
    searchVisitors: controller.searchVisitors,
    setNetwork: controller.setNetwork,
    requestApproval: controller.requestApproval,
    retryNotification: controller.retryNotification,
    // Feature 4 — visitor profile CRUD wiring.
    loadVisitorProfiles: controller.loadVisitorProfiles,
    createVisitorProfile: controller.createVisitorProfile,
    updateVisitorProfile: controller.updateVisitorProfile,
    softDeleteVisitorProfile: controller.softDeleteVisitorProfile,
    restoreVisitorProfile: controller.restoreVisitorProfile,
    toggleVisitorProfilesIncludeDeleted:
      controller.toggleVisitorProfilesIncludeDeleted,
    // Feature 5 — shift log aggregation wiring.
    setShiftsQuery: controller.setShiftsQuery,
    loadShifts: controller.loadShifts,
    // Feature 6 — visitor invitation wiring.
    issueVisitorInvitation: controller.issueVisitorInvitation,
    resetVisitorInvitation: controller.resetVisitorInvitation,
    // Feature 7 — exit tracking wiring.
    loadOnPremise: controller.loadOnPremise,
    recordExit: controller.recordExit,
    // Feature 9 — guard notes wiring.
    addEntryNote: controller.addEntryNote,
    // Feature 8 — delivery management wiring.
    submitDelivery: controller.submitDelivery,
    loadDeliveries: controller.loadDeliveries,
    resetDeliveryForm: controller.resetDeliveryForm,
  };

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-4 md:px-6 md:py-6">
        <StatusBanner state={state} dispatch={dispatch} actions={actions} />
        <nav
          className="grid grid-cols-3 gap-2 md:grid-cols-6"
          aria-label="GatePass modules"
        >
          {(["home", "qr", "walkin", "search", "override", "admin"] as const).map(
            (mode) => (
              <button
                key={mode}
                className={`focus-ring border px-3 py-3 text-sm font-bold capitalize ${
                  state.mode === mode
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card"
                }`}
                onClick={() => {
                  if (mode === "qr") {
                    dispatch({ type: "START_CAMERA" });
                    return;
                  }
                  if (mode === "search") {
                    dispatch({ type: "NAVIGATE", mode });
                    void controller.searchVisitors("");
                    return;
                  }
                  dispatch({ type: "NAVIGATE", mode });
                }}
              >
                {mode === "walkin" ? "Walk-in" : mode}
              </button>
            )
          )}
        </nav>
        {state.mode === "home" && (
          <GuardHome state={state} dispatch={dispatch} actions={actions} />
        )}
        {state.mode === "qr" && (
          <QrScanPanel state={state} dispatch={dispatch} actions={actions} />
        )}
        {state.mode === "walkin" && (
          <WalkInPanel state={state} dispatch={dispatch} actions={actions} />
        )}
        {state.mode === "override" && (
          <OverridePanel state={state} dispatch={dispatch} actions={actions} />
        )}
        {state.mode === "search" && (
          <SearchPanel state={state} dispatch={dispatch} actions={actions} />
        )}
        {state.mode === "awaiting-approval" && (
          <AwaitingApprovalPanel
            state={state}
            dispatch={dispatch}
            actions={actions}
          />
        )}
        {state.mode === "confirmed" && (
          <ConfirmationPanel state={state} dispatch={dispatch} actions={actions} />
        )}
        {state.mode === "error" && (
          <ErrorPanel state={state} dispatch={dispatch} actions={actions} />
        )}
        {state.mode === "admin" && (
          <div className="grid gap-5">
            <AdminShell state={state} />
            <VisitorInvitationsAdminPanel
              state={state}
              dispatch={dispatch}
              actions={actions}
            />
            <VisitorsAdminPanel
              state={state}
              dispatch={dispatch}
              actions={actions}
            />
            <ShiftLogPanel
              state={state}
              dispatch={dispatch}
              actions={actions}
            />
            <OnPremisePanel
              state={state}
              dispatch={dispatch}
              actions={actions}
            />
            <DeliveryAdminPanel
              state={state}
              dispatch={dispatch}
              actions={actions}
            />
          </div>
        )}
      </div>
    </main>
  );
}
