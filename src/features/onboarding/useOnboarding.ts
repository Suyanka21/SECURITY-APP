import { useCallback, useMemo, useSyncExternalStore } from "react";
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

/**
 * One in-memory onboarding state shared by every `useOnboarding()` caller.
 * The gate and the router both consume this hook; if each held its own copy,
 * a reset in one would leave the other acting on the stale role. The cache is
 * dropped when the last subscriber unmounts so a fresh mount re-reads storage.
 */
let cached: OnboardingState | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): OnboardingState {
  if (cached === null) cached = readStorage();
  return cached;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) cached = null;
  };
}

function commit(next: OnboardingState): void {
  writeStorage(next);
  cached = next;
  listeners.forEach((listener) => listener());
}

function update(reducer: (prev: OnboardingState) => OnboardingState): void {
  commit(reducer(getSnapshot()));
}

export function useOnboarding() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const steps = useMemo(
    () => (state.role ? getStepsForRole(state.role) : []),
    [state.role],
  );

  const totalSteps = steps.length;

  const selectRole = useCallback((role: StakeholderRole) => {
    commit({ role, completed: false, currentStep: 0 });
  }, []);

  const nextStep = useCallback(() => {
    update((prev) => {
      const next = prev.currentStep + 1;
      const stepsCount = prev.role ? getStepsForRole(prev.role).length : 0;
      if (next >= stepsCount) {
        return { ...prev, completed: true, currentStep: stepsCount - 1 };
      }
      return { ...prev, currentStep: next };
    });
  }, []);

  const prevStep = useCallback(() => {
    update((prev) => ({ ...prev, currentStep: Math.max(0, prev.currentStep - 1) }));
  }, []);

  const completeOnboarding = useCallback(() => {
    update((prev) => ({ ...prev, completed: true }));
  }, []);

  const resetOnboarding = useCallback(() => {
    commit({ role: null, completed: false, currentStep: 0 });
    try { localStorage.removeItem(STORAGE_KEYS.completed); } catch { /* noop */ }
    try { localStorage.removeItem(STORAGE_KEYS.step); } catch { /* noop */ }
  }, []);

  /** Skip straight to the app with no stored role; the tutorial stays
   *  available from the Help Center, which sends the user back to the picker. */
  const skipOnboarding = useCallback(() => {
    commit({ role: null, completed: true, currentStep: 0 });
  }, []);

  const replayOnboarding = useCallback(() => {
    update((prev) => ({ role: prev.role, completed: false, currentStep: 0 }));
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
    skipOnboarding,
    replayOnboarding,
  };
}
