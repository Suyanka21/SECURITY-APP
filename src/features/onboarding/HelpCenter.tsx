import { useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  Bell,
  CheckCircle2,
  FileSearch,
  HelpCircle,
  LayoutDashboard,
  LogOut,
  Package,
  QrCode,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Timer,
  UserCheck,
  Users,
  WifiOff,
  X as XIcon,
} from "lucide-react";

type HelpSection = {
  id: string;
  title: string;
  icon: typeof ShieldCheck;
  content: string[];
};

const HELP_SECTIONS: HelpSection[] = [
  {
    id: "guard-guide",
    title: "Guard Guide",
    icon: ShieldCheck,
    content: [
      "Your primary role: record every entry and enforce resident decisions.",
      "Walk-In: Fill in visitor details, request resident approval, wait for response, confirm entry.",
      "QR Scan: Visitor shows QR → you scan → entry confirmed if valid.",
      "Override: For emergencies. Must include a written reason. Flagged for admin review.",
      "Recognized: Search for frequent visitors by name to speed up processing.",
      "When in doubt, request resident approval. When it's urgent, use Override.",
    ],
  },
  {
    id: "resident-guide",
    title: "Resident Guide",
    icon: UserCheck,
    content: [
      "You control who enters. Every visitor needs your explicit approval.",
      "When a visitor arrives, you receive a WhatsApp/SMS notification.",
      "Tap the link to see visitor details and choose Approve or Deny.",
      "If denying, provide a brief reason so the guard can inform the visitor.",
      "Each link decides one arrival — there's no resident account or dashboard.",
      "For frequent or expected visitors, ask your administrator about auto-approvals or QR passes.",
    ],
  },
  {
    id: "admin-guide",
    title: "Administrator Guide",
    icon: LayoutDashboard,
    content: [
      "The Admin panel is your command center for estate security.",
      "Dashboard: entries logged, pending sync, override flags, auto-approved.",
      "Shift log: per-guard entry summaries with method breakdowns.",
      "Visitor profiles: manage the recognition directory and WATCH flags.",
      "On-premise: real-time view of everyone currently inside the estate.",
      "Deliveries: separate log for parcel, food, gas, water, and service entries.",
      "All actions are recorded with Trace IDs for incident investigation.",
    ],
  },
  {
    id: "offline-mode",
    title: "Offline Mode",
    icon: WifiOff,
    content: [
      "GatePass works even when the internet drops.",
      "Entries are stored locally in the offline queue.",
      "The banner shows 'Gate station offline' when disconnected.",
      "The Sync badge shows how many entries are waiting to upload.",
      "When internet returns, synchronization happens automatically.",
      "Nothing is ever lost — every offline entry is preserved.",
    ],
  },
  {
    id: "notifications",
    title: "Notifications",
    icon: Bell,
    content: [
      "Residents receive WhatsApp or SMS notifications when a visitor arrives.",
      "The notification contains a secure link to approve or deny.",
      "If delivery fails, the guard can resend the notification.",
      "A 30-second cooldown prevents notification spam.",
      "If the resident doesn't respond in time, the approval expires.",
    ],
  },
  {
    id: "qr-entry",
    title: "QR Entry",
    icon: QrCode,
    content: [
      "QR passes are single-use, time-limited credentials for expected visitors.",
      "Estate staff (admins/senior guards) issue them from the 'Invite visitor' form.",
      "The visitor shows the QR at the gate; the guard scans it.",
      "If valid: entry is confirmed instantly.",
      "If expired: QR_EXPIRED error. Visitor needs a new pass.",
      "If already used: QR_CONSUMED error. QR codes are single-use.",
      "If tampered: QR_INVALID error. Do not allow entry.",
    ],
  },
  {
    id: "approvals",
    title: "Approvals",
    icon: CheckCircle2,
    content: [
      "The approval flow: guard requests → resident decides → entry logged or denied.",
      "Only one approval can be in-flight per guard at a time.",
      "Approval statuses: pending, approved, denied, expired.",
      "Denied entries must include a reason from the resident.",
      "Expired approvals require the guard to start over.",
      "Auto-approval rules skip the manual flow when a matching rule exists.",
    ],
  },
  {
    id: "override-entry",
    title: "Override Entry",
    icon: ShieldAlert,
    content: [
      "Override is an emergency entry method that bypasses resident approval.",
      "A written reason is REQUIRED — the system blocks override without one.",
      "Override entries are flagged in the audit log for administrator review.",
      "Use overrides only for genuine emergencies.",
      "Administrators see override counts in the shift log.",
      "Excessive overrides may indicate training issues or security concerns.",
    ],
  },
  {
    id: "delivery-management",
    title: "Delivery Management",
    icon: Package,
    content: [
      "Deliveries are tracked separately from visitor entries.",
      "Categories: parcel, food, gas, water, service, other.",
      "Guards log deliveries from the Deliveries section in the Admin panel.",
      "Each delivery records: rider name, unit, category, plate, and entry method.",
      "Administrators can review delivery patterns per unit.",
    ],
  },
  {
    id: "exit-tracking",
    title: "Exit Tracking",
    icon: LogOut,
    content: [
      "Entry-to-exit lifecycle tracking shows who is currently on-premise.",
      "'Currently on-premise' lists everyone who has entered but not yet exited.",
      "Click 'Record exit' when someone leaves.",
      "The system blocks exits without matching open entries (no orphan records).",
      "On-premise data is critical for emergency evacuation response.",
    ],
  },
  {
    id: "visitor-profiles",
    title: "Visitor Profiles",
    icon: Users,
    content: [
      "Profiles are stored in the visitor directory for recognition.",
      "WATCH flag: marks individuals requiring extra scrutiny.",
      "Soft-delete: removes a profile but keeps the data (recoverable).",
      "Restore: brings back a soft-deleted profile.",
      "Only admin tokens can modify profiles — guard tokens are rejected.",
    ],
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    icon: AlertTriangle,
    content: [
      "AUTH_FORBIDDEN (403) — You don't have permission for this action. Check your role.",
      "INTERNAL_ERROR (500) — Server error. Your data is safe; entry saved offline if applicable.",
      "PROFILE_DUPLICATE (409) — A profile with this name and unit already exists.",
      "PROFILE_RESTORE_CONFLICT (409) — Tried to restore a profile that isn't deleted.",
      "QR_CONSUMED (410) — QR code already used. Ask resident for a new one.",
      "QR_EXPIRED (410) — QR code timed out. Ask resident to reissue.",
      "QR_INVALID — QR code is tampered or unrecognized. Do NOT allow entry.",
      "EXIT_NO_OPEN_ENTRY (404) — Tried to exit someone who has no open entry.",
      "EXIT_ALREADY_RECORDED (409) — Exit was already recorded for this entry.",
      "RATE_LIMITED (429) — Too many retries. Wait and try again.",
      "Every error includes a Trace ID — share it with your administrator for investigation.",
    ],
  },
];

type HelpCenterProps = {
  onClose: () => void;
  onReplayTutorial: () => void;
};

export function HelpCenter({ onClose, onReplayTutorial }: HelpCenterProps) {
  const [activeSection, setActiveSection] = useState<string | null>(null);

  const section = HELP_SECTIONS.find((s) => s.id === activeSection);

  return (
    <main className="flex min-h-screen flex-col bg-background px-4 py-6 md:py-8">
      <div className="mx-auto w-full max-w-2xl flex-1">
        {/* Header */}
        <header className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <HelpCircle className="h-6 w-6 text-primary" aria-hidden="true" />
            <h1 className="font-display text-2xl font-bold text-foreground">
              Help Center
            </h1>
          </div>
          <button
            type="button"
            className="focus-ring border border-border p-2 text-muted-foreground transition-colors hover:text-foreground"
            onClick={onClose}
            aria-label="Close help center"
          >
            <XIcon className="h-5 w-5" />
          </button>
        </header>

        {section ? (
          /* Section detail view */
          <div>
            <button
              type="button"
              className="focus-ring mb-4 flex items-center gap-2 text-sm font-semibold text-primary"
              onClick={() => setActiveSection(null)}
            >
              <ArrowLeft className="h-4 w-4" />
              Back to all topics
            </button>
            <section className="border border-border bg-card p-6 shadow-panel">
              <div className="flex items-center gap-3 mb-4">
                <section.icon className="h-5 w-5 text-primary" aria-hidden="true" />
                <h2 className="font-display text-xl font-bold text-foreground">
                  {section.title}
                </h2>
              </div>
              <ul className="grid gap-3">
                {section.content.map((item, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-sm text-muted-foreground"
                  >
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/40" />
                    {item}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        ) : (
          /* Section list view */
          <div className="grid gap-3">
            {HELP_SECTIONS.map(({ id, title, icon: Icon }) => (
              <button
                key={id}
                type="button"
                className="focus-ring flex items-center gap-3 border border-border bg-card p-4 text-left shadow-panel transition-all hover:border-primary"
                onClick={() => setActiveSection(id)}
                data-testid={`help-${id}`}
              >
                <Icon
                  className="h-5 w-5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="text-sm font-semibold text-foreground">
                  {title}
                </span>
              </button>
            ))}

            {/* Replay tutorials button */}
            <button
              type="button"
              className="focus-ring mt-2 flex items-center gap-3 border border-primary/30 bg-primary/5 p-4 text-left transition-all hover:border-primary"
              onClick={onReplayTutorial}
              data-testid="help-replay-tutorial"
            >
              <RefreshCw
                className="h-5 w-5 shrink-0 text-primary"
                aria-hidden="true"
              />
              <div>
                <span className="text-sm font-semibold text-primary">
                  Replay Tutorial
                </span>
                <p className="text-xs text-muted-foreground">
                  Re-launch the guided onboarding walkthrough for your role.
                </p>
              </div>
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
