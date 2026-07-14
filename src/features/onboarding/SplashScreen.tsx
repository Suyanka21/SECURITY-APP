import { ShieldCheck, QrCode, ClipboardList, ArrowRight } from "lucide-react";

type SplashScreenProps = {
  onContinue: () => void;
};

const HIGHLIGHTS: { icon: typeof ShieldCheck; label: string }[] = [
  { icon: ShieldCheck, label: "Control who enters" },
  { icon: QrCode, label: "Scan & issue QR passes" },
  { icon: ClipboardList, label: "Full audit trail" },
];

/**
 * First-run welcome screen. Introduces the product before the role picker so a
 * first-time user understands what GatePass is before being asked to choose a
 * role. Dismissal is persisted (STORAGE_KEYS.welcomed) so it shows once.
 */
export function SplashScreen({ onContinue }: SplashScreenProps) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
      <div className="mx-auto w-full max-w-lg text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <ShieldCheck className="h-9 w-9" aria-hidden="true" />
        </div>

        <p className="text-xs font-bold uppercase tracking-widest text-primary">
          GatePass
        </p>
        <h1 className="mt-2 font-display text-3xl font-bold text-foreground md:text-4xl">
          Visitor Management &amp; Security Operations
        </h1>
        <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-muted-foreground md:text-base">
          GatePass is the platform estates use to log every visitor, approve
          entries in real time, and keep an accountable record of who came and
          went — for guards, residents, and administrators alike.
        </p>

        <ul className="mx-auto mt-8 grid max-w-md grid-cols-1 gap-3 sm:grid-cols-3">
          {HIGHLIGHTS.map(({ icon: Icon, label }) => (
            <li
              key={label}
              className="flex flex-col items-center gap-2 border border-border bg-card p-4 text-xs font-medium text-foreground shadow-panel"
            >
              <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
              {label}
            </li>
          ))}
        </ul>

        <button
          type="button"
          onClick={onContinue}
          data-testid="splash-continue"
          className="focus-ring group mt-8 inline-flex items-center justify-center gap-2 bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground shadow-panel transition-colors hover:bg-primary/90"
        >
          Get started
          <ArrowRight
            className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        </button>
      </div>
    </main>
  );
}
