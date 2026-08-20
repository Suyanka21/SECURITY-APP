/**
 * AccountProvisioningPanel — Stage 1 (A1) + Stage 6 audit-warning RTL tests.
 *
 * Acceptance criteria pinned here:
 *   1. A generated temporary password is shown once on success.
 *   2. When the account exists but its audit row could not be written, the
 *      admin still sees the password AND an explicit warning — the creation is
 *      never presented as a failure (that lost the only copy of the password).
 *   3. No warning is rendered on a clean success.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountProvisioningPanel } from "../AccountProvisioningPanel";
import { accountsApi } from "@/lib/api/accounts";
import type { ProvisionAccountResponse } from "@/lib/api/accounts";

vi.mock("@/lib/api/accounts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/accounts")>();
  return {
    ...actual,
    accountsApi: { createAccount: vi.fn() },
  };
});

const mocked = vi.mocked(accountsApi);

const ACCOUNT = {
  guardId: "new-guard-id",
  email: "new.guard@gatepass.test",
  name: "New Guard",
  badgeNumber: "G-777",
  role: "guard" as const,
  isActive: true,
};

function ok(data: ProvisionAccountResponse) {
  return { ok: true as const, status: 201, data };
}

function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText(/full name/i), {
    target: { value: "New Guard" },
  });
  fireEvent.change(screen.getByLabelText(/badge number/i), {
    target: { value: "G-777" },
  });
  fireEvent.change(screen.getByLabelText(/email/i), {
    target: { value: "new.guard@gatepass.test" },
  });
  fireEvent.click(screen.getByRole("button", { name: /create account/i }));
}

describe("AccountProvisioningPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the generated temporary password once on success", async () => {
    mocked.createAccount.mockResolvedValue(
      ok({ account: ACCOUNT, temporaryPassword: "Gp!generated9", traceId: "t" }),
    );

    render(<AccountProvisioningPanel />);
    fillAndSubmit();

    await waitFor(() =>
      expect(screen.getByText("Gp!generated9")).toBeInTheDocument(),
    );
    expect(screen.queryByText(/audit trail not written/i)).toBeNull();
  });

  // Regression: the audit failure used to surface as a 500, so the admin saw an
  // error and never received the password of an account that had been created.
  it("shows the password AND an audit warning when the audit row failed", async () => {
    mocked.createAccount.mockResolvedValue(
      ok({
        account: ACCOUNT,
        temporaryPassword: "Gp!generated9",
        auditWarning: {
          code: "ACCOUNT_CREATED_AUDIT_FAILED",
          message:
            "The account for badge G-777 was created and its password is shown below, but writing it to the audit trail failed. Do not retry.",
        },
        traceId: "t",
      }),
    );

    render(<AccountProvisioningPanel />);
    fillAndSubmit();

    await waitFor(() =>
      expect(screen.getByText("Gp!generated9")).toBeInTheDocument(),
    );
    const warning = screen.getByRole("alert");
    expect(warning).toHaveTextContent(/audit trail not written/i);
    expect(warning).toHaveTextContent(/do not retry/i);
    // The creation itself is still reported as done, not failed.
    expect(screen.getByText(/created new guard/i)).toBeInTheDocument();
  });
});
