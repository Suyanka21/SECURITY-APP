import type { LucideIcon } from "lucide-react";

export type StakeholderRole = "guard" | "resident" | "admin";

export type OnboardingStep = {
  id: string;
  title: string;
  explanation: string;
  /** Optional bullet points displayed below the explanation. */
  details?: string[];
  /** "Now you try:" interactive task description. */
  practicePrompt?: string;
  /** Shown after the user completes the practice action. */
  successMessage?: string;
  icon?: LucideIcon;
};

export type OnboardingState = {
  role: StakeholderRole | null;
  completed: boolean;
  currentStep: number;
};

/** localStorage keys used by the onboarding system. */
export const STORAGE_KEYS = {
  role: "gatepass_role",
  completed: "gatepass_onboarding_complete",
  step: "gatepass_onboarding_step",
} as const;
