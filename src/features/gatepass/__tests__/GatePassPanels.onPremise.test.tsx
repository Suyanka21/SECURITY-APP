/**
 * OnPremisePanel — Feature 7 slice 7 RTL tests.
 *
 * Source: src/docs/specs/exit-tracking.md §8 (UI surface).
 * The panel renders state.exitTracking and calls into
 * actions.{loadOnPremise, recordExit}. It never touches the API
 * directly. Seven acceptance criteria are pinned here:
 *
 *   1. On-premise rows render with all columns (visitor, host, unit,
 *      plate, method, entered, action).
 *   2. Empty state renders "No visitors currently on-premise."
 *   3. Refresh button is disabled while loading=true.
 *   4. A failed list call surfaces error code + message in a
 *      destructive banner (no-silent-success).
 *   5. Clicking "Record exit" calls actions.recordExit with the
 *      correct entryId.
 *   6. Per-row exit error is rendered inline below the exit button.
 *   7. Success banner with traceId appears when lastExit is set.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OnPremisePanel } from "../components/GatePassPanels";
import type { GatePassActions } from "../components/GatePassPanels";
import { initialGatePassState } from "../gatepassReducer";
import type { GatePassState, ExitTrackingState } from "../types";
import type { OnPremiseEntryView, ExitRecordView } from "@/lib/api/types";

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

const ENTRY_A: OnPremiseEntryView = {
  id: "entry-aaa",
  visitorName: "Maya Chen",
  host: "A. Okafor",
  unit: "18B",
  plate: "LND-482",
  method: "walk-in",
  guardId: "guard-west-04",
  createdAt: "2024-06-01T09:30:00.000Z",
  notes: [],
};

const ENTRY_B: OnPremiseEntryView = {
  id: "entry-bbb",
  visitorName: "Dario Miles",
  host: "N. Patel",
  unit: "07C",
  plate: null,
  method: "qr",
  guardId: "guard-west-04",
  createdAt: "2024-06-01T10:15:00.000Z",
  notes: [],
};

const EXIT_VIEW: ExitRecordView = {
  id: "exit-001",
  entryId: "entry-aaa",
  guardId: "guard-west-04",
  createdAt: "2024-06-01T10:30:00.000Z",
  traceId: "trace-exit-1",
};

function stateWith(
  exitOver: Partial<ExitTrackingState> = {},
): GatePassState {
  return {
    ...initialGatePassState,
    mode: "admin",
    exitTracking: {
      ...initialGatePassState.exitTracking,
      ...exitOver,
    },
  };
}

describe("OnPremisePanel — Feature 7 admin UI", () => {
  it("renders on-premise rows with all columns", () => {
    const actions = actionsStub();
    render(
      <OnPremisePanel
        state={stateWith({ onPremise: [ENTRY_A, ENTRY_B] })}
        dispatch={vi.fn()}
        actions={actions}
      />,
    );

    const table = screen.getByTestId("on-premise-table");
    const rows = within(table).getAllByRole("row");
    // 1 header + 2 data rows.
    expect(rows).toHaveLength(3);

    // Row A.
    const rowA = screen.getByTestId("on-premise-row-entry-aaa");
    expect(within(rowA).getByText("Maya Chen")).toBeTruthy();
    expect(within(rowA).getByText("A. Okafor")).toBeTruthy();
    expect(within(rowA).getByText("18B")).toBeTruthy();
    expect(within(rowA).getByText("LND-482")).toBeTruthy();
    expect(within(rowA).getByText("walk-in")).toBeTruthy();

    // Row B — null plate renders em-dash.
    const rowB = screen.getByTestId("on-premise-row-entry-bbb");
    expect(within(rowB).getByText("Dario Miles")).toBeTruthy();
    expect(within(rowB).getByText("—")).toBeTruthy();
    expect(within(rowB).getByText("qr")).toBeTruthy();
  });

  it("renders empty state when no visitors are on-premise", () => {
    const actions = actionsStub();
    render(
      <OnPremisePanel
        state={stateWith({ onPremise: [] })}
        dispatch={vi.fn()}
        actions={actions}
      />,
    );

    expect(screen.getByTestId("on-premise-empty")).toBeTruthy();
    expect(screen.getByText("No visitors currently on-premise.")).toBeTruthy();
  });

  it("disables Refresh button while loading", () => {
    const actions = actionsStub();
    render(
      <OnPremisePanel
        state={stateWith({ loading: true })}
        dispatch={vi.fn()}
        actions={actions}
      />,
    );

    const btn = screen.getByTestId("on-premise-refresh");
    expect(btn).toBeDisabled();
    expect(btn.textContent).toBe("Loading…");
  });

  it("surfaces list error in a destructive banner (no-silent-success)", () => {
    const actions = actionsStub();
    render(
      <OnPremisePanel
        state={stateWith({
          lastError: {
            code: "AUTH_FORBIDDEN",
            message: "Insufficient role",
            traceId: "trace-403",
          },
        })}
        dispatch={vi.fn()}
        actions={actions}
      />,
    );

    const banner = screen.getByTestId("on-premise-error");
    expect(banner.textContent).toContain("AUTH_FORBIDDEN");
    expect(banner.textContent).toContain("Insufficient role");
    expect(banner.textContent).toContain("trace-403");
  });

  it("clicking Record exit calls actions.recordExit with the correct entryId", () => {
    const actions = actionsStub();
    render(
      <OnPremisePanel
        state={stateWith({ onPremise: [ENTRY_A] })}
        dispatch={vi.fn()}
        actions={actions}
      />,
    );

    const btn = screen.getByTestId("exit-btn-entry-aaa");
    fireEvent.click(btn);
    expect(actions.recordExit).toHaveBeenCalledWith("entry-aaa");
  });

  it("renders per-row exit error inline below the exit button", () => {
    const actions = actionsStub();
    render(
      <OnPremisePanel
        state={stateWith({
          onPremise: [ENTRY_A],
          exitErrors: {
            "entry-aaa": {
              code: "EXIT_NO_OPEN_ENTRY",
              message: "No entry found for the provided ID",
            },
          },
        })}
        dispatch={vi.fn()}
        actions={actions}
      />,
    );

    const errorEl = screen.getByTestId("exit-error-entry-aaa");
    expect(errorEl.textContent).toContain("EXIT_NO_OPEN_ENTRY");
    expect(errorEl.textContent).toContain("No entry found");
  });

  it("renders success banner with traceId when lastExit is set", () => {
    const actions = actionsStub();
    render(
      <OnPremisePanel
        state={stateWith({ lastExit: EXIT_VIEW })}
        dispatch={vi.fn()}
        actions={actions}
      />,
    );

    const banner = screen.getByTestId("on-premise-exit-success");
    expect(banner.textContent).toContain("Exit recorded");
    expect(banner.textContent).toContain("trace-exit-1");
  });

  it("disables the exit button while exitInFlight is true for that entry", () => {
    const actions = actionsStub();
    render(
      <OnPremisePanel
        state={stateWith({
          onPremise: [ENTRY_A],
          exitInFlight: { "entry-aaa": true },
        })}
        dispatch={vi.fn()}
        actions={actions}
      />,
    );

    const btn = screen.getByTestId("exit-btn-entry-aaa");
    expect(btn).toBeDisabled();
    expect(btn.textContent).toContain("Working…");
  });

  it("Refresh button calls actions.loadOnPremise on click", () => {
    const actions = actionsStub();
    render(
      <OnPremisePanel
        state={stateWith({ onPremise: [] })}
        dispatch={vi.fn()}
        actions={actions}
      />,
    );

    const btn = screen.getByTestId("on-premise-refresh");
    fireEvent.click(btn);
    expect(actions.loadOnPremise).toHaveBeenCalledTimes(1);
  });
});

// ─── Feature 9 — Guard notes UI ─────────────────────────────────────────
// Source: src/docs/specs/guard-notes.md §4.
//
// The Notes cell renders existing notes, exposes a tag selector, only
// shows the free-text field for the "other" tag (capped at 280), and
// calls actions.addEntryNote with a guardId-free body (server derives it).

describe("OnPremisePanel — Feature 9 guard notes", () => {
  it("renders 'No notes' when an entry has no notes", () => {
    const actions = actionsStub();
    render(
      <OnPremisePanel
        state={stateWith({ onPremise: [ENTRY_A] })}
        dispatch={vi.fn()}
        actions={actions}
      />,
    );
    expect(screen.getByTestId("notes-empty-entry-aaa")).toBeTruthy();
  });

  it("renders existing note badges and free text", () => {
    const actions = actionsStub();
    const entry: OnPremiseEntryView = {
      ...ENTRY_A,
      notes: [
        {
          id: "note-1",
          tag: "delivered_parcel",
          text: null,
          guardId: "guard-west-04",
          createdAt: "2024-06-01T09:35:00.000Z",
        },
        {
          id: "note-2",
          tag: "other",
          text: "Wore a hi-vis vest",
          guardId: "guard-west-04",
          createdAt: "2024-06-01T09:36:00.000Z",
        },
      ],
    };
    render(
      <OnPremisePanel
        state={stateWith({ onPremise: [entry] })}
        dispatch={vi.fn()}
        actions={actions}
      />,
    );
    expect(screen.getByTestId("note-note-1").textContent).toContain(
      "Delivered parcel",
    );
    const other = screen.getByTestId("note-note-2");
    expect(other.textContent).toContain("Other");
    expect(other.textContent).toContain("Wore a hi-vis vest");
  });

  it("only shows the free-text field for the 'other' tag", () => {
    const actions = actionsStub();
    render(
      <OnPremisePanel
        state={stateWith({ onPremise: [ENTRY_A] })}
        dispatch={vi.fn()}
        actions={actions}
      />,
    );
    fireEvent.click(screen.getByTestId("note-add-btn-entry-aaa"));
    // Predefined tag: no text field.
    expect(screen.queryByTestId("note-text-entry-aaa")).toBeNull();
    fireEvent.change(screen.getByTestId("note-tag-entry-aaa"), {
      target: { value: "other" },
    });
    // "other" reveals the capped text field.
    const textarea = screen.getByTestId(
      "note-text-entry-aaa",
    ) as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea.maxLength).toBe(280);
  });

  it("submits a predefined tag with no text (guardId omitted)", () => {
    const actions = actionsStub();
    render(
      <OnPremisePanel
        state={stateWith({ onPremise: [ENTRY_A] })}
        dispatch={vi.fn()}
        actions={actions}
      />,
    );
    fireEvent.click(screen.getByTestId("note-add-btn-entry-aaa"));
    fireEvent.change(screen.getByTestId("note-tag-entry-aaa"), {
      target: { value: "left_id_at_gate" },
    });
    fireEvent.click(screen.getByTestId("note-save-entry-aaa"));
    expect(actions.addEntryNote).toHaveBeenCalledWith("entry-aaa", {
      tag: "left_id_at_gate",
    });
  });

  it("submits 'other' with trimmed text", () => {
    const actions = actionsStub();
    render(
      <OnPremisePanel
        state={stateWith({ onPremise: [ENTRY_A] })}
        dispatch={vi.fn()}
        actions={actions}
      />,
    );
    fireEvent.click(screen.getByTestId("note-add-btn-entry-aaa"));
    fireEvent.change(screen.getByTestId("note-tag-entry-aaa"), {
      target: { value: "other" },
    });
    fireEvent.change(screen.getByTestId("note-text-entry-aaa"), {
      target: { value: "  needs escort  " },
    });
    fireEvent.click(screen.getByTestId("note-save-entry-aaa"));
    expect(actions.addEntryNote).toHaveBeenCalledWith("entry-aaa", {
      tag: "other",
      text: "needs escort",
    });
  });

  it("disables save for 'other' with empty text", () => {
    const actions = actionsStub();
    render(
      <OnPremisePanel
        state={stateWith({ onPremise: [ENTRY_A] })}
        dispatch={vi.fn()}
        actions={actions}
      />,
    );
    fireEvent.click(screen.getByTestId("note-add-btn-entry-aaa"));
    fireEvent.change(screen.getByTestId("note-tag-entry-aaa"), {
      target: { value: "other" },
    });
    expect(screen.getByTestId("note-save-entry-aaa")).toBeDisabled();
    fireEvent.click(screen.getByTestId("note-save-entry-aaa"));
    expect(actions.addEntryNote).not.toHaveBeenCalled();
  });

  it("disables the save button while a note is in flight", () => {
    const actions = actionsStub();
    render(
      <OnPremisePanel
        state={stateWith({
          onPremise: [ENTRY_A],
          noteInFlight: { "entry-aaa": true },
        })}
        dispatch={vi.fn()}
        actions={actions}
      />,
    );
    fireEvent.click(screen.getByTestId("note-add-btn-entry-aaa"));
    const save = screen.getByTestId("note-save-entry-aaa");
    expect(save).toBeDisabled();
    expect(save.textContent).toContain("Saving…");
  });

  it("surfaces a per-entry note error", () => {
    const actions = actionsStub();
    render(
      <OnPremisePanel
        state={stateWith({
          onPremise: [ENTRY_A],
          noteErrors: {
            "entry-aaa": {
              code: "GUARD_NOTE_INVALID_INPUT",
              message: "text is required when tag is 'other'",
            },
          },
        })}
        dispatch={vi.fn()}
        actions={actions}
      />,
    );
    fireEvent.click(screen.getByTestId("note-add-btn-entry-aaa"));
    const err = screen.getByTestId("note-error-entry-aaa");
    expect(err.textContent).toContain("GUARD_NOTE_INVALID_INPUT");
  });
});
