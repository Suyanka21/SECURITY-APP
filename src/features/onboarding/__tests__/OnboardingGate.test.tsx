import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { OnboardingGate } from "../OnboardingGate";
import { STORAGE_KEYS } from "../types";

function clearStorage() {
  localStorage.removeItem(STORAGE_KEYS.role);
  localStorage.removeItem(STORAGE_KEYS.completed);
  localStorage.removeItem(STORAGE_KEYS.step);
}

function renderGate() {
  return render(
    <MemoryRouter>
      <OnboardingGate>
        <div data-testid="main-app">GatePass App</div>
      </OnboardingGate>
    </MemoryRouter>,
  );
}

describe("OnboardingGate", () => {
  afterEach(clearStorage);

  it("shows role selection on first launch", () => {
    renderGate();
    expect(screen.getByText("Who are you?")).toBeInTheDocument();
    expect(screen.getByTestId("role-guard")).toBeInTheDocument();
    expect(screen.getByTestId("role-resident")).toBeInTheDocument();
    expect(screen.getByTestId("role-admin")).toBeInTheDocument();
  });

  it("shows walkthrough after selecting a role", () => {
    renderGate();
    fireEvent.click(screen.getByTestId("role-guard"));
    expect(screen.getByText("Welcome to GatePass")).toBeInTheDocument();
    expect(screen.getByText(/1 \/ /)).toBeInTheDocument();
  });

  it("advances through steps with Continue button", () => {
    renderGate();
    fireEvent.click(screen.getByTestId("role-guard"));
    expect(screen.getByText("Welcome to GatePass")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("onboarding-next"));
    expect(screen.getByText(/Scenario 1/)).toBeInTheDocument();
  });

  it("Back button goes to previous step", () => {
    renderGate();
    fireEvent.click(screen.getByTestId("role-guard"));
    fireEvent.click(screen.getByTestId("onboarding-next"));
    expect(screen.getByText(/Scenario 1/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Back"));
    expect(screen.getByText("Welcome to GatePass")).toBeInTheDocument();
  });

  it("shows main app after completing onboarding", () => {
    localStorage.setItem(STORAGE_KEYS.role, "guard");
    localStorage.setItem(STORAGE_KEYS.completed, "true");
    renderGate();
    expect(screen.getByTestId("main-app")).toBeInTheDocument();
    expect(screen.getByTestId("help-button")).toBeInTheDocument();
  });

  it("shows help center when Help button clicked", () => {
    localStorage.setItem(STORAGE_KEYS.role, "guard");
    localStorage.setItem(STORAGE_KEYS.completed, "true");
    renderGate();
    fireEvent.click(screen.getByTestId("help-button"));
    expect(screen.getByText("Help Center")).toBeInTheDocument();
  });

  it("help center has all sections", () => {
    localStorage.setItem(STORAGE_KEYS.role, "guard");
    localStorage.setItem(STORAGE_KEYS.completed, "true");
    renderGate();
    fireEvent.click(screen.getByTestId("help-button"));
    expect(screen.getByTestId("help-guard-guide")).toBeInTheDocument();
    expect(screen.getByTestId("help-resident-guide")).toBeInTheDocument();
    expect(screen.getByTestId("help-admin-guide")).toBeInTheDocument();
    expect(screen.getByTestId("help-offline-mode")).toBeInTheDocument();
    expect(screen.getByTestId("help-qr-entry")).toBeInTheDocument();
    expect(screen.getByTestId("help-override-entry")).toBeInTheDocument();
    expect(screen.getByTestId("help-delivery-management")).toBeInTheDocument();
    expect(screen.getByTestId("help-exit-tracking")).toBeInTheDocument();
    expect(screen.getByTestId("help-troubleshooting")).toBeInTheDocument();
    expect(screen.getByTestId("help-replay-tutorial")).toBeInTheDocument();
  });

  it("replay tutorial restarts onboarding from step 0", () => {
    localStorage.setItem(STORAGE_KEYS.role, "admin");
    localStorage.setItem(STORAGE_KEYS.completed, "true");
    renderGate();
    fireEvent.click(screen.getByTestId("help-button"));
    fireEvent.click(screen.getByTestId("help-replay-tutorial"));
    expect(screen.getByText("Welcome to GatePass Administration")).toBeInTheDocument();
  });

  it("help center section drill-down works", () => {
    localStorage.setItem(STORAGE_KEYS.role, "guard");
    localStorage.setItem(STORAGE_KEYS.completed, "true");
    renderGate();
    fireEvent.click(screen.getByTestId("help-button"));
    fireEvent.click(screen.getByTestId("help-troubleshooting"));
    expect(screen.getByText("Troubleshooting")).toBeInTheDocument();
    expect(screen.getByText(/AUTH_FORBIDDEN/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Back to all topics"));
    expect(screen.getByTestId("help-guard-guide")).toBeInTheDocument();
  });

  it("resident onboarding has correct steps", () => {
    renderGate();
    fireEvent.click(screen.getByTestId("role-resident"));
    expect(screen.getByText("Welcome to GatePass")).toBeInTheDocument();
    // Navigate through all steps
    fireEvent.click(screen.getByTestId("onboarding-next"));
    expect(screen.getByText(/Approvals Protect/)).toBeInTheDocument();
  });

  it("admin onboarding has correct steps", () => {
    renderGate();
    fireEvent.click(screen.getByTestId("role-admin"));
    expect(screen.getByText("Welcome to GatePass Administration")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("onboarding-next"));
    expect(screen.getByText(/Dashboard Overview/)).toBeInTheDocument();
  });

  it("complete guard walkthrough end-to-end", () => {
    renderGate();
    fireEvent.click(screen.getByTestId("role-guard"));

    // Walk through all steps: welcome + 7 scenarios + completion = 9 steps
    // Click Continue 8 times (welcome to errors), then Finish
    for (let i = 0; i < 8; i++) {
      fireEvent.click(screen.getByTestId("onboarding-next"));
    }
    // Now on the final step, should see Finish button
    expect(screen.getByTestId("onboarding-finish")).toBeInTheDocument();
    expect(screen.getByText(/ready to begin your shift/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("onboarding-finish"));
    // Should now show the main app
    expect(screen.getByTestId("main-app")).toBeInTheDocument();
  });
});
