/**
 * GatePass — post-onboarding router tests (Phase 2).
 *
 * Source: src/docs/specs/auth-and-role-routing.md §6.
 *
 * These tests pin the CRITICAL contract: routing keys off the DB-verified
 * auth-role only, the resident onboarding-role gets the magic-link info state,
 * and there is NO silent fallback to the guard console for an unknown role.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import Index from "../Index";
import type { AuthContextValue, AuthStatus } from "@/features/auth/AuthContext";
import type { AuthRole } from "@/lib/api/me";
import type { StakeholderRole } from "@/features/onboarding/types";

// Mock the heavy leaf interfaces so we assert on routing, not their internals.
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
const mockResetOnboarding = vi.fn();
const mockOnboarding = vi.fn<
  [],
  { state: { role: StakeholderRole | null }; resetOnboarding: () => void }
>();

vi.mock("@/features/auth/AuthContext", () => ({
  useAuth: () => mockAuth(),
}));
vi.mock("@/features/onboarding/useOnboarding", () => ({
  useOnboarding: () => mockOnboarding(),
}));

function setAuth(overrides: Partial<AuthContextValue> & { status: AuthStatus }) {
  const value: AuthContextValue = {
    status: overrides.status,
    role: overrides.role ?? null,
    me: overrides.me ?? null,
    identityVerified: overrides.identityVerified ?? true,
    loginAvailable: overrides.loginAvailable ?? true,
    error: overrides.error ?? null,
    signIn: overrides.signIn ?? vi.fn(),
    signOut: overrides.signOut ?? vi.fn().mockResolvedValue(undefined),
    refresh: overrides.refresh ?? vi.fn().mockResolvedValue(undefined),
  };
  mockAuth.mockReturnValue(value);
}

function setOnboardingRole(role: StakeholderRole | null) {
  mockOnboarding.mockReturnValue({
    state: { role },
    resetOnboarding: mockResetOnboarding,
  });
}

describe("Index post-onboarding router", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("resident onboarding-role + no session → magic-link info, not a login prompt", () => {
    setOnboardingRole("resident");
    setAuth({ status: "unauthenticated" });
    render(<Index />);
    expect(screen.getByTestId("resident-not-available")).toBeInTheDocument();
    expect(screen.queryByTestId("iface-guard")).not.toBeInTheDocument();
    expect(screen.queryByTestId("iface-login")).not.toBeInTheDocument();
  });

  it("resident onboarding-role while auth is loading → spinner, never a console", () => {
    setOnboardingRole("resident");
    setAuth({ status: "loading" });
    render(<Index />);
    expect(screen.getByTestId("auth-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("iface-guard")).not.toBeInTheDocument();
  });

  it("an authenticated staff session wins over a stale resident onboarding-role", () => {
    setOnboardingRole("resident");
    setAuth({ status: "authenticated", role: "guard" });
    render(<Index />);
    expect(screen.getByTestId("iface-guard")).toBeInTheDocument();
    expect(screen.queryByTestId("resident-not-available")).not.toBeInTheDocument();
  });

  it("an authenticated admin session wins over a stale resident onboarding-role", () => {
    setOnboardingRole("resident");
    setAuth({ status: "authenticated", role: "admin" });
    render(<Index />);
    expect(screen.getByTestId("iface-admin")).toBeInTheDocument();
    expect(screen.queryByTestId("resident-not-available")).not.toBeInTheDocument();
  });

  it("a signed-in account with no guard profile is told so, even with a resident onboarding-role", () => {
    setOnboardingRole("resident");
    setAuth({ status: "no-guard-profile" });
    render(<Index />);
    expect(screen.getByTestId("no-guard-profile")).toBeInTheDocument();
    expect(screen.queryByTestId("resident-not-available")).not.toBeInTheDocument();
  });

  it("resident info screen offers 'Staff sign in' that clears the onboarding role", () => {
    setOnboardingRole("resident");
    setAuth({ status: "unauthenticated" });
    render(<Index />);
    fireEvent.click(screen.getByRole("button", { name: /staff sign in/i }));
    expect(mockResetOnboarding).toHaveBeenCalledTimes(1);
  });

  it("loading → spinner, no interface leaks", () => {
    setOnboardingRole("guard");
    setAuth({ status: "loading" });
    render(<Index />);
    expect(screen.getByTestId("auth-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("iface-guard")).not.toBeInTheDocument();
    expect(screen.queryByTestId("iface-admin")).not.toBeInTheDocument();
  });

  it("unauthenticated → login screen, never guard console", () => {
    setOnboardingRole("guard");
    setAuth({ status: "unauthenticated" });
    render(<Index />);
    expect(screen.getByTestId("iface-login")).toBeInTheDocument();
    expect(screen.queryByTestId("iface-guard")).not.toBeInTheDocument();
  });

  it("no-guard-profile → explicit not-available notice, never guard console", () => {
    setOnboardingRole("guard");
    setAuth({ status: "no-guard-profile" });
    render(<Index />);
    expect(screen.getByTestId("no-guard-profile")).toBeInTheDocument();
    expect(screen.queryByTestId("iface-guard")).not.toBeInTheDocument();
    expect(screen.queryByTestId("iface-admin")).not.toBeInTheDocument();
  });

  it("auth-role guard → GatePassApp", () => {
    setOnboardingRole("guard");
    setAuth({ status: "authenticated", role: "guard" });
    render(<Index />);
    expect(screen.getByTestId("iface-guard")).toBeInTheDocument();
    expect(screen.queryByTestId("iface-admin")).not.toBeInTheDocument();
  });

  it("auth-role senior-guard → GatePassApp", () => {
    setOnboardingRole("admin"); // onboarding-role is irrelevant for auth routing
    setAuth({ status: "authenticated", role: "senior-guard" });
    render(<Index />);
    expect(screen.getByTestId("iface-guard")).toBeInTheDocument();
  });

  it("auth-role admin → AdminDashboard, never guard console", () => {
    setOnboardingRole("guard"); // onboarding-role guard must NOT override auth-role admin
    setAuth({ status: "authenticated", role: "admin" });
    render(<Index />);
    expect(screen.getByTestId("iface-admin")).toBeInTheDocument();
    expect(screen.queryByTestId("iface-guard")).not.toBeInTheDocument();
  });

  it("unknown auth-role → explicit not-available, NEVER silent guard fallback", () => {
    setOnboardingRole("guard");
    // Force an unhandled role to prove there is no default → GatePassApp.
    setAuth({ status: "authenticated", role: "superuser" as unknown as AuthRole });
    render(<Index />);
    expect(screen.getByTestId("role-not-available")).toBeInTheDocument();
    expect(screen.queryByTestId("iface-guard")).not.toBeInTheDocument();
    expect(screen.queryByTestId("iface-admin")).not.toBeInTheDocument();
  });
});
