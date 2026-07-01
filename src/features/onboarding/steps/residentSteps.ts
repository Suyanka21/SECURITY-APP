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
        "a notification via WhatsApp or SMS with a link to approve or deny.",
      details: [
        "The notification contains a secure link — tap it to see visitor details.",
        "You can approve immediately from your phone without opening the app.",
        "If the notification fails to deliver, the guard can resend it.",
        "Notifications have a cooldown to prevent spam.",
        "If you don't respond in time, the approval expires — the guard must start over.",
      ],
      practicePrompt:
        "When you receive a notification link, just tap it and choose Approve or Deny.",
      successMessage:
        "Fast responses mean faster entry for your visitors. The guard waits for your decision.",
      icon: Bell,
    },

    // ── Topic 3: Auto-Approval Rules ───────────────────────────────
    {
      id: "resident-auto-approval",
      title: "Topic 3 — Auto-Approval Rules",
      explanation:
        "For frequent visitors (cleaners, tutors, family members), you can create " +
        "auto-approval rules. When these visitors arrive, entry is approved automatically " +
        "— no phone call needed.",
      details: [
        "Create a rule: 'Allow [visitor name] visiting [your unit] until [expiry date]'.",
        "When the visitor arrives, the guard sees an AUTO badge — entry is instant.",
        "Rules expire on the date you set for security hygiene.",
        "You can view and manage all your active rules.",
        "Auto-approved entries are fully logged and auditable — they're not invisible.",
      ],
      practicePrompt:
        "Think of one person who visits you regularly. An auto-approval rule would save them waiting at the gate every time.",
      successMessage:
        "Auto-approval is safe because it's logged and time-limited. Your administrator can always audit it.",
      icon: Timer,
    },

    // ── Topic 4: QR Passes ─────────────────────────────────────────
    {
      id: "resident-qr",
      title: "Topic 4 — QR Passes for Guests",
      explanation:
        "Expecting a visitor? Issue a QR pass and share it with them before they arrive. " +
        "At the gate, they show the QR code and the guard scans it — entry is confirmed instantly.",
      details: [
        "Go to the Admin panel and use 'Invite visitor' to issue a QR pass.",
        "Enter the visitor's name, your unit, and optionally their vehicle plate.",
        "A QR code and shareable link are generated.",
        "Share the QR code or link with your visitor via WhatsApp, email, or text.",
        "QR codes are single-use and time-limited — expired or reused codes are rejected.",
        "This is the fastest entry method, best for planned visits.",
      ],
      practicePrompt:
        "Next time you expect a guest, issue a QR pass beforehand — they'll breeze through the gate.",
      successMessage:
        "QR passes save time for you, the guard, and your visitor. No waiting, no phone calls.",
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
        "You now understand how GatePass protects your home. Approvals, notifications, " +
        "auto-rules, and QR passes — you have full control over who enters the estate.",
      details: [
        "If you ever need a refresher, tap the Help icon (?) in the navigation bar.",
        "Approve quickly to keep visitors moving; deny firmly when something feels wrong.",
        "Auto-approval rules and QR passes save time for frequent or expected visitors.",
      ],
      icon: CheckCircle2,
    },
  ];
}
