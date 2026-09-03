/**
 * GatePass — resident-role trap regression (readiness PR B).
 *
 * Uses the REAL useOnboarding hook against localStorage. Pins: a stored
 * `resident` onboarding-role with no staff session is recoverable from the
 * screen itself ("Staff sign in" → login, stored role cleared), and a real
 * staff session is never hidden behind that stored value.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import Index from "../Index";
import type { AuthContextValue, AuthStatus } from "@/features/auth/AuthContext";
import { STORAGE_KEYS } from "@/features/onboarding/types";

vi.mock("@/features/gatepass/GatePassApp", () => ({
  GatePassApp: () => <div data-testid="iface-guard">GUARD CONSOLE</div>,
}));
vi.mock("@/features/admin/AdminDashboard", () => ({
  AdminDashboard: () => <div data-testid="iface-admin">ADMIN DASHBOARD</div>,
}));
vi.mock("@/features/auth/LoginScreen", () => ({
  LoginScreen: () => <div data-testid="iface-login">LOGIN</div>,
}));

const mockAuth = vi.fn<[], AuthContextValue>();
vi.mock("@/features/auth/AuthContext", () => ({
  useAuth: () => mockAuth(),
}));

function setAuth(status: AuthStatus, role: AuthContextValue["role"] = null) {
  mockAuth.mockReturnValue({
    status,
    role,
    me: null,
    identityVerified: true,
    loginAvailable: true,
    error: null,
    signIn: vi.fn(),
    signOut: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
  });
}

function storeResidentOnboarding() {
  localStorage.setItem(STORAGE_KEYS.role, "resident");
  localStorage.setItem(STORAGE_KEYS.completed, "true");
  localStorage.setItem(STORAGE_KEYS.welcomed, "true");
}

describe("Index — resident onboarding-role trap", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("stored resident role + no session: 'Staff sign in' reaches login and clears the role", () => {
    storeResidentOnboarding();
    setAuth("unauthenticated");
    render(<Index />);

    expect(screen.getByTestId("resident-not-available")).toBeInTheDocument();
    expect(screen.queryByTestId("iface-login")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("resident-staff-sign-in"));

    expect(screen.getByTestId("iface-login")).toBeInTheDocument();
    expect(screen.queryByTestId("resident-not-available")).not.toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEYS.role)).toBeNull();
  });

  it("stored resident role never hides an authenticated guard session", () => {
    storeResidentOnboarding();
    setAuth("authenticated", "guard");
    render(<Index />);
    expect(screen.getByTestId("iface-guard")).toBeInTheDocument();
    expect(screen.queryByTestId("resident-not-available")).not.toBeInTheDocument();
  });
});
