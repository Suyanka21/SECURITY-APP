/**
 * PR A — guard console identity, sign-out, and audit truth.
 *
 * Regression cover for the pre-shipping audit findings:
 *   1.1 the console never said who was signed in
 *   1.2 the console had no sign-out (no shift handover was possible)
 *   1.3 the audit panel named a hardcoded `guard-west-04`
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { GatePassApp } from "../GatePassApp";
import type { GatePassApi } from "@/lib/api/gatepass";

const { AUTH } = vi.hoisted(() => ({
  AUTH: {
    status: "authenticated" as const,
    role: "guard" as const,
    me: {
      guardId: "11111111-1111-4111-8111-111111111111",
      role: "guard" as const,
      name: "N. Adeyemi",
      badgeNumber: "G-001",
      isActive: true,
      traceId: "trace-me",
    },
    loginAvailable: true,
    error: null,
    signIn: vi.fn(),
    signOut: vi.fn(),
    refresh: vi.fn(),
  },
}));

vi.mock("@/features/auth/AuthContext", () => ({
  useAuth: () => AUTH,
}));

function buildApi(): GatePassApi {
  const stub = vi.fn(async () => ({
    ok: false as const,
    status: 0,
    error: { code: "NETWORK_ERROR", message: "no api configured" },
  }));
  return {
    submitEntry: stub,
    validateQr: stub,
    syncEntries: stub,
    searchVisitors: stub,
  } as unknown as GatePassApi;
}

describe("guard console identity + sign-out (PR A)", () => {
  beforeEach(() => {
    AUTH.signOut.mockClear();
  });

  it("names the signed-in guard, badge and role in the console chrome", () => {
    render(<GatePassApp controller={{ api: buildApi() }} />);
    expect(screen.getByTestId("guard-identity")).toHaveTextContent(
      "N. Adeyemi · G-001 · guard"
    );
  });

  it("offers a Sign out control that calls the shared auth signOut", () => {
    render(<GatePassApp controller={{ api: buildApi() }} />);
    fireEvent.click(screen.getByRole("button", { name: /Sign out/i }));
    expect(AUTH.signOut).toHaveBeenCalledTimes(1);
  });

  it("attributes the audit panel to the real guard, never guard-west-04", () => {
    const { container } = render(<GatePassApp controller={{ api: buildApi() }} />);
    fireEvent.click(screen.getByRole("button", { name: /^admin$/i }));

    expect(screen.getByTestId("audit-session-guard")).toHaveTextContent(
      "Session guard: N. Adeyemi (G-001)"
    );
    expect(screen.getByText("Session opened by N. Adeyemi (G-001)")).toBeInTheDocument();
    expect(container.textContent).not.toContain("guard-west-04");
  });
});
