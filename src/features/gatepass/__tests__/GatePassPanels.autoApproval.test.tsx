import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AdminShell,
  ConfirmationPanel,
} from "../components/GatePassPanels";
import { initialGatePassState } from "../gatepassReducer";
import type {
  EntryRecord,
  GatePassActions,
  GatePassState,
} from "../types";

// Source: src/docs/specs/auto-approval.md §6 (frontend UI surface) —
// auto-approved entries MUST be visually distinguishable from manual
// walk-in / override / QR / resident-approved entries. These tests
// pin three guarantees:
//   1. ConfirmationPanel shows an AUTO pill + rule line when method='auto'
//   2. ConfirmationPanel shows neither when method='walk-in'/'override'/etc.
//   3. AdminShell counts auto-approved entries in its own stat tile
// Together they guarantee an auditor scanning the live UI can tell
// auto from manual without parsing the audit text.

function makeEntry(overrides: Partial<EntryRecord> = {}): EntryRecord {
  return {
    id: "entry-1",
    visitorName: "Ada Lovelace",
    host: "Bola",
    unit: "4A",
    plate: undefined,
    reason: "",
    method: "walk-in",
    guardId: "guard-west-04",
    createdAt: new Date("2024-01-01T00:00:00Z").toISOString(),
    status: "logged",
    syncState: "synced",
    ...overrides,
  };
}

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
  } as unknown as GatePassActions;
}

describe("ConfirmationPanel — auto-approval UI surface", () => {
  it("renders the AUTO pill, accent border, and rule line when method='auto'", () => {
    const entry = makeEntry({ method: "auto", id: "entry-auto-1" });
    const ruleAuditLine =
      'auto_approval_matched: rule=rule-1 visitor="Ada Lovelace" host="Bola" unit="4A" by guard-west-04';
    const state: GatePassState = {
      ...initialGatePassState,
      mode: "confirmed",
      lastEntry: entry,
      entries: [entry],
      audit: [ruleAuditLine, ...initialGatePassState.audit],
    };

    render(
      <ConfirmationPanel
        state={state}
        dispatch={vi.fn()}
        actions={actionsStub()}
      />
    );

    // Heading announces auto-approval explicitly — not just "Entry recorded".
    expect(
      screen.getByRole("heading", { name: /Entry auto-approved/i })
    ).toBeInTheDocument();

    // Pill is present and labeled for screen readers.
    const pill = screen.getByTestId("auto-pill");
    expect(pill).toHaveTextContent("AUTO");
    expect(pill).toHaveAttribute("aria-label", "Auto-approved by rule");

    // Rule audit line is surfaced verbatim (minus the prefix).
    const ruleLine = screen.getByTestId("auto-rule-line");
    expect(ruleLine).toHaveTextContent("rule=rule-1");
    expect(ruleLine).toHaveTextContent('visitor="Ada Lovelace"');
    expect(ruleLine).toHaveTextContent('host="Bola"');
    expect(ruleLine).toHaveTextContent('unit="4A"');

    // Panel exposes a machine-readable flag for the audit harness +
    // a11y tools to assert auto-approval at the section level.
    const panel = screen.getByTestId("confirmation-panel");
    expect(panel).toHaveAttribute("data-auto-approved", "true");
  });

  it("renders NO auto pill or rule line for a manual walk-in entry", () => {
    const entry = makeEntry({ method: "walk-in", id: "entry-manual-1" });
    const state: GatePassState = {
      ...initialGatePassState,
      mode: "confirmed",
      lastEntry: entry,
      entries: [entry],
      // Even if a stale auto_approval_matched line exists somewhere in
      // the audit (it shouldn't for a manual entry, but defense in depth):
      audit: [
        'auto_approval_matched: rule=stale visitor="ghost" host="ghost" unit="ghost"',
        ...initialGatePassState.audit,
      ],
    };

    render(
      <ConfirmationPanel
        state={state}
        dispatch={vi.fn()}
        actions={actionsStub()}
      />
    );

    // Heading is the manual confirmation, not the auto variant.
    expect(
      screen.getByRole("heading", { name: /Entry recorded/i })
    ).toBeInTheDocument();

    // No pill, no rule line.
    expect(screen.queryByTestId("auto-pill")).toBeNull();
    expect(screen.queryByTestId("auto-rule-line")).toBeNull();

    const panel = screen.getByTestId("confirmation-panel");
    expect(panel).toHaveAttribute("data-auto-approved", "false");
  });

  it("does NOT surface the rule line when audit lacks an auto_approval_matched entry", () => {
    // Defensive: if the reducer somehow lands in 'confirmed' with
    // method='auto' but no matching audit row exists (would indicate
    // a frontend bug), the UI must NOT fabricate a rule line.
    const entry = makeEntry({ method: "auto" });
    const state: GatePassState = {
      ...initialGatePassState,
      mode: "confirmed",
      lastEntry: entry,
      entries: [entry],
      audit: initialGatePassState.audit, // no auto_approval_matched line
    };

    render(
      <ConfirmationPanel
        state={state}
        dispatch={vi.fn()}
        actions={actionsStub()}
      />
    );

    // Pill still renders (method='auto' is the source of truth).
    expect(screen.getByTestId("auto-pill")).toBeInTheDocument();
    // But the rule line is omitted because there is no rule audit line.
    expect(screen.queryByTestId("auto-rule-line")).toBeNull();
  });
});

describe("AdminShell — auto-approval count", () => {
  it("counts only entries with method='auto' in the Auto-approved stat", () => {
    const state: GatePassState = {
      ...initialGatePassState,
      entries: [
        makeEntry({ id: "e1", method: "auto" }),
        makeEntry({ id: "e2", method: "auto" }),
        makeEntry({ id: "e3", method: "walk-in" }),
        makeEntry({ id: "e4", method: "override" }),
        makeEntry({ id: "e5", method: "qr" }),
      ],
    };

    render(<AdminShell state={state} />);

    // The stat tile renders the label and the integer separately,
    // so we locate the label's parent and assert the rendered count.
    const label = screen.getByText("Auto-approved");
    const tile = label.closest("div");
    expect(tile).not.toBeNull();
    expect(tile!).toHaveTextContent("2");

    // Sanity: override count unaffected.
    const overrideLabel = screen.getByText("Override flags");
    const overrideTile = overrideLabel.closest("div");
    expect(overrideTile!).toHaveTextContent("1");
  });

  it("renders 0 for Auto-approved when no auto entries exist (sanity)", () => {
    const state: GatePassState = {
      ...initialGatePassState,
      entries: [
        makeEntry({ id: "e1", method: "walk-in" }),
        makeEntry({ id: "e2", method: "override" }),
      ],
    };

    render(<AdminShell state={state} />);

    const label = screen.getByText("Auto-approved");
    const tile = label.closest("div");
    expect(tile!).toHaveTextContent("0");
  });
});
