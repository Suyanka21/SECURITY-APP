import {
  Bell,
  CheckCircle2,
  Lock,
  QrCode,
  ShieldCheck,
  Timer,
  UserCheck,
} from "lucide-react";
import type { OnboardingStep } from "../types";

export function getResidentSteps(): OnboardingStep[] {
  return [
    // ── Welcome ────────────────────────────────────────────────────
    {
      id: "resident-welcome",
      title: "Welcome to GatePass",
      explanation:
        "GatePass puts you in control of who enters your estate. " +
        "No visitor can enter without your explicit approval — " +
        "and every decision you make is recorded for your protection.",
      details: [
        "Guards cannot allow visitors in without your permission (unless it's an audited emergency override).",
        "You decide: approve or deny, every time.",
        "Your approval history is private and only visible to you and estate administrators.",
      ],
      icon: ShieldCheck,
    },

    // ── Topic 1: Why Approvals Exist ───────────────────────────────
    {
      id: "resident-approvals",
      title: "Topic 1 — Approvals Protect Your Home",
      explanation:
        "Every visitor must be authorized by a resident before the guard allows entry. " +
        "This creates a record of who was approved, when, and by whom.",
      details: [
        "When a visitor arrives, the guard sends you an approval request.",
        "You see the visitor's name, which unit they're visiting, and why they're here.",
        "You choose: Approve or Deny.",
        "If you deny, you must provide a brief reason so the guard can inform the visitor.",
        "The guard cannot override your denial (except in genuine emergencies, which are flagged and reviewed).",
      ],
      practicePrompt:
        "Imagine a visitor named 'John' arrives at your gate. You would see their details and tap Approve or Deny.",
      successMessage:
        "Every approval and denial is logged. You always have a record of your decisions.",
      icon: UserCheck,
    },

    // ── Topic 2: Notifications ─────────────────────────────────────
    {
      id: "resident-notifications",
      title: "Topic 2 — Receiving Notifications",
      explanation:
        "When a visitor arrives and the guard requests your approval, you receive " +
        "a WhatsApp or SMS message with a link to approve or deny. Until the estate's message " +
        "provider is switched on, the guard phones you instead.",
      details: [
        "The notification contains a secure link — tap it to see visitor details.",
        "You can approve immediately from your phone without opening the app.",
        "If the message fails to deliver, the guard can resend it or call you.",
        "Notifications have a cooldown to prevent spam.",
        "If you don't respond in time, the approval expires — the guard must start over.",
      ],
      practicePrompt:
        "When you receive a notification link, just tap it and choose Approve or Deny.",
      successMessage:
        "Fast responses mean faster entry for your visitors. The guard waits for your decision.",
      icon: Bell,
    },

    // ── Topic 3: Frequent Visitors ─────────────────────────────────
    {
      id: "resident-auto-approval",
      title: "Topic 3 — Frequent Visitors",
      explanation:
        "Have someone who visits regularly (a cleaner, tutor, or family member)? " +
        "Register them in the resident portal so those arrivals don't need " +
        "a fresh approval every time.",
      details: [
        "In the resident portal, add household members, workers and vehicles to your unit.",
        "When that visitor arrives, the guard sees an AUTO badge — entry is instant.",
        "Household and worker entries last 90 days; renew them in the portal. A person must give the same name at the gate.",
        "Vehicles are matched on the number plate for your unit. Remove an entry when it no longer applies.",
        "Auto-approved entries are fully logged and auditable — they're not invisible.",
      ],
      practicePrompt:
        "Think of one person who visits you regularly — register them once in the portal.",
      successMessage:
        "Registrations are logged, time-limited, and an administrator can switch any of them off.",
      icon: Timer,
    },

    // ── Topic 4: QR Passes ─────────────────────────────────────────
    {
      id: "resident-qr",
      title: "Topic 4 — QR Passes for Guests",
      explanation:
        "Expecting a guest? Send a single-use QR pass from the resident portal so your visitor " +
        "skips the approval wait. At the gate they show the QR code, the guard scans it, " +
        "and entry is confirmed instantly.",
      details: [
        "Sign in to the resident portal with your phone number and choose Send a pass.",
        "The visitor's name and unit — and optionally a vehicle plate — are recorded on the pass.",
        "The visitor receives a QR code / shareable link to present at the gate.",
        "QR codes are single-use and time-limited — expired or reused codes are rejected.",
        "A pass lasts at most 48 hours, and a unit can have at most 10 open passes.",
      ],
      practicePrompt:
        "Next time you expect a guest, send them a pass before they set off.",
      successMessage:
        "QR passes save time for you, the guard, and your visitor — no waiting, no phone calls.",
      icon: QrCode,
    },

    // ── Topic 5: Privacy ───────────────────────────────────────────
    {
      id: "resident-privacy",
      title: "Topic 5 — Your Privacy",
      explanation:
        "GatePass records accountability, not surveillance. " +
        "Your data is protected with clear access boundaries.",
      details: [
        "Only your approved visitors are visible to you.",
        "Guards cannot see other residents' approval history.",
        "Administrators see aggregated logs (shift totals, entry counts) — not your private messages.",
        "All data is stored securely with audit trails.",
        "The system tracks who accessed what and when.",
      ],
      icon: Lock,
    },

    // ── Completion ─────────────────────────────────────────────────
    {
      id: "resident-complete",
      title: "You are set up to manage visitor access",
      explanation:
        "You now understand how GatePass protects your home. Every visitor waits for " +
        "your approval. You decide from a link on your phone, and you send passes and " +
        "register regular visitors in the resident portal.",
      details: [
        "If you ever need a refresher, tap the Help icon (?) in the navigation bar.",
        "Approve quickly to keep visitors moving; deny firmly when something feels wrong.",
        "To link your phone to your home, ask your estate administrator for a one-time claim code.",
      ],
      icon: CheckCircle2,
    },
  ];
}
