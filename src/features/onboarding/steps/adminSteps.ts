import {
  BarChart3,
  CheckCircle2,
  ClipboardList,
  FileSearch,
  LayoutDashboard,
  LogOut,
  Package,
  QrCode,
  ShieldCheck,
  Users,
} from "lucide-react";
import type { OnboardingStep } from "../types";

export function getAdminSteps(): OnboardingStep[] {
  return [
    // ── Welcome ────────────────────────────────────────────────────
    {
      id: "admin-welcome",
      title: "Welcome to GatePass Administration",
      explanation:
        "As a security company administrator, you have full visibility into every " +
        "entry, exit, and decision made at the estate gate. GatePass gives you " +
        "the tools to audit guard performance, manage visitor profiles, and " +
        "ensure accountability across every shift.",
      details: [
        "Every action in GatePass is recorded with a Trace ID.",
        "No entry is ever silently accepted — errors surface explicitly.",
        "Override entries are flagged for your review.",
        "The audit log is append-only — nothing can be deleted or hidden.",
      ],
      icon: ShieldCheck,
    },

    // ── Topic 1: Dashboard Overview ────────────────────────────────
    {
      id: "admin-dashboard",
      title: "Topic 1 — Dashboard Overview",
      explanation:
        "The Admin panel is your command center. It shows real-time operational " +
        "counters and a rolling audit log of every system event.",
      details: [
        "Entries logged — total entries recorded in the current session.",
        "Pending sync — entries stored offline, waiting for internet.",
        "Override flags — entries that bypassed normal approval (review these).",
        "Auto-approved — entries approved by resident auto-rules.",
        "Audit log — chronological list of every event (entries, approvals, errors, overrides).",
      ],
      practicePrompt:
        "Navigate to the Admin tab to see the dashboard counters and audit log.",
      successMessage:
        "The dashboard gives you a snapshot of gate activity at a glance.",
      icon: LayoutDashboard,
    },

    // ── Topic 2: Shift Log Aggregation ─────────────────────────────
    {
      id: "admin-shifts",
      title: "Topic 2 — Shift Log",
      explanation:
        "The shift log shows per-guard entry summaries. Use it to review " +
        "guard performance, detect anomalies, and verify shift handover accuracy.",
      details: [
        "Each row shows one guard: name, badge, total entries, and method breakdown.",
        "Method counters: QR, Walk-in, Override, Auto, Denied, Expired.",
        "Key invariant: total entries always equals the sum of all method counters.",
        "Filter by date range (From/To) to review a specific shift.",
        "Filter by Guard ID (UUID) to review a specific guard's activity.",
        "Excessive overrides or denials may indicate issues requiring attention.",
      ],
      practicePrompt:
        "Open the Shift log section in the Admin panel and try the Refresh button.",
      successMessage:
        "Shift logs are your primary tool for guard accountability. Review them daily.",
      icon: BarChart3,
    },

    // ── Topic 3: Visitor Profile Management ────────────────────────
    {
      id: "admin-visitors",
      title: "Topic 3 — Visitor Profiles",
      explanation:
        "Manage the visitor directory used for recognition and watch flags. " +
        "Profiles help guards identify returning visitors and flag individuals " +
        "who require extra scrutiny.",
      details: [
        "Create visitor profiles with name, host, unit, plate, and phone.",
        "WATCH flag — marks a visitor for extra scrutiny (shown as a red pill in the table).",
        "Soft-delete — removes a profile without permanent deletion (recoverable).",
        "Restore — brings back a soft-deleted profile.",
        "Toggle 'Show deleted' to see tombstoned profiles.",
        "Only admin tokens can modify profiles — guard tokens are rejected (403 AUTH_FORBIDDEN).",
      ],
      practicePrompt:
        "Look at the Visitors section in the Admin panel. Notice the WATCH pill and the action buttons.",
      successMessage:
        "Visitor profiles enable smarter gate operations. WATCH flags alert guards without blocking entry.",
      icon: Users,
    },

    // ── Topic 4: Currently On-Premise ──────────────────────────────
    {
      id: "admin-onpremise",
      title: "Topic 4 — Currently On-Premise",
      explanation:
        "The on-premise panel shows a real-time view of everyone who has entered " +
        "the estate but has not yet exited. This is critical for security incidents " +
        "and emergency response.",
      details: [
        "Each row shows: visitor name, host, unit, plate, entry method, and entry time.",
        "Click 'Record exit' when someone leaves to close their entry lifecycle.",
        "The system blocks orphan exits — you can't record an exit without an open entry.",
        "During emergencies, this tells you exactly who is on-site.",
        "Refresh to get the latest data from the server.",
      ],
      practicePrompt:
        "Check the 'Currently on-premise' section. Count how many people are inside.",
      successMessage:
        "On-premise tracking is your emergency response tool. Always know who is on-site.",
      icon: LogOut,
    },

    // ── Topic 5: Delivery Logs ─────────────────────────────────────
    {
      id: "admin-deliveries",
      title: "Topic 5 — Delivery Management",
      explanation:
        "Deliveries are the most frequent gate interactions in most estates. " +
        "GatePass tracks them separately to prevent cluttering visitor logs.",
      details: [
        "View all delivery entries: rider name, unit, category, plate, method, time.",
        "Categories: parcel, food, gas, water, service, other.",
        "Create new delivery entries with '+ New delivery'.",
        "Track delivery patterns per unit (useful for detecting anomalies).",
        "Delivery entries are logged with the same audit trail as visitor entries.",
      ],
      practicePrompt:
        "Open the Deliveries section and review the delivery log.",
      successMessage:
        "Separate delivery tracking keeps your visitor logs clean and delivery patterns visible.",
      icon: Package,
    },

    // ── Topic 6: Accountability and Audit ──────────────────────────
    {
      id: "admin-accountability",
      title: "Topic 6 — Accountability and Audit",
      explanation:
        "GatePass never silently accepts failures. Every action surfaces an " +
        "explicit code and Trace ID. This is the foundation of the system's " +
        "trustworthiness.",
      details: [
        "Every action has a Trace ID — a unique identifier for incident investigation.",
        "Audit history is append-only: nothing can be deleted or modified after the fact.",
        "Error codes are explicit: AUTH_FORBIDDEN, INTERNAL_ERROR, QR_CONSUMED, etc.",
        "Override entries are flagged for review — excessive overrides indicate a problem.",
        "Guard tokens cannot access admin operations — role-based access is enforced.",
        "If a guard attempts an unauthorized action, the system rejects it with a clear error and logs the attempt.",
      ],
      practicePrompt:
        "Look at the audit log in the Admin dashboard. Notice the Trace IDs.",
      successMessage:
        "Every error tells a story. Trace IDs let you investigate any incident end-to-end.",
      icon: FileSearch,
    },

    // ── Topic 7: Issuing QR Passes ─────────────────────────────────
    {
      id: "admin-qr-passes",
      title: "Topic 7 — Issuing QR Passes",
      explanation:
        "Administrators can issue QR passes on behalf of residents — useful for " +
        "estate events, maintenance contractors, or any planned visit.",
      details: [
        "Use the 'Invite visitor' form in the Admin panel.",
        "Enter: visitor name, host (resident), unit, and optionally vehicle plate.",
        "The system generates a single-use, time-limited QR code.",
        "Share the QR code image or link with the visitor.",
        "When the visitor arrives, the guard scans it — entry is confirmed instantly.",
        "Expired, consumed, or tampered QR codes are rejected with clear error codes.",
      ],
      practicePrompt:
        "Look at the 'Invite visitor' form at the top of the Admin panel.",
      successMessage:
        "QR passes are the fastest way to facilitate planned visits. Secure, single-use, and auditable.",
      icon: QrCode,
    },

    // ── Completion ─────────────────────────────────────────────────
    {
      id: "admin-complete",
      title: "You understand GatePass accountability",
      explanation:
        "You now know how GatePass protects accountability across every entry, " +
        "exit, and decision. The dashboard, shift logs, visitor profiles, on-premise " +
        "tracking, delivery logs, QR issuance, and audit trail — you have full " +
        "operational visibility.",
      details: [
        "If you ever need a refresher, tap the Help icon (?) in the navigation bar.",
        "Review shift logs daily. Check override counts weekly.",
        "On-premise tracking is your emergency response tool.",
        "Every error has a Trace ID — use it for incident investigation.",
      ],
      icon: CheckCircle2,
    },
  ];
}
