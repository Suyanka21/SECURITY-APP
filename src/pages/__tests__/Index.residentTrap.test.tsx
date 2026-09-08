/**
 * GatePass — resident-role trap regression (readiness PR B).
 *
 * App-level: the REAL OnboardingGate wrapping the REAL Index, with the real
 * useOnboarding hook against localStorage (only auth and the consoles are
 * mocked). Pins that the gate and the router act on ONE onboarding state:
 * a stored `resident` role is recoverable from the info screen itself, the
 * exit is not undone by the gate or by a later tutorial replay, and a real
 * staff session is never hidden behind the stored value.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import Index from "../Index";
import { OnboardingGate } from "@/features/onboarding/OnboardingGate";
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

function storeResidentOnboarding(completed: boolean) {
  localStorage.setItem(STORAGE_KEYS.role, "resident");
  localStorage.setItem(STORAGE_KEYS.completed, String(completed));
  localStorage.setItem(STORAGE_KEYS.welcomed, "true");
}

function renderApp() {
  return render(
    <MemoryRouter>
      <OnboardingGate>
        <Index />
      </OnboardingGate>
    </MemoryRouter>,
  );
}

describe("App — resident onboarding-role trap (real gate + real router)", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("the original trap: stored resident role + no session shows the info screen, not the login", () => {
    storeResidentOnboarding(true);
    setAuth("unauthenticated");
    renderApp();
    expect(screen.getByTestId("resident-not-available")).toBeInTheDocument();
    expect(screen.queryByTestId("iface-login")).not.toBeInTheDocument();
  });

  it("'Staff sign in' reaches the login in one tap; the gate does not re-open the picker", () => {
    storeResidentOnboarding(true);
    setAuth("unauthenticated");
    renderApp();

    fireEvent.click(screen.getByTestId("resident-staff-sign-in"));

    expect(screen.getByTestId("iface-login")).toBeInTheDocument();
    expect(screen.queryByTestId("resident-not-available")).not.toBeInTheDocument();
    expect(screen.queryByTestId("role-resident")).not.toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEYS.role)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.completed)).toBe("true");
  });

  it("a Help Center replay after the exit goes to the role picker, not back to the resident tutorial", () => {
    storeResidentOnboarding(true);
    setAuth("unauthenticated");
    renderApp();
    fireEvent.click(screen.getByTestId("resident-staff-sign-in"));

    fireEvent.click(screen.getByTestId("help-button"));
    fireEvent.click(screen.getByTestId("help-replay-tutorial"));

    expect(screen.getByTestId("role-guard")).toBeInTheDocument();
    expect(screen.queryByTestId("resident-not-available")).not.toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEYS.role)).toBeNull();
  });

  it("stored resident role never hides an authenticated guard session", () => {
    storeResidentOnboarding(true);
    setAuth("authenticated", "guard");
    renderApp();
    expect(screen.getByTestId("iface-guard")).toBeInTheDocument();
    expect(screen.queryByTestId("resident-not-available")).not.toBeInTheDocument();
  });

  it("an unfinished resident walkthrough completes into the guard console, not the resident screen", () => {
    storeResidentOnboarding(false);
    setAuth("authenticated", "guard");
    renderApp();

    // The gate still owns the screen while the walkthrough is incomplete…
    expect(screen.queryByTestId("iface-guard")).not.toBeInTheDocument();
    for (let i = 0; i < 20 && !screen.queryByTestId("onboarding-finish"); i++) {
      fireEvent.click(screen.getByTestId("onboarding-next"));
    }
    fireEvent.click(screen.getByTestId("onboarding-finish"));

    // …and the moment it hands over, the DB-verified session wins.
    expect(screen.getByTestId("iface-guard")).toBeInTheDocument();
    expect(screen.queryByTestId("resident-not-available")).not.toBeInTheDocument();
  });
});
