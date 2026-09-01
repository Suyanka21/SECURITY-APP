import { useMemo } from "react";
import { LogOut, WifiOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/AuthContext";
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
import type { GuardIdentity } from "./types";

/**
 * Top-level shell. Owns the controller (state + side effects) and
 * routes the current mode to the matching panel. Panels receive both
 * `dispatch` (UI-only actions) and `actions` (network-bound).
 */
export function GatePassApp(props: { controller?: GatePassControllerOptions } = {}) {
  const { me, identityVerified, signOut } = useAuth();
  // The signed-in guard's identity is the ONLY source for who this session
  // belongs to; the console never invents or defaults one. Memoised so the
  // controller's identity effect only fires when the guard actually changes.
  const identity = useMemo<GuardIdentity | undefined>(
    () =>
      me
        ? {
            guardId: me.guardId,
            name: me.name,
            badgeNumber: me.badgeNumber,
            role: me.role,
          }
        : undefined,
    [me]
  );
  const controller = useGatePassController({
    identity,
    ...props.controller,
  });
  const { state, dispatch } = controller;
  const actions = {
    submitEntry: controller.submitEntry,
    scanQr: controller.scanQr,
    // Feature 11 — One-Time PIN Backup redemption wiring.
    redeemPin: controller.redeemPin,
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
        <header className="flex flex-wrap items-center justify-between gap-3 border border-border bg-card px-4 py-3">
          <div>
            <h1 className="text-lg font-semibold text-foreground">
              GatePass — Gate station
            </h1>
            <p className="text-xs text-muted-foreground" data-testid="guard-identity">
              {me
                ? `${me.name} · ${me.badgeNumber} · ${me.role}`
                : "Identifying guard…"}
            </p>
            {me && !identityVerified ? (
              <p
                className="mt-1 flex items-center gap-1 text-xs font-bold text-amber-700"
                data-testid="guard-identity-unverified"
              >
                <WifiOff className="h-3 w-3" aria-hidden="true" />
                Offline — identity not re-verified with the server
              </p>
            ) : null}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void signOut()}
            data-testid="guard-sign-out"
          >
            <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />
            Sign out
          </Button>
        </header>
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
