/**
 * VisitorsAdminPanel — Feature 4 slice 7 RTL tests.
 *
 * Source: src/docs/specs/visitor-profiles.md §6 (UI surface), §8
 * (frontend reducer contract). The panel renders state.visitorProfiles
 * and calls into actions.{create,update,softDelete,restore,
 * toggleIncludeDeleted,loadVisitorProfiles}. The tests below pin five
 * acceptance criteria the spec demands:
 *
 *   1. Watch-flagged rows render an accent + WATCH pill so an admin
 *      sees them at a glance.
 *   2. Soft-deleted rows show a Restore action instead of Edit/Delete
 *      and visually distinguish themselves (data-deleted attr).
 *   3. The "+ New visitor" form validates required fields client-side
 *      AND surfaces a server-issued field error inline (no silent
 *      success on 409 PROFILE_DUPLICATE).
 *   4. Per-row mutation errors land beneath the row that caused them
 *      and do NOT remove the row from the table (failed delete must
 *      leave the row visible — no optimistic removal).
 *   5. The Show-deleted toggle calls into the controller so the next
 *      list call propagates includeDeleted: true.
 *   6. The list-level lastError banner renders the error code +
 *      message so a failed list load cannot fail silently.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VisitorsAdminPanel } from "../components/GatePassPanels";
import { initialGatePassState } from "../gatepassReducer";
import type { GatePassActions, GatePassState } from "../types";
import { VISITOR_PROFILE_NEW_KEY } from "../types";
import type { VisitorProfileView } from "@/lib/api/types";

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

function makeProfile(
  overrides: Partial<VisitorProfileView> = {},
): VisitorProfileView {
  return {
    id: "00000000-0000-4000-8000-0000000000a1",
    visitorName: "Maya Chen",
    host: "A. Okafor",
    unit: "18B",
    plate: "LND-482",
    phoneE164: "+254700000001",
    notes: null,
    watchFlag: false,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-15T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function stateWith(
  profiles: VisitorProfileView[],
  overrides: Partial<GatePassState["visitorProfiles"]> = {},
): GatePassState {
  const byId: Record<string, VisitorProfileView> = {};
  for (const p of profiles) byId[p.id] = p;
  return {
    ...initialGatePassState,
    mode: "admin",
    visitorProfiles: {
      ...initialGatePassState.visitorProfiles,
      byId,
      order: profiles.map((p) => p.id),
      ...overrides,
    },
  };
}

describe("VisitorsAdminPanel — Feature 4 admin UI", () => {
  it("renders a watch-flagged row with the WATCH pill, accent border, and a non-watch row without them", () => {
    const watch = makeProfile({
      id: "watch-1",
      visitorName: "Risky Rita",
      watchFlag: true,
    });
    const normal = makeProfile({
      id: "normal-1",
      visitorName: "Calm Carl",
      watchFlag: false,
    });
    const state = stateWith([watch, normal]);

    render(
      <VisitorsAdminPanel
        state={state}
        dispatch={vi.fn()}
        actions={actionsStub()}
      />,
    );

    const watchRow = screen.getByTestId("visitor-row-watch-1");
    expect(watchRow).toHaveAttribute("data-watch", "true");
    expect(within(watchRow).getByTestId("watch-pill-watch-1")).toHaveTextContent(
      "WATCH",
    );

    const normalRow = screen.getByTestId("visitor-row-normal-1");
    expect(normalRow).not.toHaveAttribute("data-watch");
    expect(within(normalRow).queryByText("WATCH")).toBeNull();
  });

  it("renders a Restore button (not Edit/Delete) on a soft-deleted row and marks it visually", () => {
    const tombstoned = makeProfile({
      id: "deleted-1",
      visitorName: "Erased Edna",
      deletedAt: "2024-02-01T00:00:00.000Z",
    });
    const state = stateWith([tombstoned], { includeDeleted: true });
    const actions = actionsStub();

    render(
      <VisitorsAdminPanel state={state} dispatch={vi.fn()} actions={actions} />,
    );

    const row = screen.getByTestId("visitor-row-deleted-1");
    expect(row).toHaveAttribute("data-deleted", "true");
    expect(screen.getByTestId("visitor-restore-deleted-1")).toBeInTheDocument();
    expect(screen.queryByTestId("visitor-edit-deleted-1")).toBeNull();
    expect(screen.queryByTestId("visitor-delete-deleted-1")).toBeNull();

    fireEvent.click(screen.getByTestId("visitor-restore-deleted-1"));
    expect(actions.restoreVisitorProfile).toHaveBeenCalledWith("deleted-1");
  });

  it("opens the create form, blocks submit on empty required fields, then calls createVisitorProfile on a valid submit", () => {
    const state = stateWith([]);
    const actions = actionsStub();

    render(
      <VisitorsAdminPanel state={state} dispatch={vi.fn()} actions={actions} />,
    );

    expect(screen.queryByTestId("visitor-form-dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("visitors-new-button"));
    expect(screen.getByTestId("visitor-form-dialog")).toBeInTheDocument();

    // Empty submit: client-side validation message, no API call.
    fireEvent.click(screen.getByTestId("visitor-form-submit"));
    expect(
      screen.getByTestId("visitor-form-validation"),
    ).toHaveTextContent(/required/i);
    expect(actions.createVisitorProfile).not.toHaveBeenCalled();

    // Fill the required fields and submit.
    fireEvent.change(screen.getByTestId("visitor-form-name"), {
      target: { value: "New Nancy" },
    });
    fireEvent.change(screen.getByTestId("visitor-form-host"), {
      target: { value: "Resident R." },
    });
    fireEvent.change(screen.getByTestId("visitor-form-unit"), {
      target: { value: "2C" },
    });
    fireEvent.click(screen.getByTestId("visitor-form-submit"));

    expect(actions.createVisitorProfile).toHaveBeenCalledTimes(1);
    const payload = (actions.createVisitorProfile as ReturnType<typeof vi.fn>)
      .mock.calls[0][0];
    expect(payload).toMatchObject({
      visitorName: "New Nancy",
      host: "Resident R.",
      unit: "2C",
    });
  });

  it("surfaces a server-issued field error in the form so a 409 PROFILE_DUPLICATE does NOT silently succeed", () => {
    const state = stateWith([], {
      mutationInFlight: { [VISITOR_PROFILE_NEW_KEY]: false },
      mutationErrors: {
        [VISITOR_PROFILE_NEW_KEY]: {
          code: "PROFILE_DUPLICATE",
          message: "A profile with this name + unit already exists.",
          field: "visitorName",
        },
      },
    });
    const actions = actionsStub();

    render(
      <VisitorsAdminPanel state={state} dispatch={vi.fn()} actions={actions} />,
    );

    // Open the create form so the error has a home to render in.
    fireEvent.click(screen.getByTestId("visitors-new-button"));

    const err = screen.getByTestId("visitor-form-error");
    expect(err).toHaveTextContent("PROFILE_DUPLICATE");
    expect(err).toHaveTextContent(/already exists/);
    // The targeted field is highlighted (border-destructive class).
    const nameField = screen.getByTestId("visitor-form-name");
    expect(nameField.className).toMatch(/border-destructive/);
  });

  it("keeps the row visible AND renders an inline error when softDelete fails with 403 AUTH_FORBIDDEN (default-deny)", () => {
    const profile = makeProfile({ id: "row-403", visitorName: "Locked Lila" });
    const state = stateWith([profile], {
      mutationErrors: {
        [profile.id]: {
          code: "AUTH_FORBIDDEN",
          message: "Guard tokens cannot mutate visitor profiles.",
        },
      },
    });

    render(
      <VisitorsAdminPanel
        state={state}
        dispatch={vi.fn()}
        actions={actionsStub()}
      />,
    );

    // Row still visible — failed delete must NOT be optimistic.
    expect(screen.getByTestId(`visitor-row-${profile.id}`)).toBeInTheDocument();
    const inline = screen.getByTestId(`visitor-row-error-${profile.id}`);
    expect(inline).toHaveTextContent("AUTH_FORBIDDEN");
    expect(inline).toHaveTextContent(/cannot mutate/i);
  });

  it("calls toggleVisitorProfilesIncludeDeleted when the Show-deleted checkbox flips", () => {
    const state = stateWith([]);
    const actions = actionsStub();

    render(
      <VisitorsAdminPanel state={state} dispatch={vi.fn()} actions={actions} />,
    );

    fireEvent.click(screen.getByTestId("visitors-show-deleted-toggle"));
    expect(actions.toggleVisitorProfilesIncludeDeleted).toHaveBeenCalledTimes(1);
  });

  it("renders the list-level error banner with the error code and message on a failed list load", () => {
    const state = stateWith([], {
      lastError: {
        code: "INTERNAL_ERROR",
        message: "Could not load visitors.",
      },
    });

    render(
      <VisitorsAdminPanel
        state={state}
        dispatch={vi.fn()}
        actions={actionsStub()}
      />,
    );

    const banner = screen.getByTestId("visitors-list-error");
    expect(banner).toHaveTextContent("INTERNAL_ERROR");
    expect(banner).toHaveTextContent("Could not load visitors.");
  });
});
