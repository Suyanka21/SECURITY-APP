/**
 * ResidentUnitsPanel — R4a RTL tests.
 *
 * Source: src/docs/specs/resident-admin-panels.md §4, §6.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResidentUnitsPanel } from "../ResidentUnitsPanel";
import { residentAdminApi, type AdminRegistrationView, type UnitView } from "@/lib/api/resident-admin";
import { autoApprovalApi } from "@/lib/api/auto-approval";

vi.mock("@/lib/api/resident-admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/resident-admin")>();
  return {
    ...actual,
    residentAdminApi: {
      listUnits: vi.fn(),
      createUnit: vi.fn(),
      deactivateUnit: vi.fn(),
      issueClaimCode: vi.fn(),
      listResidents: vi.fn(),
      deactivateResident: vi.fn(),
      listRegistrations: vi.fn(),
    },
  };
});

vi.mock("@/lib/api/auto-approval", () => ({
  autoApprovalApi: { listRules: vi.fn(), deactivateRule: vi.fn(), clearBlock: vi.fn() },
}));

const api = vi.mocked(residentAdminApi);
const rules = vi.mocked(autoApprovalApi);

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const fail = (code: string, message: string, field?: string) => ({
  ok: false as const,
  status: 422,
  error: { code, message, traceId: "t", ...(field ? { field } : {}) },
});

function unit(over: Partial<UnitView> = {}): UnitView {
  return {
    id: "u-1",
    label: "A-101",
    isActive: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    deactivatedAt: null,
    activeResidentCount: 1,
    ...over,
  };
}

function reg(over: Partial<AdminRegistrationView> = {}): AdminRegistrationView {
  return {
    id: "reg-1",
    kind: "person",
    label: "Mary Njeri",
    plate: null,
    residentId: "res-1",
    residentDisplayName: "Amina Wanjiru",
    status: "active",
    ruleId: "rule-1",
    ruleActive: true,
    expiresAt: "2026-09-01T00:00:00.000Z",
    createdAt: "2026-06-01T00:00:00.000Z",
    removedAt: null,
    block: null,
    ...over,
  };
}

const blocked = {
  blockedAt: "2026-06-02T00:00:00.000Z",
  blockedBy: "Admin One",
  reason: "Reported incident",
  clearedAt: null,
  clearedBy: null,
  clearReason: null,
};

function setup({ units = [unit()], registrations = [reg()] } = {}) {
  api.listUnits.mockResolvedValue(ok({ units, count: units.length }));
  api.listResidents.mockResolvedValue(
    ok({
      residents: [
        {
          id: "res-1",
          displayName: "Amina Wanjiru",
          phoneMasked: "+254••••••678",
          isActive: true,
          unitId: "u-1",
          unitLabel: "A-101",
          claimedAt: "2026-01-02T00:00:00.000Z",
          deactivatedAt: null,
        },
      ],
      count: 1,
    }),
  );
  api.listRegistrations.mockResolvedValue(ok({ registrations, count: registrations.length }));
  render(<ResidentUnitsPanel />);
}

async function selectUnit(label: string) {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${label}`) }));
}

describe("ResidentUnitsPanel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("unit label input is limited to 32 characters and the create sends the trimmed label", async () => {
    setup({ units: [] });
    const input = await screen.findByLabelText(/new unit label/i);
    expect(input).toHaveAttribute("maxLength", "32");
    api.createUnit.mockResolvedValue({ ok: true, status: 201, data: { unit: unit({ id: "u-2", label: "B-7" }) } });
    fireEvent.change(input, { target: { value: "  B-7  " } });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(api.createUnit).toHaveBeenCalledWith("B-7"));
  });

  it("renders a server error as CODE — message", async () => {
    setup({ units: [] });
    api.createUnit.mockResolvedValue({ ...fail("UNIT_LABEL_TAKEN", "A unit with this label already exists", "label"), status: 409 });
    fireEvent.change(await screen.findByLabelText(/new unit label/i), { target: { value: "A-101" } });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("UNIT_LABEL_TAKEN — A unit with this label already exists");
  });

  it("surfaces a units load failure with its code", async () => {
    api.listUnits.mockResolvedValue({ ok: false, status: 403, error: { code: "AUTH_FORBIDDEN", message: "Admins only", traceId: "t" } });
    render(<ResidentUnitsPanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent("AUTH_FORBIDDEN — Admins only");
  });

  it("unit deactivation needs the confirmation step and shows the server's counts", async () => {
    setup();
    await selectUnit("A-101");
    api.deactivateUnit.mockResolvedValue(
      ok({ unit: unit({ isActive: false }), expiredPassCount: 2, deactivatedResidentCount: 1, disabledRuleCount: 3 }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /deactivate unit/i }));
    expect(api.deactivateUnit).not.toHaveBeenCalled();
    expect(screen.getByText(/deactivates its residents, expires its open passes and switches off its rules/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /confirm deactivate a-101/i }));
    await waitFor(() => expect(api.deactivateUnit).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/unit a-101 deactivated: 1 resident\(s\) deactivated, 2 open pass\(es\) expired, 3 rule\(s\) switched off/i)).toBeInTheDocument();
  });

  it("unit deactivation counts stay visible after the unit drops out of the reloaded list", async () => {
    setup();
    await selectUnit("A-101");
    api.deactivateUnit.mockResolvedValue(
      ok({ unit: unit({ isActive: false }), expiredPassCount: 2, deactivatedResidentCount: 1, disabledRuleCount: 3 }),
    );
    api.listUnits.mockResolvedValue(ok({ units: [], count: 0 }));
    fireEvent.click(await screen.findByRole("button", { name: /deactivate unit/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm deactivate a-101/i }));
    await waitFor(() => expect(api.listUnits).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("No units yet.")).toBeInTheDocument();
    expect(screen.getByText(/unit a-101 deactivated: 1 resident\(s\) deactivated/i)).toBeInTheDocument();
  });

  it("resident deactivation also refreshes the unit list and the registrations, keeping the unit selected", async () => {
    setup();
    await selectUnit("A-101");
    const residents = await screen.findByRole("region", { name: "Residents" });
    await within(residents).findByText("+254••••••678");
    expect(api.listUnits).toHaveBeenCalledTimes(1);
    expect(api.listRegistrations).toHaveBeenCalledTimes(1);
    api.deactivateResident.mockResolvedValue(
      ok({
        resident: {
          id: "res-1",
          displayName: "Amina Wanjiru",
          phoneMasked: "+254••••••678",
          isActive: false,
          unitId: "u-1",
          unitLabel: "A-101",
          claimedAt: "2026-01-02T00:00:00.000Z",
          deactivatedAt: "2026-02-01T00:00:00.000Z",
        },
      }),
    );
    fireEvent.click(within(residents).getByRole("button", { name: /^deactivate$/i }));
    fireEvent.click(within(residents).getByRole("button", { name: /confirm deactivate amina wanjiru/i }));
    await waitFor(() => expect(api.deactivateResident).toHaveBeenCalledWith("res-1"));
    await waitFor(() => expect(api.listUnits).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.listRegistrations).toHaveBeenCalledTimes(2));
    expect(api.listResidents).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("heading", { name: /unit a-101/i })).toBeInTheDocument();
  });

  it("claim code is shown once with Copy, and is gone after Dismiss or selecting another unit", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    setup({ units: [unit(), unit({ id: "u-2", label: "B-202" })] });
    await selectUnit("A-101");
    const issued = { claimCodeId: "c1", unitId: "u-1", unitLabel: "A-101", code: "AB12-CD34", expiresAt: "2026-01-04T00:00:00.000Z" };
    api.issueClaimCode.mockResolvedValue({ ok: true, status: 201, data: { claimCode: issued } });

    fireEvent.click(await screen.findByRole("button", { name: /issue claim code/i }));
    expect(await screen.findByText("AB12-CD34")).toBeInTheDocument();
    expect(screen.getByText(/shown once/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^copy$/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("AB12-CD34"));
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByText("AB12-CD34")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /issue claim code/i }));
    expect(await screen.findByText("AB12-CD34")).toBeInTheDocument();
    await selectUnit("B-202");
    expect(screen.queryByText("AB12-CD34")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("AB12-CD34")).toBeNull();
    expect(JSON.stringify({ ...window.localStorage })).not.toContain("AB12-CD34");
  });

  it("a failed re-issue does not leave the earlier code on screen next to the error", async () => {
    setup();
    await selectUnit("A-101");
    const issued = { claimCodeId: "c1", unitId: "u-1", unitLabel: "A-101", code: "AB12-CD34", expiresAt: "2026-01-04T00:00:00.000Z" };
    api.issueClaimCode.mockResolvedValueOnce({ ok: true, status: 201, data: { claimCode: issued } });
    fireEvent.click(await screen.findByRole("button", { name: /issue claim code/i }));
    expect(await screen.findByText("AB12-CD34")).toBeInTheDocument();
    api.issueClaimCode.mockResolvedValueOnce({ ok: false, status: 500, error: { code: "INTERNAL_ERROR", message: "Try again", traceId: "t" } });
    fireEvent.click(screen.getByRole("button", { name: /issue claim code/i }));
    expect(await screen.findByText(/INTERNAL_ERROR/)).toBeInTheDocument();
    expect(screen.queryByText("AB12-CD34")).not.toBeInTheDocument();
  });

  it("residents show the server's masked phone exactly as given", async () => {
    setup();
    await selectUnit("A-101");
    const residents = await screen.findByRole("region", { name: "Residents" });
    expect(await within(residents).findByText("+254••••••678")).toBeInTheDocument();
  });

  it("Switch off stays disabled until the reason is 3+ characters; REASON_REQUIRED shows on the reason field", async () => {
    setup();
    await selectUnit("A-101");
    fireEvent.click(await screen.findByRole("button", { name: /switch off/i }));
    const confirm = screen.getByRole("button", { name: /confirm switch off/i });
    const reason = screen.getByLabelText(/reason for switching off/i);
    expect(confirm).toBeDisabled();
    fireEvent.change(reason, { target: { value: "  ab  " } });
    expect(confirm).toBeDisabled();
    fireEvent.change(reason, { target: { value: "Reported incident" } });
    expect(confirm).toBeEnabled();

    rules.deactivateRule.mockResolvedValue(fail("REASON_REQUIRED", "A reason is required to switch off a resident's rule", "reason"));
    fireEvent.click(confirm);
    await waitFor(() => expect(rules.deactivateRule).toHaveBeenCalledWith("rule-1", "Reported incident"));
    expect(await screen.findByText(/REASON_REQUIRED/)).toBeInTheDocument();
    expect(reason).toHaveAttribute("aria-invalid", "true");
  });

  it("Clear block is offered only on a standing block and needs a 3+ character reason", async () => {
    setup({
      registrations: [
        reg({ id: "r-live", label: "Live One", ruleId: "rule-live" }),
        reg({ id: "r-cleared", label: "Cleared One", ruleId: "rule-c", ruleActive: false, status: "disabled", block: { ...blocked, clearedAt: "2026-06-03T00:00:00.000Z", clearedBy: "Admin Two", clearReason: "Verified" } }),
        reg({ id: "r-blocked", label: "Blocked One", ruleId: "rule-b", ruleActive: false, status: "disabled", block: blocked }),
      ],
    });
    await selectUnit("A-101");
    expect(await screen.findAllByRole("button", { name: /clear block/i })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /clear block/i }));
    const confirm = screen.getByRole("button", { name: /confirm clear/i });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/reason for clearing the block/i), { target: { value: "ok" } });
    expect(confirm).toBeDisabled();
  });

  it("after clearing, the message differs for a not-removed and a removed row", async () => {
    setup({
      registrations: [
        reg({ id: "r-kept", label: "Kept Entry", ruleId: "rule-k", ruleActive: false, status: "disabled", block: blocked }),
      ],
    });
    await selectUnit("A-101");
    rules.clearBlock.mockResolvedValue(ok({ block: { ruleId: "rule-k", registrationId: "r-kept", blockClearedAt: "x" }, traceId: "t" }));
    fireEvent.click(await screen.findByRole("button", { name: /clear block/i }));
    fireEvent.change(screen.getByLabelText(/reason for clearing the block/i), { target: { value: "Verified with owner" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm clear/i }));
    await waitFor(() => expect(rules.clearBlock).toHaveBeenCalledWith("rule-k", "Verified with owner"));
    expect(await screen.findByText(/must first remove the switched-off entry in their portal/i)).toBeInTheDocument();
  });

  it("after clearing a removed row, the resident can register again", async () => {
    setup({
      registrations: [
        reg({ id: "r-gone", label: "Gone Entry", ruleId: "rule-g", ruleActive: false, status: "removed", removedAt: "2026-06-04T00:00:00.000Z", block: blocked }),
      ],
    });
    await selectUnit("A-101");
    rules.clearBlock.mockResolvedValue(ok({ block: { ruleId: "rule-g", registrationId: "r-gone", blockClearedAt: "x" }, traceId: "t" }));
    expect(screen.queryByRole("button", { name: /switch off/i })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /clear block/i }));
    fireEvent.change(screen.getByLabelText(/reason for clearing the block/i), { target: { value: "Verified with owner" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm clear/i }));
    expect(await screen.findByText(/the resident can now register this again/i)).toBeInTheDocument();
  });
});
