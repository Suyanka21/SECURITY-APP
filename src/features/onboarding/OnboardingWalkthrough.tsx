import { ArrowLeft, ArrowRight, CheckCircle2 } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import type { OnboardingStep, StakeholderRole } from "./types";

type OnboardingWalkthroughProps = {
  role: StakeholderRole;
  steps: OnboardingStep[];
  currentStepIndex: number;
  onNext: () => void;
  onPrev: () => void;
  onComplete: () => void;
};

const ROLE_LABELS: Record<StakeholderRole, string> = {
  guard: "Guard Onboarding",
  resident: "Resident Onboarding",
  admin: "Administrator Onboarding",
};

export function OnboardingWalkthrough({
  role,
  steps,
  currentStepIndex,
  onNext,
  onPrev,
  onComplete,
}: OnboardingWalkthroughProps) {
  const step = steps[currentStepIndex];
  // Defensive no-op: useOnboarding guarantees a clamped index, so this is unreachable
  if (!step) return null;

  const isFirst = currentStepIndex === 0;
  const isLast = currentStepIndex === steps.length - 1;
  const progressPercent = ((currentStepIndex + 1) / steps.length) * 100;

  const Icon = step.icon;

  return (
    <main className="flex min-h-screen flex-col bg-background px-4 py-6 md:py-8">
      <div className="mx-auto w-full max-w-2xl flex-1">
        {/* Header with progress */}
        <header className="mb-6">
          <p className="text-xs font-bold uppercase tracking-widest text-primary">
            {ROLE_LABELS[role]}
          </p>
          <div className="mt-3 flex items-center gap-3">
            <Progress
              value={progressPercent}
              className="h-2 flex-1"
              aria-label={`Step ${currentStepIndex + 1} of ${steps.length}`}
            />
            <span className="shrink-0 text-xs font-semibold text-muted-foreground">
              {currentStepIndex + 1} / {steps.length}
            </span>
          </div>
        </header>

        {/* Step content */}
        <section
          className="border border-border bg-card p-6 shadow-panel md:p-8"
          data-testid={`onboarding-step-${step.id}`}
        >
          <div className="flex items-start gap-4">
            {Icon && (
              <div className="flex h-10 w-10 shrink-0 items-center justify-center border border-primary/20 bg-primary/5">
                <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
              </div>
            )}
            <div className="flex-1">
              <h2 className="font-display text-xl font-bold text-foreground md:text-2xl">
                {step.title}
              </h2>
            </div>
          </div>

          <p className="mt-4 text-sm leading-relaxed text-foreground">
            {step.explanation}
          </p>

          {step.details && step.details.length > 0 && (
            <ul className="mt-4 grid gap-2">
              {step.details.map((detail, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 text-sm text-muted-foreground"
                >
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/40" />
                  {detail}
                </li>
              ))}
            </ul>
          )}

          {step.practicePrompt && (
            <div className="mt-5 border-l-4 border-primary/30 bg-primary/5 p-4">
              <p className="text-xs font-bold uppercase tracking-widest text-primary">
                Now you try
              </p>
              <p className="mt-1 text-sm text-foreground">
                {step.practicePrompt}
              </p>
            </div>
          )}

          {step.successMessage && (
            <div className="mt-4 flex items-start gap-2 text-sm text-success">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <p>{step.successMessage}</p>
            </div>
          )}
        </section>

        {/* Navigation */}
        <nav className="mt-6 flex items-center justify-between" aria-label="Onboarding navigation">
          <button
            type="button"
            className="focus-ring flex items-center gap-2 border border-border px-4 py-3 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
            disabled={isFirst}
            onClick={onPrev}
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back
          </button>

          {isLast ? (
            <button
              type="button"
              className="focus-ring flex items-center gap-2 bg-primary px-6 py-3 text-sm font-bold text-primary-foreground shadow-panel transition-transform hover:-translate-y-0.5"
              onClick={onComplete}
              data-testid="onboarding-finish"
            >
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              Finish
            </button>
          ) : (
            <button
              type="button"
              className="focus-ring flex items-center gap-2 bg-primary px-6 py-3 text-sm font-bold text-primary-foreground shadow-panel transition-transform hover:-translate-y-0.5"
              onClick={onNext}
              data-testid="onboarding-next"
            >
              Continue
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </nav>
      </div>
    </main>
  );
}
