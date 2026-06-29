import {
  AlertTriangle,
  ClipboardCheck,
  LogOut,
  Package,
  QrCode,
  ScanLine,
  ShieldAlert,
  UserPlus,
  Wifi,
  WifiOff,
} from "lucide-react";
import type { OnboardingStep } from "../types";

export function getGuardSteps(): OnboardingStep[] {
  return [
    // ── Welcome ────────────────────────────────────────────────────
    {
      id: "guard-welcome",
      title: "Welcome to GatePass",
      explanation:
        "You are responsible for recording every entry into the estate. " +
        "GatePass helps you make every decision traceable — no entry goes unrecorded, " +
        "and no approval happens silently.",
      details: [
        "Every visitor, delivery, and override is logged with your guard ID.",
        "Residents decide who enters — you enforce their decision.",
        "If something goes wrong, the audit trail shows exactly what happened.",
      ],
      icon: ClipboardCheck,
    },

    // ── Scenario 1: Walk-in Entry ──────────────────────────────────
    {
      id: "guard-walkin",
      title: "Scenario 1 — Walk-in Entry",
      explanation:
        "A visitor arrives on foot without a pre-approved QR code. " +
        "This is the most common entry method.",
      details: [
        "Tap Walk-In on the home screen.",
        "Enter the visitor's name, the host (resident) they're visiting, and the unit number.",
        "Tap Request Approval — a notification is sent to the resident.",
        "Wait for the resident to approve or deny.",
        "If approved, the entry is logged automatically. If denied, inform the visitor.",
      ],
      practicePrompt:
        "Try navigating to the Walk-In panel and filling in a visitor's details.",
      successMessage:
        "You just completed a walk-in entry. The resident was notified and the entry is now in the audit log.",
      icon: UserPlus,
    },

    // ── Scenario 2: QR Code Entry ──────────────────────────────────
    {
      id: "guard-qr",
      title: "Scenario 2 — QR Code Entry",
      explanation:
        "When a resident has pre-approved a visitor, they can share a QR pass. " +
        "The visitor shows the QR code at the gate and you scan it.",
      details: [
        "Tap Scan QR on the home screen.",
        "Point the camera at the visitor's QR code.",
        "If valid: entry is confirmed instantly — no phone call needed.",
        "If expired or already used: the scan fails with a clear error code.",
        "QR codes are single-use and time-limited for security.",
      ],
      practicePrompt:
        "Navigate to the QR scanner panel to see how scanning works.",
      successMessage:
        "QR scanning is the fastest entry method. No waiting, no phone calls.",
      icon: QrCode,
    },

    // ── Scenario 3: Override Entry ─────────────────────────────────
    {
      id: "guard-override",
      title: "Scenario 3 — Override Entry",
      explanation:
        "In emergency or urgent situations, you can override the normal approval process. " +
        "Override requires a written reason and is flagged for administrator review.",
      details: [
        "Tap Override on the home screen.",
        "Fill in the visitor details (name, host, unit).",
        "You MUST provide a reason — overrides without reasons are blocked.",
        "The entry is logged with method 'override' and flagged in the audit log.",
        "Administrators review all overrides — use this only when genuinely needed.",
      ],
      practicePrompt:
        "Navigate to the Override panel. Notice the 'Reason required' label.",
      successMessage:
        "Overrides are a safety valve, not a shortcut. Each one is reviewed by your supervisor.",
      icon: ShieldAlert,
    },

    // ── Scenario 4: Delivery Entry ─────────────────────────────────
    {
      id: "guard-delivery",
      title: "Scenario 4 — Delivery Entry",
      explanation:
        "Delivery riders (Jumia, Uber Eats, gas, water, etc.) are the most frequent " +
        "gate interactions. GatePass tracks deliveries separately from visitor entries.",
      details: [
        "Go to Admin panel and find the Deliveries section.",
        "Tap '+ New delivery' to open the delivery form.",
        "Enter the rider's name, destination unit, and select a category (parcel, food, gas, water, service, or other).",
        "Optionally record the vehicle plate number.",
        "The delivery is logged separately from visitor entries for cleaner records.",
      ],
      practicePrompt:
        "Open the Admin panel and look for the Deliveries section with '+ New delivery'.",
      successMessage:
        "Deliveries are now tracked separately — administrators can review delivery patterns per unit.",
      icon: Package,
    },

    // ── Scenario 5: Exit Tracking ──────────────────────────────────
    {
      id: "guard-exit",
      title: "Scenario 5 — Recording Exits",
      explanation:
        "When a visitor or delivery rider leaves the estate, their exit should be recorded. " +
        "This closes the entry-to-exit lifecycle and lets administrators see who is still on-premise.",
      details: [
        "Go to Admin panel and find 'Currently on-premise'.",
        "This shows everyone who has entered but not yet exited.",
        "Click 'Record exit' next to the person leaving.",
        "The entry is marked as complete with an exit timestamp.",
        "If someone appears who has no open entry, the system blocks the exit (no orphan records).",
      ],
      practicePrompt:
        "Check the 'Currently on-premise' panel to see who is inside the estate.",
      successMessage:
        "Exit tracking is critical during emergencies — you always know who is on-site.",
      icon: LogOut,
    },

    // ── Scenario 6: Offline Mode ───────────────────────────────────
    {
      id: "guard-offline",
      title: "Scenario 6 — Working Offline",
      explanation:
        "Internet connections are unreliable. GatePass works even when the connection drops.",
      details: [
        "When offline, you can still record entries normally.",
        "Entries are stored locally in the offline queue.",
        "The banner shows 'Gate station offline' and the Sync badge shows pending count.",
        "When internet returns, synchronization happens automatically.",
        "Nothing is lost — every offline entry is preserved and synced.",
        "'Pending sync: 3' means 3 entries are safe and waiting to upload.",
      ],
      practicePrompt:
        "Look at the status banner at the top. Notice the Sync count in the audit panel.",
      successMessage:
        "You never need to worry about internet — GatePass saves everything locally first.",
      icon: WifiOff,
    },

    // ── Scenario 7: Errors and Edge Cases ──────────────────────────
    {
      id: "guard-errors",
      title: "Scenario 7 — Handling Errors",
      explanation:
        "Errors are not failures — they are instructions. Every error in GatePass tells you exactly what happened and what to do next.",
      details: [
        "EXPIRED — Approval timed out. Ask the resident to re-approve, or use Override if urgent.",
        "DENIED — Resident rejected the visitor. Do NOT allow entry. Inform the visitor.",
        "409 Duplicate — Visitor already has an active entry. No action needed.",
        "QR_CONSUMED — QR was already used. It's single-use; visitor needs a new one from the resident.",
        "QR_EXPIRED — QR code timed out. Ask resident to issue a new pass.",
        "QR_INVALID — QR is tampered or fake. Do NOT allow entry. Report to your administrator.",
        "Server 500 — Something went wrong on the server. Your entry is saved offline and will sync later.",
      ],
      practicePrompt:
        "Read through each error code above. In production, these appear as banners in the app.",
      successMessage:
        "You now know what every error means. No error in GatePass is silent — they always tell you what happened.",
      icon: AlertTriangle,
    },

    // ── Completion ─────────────────────────────────────────────────
    {
      id: "guard-complete",
      title: "You are ready to begin your shift",
      explanation:
        "You now understand every workflow a security guard uses in GatePass. " +
        "Walk-in entries, QR scanning, overrides, deliveries, exit tracking, " +
        "offline mode, and error handling — you're prepared for all of them.",
      details: [
        "If you ever need a refresher, tap the Help icon (?) in the navigation bar.",
        "GatePass records everything — your job is to enforce decisions, not make them alone.",
        "When in doubt, ask the resident. When it's urgent, use Override with a clear reason.",
      ],
      icon: Wifi,
    },
  ];
}
