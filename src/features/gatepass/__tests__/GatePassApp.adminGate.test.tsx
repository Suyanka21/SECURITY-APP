/**
 * PR C — the guard console's "admin" tab is role-gated.
 *
 * Readiness audit #3.1: every panel behind the tab (shift log, on-premise,
 * deliveries list, invitation issuance, visitor CRUD) is served by routes
 * wired with requireRole("admin", "senior-guard"). Offering the tab to a
 * plain guard only ever produced AUTH_FORBIDDEN strings. The backend was
 * already correct; the UI must stop offering a destination the role cannot
 * have. Senior guards keep the tab because the same routes admit them.
 */

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GatePassApp } from "../GatePassApp";
import type { GatePassApi } from "@/lib/api/gatepass";
import type { AuthRole } from "@/lib/api/me";

const { AUTH } = vi.hoisted(() => ({
  AUTH: {
    status: "authenticated" as const,
    role: "guard" as AuthRole,
    me: {
      guardId: "11111111-1111-4111-8111-111111111111",
      role: "guard" as AuthRole,
      name: "N. Adeyemi",
      badgeNumber: "G-001",
      isActive: true,
      traceId: "trace-me",
    },
    identityVerified: true,
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

function setRole(role: AuthRole) {
  AUTH.role = role;
  AUTH.me = { ...AUTH.me, role };
}

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

const STAFF_TABS = ["home", "qr", "walk-in", "search", "override"];

describe("guard console admin tab is role-gated (PR C)", () => {
  beforeEach(() => setRole("guard"));

  afterEach(async () => {
    cleanup();
    await act(async () => {});
  });

  it("a plain guard is never offered the admin tab", () => {
    render(<GatePassApp controller={{ api: buildApi() }} />);

    const nav = screen.getByRole("navigation", { name: /GatePass modules/i });
    expect(
      screen.queryByRole("button", { name: /^admin$/i })
    ).not.toBeInTheDocument();
    expect(
      within(nav)
        .getAllByRole("button")
        .map((b) => b.textContent?.trim().toLowerCase())
    ).toEqual(STAFF_TABS);
    expect(screen.queryByTestId("audit-session-guard")).not.toBeInTheDocument();
  });

  it("a senior guard keeps the admin tab and can open it", () => {
    setRole("senior-guard");
    render(<GatePassApp controller={{ api: buildApi() }} />);

    fireEvent.click(screen.getByRole("button", { name: /^admin$/i }));
    expect(screen.getByTestId("audit-session-guard")).toHaveTextContent(
      "Session guard: N. Adeyemi (G-001)"
    );
  });

  it("the tab is not offered before the guard's role has resolved", () => {
    // Fail-closed: no identity → no privileged destination, matching the
    // console's GUARD_ID_MISSING stance on logging before /auth/me resolves.
    const saved = AUTH.me;
    // @ts-expect-error — the real hook yields me: null until /auth/me resolves
    AUTH.me = null;
    try {
      render(<GatePassApp controller={{ api: buildApi() }} />);
      expect(
        screen.queryByRole("button", { name: /^admin$/i })
      ).not.toBeInTheDocument();
    } finally {
      AUTH.me = saved;
    }
  });
});
