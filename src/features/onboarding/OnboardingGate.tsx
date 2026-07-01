import type { ReactNode } from "react";
import { useState } from "react";
import { HelpCircle } from "lucide-react";
import { useOnboarding } from "./useOnboarding";
import { RoleSelection } from "./RoleSelection";
import { OnboardingWalkthrough } from "./OnboardingWalkthrough";
import { HelpCenter } from "./HelpCenter";

type OnboardingGateProps = {
  children: ReactNode;
};

/**
 * Wraps the main application. On first launch (no role selected or
 * onboarding incomplete), renders the onboarding flow instead of the
 * app. After completion, renders children (the GatePass app) with a
 * persistent Help button in the nav.
 */
export function OnboardingGate({ children }: OnboardingGateProps) {
  const {
    state,
    steps,
    selectRole,
    nextStep,
    prevStep,
    completeOnboarding,
    replayOnboarding,
  } = useOnboarding();

  const [showHelp, setShowHelp] = useState(false);

  // Phase 1: No role selected → show role picker
  if (!state.role) {
    return <RoleSelection onSelect={selectRole} />;
  }

  // Phase 2: Role selected but onboarding incomplete → show walkthrough
  if (!state.completed) {
    return (
      <OnboardingWalkthrough
        role={state.role}
        steps={steps}
        currentStepIndex={state.currentStep}
        onNext={nextStep}
        onPrev={prevStep}
        onComplete={completeOnboarding}
      />
    );
  }

  // Phase 3: Help center open
  if (showHelp) {
    return (
      <HelpCenter
        onClose={() => setShowHelp(false)}
        onReplayTutorial={() => {
          setShowHelp(false);
          replayOnboarding();
        }}
      />
    );
  }

  // Phase 4: Onboarding complete → show app with Help button
  return (
    <div className="relative">
      {children}
      <button
        type="button"
        className="focus-ring fixed bottom-4 right-4 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105"
        onClick={() => setShowHelp(true)}
        aria-label="Open help center"
        data-testid="help-button"
      >
        <HelpCircle className="h-6 w-6" />
      </button>
    </div>
  );
}
