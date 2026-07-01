import { useCallback, useMemo, useState } from "react";
import type { OnboardingState, OnboardingStep, StakeholderRole } from "./types";
import { STORAGE_KEYS } from "./types";
import { getGuardSteps } from "./steps/guardSteps";
import { getResidentSteps } from "./steps/residentSteps";
import { getAdminSteps } from "./steps/adminSteps";

const VALID_ROLES: ReadonlySet<string> = new Set<string>(["guard", "resident", "admin"]);

function readStorage(): OnboardingState {
  try {
    const rawRole = localStorage.getItem(STORAGE_KEYS.role);
    const role: StakeholderRole | null =
      rawRole !== null && VALID_ROLES.has(rawRole)
        ? (rawRole as StakeholderRole)
        : null;
    const completed = localStorage.getItem(STORAGE_KEYS.completed) === "true";
    const rawStep = parseInt(localStorage.getItem(STORAGE_KEYS.step) ?? "0", 10);
    const parsedStep = isNaN(rawStep) ? 0 : rawStep;

    // Clamp currentStep to valid range for the resolved role
    const maxStep = role ? getStepsForRole(role).length - 1 : 0;
    const currentStep = Math.max(0, Math.min(parsedStep, maxStep));

    return { role, completed, currentStep };
  } catch {
    return { role: null, completed: false, currentStep: 0 };
  }
}

function writeStorage(state: Partial<OnboardingState>): void {
  try {
    if (state.role !== undefined) {
      if (state.role === null) {
        localStorage.removeItem(STORAGE_KEYS.role);
      } else {
        localStorage.setItem(STORAGE_KEYS.role, state.role);
      }
    }
    if (state.completed !== undefined) {
      localStorage.setItem(STORAGE_KEYS.completed, String(state.completed));
    }
    if (state.currentStep !== undefined) {
      localStorage.setItem(STORAGE_KEYS.step, String(state.currentStep));
    }
  } catch {
    // localStorage unavailable (private browsing, quota exceeded) — degrade gracefully
  }
}

function getStepsForRole(role: StakeholderRole): OnboardingStep[] {
  switch (role) {
    case "guard":
      return getGuardSteps();
    case "resident":
      return getResidentSteps();
    case "admin":
      return getAdminSteps();
  }
}

export function useOnboarding() {
  const [state, setState] = useState<OnboardingState>(readStorage);

  const steps = useMemo(
    () => (state.role ? getStepsForRole(state.role) : []),
    [state.role],
  );

  const totalSteps = steps.length;

  const selectRole = useCallback((role: StakeholderRole) => {
    const next: OnboardingState = { role, completed: false, currentStep: 0 };
    writeStorage(next);
    setState(next);
  }, []);

  const nextStep = useCallback(() => {
    setState((prev) => {
      const next = prev.currentStep + 1;
      const stepsCount = prev.role ? getStepsForRole(prev.role).length : 0;
      if (next >= stepsCount) {
        const finished: OnboardingState = {
          ...prev,
          completed: true,
          currentStep: stepsCount - 1,
        };
        writeStorage(finished);
        return finished;
      }
      writeStorage({ currentStep: next });
      return { ...prev, currentStep: next };
    });
  }, []);

  const prevStep = useCallback(() => {
    setState((prev) => {
      const next = Math.max(0, prev.currentStep - 1);
      writeStorage({ currentStep: next });
      return { ...prev, currentStep: next };
    });
  }, []);

  const completeOnboarding = useCallback(() => {
    setState((prev) => {
      const finished: OnboardingState = { ...prev, completed: true };
      writeStorage(finished);
      return finished;
    });
  }, []);

  const resetOnboarding = useCallback(() => {
    const fresh: OnboardingState = { role: null, completed: false, currentStep: 0 };
    writeStorage(fresh);
    // Also clear the completed flag explicitly
    try { localStorage.removeItem(STORAGE_KEYS.completed); } catch { /* noop */ }
    try { localStorage.removeItem(STORAGE_KEYS.step); } catch { /* noop */ }
    setState(fresh);
  }, []);

  const replayOnboarding = useCallback(() => {
    setState((prev) => {
      const replaying: OnboardingState = {
        role: prev.role,
        completed: false,
        currentStep: 0,
      };
      writeStorage(replaying);
      return replaying;
    });
  }, []);

  return {
    state,
    steps,
    totalSteps,
    currentStep: steps[state.currentStep] ?? null,
    selectRole,
    nextStep,
    prevStep,
    completeOnboarding,
    resetOnboarding,
    replayOnboarding,
  };
}
