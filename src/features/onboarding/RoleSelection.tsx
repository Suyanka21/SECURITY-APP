import { LayoutDashboard, ShieldCheck, UserCheck } from "lucide-react";
import type { StakeholderRole } from "./types";

const ROLES: { role: StakeholderRole; label: string; description: string; icon: typeof ShieldCheck }[] = [
  {
    role: "guard",
    label: "Security Guard",
    description: "I record visitor entries, scan QR codes, and enforce gate access decisions.",
    icon: ShieldCheck,
  },
  {
    role: "resident",
    label: "Resident / Host",
    description: "I approve or deny visitors, manage auto-rules, and issue QR passes.",
    icon: UserCheck,
  },
  {
    role: "admin",
    label: "Security Company Administrator",
    description: "I audit all activity, review shift logs, and manage estate security operations.",
    icon: LayoutDashboard,
  },
];

type RoleSelectionProps = {
  onSelect: (role: StakeholderRole) => void;
};

export function RoleSelection({ onSelect }: RoleSelectionProps) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
      <div className="mx-auto w-full max-w-2xl">
        <header className="mb-8 text-center">
          <p className="text-xs font-bold uppercase tracking-widest text-primary">
            GatePass
          </p>
          <h1 className="mt-2 font-display text-3xl font-bold text-foreground md:text-4xl">
            Who are you?
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Select your role to begin a guided walkthrough of GatePass.
          </p>
        </header>

        <div className="grid gap-4">
          {ROLES.map(({ role, label, description, icon: Icon }) => (
            <button
              key={role}
              type="button"
              className="focus-ring group flex items-start gap-4 border border-border bg-card p-5 text-left shadow-panel transition-all hover:border-primary hover:shadow-md"
              onClick={() => onSelect(role)}
              data-testid={`role-${role}`}
            >
              <div className="flex h-12 w-12 shrink-0 items-center justify-center border border-border bg-background transition-colors group-hover:border-primary group-hover:bg-primary/5">
                <Icon
                  className="h-6 w-6 text-muted-foreground transition-colors group-hover:text-primary"
                  aria-hidden="true"
                />
              </div>
              <div>
                <h2 className="font-display text-lg font-bold text-foreground">
                  {label}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {description}
                </p>
              </div>
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}
