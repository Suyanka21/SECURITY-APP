import { afterEach, describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useOnboarding } from "../useOnboarding";
import { STORAGE_KEYS } from "../types";

function clearStorage() {
  localStorage.removeItem(STORAGE_KEYS.role);
  localStorage.removeItem(STORAGE_KEYS.completed);
  localStorage.removeItem(STORAGE_KEYS.step);
}

describe("useOnboarding", () => {
  afterEach(clearStorage);

  it("starts with no role and not completed", () => {
    const { result } = renderHook(() => useOnboarding());
    expect(result.current.state.role).toBeNull();
    expect(result.current.state.completed).toBe(false);
    expect(result.current.state.currentStep).toBe(0);
  });

  it("selectRole persists to localStorage and loads steps", () => {
    const { result } = renderHook(() => useOnboarding());
    act(() => result.current.selectRole("guard"));
    expect(result.current.state.role).toBe("guard");
    expect(result.current.steps.length).toBeGreaterThan(0);
    expect(localStorage.getItem(STORAGE_KEYS.role)).toBe("guard");
  });

  it("nextStep advances and persists", () => {
    const { result } = renderHook(() => useOnboarding());
    act(() => result.current.selectRole("resident"));
    expect(result.current.state.currentStep).toBe(0);
    act(() => result.current.nextStep());
    expect(result.current.state.currentStep).toBe(1);
    expect(localStorage.getItem(STORAGE_KEYS.step)).toBe("1");
  });

  it("prevStep does not go below 0", () => {
    const { result } = renderHook(() => useOnboarding());
    act(() => result.current.selectRole("admin"));
    act(() => result.current.prevStep());
    expect(result.current.state.currentStep).toBe(0);
  });

  it("nextStep past last step marks onboarding complete", () => {
    const { result } = renderHook(() => useOnboarding());
    act(() => result.current.selectRole("guard"));
    const totalSteps = result.current.steps.length;
    for (let i = 0; i < totalSteps; i++) {
      act(() => result.current.nextStep());
    }
    expect(result.current.state.completed).toBe(true);
    expect(localStorage.getItem(STORAGE_KEYS.completed)).toBe("true");
  });

  it("completeOnboarding marks done immediately", () => {
    const { result } = renderHook(() => useOnboarding());
    act(() => result.current.selectRole("guard"));
    act(() => result.current.completeOnboarding());
    expect(result.current.state.completed).toBe(true);
  });

  it("replayOnboarding resets step to 0 but keeps role", () => {
    const { result } = renderHook(() => useOnboarding());
    act(() => result.current.selectRole("admin"));
    act(() => result.current.completeOnboarding());
    expect(result.current.state.completed).toBe(true);
    act(() => result.current.replayOnboarding());
    expect(result.current.state.completed).toBe(false);
    expect(result.current.state.currentStep).toBe(0);
    expect(result.current.state.role).toBe("admin");
  });

  it("resetOnboarding clears everything", () => {
    const { result } = renderHook(() => useOnboarding());
    act(() => result.current.selectRole("resident"));
    act(() => result.current.completeOnboarding());
    act(() => result.current.resetOnboarding());
    expect(result.current.state.role).toBeNull();
    expect(result.current.state.completed).toBe(false);
    expect(result.current.state.currentStep).toBe(0);
    expect(localStorage.getItem(STORAGE_KEYS.role)).toBeNull();
  });

  it("resumes from localStorage on remount", () => {
    localStorage.setItem(STORAGE_KEYS.role, "guard");
    localStorage.setItem(STORAGE_KEYS.step, "3");
    const { result } = renderHook(() => useOnboarding());
    expect(result.current.state.role).toBe("guard");
    expect(result.current.state.currentStep).toBe(3);
  });

  it("returns correct currentStep object", () => {
    const { result } = renderHook(() => useOnboarding());
    act(() => result.current.selectRole("guard"));
    expect(result.current.currentStep).not.toBeNull();
    expect(result.current.currentStep?.id).toBe("guard-welcome");
  });

  it("loads different step counts per role", () => {
    const { result } = renderHook(() => useOnboarding());
    act(() => result.current.selectRole("guard"));
    const guardCount = result.current.totalSteps;
    act(() => result.current.resetOnboarding());
    act(() => result.current.selectRole("resident"));
    const residentCount = result.current.totalSteps;
    act(() => result.current.resetOnboarding());
    act(() => result.current.selectRole("admin"));
    const adminCount = result.current.totalSteps;

    expect(guardCount).toBeGreaterThan(0);
    expect(residentCount).toBeGreaterThan(0);
    expect(adminCount).toBeGreaterThan(0);
    // Admin has more steps than resident (7 topics + welcome + complete vs 5 topics + welcome + complete)
    expect(adminCount).toBeGreaterThan(residentCount);
  });
});
