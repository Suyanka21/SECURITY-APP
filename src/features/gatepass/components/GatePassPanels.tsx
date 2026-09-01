import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Copy,
  ExternalLink,
  LayoutDashboard,
  Loader2,
  Lock,
  LogOut,
  MailCheck,
  MessageSquarePlus,
  Package,
  StickyNote,
  QrCode,
  Radar,
  RefreshCw,
  ScanLine,
  Search,
  ShieldAlert,
  UserPlus,
  Wifi,
  WifiOff,
  X as XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  EntryDraft,
  GatePassAction,
  GatePassState,
  NotificationDeliveryView,
  ShiftsQuery,
  Visitor,
} from "../types";
import { VISITOR_PROFILE_NEW_KEY } from "../types";
import { getPlateComparison } from "../plate-verification";
import type {
  AddGuardNoteRequest,
  CreateDeliveryEntryRequest,
  CreateVisitorProfileRequest,
  DeliveryCategory,
  GuardNoteTag,
  IssueVisitorInvitationRequest,
  UpdateVisitorProfileRequest,
  VisitorProfileView,
  WatchlistMatchView,
} from "@/lib/api/types";
import {
  GUARD_NOTE_TAG_LABELS,
  GUARD_NOTE_TEXT_MAX,
} from "@/lib/api/types";
import { QRCodeSVG } from "qrcode.react";

/**
 * Panels are presentational only. They never call the API directly —
 * they read state, dispatch UI-only actions (UPDATE_DRAFT, NAVIGATE,
 * etc.), and call into the controller's bound async actions for
 * anything that touches the network. This separation makes the panels
 * trivially testable and keeps side effects pinned to one module.
 */
export type GatePassActions = {
  submitEntry: () => Promise<void> | void;
  scanQr: (token: string) => Promise<void> | void;
  /**
   * Feature 11 (Stage 4) — redeem a pass by pass reference + 6-digit PIN
   * when the QR can't be scanned. Lands on the same confirmation screen.
   */
  redeemPin: (passRef: string, pin: string) => Promise<void> | void;
  syncPending: () => Promise<void> | void;
  searchVisitors: (query?: string) => Promise<void> | void;
  setNetwork: (network: "online" | "offline") => void;
  /**
   * Initiate a resident-approval flow for the current walk-in draft.
   * Source: src/docs/specs/resident-approval-flow.md §7.1
   * Feature 2: optional hostPhoneE164 enrolls the approval into the
   * notifications delivery pipeline (spec notifications.md §7.1).
   */
  requestApproval: (hostPhoneE164?: string) => Promise<void> | void;
  /**
   * Manually retry a failed notification delivery.
   * Source: src/docs/specs/notifications.md §7.3
   */
  retryNotification: (notificationId: string) => Promise<void> | void;
  // ─── Visitor profile CRUD (Feature 4) ────────────────────────
  // Source: src/docs/specs/visitor-profiles.md §8
  loadVisitorProfiles: (query?: {
    page?: number;
    pageSize?: number;
    q?: string;
    host?: string;
    unit?: string;
  }) => Promise<void> | void;
  createVisitorProfile: (
    input: CreateVisitorProfileRequest,
  ) => Promise<void> | void;
  updateVisitorProfile: (
    id: string,
    patch: UpdateVisitorProfileRequest,
  ) => Promise<void> | void;
  softDeleteVisitorProfile: (id: string) => Promise<void> | void;
  restoreVisitorProfile: (id: string) => Promise<void> | void;
  toggleVisitorProfilesIncludeDeleted: () => void;
  // ─── Shift log aggregation (Feature 5) ───────────────
  // Source: src/docs/specs/shift-log-aggregation.md §8
  setShiftsQuery: (query: ShiftsQuery) => void;
  loadShifts: (override?: ShiftsQuery) => Promise<void> | void;
  // ─── Visitor invitations (Feature 6) ─────────────────
  // Source: src/docs/specs/guest-qr-ticket.md §6
  issueVisitorInvitation: (input: IssueVisitorInvitationRequest) => Promise<void> | void;
  resetVisitorInvitation: () => void;
  // ─── Exit tracking (Feature 7) ────────────────────────
  // Source: src/docs/specs/exit-tracking.md §8
  loadOnPremise: () => Promise<void> | void;
  recordExit: (entryId: string) => Promise<void> | void;
  // ─── Guard notes (Feature 9) ──────────────────────────
  // Source: src/docs/specs/guard-notes.md §4
  addEntryNote: (
    entryId: string,
    body: import("@/lib/api/types").AddGuardNoteRequest,
  ) => Promise<void> | void;
  // ─── Delivery management (Feature 8) ────────────────────
  // Source: src/docs/specs/delivery-management.md §5
  submitDelivery: (input: import("@/lib/api/types").CreateDeliveryEntryRequest) => Promise<void> | void;
  loadDeliveries: () => Promise<void> | void;
  resetDeliveryForm: () => void;
};

type Props = {
  state: GatePassState;
  dispatch: React.Dispatch<GatePassAction>;
  actions: GatePassActions;
};

const toneClass = {
  info: "border-info bg-info/10 text-info-foreground",
  success: "border-success bg-success/10 text-success-foreground",
  warning: "border-warning bg-warning/15 text-warning-foreground",
  danger: "border-destructive bg-destructive/10 text-destructive",
};

export function StatusBanner({ state, actions }: Props) {
  return (
    <div
      className={`flex flex-col gap-3 border p-4 shadow-panel md:flex-row md:items-center md:justify-between ${toneClass[state.banner.tone]}`}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        {state.network === "offline" ? (
          <WifiOff className="mt-0.5 h-5 w-5 shrink-0" />
        ) : (
          <Wifi className="mt-0.5 h-5 w-5 shrink-0" />
        )}
        <div>
          <p className="font-display text-base font-semibold">
            {state.network === "offline" ? "Offline guard mode" : "Gate station online"}
          </p>
          <p className="text-sm opacity-90">{state.banner.message}</p>
          {state.lastError?.traceId && (
            <p className="mt-1 text-xs opacity-70">
              Trace: <code>{state.lastError.traceId}</code>
            </p>
          )}
        </div>
      </div>
      <button
        className="focus-ring border border-current px-4 py-2 text-sm font-semibold transition-transform hover:-translate-y-0.5"
        onClick={() =>
          actions.setNetwork(state.network === "online" ? "offline" : "online")
        }
      >
        Simulate {state.network === "online" ? "offline" : "online"}
      </button>
    </div>
  );
}

export function GuardHome({ state, dispatch, actions }: Props) {
  return (
    <section className="grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
      <div className="surface-grid border border-border p-5 shadow-panel">
        <p className="text-xs font-bold uppercase tracking-widest text-accent">
          Default guard workflow
        </p>
        <h1 className="mt-3 font-display text-4xl font-black leading-tight text-foreground md:text-6xl">
          GatePass
        </h1>
        <p className="mt-3 max-w-2xl text-base text-muted-foreground">
          Fast entry control with explicit logging, offline queues, and no silent
          approvals.
        </p>
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <ActionButton
            icon={<ScanLine />}
            label="Scan QR"
            hint="pre-approved visitor"
            onClick={() => dispatch({ type: "START_CAMERA" })}
          />
          <ActionButton
            icon={<UserPlus />}
            label="Walk-in"
            hint="log guest manually"
            onClick={() => dispatch({ type: "NAVIGATE", mode: "walkin" })}
          />
          <ActionButton
            icon={<Search />}
            label="Recognized"
            hint="search frequent visitors"
            onClick={() => {
              dispatch({ type: "NAVIGATE", mode: "search" });
              void actions.searchVisitors("");
            }}
          />
          <ActionButton
            icon={<ShieldAlert />}
            label="Override"
            hint="reason required"
            danger
            onClick={() => dispatch({ type: "NAVIGATE", mode: "override" })}
          />
        </div>
      </div>
      <AuditPanel state={state} actions={actions} />
    </section>
  );
}

function ActionButton({
  icon,
  label,
  hint,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className={`focus-ring group flex min-h-28 items-center gap-4 border p-4 text-left shadow-panel transition-all hover:-translate-y-1 hover:shadow-glow ${danger ? "border-destructive bg-destructive/10" : "border-border bg-card"}`}
      onClick={onClick}
    >
      <span
        className={`grid h-12 w-12 place-items-center border ${danger ? "border-destructive text-destructive" : "border-primary text-primary"}`}
      >
        {icon}
      </span>
      <span>
        <span className="block font-display text-2xl font-bold text-foreground">
          {label}
        </span>
        <span className="text-sm text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}

export function QrScanPanel({ state, dispatch, actions }: Props) {
  const scanning = state.qrState === "scanning";
  return (
    <section className="grid gap-5 lg:grid-cols-[0.85fr_1fr]">
      <div className="border border-border bg-card p-5 shadow-panel">
        <h2 className="font-display text-3xl font-bold">QR scan</h2>
        <div className="mt-5 grid aspect-square place-items-center border border-dashed border-primary bg-primary/10 scan-field">
          {scanning ? (
            <Loader2 className="h-20 w-20 animate-spin text-primary" />
          ) : (
            <QrCode className="h-28 w-28 text-primary" />
          )}
        </div>
        <label className="mt-4 grid gap-2 text-sm font-semibold text-foreground">
          QR token
          <input
            className="focus-ring border border-input bg-background px-3 py-3 font-mono text-sm"
            placeholder="Paste or scan QR token"
            value={state.qrToken}
            onChange={(event) =>
              dispatch({ type: "UPDATE_QR_TOKEN", value: event.target.value })
            }
          />
        </label>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            className="focus-ring border border-primary bg-primary px-3 py-3 text-sm font-semibold text-primary-foreground disabled:opacity-60"
            onClick={() => void actions.scanQr(state.qrToken)}
            disabled={state.inFlight || state.qrState === "locked"}
          >
            {scanning ? "Validating…" : "Validate QR"}
          </button>
          <button
            className="focus-ring border border-destructive p-3 text-sm font-semibold text-destructive"
            onClick={() => dispatch({ type: "CAMERA_FAILED" })}
          >
            Camera failed
          </button>
        </div>
        {state.qrState === "valid" && (
          <p className="mt-3 text-sm text-success-foreground">
            QR verified. Confirm the entry on the right.
          </p>
        )}
        {/* A pass locked by the PIN limiter is refused on the QR path too.
            The guard sees the truth here — "Locked", not "unknown token". */}
        {state.qrState === "locked" && (
          <p
            role="alert"
            data-testid="qr-locked-banner"
            className="mt-3 border border-destructive bg-destructive/10 px-3 py-2 text-sm font-semibold text-destructive"
          >
            Locked — this pass was locked after too many incorrect PIN
            attempts. Do not admit on this pass: ask the resident to re-issue,
            or log a walk-in/override.
          </p>
        )}

        {/* Feature 11 (Stage 4) — One-Time PIN Backup. When the QR can't be
            scanned, the guard redeems the SAME pass with its reference + the
            6-digit PIN. A lockout after too many wrong PINs is surfaced as a
            danger banner and disables the redeem button. */}
        <div
          className="mt-6 border-t border-border pt-4"
          data-testid="pin-redemption"
        >
          <h3 className="font-display text-lg font-bold">
            Can&apos;t scan? Redeem by PIN
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Enter the pass reference and the 6-digit PIN from the visitor&apos;s
            pass. Using the PIN also invalidates the QR.
          </p>
          <label className="mt-3 grid gap-2 text-sm font-semibold text-foreground">
            Pass reference
            <input
              className="focus-ring border border-input bg-background px-3 py-3 font-mono text-sm uppercase tracking-widest"
              placeholder="e.g. AB12CD34"
              maxLength={8}
              autoCapitalize="characters"
              value={state.pinPassRef}
              onChange={(event) =>
                dispatch({ type: "UPDATE_PIN_PASS_REF", value: event.target.value })
              }
              data-testid="pin-pass-ref-input"
            />
          </label>
          <label className="mt-3 grid gap-2 text-sm font-semibold text-foreground">
            6-digit PIN
            <input
              className="focus-ring border border-input bg-background px-3 py-3 font-mono text-lg tracking-[0.5em]"
              placeholder="••••••"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={state.pinValue}
              onChange={(event) =>
                dispatch({ type: "UPDATE_PIN_VALUE", value: event.target.value })
              }
              data-testid="pin-value-input"
            />
          </label>
          {state.qrState === "locked" && (
            <p
              role="alert"
              data-testid="pin-locked-banner"
              className="mt-3 border border-destructive bg-destructive/10 px-3 py-2 text-sm font-semibold text-destructive"
            >
              Locked — this pass is locked after too many incorrect PIN
              attempts. Ask the resident to re-issue, or use walk-in/override.
            </p>
          )}
          <button
            className="focus-ring mt-4 w-full border border-primary bg-primary px-3 py-3 text-sm font-semibold text-primary-foreground disabled:opacity-60"
            onClick={() => void actions.redeemPin(state.pinPassRef, state.pinValue)}
            disabled={state.inFlight || state.qrState === "locked"}
            data-testid="pin-redeem-button"
          >
            {scanning ? "Verifying…" : "Redeem by PIN"}
          </button>
        </div>
      </div>
      <EntryForm
        title="QR confirmation"
        state={state}
        dispatch={dispatch}
        actions={actions}
        requireReason={false}
        showVehicleVerification
      />
    </section>
  );
}

/**
 * Feature 10 — Vehicle Verification (Stage 3).
 *
 * Presentational only: shows the pre-registered ("expected") plate next
 * to the plate the guard has entered so the two can be compared, and
 * renders a SOFT WARNING on mismatch. It never blocks or disables entry —
 * it only advises. Source: src/docs/specs/vehicle-verification.md.
 */
function VehicleVerification({
  expectedPlate,
  observedPlate,
}: {
  expectedPlate: string | null | undefined;
  observedPlate: string;
}) {
  const comparison = getPlateComparison(expectedPlate, observedPlate);

  if (comparison === "no-expected") {
    return (
      <div
        data-testid="vehicle-verification"
        className="mt-4 flex items-start gap-2 border border-border bg-muted/40 px-3 py-3 text-sm text-muted-foreground"
      >
        <QrCode className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p>No plate on file for this visitor — nothing to verify.</p>
      </div>
    );
  }

  return (
    <div
      data-testid="vehicle-verification"
      className="mt-4 grid gap-2 border border-border bg-muted/40 px-3 py-3 text-sm"
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-foreground">
        <span className="font-semibold">Expected plate (pre-registered):</span>
        <span
          data-testid="expected-plate"
          className="font-mono font-semibold tracking-wide"
        >
          {expectedPlate}
        </span>
      </p>

      {comparison === "no-observed" && (
        <p className="text-muted-foreground">
          Enter the observed plate above to compare against the vehicle.
        </p>
      )}

      {comparison === "match" && (
        <p
          data-testid="plate-match"
          className="flex items-center gap-2 font-medium text-success-foreground"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          Observed plate matches the pre-registered plate.
        </p>
      )}

      {comparison === "mismatch" && (
        <div
          role="alert"
          data-testid="plate-mismatch-warning"
          className="flex items-start gap-2 border border-warning bg-warning/10 px-3 py-2 font-medium text-warning-foreground"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            Observed plate does not match the pre-registered plate. Verify
            the vehicle before continuing — this does not block entry.
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Feature 12 — Watchlist warning + supervisor escalation (Stage 5).
 *
 * HARD RULE (src/docs/specs/watchlist.md §1): the system never denies entry
 * on a match. This surfaces the stored reason, states plainly that it does
 * not block entry, and requires the guard to record the supervisor who
 * authorised the arrival before the entry can be finalised.
 *
 * `mode="gate"`   — pre-log (QR/PIN confirmation): escalation is required
 *                   before "Log entry" will submit.
 * `mode="notice"` — post-log (walk-in): the entry already exists; the guard
 *                   is told to escalate now.
 */
function WatchlistWarning({
  match,
  escalation,
  dispatch,
  mode,
}: {
  match: WatchlistMatchView;
  escalation: { supervisor: string; acknowledged: boolean };
  dispatch: Props["dispatch"];
  mode: "gate" | "notice";
}) {
  return (
    <div
      role="alert"
      data-testid="watchlist-warning"
      className="mt-4 grid gap-3 border-2 border-destructive bg-destructive/10 px-3 py-3 text-sm"
    >
      <p className="flex items-start gap-2 font-bold text-destructive">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <span>
          WATCHLIST MATCH — matched on {match.matchedOn.replace("+", " + ")}
        </span>
      </p>

      <p className="text-foreground">
        <span className="font-semibold">Reason on file:</span> {match.reason}
      </p>

      <p className="font-medium text-foreground">
        This does not automatically block entry. Escalate to a supervisor and
        record their decision — the supervisor decides, not the system.
      </p>

      {mode === "notice" ? (
        <p data-testid="watchlist-post-log-notice" className="text-foreground">
          This entry has already been logged. Escalate to a supervisor now.
        </p>
      ) : (
        <div className="grid gap-2">
          <label className="grid gap-1 text-sm font-semibold text-foreground">
            Supervisor who authorised this entry
            <input
              data-testid="watchlist-supervisor"
              className="focus-ring border border-input bg-background px-3 py-2 text-base font-medium"
              value={escalation.supervisor}
              autoComplete="off"
              onChange={(event) =>
                dispatch({
                  type: "WATCHLIST_ESCALATION_UPDATED",
                  supervisor: event.target.value,
                })
              }
            />
          </label>
          <label className="flex items-start gap-2 text-sm font-medium text-foreground">
            <input
              type="checkbox"
              data-testid="watchlist-acknowledge"
              className="focus-ring mt-1"
              checked={escalation.acknowledged}
              onChange={(event) =>
                dispatch({
                  type: "WATCHLIST_ESCALATION_UPDATED",
                  acknowledged: event.target.checked,
                })
              }
            />
            I escalated this match to the named supervisor and they authorised
            the entry. This is logged as a manual override.
          </label>
        </div>
      )}
    </div>
  );
}

export function WalkInPanel(props: Props) {
  return (
    <EntryForm
      title="Walk-in entry"
      {...props}
      requireReason={false}
      showRequestApproval
    />
  );
}

export function OverridePanel(props: Props) {
  return <EntryForm title="Manual override" {...props} requireReason />;
}

function EntryForm({
  title,
  state,
  dispatch,
  actions,
  requireReason,
  showRequestApproval = false,
  showVehicleVerification = false,
}: Props & {
  title: string;
  requireReason: boolean;
  showRequestApproval?: boolean;
  /** Feature 10 — render the pre-registered-plate comparison (QR flow only). */
  showVehicleVerification?: boolean;
}) {
  const fields: Array<[keyof EntryDraft, string, string]> = [
    ["visitorName", "Visitor name", "e.g. Ama Mensah"],
    ["host", "Resident / host", "e.g. J. Bello"],
    ["unit", "Unit", "e.g. 14D"],
    ["plate", "Plate / ID", "optional"],
  ];
  const errorField = state.lastError?.field;
  // Feature 2 — slice 7: host phone is collected ONLY on the Walk-in
  // panel, since approval requests are scoped to walk-ins (spec
  // resident-approval-flow.md §3, notifications.md §7.1). It is local
  // to this component because it's a transient pre-request input —
  // the controller validates + persists it on its own state machine.
  const [hostPhoneE164, setHostPhoneE164] = useState("");
  const phoneFieldHasError = state.lastError?.field === "hostPhoneE164";
  return (
    <section className="border border-border bg-card p-5 shadow-panel">
      <h2 className="font-display text-3xl font-bold">{title}</h2>
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        {fields.map(([field, label, placeholder]) => (
          <label
            key={field}
            className="grid gap-2 text-sm font-semibold text-foreground"
          >
            {label}
            <input
              className={`focus-ring border bg-background px-3 py-3 text-base font-medium ${errorField === field ? "border-destructive" : "border-input"}`}
              value={state.draft[field] as string}
              placeholder={placeholder}
              onChange={(event) =>
                dispatch({ type: "UPDATE_DRAFT", field, value: event.target.value })
              }
            />
          </label>
        ))}
        <label className="grid gap-2 text-sm font-semibold text-foreground md:col-span-2">
          Reason {requireReason ? "(required)" : ""}
          <textarea
            className={`focus-ring min-h-24 border bg-background px-3 py-3 text-base font-medium ${errorField === "reason" ? "border-destructive" : "border-input"}`}
            value={state.draft.reason}
            placeholder="Visible audit reason"
            onChange={(event) =>
              dispatch({ type: "UPDATE_DRAFT", field: "reason", value: event.target.value })
            }
          />
        </label>
        {showRequestApproval && (
          <label
            htmlFor="host-phone-e164"
            className="grid gap-2 text-sm font-semibold text-foreground md:col-span-2"
          >
            Host phone (E.164, optional — enables WhatsApp/SMS delivery)
            <input
              id="host-phone-e164"
              data-testid="host-phone-input"
              type="tel"
              inputMode="tel"
              autoComplete="off"
              className={`focus-ring border bg-background px-3 py-3 text-base font-medium ${phoneFieldHasError ? "border-destructive" : "border-input"}`}
              value={hostPhoneE164}
              placeholder="+15551230001"
              aria-invalid={phoneFieldHasError || undefined}
              aria-describedby={phoneFieldHasError ? "host-phone-error" : undefined}
              onChange={(event) => setHostPhoneE164(event.target.value)}
            />
            <span className="text-xs font-normal text-muted-foreground">
              Starts with +country code, no spaces or dashes. Leave blank
              to deliver the link via the on-screen copy only.
            </span>
          </label>
        )}
      </div>
      {showVehicleVerification && (
        <VehicleVerification
          expectedPlate={state.expectedPlate}
          observedPlate={state.draft.plate}
        />
      )}
      {state.watchlistMatch && (
        <WatchlistWarning
          match={state.watchlistMatch}
          escalation={state.watchlistEscalation}
          dispatch={dispatch}
          mode="gate"
        />
      )}
      <div className="mt-5 flex flex-col gap-3 sm:flex-row">
        <button
          className="focus-ring flex-1 bg-primary px-5 py-4 font-display text-lg font-bold text-primary-foreground shadow-panel transition-transform hover:-translate-y-0.5 disabled:opacity-60"
          onClick={() => void actions.submitEntry()}
          disabled={state.inFlight}
        >
          {state.inFlight ? "Logging…" : "Log entry"}
        </button>
        {showRequestApproval && (
          <button
            className="focus-ring flex items-center justify-center gap-2 border border-primary bg-card px-5 py-4 font-display text-base font-bold text-primary shadow-panel transition-transform hover:-translate-y-0.5 disabled:opacity-60"
            onClick={() =>
              void actions.requestApproval(
                hostPhoneE164.trim() ? hostPhoneE164.trim() : undefined,
              )
            }
            disabled={state.inFlight || state.network === "offline"}
            title={
              state.network === "offline"
                ? "Resident approval requires a live connection \u2014 use override (with reason)"
                : hostPhoneE164.trim()
                  ? "Send a magic-link approval AND deliver it via WhatsApp/SMS"
                  : "Send a magic-link approval to the resident"
            }
          >
            <MailCheck className="h-5 w-5" aria-hidden="true" />
            Request resident approval
          </button>
        )}
        <button
          className="focus-ring border border-border px-5 py-4 font-semibold"
          onClick={() => dispatch({ type: "RESET_FLOW" })}
        >
          Cancel visibly
        </button>
      </div>
      {state.lastError && (
        <p
          id={
            state.lastError.field === "hostPhoneE164"
              ? "host-phone-error"
              : undefined
          }
          className="mt-3 text-sm text-destructive"
          role="alert"
        >
          <span className="font-bold">{state.lastError.code}:</span>{" "}
          {state.lastError.message}
        </p>
      )}
    </section>
  );
}

export function SearchPanel({ state, dispatch, actions }: Props) {
  return (
    <section className="border border-border bg-card p-5 shadow-panel">
      <h2 className="font-display text-3xl font-bold">Recognized visitors</h2>
      <form
        className="mt-4 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void actions.searchVisitors(state.searchQuery);
        }}
      >
        <input
          aria-label="Search recognized visitors"
          className="focus-ring flex-1 border border-input bg-background px-3 py-3 text-base font-medium"
          placeholder="Search by name or plate"
          value={state.searchQuery}
          onChange={(event) =>
            dispatch({ type: "UPDATE_SEARCH_QUERY", value: event.target.value })
          }
        />
        <button
          type="submit"
          className="focus-ring border border-primary bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground disabled:opacity-60"
          disabled={state.searchLoading}
        >
          {state.searchLoading ? "Searching…" : "Search"}
        </button>
      </form>
      <div className="mt-5 grid gap-3">
        {state.recognizedVisitors.length === 0 && !state.searchLoading && (
          <p className="text-sm text-muted-foreground">
            No recognized visitors matched.
          </p>
        )}
        {state.recognizedVisitors.map((visitor) => (
          <VisitorRow key={visitor.id} visitor={visitor} dispatch={dispatch} />
        ))}
      </div>
    </section>
  );
}

function VisitorRow({
  visitor,
  dispatch,
}: {
  visitor: Visitor;
  dispatch: React.Dispatch<GatePassAction>;
}) {
  return (
    <button
      className="focus-ring grid gap-2 border border-border bg-background p-4 text-left transition-transform hover:-translate-y-0.5 md:grid-cols-[1fr_auto]"
      onClick={() => dispatch({ type: "SELECT_VISITOR", visitor })}
    >
      <span>
        <span className="font-display text-xl font-bold">{visitor.name}</span>
        <span className="block text-sm text-muted-foreground">
          Host {visitor.host} · Unit {visitor.unit} · {visitor.plate ?? "No plate"}
        </span>
      </span>
      <span className="text-sm font-bold uppercase text-accent">
        {visitor.recognition}
      </span>
    </button>
  );
}

// ─── Awaiting Approval Panel (Feature 1) ──────────────────────────────
// Source: src/docs/specs/resident-approval-flow.md §10 (UI requirements)

/**
 * Format a millisecond delta into "M:SS".
 */
function formatCountdown(ms: number): string {
  if (ms <= 0) return "0:00";
  const totalSeconds = Math.ceil(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function statusBadgeClass(status: NotificationDeliveryView["status"]) {
  switch (status) {
    case "delivered":
      return "border-success bg-success/10 text-success-foreground";
    case "failed":
      return "border-destructive bg-destructive/10 text-destructive";
    case "sending":
      return "border-info bg-info/10 text-info-foreground";
    case "queued":
    default:
      return "border-warning bg-warning/15 text-warning-foreground";
  }
}

function maskPhone(phone: string) {
  // Show country + last 4 only. spec notifications.md §5 bans full PII in
  // the audit/log surface; the same discipline applies on screen since
  // a guard shoulder-surfing scenario is realistic.
  if (phone.length < 6) return phone;
  const tail = phone.slice(-4);
  return `${phone.slice(0, 3)}••••${tail}`;
}

/**
 * Renders the delivery rows for a single approval. Each row shows the
 * channel, masked target, status badge, attempt count, and (when
 * applicable) a Resend button + last-error line. Source: spec
 * notifications.md §5, §7.2, §7.3.
 */
function DeliveryStatusBlock({
  rows,
  loading,
  lastError,
  onRetry,
  nowMs,
}: {
  rows: NotificationDeliveryView[] | undefined;
  loading: boolean;
  lastError: GatePassState["notifications"]["lastError"];
  onRetry: (id: string) => Promise<void> | void;
  /**
   * Current epoch ms. Passed in so the parent (which already runs a
   * 1Hz tick for the approval countdown) drives the cooldown
   * countdown too, without spawning a second interval.
   */
  nowMs: number;
}) {
  if (!rows || rows.length === 0) {
    return (
      <div
        className="border border-border bg-card p-4"
        aria-live="polite"
        data-testid="delivery-status-empty"
      >
        <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
          Delivery
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {loading
            ? "Checking delivery status…"
            : "No notifications enrolled. Share the link manually."}
        </p>
        {lastError && (
          <p
            className="mt-2 text-xs text-destructive"
            role="alert"
            data-testid="delivery-list-error"
          >
            <span className="font-bold">{lastError.code}:</span>{" "}
            {lastError.message}
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      className="border border-border bg-card p-4"
      data-testid="delivery-status-block"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
          Delivery
        </p>
        {loading && (
          <Loader2
            className="h-3.5 w-3.5 animate-spin text-muted-foreground"
            aria-label="Refreshing delivery status"
          />
        )}
      </div>
      <ul className="mt-3 grid gap-2">
        {rows.map((row) => {
          const cooldownRemainingMs =
            row.retryCooldownUntilMs && row.retryCooldownUntilMs > nowMs
              ? row.retryCooldownUntilMs - nowMs
              : 0;
          const inCooldown = cooldownRemainingMs > 0;
          const canRetry =
            row.status === "failed" && !row.retryInFlight && !inCooldown;
          return (
            <li
              key={row.id}
              data-testid={`delivery-row-${row.id}`}
              className="flex flex-col gap-2 border border-border bg-background p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex flex-col gap-1">
                <span className="text-sm font-semibold capitalize">
                  {row.channel}
                  <span className="ml-2 font-normal text-muted-foreground">
                    → {maskPhone(row.targetPhone)}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  Attempt {row.attempts}
                  {row.lastErrorCode ? ` · ${row.lastErrorCode}` : ""}
                </span>
                {row.retryError && (
                  <span
                    className="text-xs text-destructive"
                    role="alert"
                    data-testid={`delivery-retry-error-${row.id}`}
                  >
                    <span className="font-bold">{row.retryError.code}:</span>{" "}
                    {row.retryError.message}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`focus-ring inline-flex border px-2 py-1 text-xs font-bold uppercase ${statusBadgeClass(row.status)}`}
                  data-testid={`delivery-status-${row.id}`}
                >
                  {row.status}
                </span>
                {canRetry && (
                  <button
                    type="button"
                    data-testid={`delivery-retry-${row.id}`}
                    className="focus-ring inline-flex items-center gap-1 border border-primary bg-card px-3 py-2 text-xs font-semibold text-primary disabled:opacity-60"
                    onClick={() => void onRetry(row.id)}
                  >
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                    Resend
                  </button>
                )}
                {row.retryInFlight && (
                  <span
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                    data-testid={`delivery-retry-inflight-${row.id}`}
                  >
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Resending…
                  </span>
                )}
                {inCooldown && !row.retryInFlight && (
                  <span
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                    data-testid={`delivery-cooldown-${row.id}`}
                    aria-live="polite"
                  >
                    Resend in {Math.ceil(cooldownRemainingMs / 1000)}s
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function AwaitingApprovalPanel({ state, dispatch, actions }: Props) {
  const approval = state.pendingApproval;
  // Tick the displayed countdown locally every second. The server is
  // still the source of truth for expiry (lazy flip in /status), but
  // the UI cannot wait for a poll to refresh — it must update every
  // second so the guard sees the time draining in real time.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const [copied, setCopied] = useState(false);

  if (!approval) {
    // Defensive: the parent should only mount this when mode ===
    // "awaiting-approval" AND pendingApproval is set, but if state
    // gets desynced, render an explicit recovery prompt instead of a
    // blank panel (no silent success — same rule everywhere).
    return (
      <section className="border border-warning bg-warning/10 p-5 shadow-panel">
        <h2 className="font-display text-3xl font-bold">No active approval</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The approval state is missing. Return to the walk-in form to start over.
        </p>
        <button
          className="focus-ring mt-4 border border-border px-5 py-3 font-semibold"
          onClick={() => dispatch({ type: "RESET_FLOW" })}
        >
          Reset
        </button>
      </section>
    );
  }

  const expiresAt = new Date(approval.expiresAt).getTime();
  const remainingMs = expiresAt - now;
  const expired = remainingMs <= 0;

  const onCopy = async () => {
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard?.writeText
      ) {
        await navigator.clipboard.writeText(approval.magicLinkUrl);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      // Clipboard may be blocked (insecure context, missing permission).
      // Failure is non-fatal — the link is visible on screen so the
      // guard can read it. We just don't get to show the "Copied" hint.
      setCopied(false);
    }
  };

  return (
    <section
      className="border border-info bg-info/5 p-5 shadow-panel"
      aria-live="polite"
    >
      <div className="flex flex-col gap-1">
        <p className="text-xs font-bold uppercase tracking-widest text-info-foreground">
          Awaiting resident approval
        </p>
        <h2 className="font-display text-3xl font-bold text-foreground">
          {approval.draft.visitorName}
          <span className="ml-3 text-base font-semibold text-muted-foreground">
            → {approval.draft.host} (Unit {approval.draft.unit})
          </span>
        </h2>
      </div>

      <div className="mt-5 grid gap-5 md:grid-cols-[1fr_1fr]">
        <div className="border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <Clock3 className="h-4 w-4" aria-hidden="true" />
            Time remaining
          </div>
          <p
            data-testid="approval-countdown"
            className={`mt-2 font-display text-5xl font-black tabular-nums ${
              expired
                ? "text-destructive"
                : remainingMs < 60_000
                  ? "text-warning"
                  : "text-foreground"
            }`}
          >
            {formatCountdown(remainingMs)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Expires at{" "}
            {new Date(approval.expiresAt).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </p>
        </div>

        <div className="border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <MailCheck className="h-4 w-4" aria-hidden="true" />
            Magic link (single-use)
          </div>
          {/* A resumed approval (console reopened after the link was handed to
              the resident) has no link: the single-use token is deliberately
              never persisted on the gate device. Say so rather than render an
              empty/broken link. */}
          {approval.magicLinkUrl === "" ? (
            <p
              data-testid="approval-magic-link-unavailable"
              className="mt-2 text-xs text-muted-foreground"
            >
              The link is not shown again after the console was reopened. The
              resident&apos;s decision still appears here; request a new
              approval if they never received it.
            </p>
          ) : (
            <p
              data-testid="approval-magic-link"
              className="mt-2 break-all font-mono text-xs text-foreground"
            >
              {approval.magicLinkUrl}
            </p>
          )}
          {approval.magicLinkUrl !== "" && (
            <>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="focus-ring inline-flex items-center gap-1 border border-primary bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground"
                  onClick={() => void onCopy()}
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  {copied ? "Copied" : "Copy link"}
                </button>
                <a
                  className="focus-ring inline-flex items-center gap-1 border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground"
                  href={approval.magicLinkUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  Open
                </a>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Share with the resident. Anyone who receives this link can
                approve or deny once — don't post it publicly.
              </p>
            </>
          )}
        </div>
      </div>

      <div className="mt-5 flex items-center gap-3">
        <Loader2
          className="h-5 w-5 animate-spin text-info-foreground"
          aria-hidden="true"
        />
        <p className="text-sm font-semibold text-muted-foreground">
          {approval.status === "pending" && !expired
            ? "Polling for the resident's decision…"
            : approval.status === "pending" && expired
              ? "Time expired — next poll will confirm."
              : `Status: ${approval.status}`}
        </p>
      </div>

      <div className="mt-5">
        <DeliveryStatusBlock
          rows={state.notifications.byApprovalId[approval.id]}
          loading={state.notifications.loading}
          lastError={state.notifications.lastError}
          onRetry={actions.retryNotification}
          nowMs={now}
        />
      </div>

      <div className="mt-5 flex flex-col gap-3 sm:flex-row">
        <button
          className="focus-ring border border-border px-5 py-3 font-semibold"
          onClick={() => dispatch({ type: "RESET_FLOW" })}
        >
          <XIcon className="mr-1 inline h-4 w-4" aria-hidden="true" />
          Cancel approval
        </button>
      </div>
    </section>
  );
}

export function ConfirmationPanel({ state, dispatch }: Props) {
  const entry = state.lastEntry;
  // Source: src/docs/specs/auto-approval.md §6 (UI surface) — when an
  // entry was logged via the auto-approval short-circuit, the
  // confirmation panel MUST visually distinguish it from a manual
  // walk-in / override / QR / resident-approved entry. The pill +
  // accent border + rule line are the only places this distinction
  // surfaces in the live UI; the audit log mirrors it in text.
  const isAuto = entry?.method === "auto";
  // The matched rule that fired lives at the head of the audit log
  // (the reducer prepends it inside the same dispatch as the entry).
  // We surface a human-readable subset here without parsing — the
  // audit string is authoritative; the panel quotes it.
  const matchedRuleAuditLine = isAuto
    ? state.audit.find((line) => line.startsWith("auto_approval_matched"))
    : undefined;
  return (
    <section
      className={
        isAuto
          ? "border-2 border-primary bg-success/10 p-6 shadow-panel"
          : "border border-success bg-success/10 p-6 shadow-panel"
      }
      data-testid="confirmation-panel"
      data-auto-approved={isAuto ? "true" : "false"}
    >
      <CheckCircle2 className="h-12 w-12 text-success-foreground" />
      <div className="mt-4 flex items-center gap-3">
        <h2 className="font-display text-4xl font-black">
          {isAuto ? "Entry auto-approved" : "Entry recorded"}
        </h2>
        {isAuto && (
          <span
            className="inline-flex items-center border-2 border-primary bg-primary/15 px-2 py-1 text-xs font-bold uppercase tracking-widest text-primary"
            data-testid="auto-pill"
            aria-label="Auto-approved by rule"
          >
            AUTO
          </span>
        )}
      </div>
      <p className="mt-2 text-muted-foreground">
        {entry?.visitorName} · {entry?.method} · {entry?.guardId} ·{" "}
        {entry?.syncState}
      </p>
      {isAuto && matchedRuleAuditLine && (
        <p
          className="mt-3 border-l-2 border-primary bg-card/50 px-3 py-2 text-xs text-foreground"
          data-testid="auto-rule-line"
        >
          <span className="font-semibold uppercase tracking-widest text-primary">
            Rule:
          </span>{" "}
          {matchedRuleAuditLine.replace(/^auto_approval_matched: /, "")}
        </p>
      )}
      {entry?.syncState === "queued" && (
        <p className="mt-3 text-sm text-warning-foreground">
          Queued offline. Reconcile when the network is restored.
        </p>
      )}
      {state.watchlistMatch && (
        <WatchlistWarning
          match={state.watchlistMatch}
          escalation={state.watchlistEscalation}
          dispatch={dispatch}
          mode="notice"
        />
      )}
      <button
        className="focus-ring mt-6 bg-primary px-5 py-4 font-display text-lg font-bold text-primary-foreground"
        onClick={() => dispatch({ type: "RESET_FLOW" })}
      >
        Next arrival
      </button>
    </section>
  );
}

export function ErrorPanel({ state, dispatch }: Props) {
  // A failed redemption replaces the QR/PIN panel with this screen, so this
  // is the only place the guard can be told *why* the pass was refused. A
  // pass locked by the PIN limiter is not a generic block: the guard must
  // know it can never be admitted on this pass, however many times they
  // re-scan it.
  const locked = state.qrState === "locked";
  return (
    <section
      className="border border-destructive bg-destructive/10 p-6 shadow-panel"
      role="alert"
    >
      {locked ? (
        <Lock className="h-12 w-12 text-destructive" />
      ) : (
        <AlertTriangle className="h-12 w-12 text-destructive" />
      )}
      <h2
        className="mt-4 font-display text-4xl font-black"
        data-testid="error-panel-title"
      >
        {locked ? "Locked" : "Entry blocked"}
      </h2>
      <p className="mt-2 text-destructive">{state.banner.message}</p>
      {locked && (
        <p
          className="mt-2 text-sm font-semibold text-destructive"
          data-testid="error-panel-locked-note"
        >
          Too many incorrect PIN attempts locked this pass — the QR on it is
          dead too. Re-scanning will not help. Ask the resident to re-issue, or
          log a walk-in/override.
        </p>
      )}
      {state.lastError?.code && (
        <p className="mt-2 text-sm text-destructive/80">
          Code: <code>{state.lastError.code}</code>
        </p>
      )}
      <div className="mt-5 flex flex-wrap gap-3">
        <button
          className="focus-ring border border-destructive px-4 py-3 text-sm font-semibold text-destructive"
          onClick={() => dispatch({ type: "NAVIGATE", mode: "walkin" })}
        >
          Use walk-in
        </button>
        <button
          className="focus-ring border border-border px-4 py-3 text-sm font-semibold"
          onClick={() => dispatch({ type: "RESET_FLOW" })}
        >
          Reset flow
        </button>
      </div>
    </section>
  );
}

function AuditPanel({
  state,
  actions,
}: {
  state: GatePassState;
  actions: GatePassActions;
}) {
  return (
    <aside className="border border-border bg-card p-5 shadow-panel">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-display text-2xl font-bold">
          <LayoutDashboard className="mr-2 inline h-5 w-5" /> Audit
        </h3>
        <button
          className="focus-ring flex items-center gap-2 border border-border px-3 py-2 text-xs font-semibold disabled:opacity-60"
          onClick={() => void actions.syncPending()}
          disabled={state.inFlight || state.pendingSync.length === 0}
        >
          <RefreshCw className="h-4 w-4" />
          Sync ({state.pendingSync.length})
        </button>
      </div>
      <ul className="mt-3 grid gap-2 text-sm">
        <li className="flex items-center gap-2">
          <Radar className="h-4 w-4" /> Entries logged: {state.entries.length}
        </li>
        <li className="flex items-center gap-2">
          <Clock3 className="h-4 w-4" /> Pending sync: {state.pendingSync.length}
        </li>
      </ul>
      {state.pendingSync.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
            Queued
          </p>
          <ul className="mt-2 grid gap-2 text-sm">
            {state.pendingSync.map((entry) => (
              <li
                key={entry.offlineId ?? entry.id}
                className={`border p-2 ${entry.syncState === "failed" ? "border-destructive bg-destructive/10" : "border-border"}`}
              >
                <span className="font-semibold">{entry.visitorName}</span> ·{" "}
                {entry.method} · {entry.syncState}
                {entry.lastError && (
                  <span className="block text-xs text-destructive">
                    {entry.lastError.code}: {entry.lastError.message}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {state.lastSyncResults.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
            Last sync results
          </p>
          <ul className="mt-2 grid gap-2 text-sm">
            {state.lastSyncResults.map((result) => (
              <li
                key={result.offlineId}
                className={`border p-2 ${result.status === "rejected" ? "border-destructive bg-destructive/10 text-destructive" : "border-border"}`}
              >
                <span className="font-semibold">{result.visitorName}</span> ·{" "}
                {result.status}
                {result.error && (
                  <span className="block text-xs">
                    {result.error.code}: {result.error.message}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-4 text-xs text-muted-foreground">
        Most recent: {state.audit[0] ?? "No activity yet this session."}
      </p>
    </aside>
  );
}

export function AdminShell({ state }: { state: GatePassState }) {
  // Source: src/docs/specs/auto-approval.md §6 — auto-approvals are
  // counted alongside override flags in admin so an admin scanning the
  // shell can see the auto-vs-manual mix at a glance.
  return (
    <section className="border border-border bg-card p-5 shadow-panel">
      <h2 className="font-display text-3xl font-bold">Admin shell</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Operational counts and the rolling guard audit log.
      </p>
      <p
        className="mt-1 text-xs text-muted-foreground"
        data-testid="audit-session-guard"
      >
        {state.guardLabel
          ? `Session guard: ${state.guardLabel}`
          : "Session guard: identifying…"}
      </p>
      <div className="mt-5 grid gap-3 md:grid-cols-4">
        <Stat label="Entries logged" value={state.entries.length} />
        <Stat label="Pending sync" value={state.pendingSync.length} />
        <Stat
          label="Override flags"
          value={state.entries.filter((entry) => entry.method === "override").length}
        />
        <Stat
          label="Auto-approved"
          value={state.entries.filter((entry) => entry.method === "auto").length}
        />
      </div>
      <div className="mt-5">
        <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
          Audit log
        </p>
        {state.audit.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No activity logged in this session yet.
          </p>
        ) : (
          <ul className="mt-2 grid gap-1 text-sm">
            {state.audit.slice(0, 8).map((line, index) => (
              <li key={`${index}-${line}`} className="border-b border-border py-1">
                {line}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// ─── Feature 4 — Visitor profile CRUD admin panel ───────────────────
//
// Source: src/docs/specs/visitor-profiles.md §8 (frontend reducer
// contract) and §4 (API). The panel is a pure consumer of
// state.visitorProfiles and the controller's visitor methods; it never
// touches the API directly. Watch-flagged rows render with a left
// accent border and a WATCH pill so an admin scanning the table can
// spot them without reading the row body. Soft-deleted rows render a
// Restore action instead of Edit/Delete and a tombstone timestamp.

export function VisitorsAdminPanel({ state, actions }: Props) {
  const slice = state.visitorProfiles;
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const editingProfile = useMemo(
    () => (editingId ? slice.byId[editingId] : undefined),
    [editingId, slice.byId],
  );

  const visibleRows = useMemo(
    () =>
      slice.order
        .map((id) => slice.byId[id])
        .filter((profile): profile is VisitorProfileView => Boolean(profile)),
    [slice.byId, slice.order],
  );

  const openCreate = () => {
    setEditingId(null);
    setShowForm(true);
  };

  const openEdit = (id: string) => {
    setEditingId(id);
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingId(null);
  };

  const createInFlight = Boolean(
    slice.mutationInFlight[VISITOR_PROFILE_NEW_KEY],
  );
  const createError = slice.mutationErrors[VISITOR_PROFILE_NEW_KEY];

  return (
    <section
      className="border border-border bg-card p-5 shadow-panel"
      data-testid="visitors-admin-panel"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-3xl font-bold">Visitors</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage the visitor directory used for recognition + watch flags.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input
              type="checkbox"
              checked={slice.includeDeleted}
              onChange={() => actions.toggleVisitorProfilesIncludeDeleted()}
              data-testid="visitors-show-deleted-toggle"
            />
            Show deleted
          </label>
          <button
            type="button"
            className="focus-ring border border-primary bg-primary px-4 py-2 font-display text-sm font-bold text-primary-foreground shadow-panel transition-transform hover:-translate-y-0.5"
            onClick={openCreate}
            data-testid="visitors-new-button"
          >
            + New visitor
          </button>
        </div>
      </header>

      {slice.lastError && (
        <div
          role="alert"
          data-testid="visitors-list-error"
          className="mt-4 border border-destructive bg-destructive/10 p-3 text-sm font-semibold text-destructive"
        >
          {slice.lastError.code}: {slice.lastError.message}
        </div>
      )}

      {slice.loading && (
        <p
          className="mt-4 text-sm font-semibold text-muted-foreground"
          data-testid="visitors-loading"
        >
          Loading visitors…
        </p>
      )}

      <div className="mt-4 overflow-x-auto">
        <table
          className="w-full border-collapse text-left text-sm"
          data-testid="visitors-table"
        >
          <thead className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
            <tr>
              <th className="border-b border-border px-2 py-2">Visitor</th>
              <th className="border-b border-border px-2 py-2">Host</th>
              <th className="border-b border-border px-2 py-2">Unit</th>
              <th className="border-b border-border px-2 py-2">Plate</th>
              <th className="border-b border-border px-2 py-2">Phone</th>
              <th className="border-b border-border px-2 py-2">Notes</th>
              <th className="border-b border-border px-2 py-2">Updated</th>
              <th className="border-b border-border px-2 py-2 text-right">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.length === 0 && !slice.loading && (
              <tr>
                <td
                  colSpan={8}
                  className="px-2 py-6 text-center text-muted-foreground"
                  data-testid="visitors-empty-row"
                >
                  No visitors yet. Use “+ New visitor” to add one.
                </td>
              </tr>
            )}
            {visibleRows.map((profile) => (
              <VisitorAdminRow
                key={profile.id}
                profile={profile}
                inFlight={Boolean(slice.mutationInFlight[profile.id])}
                error={slice.mutationErrors[profile.id]}
                onEdit={() => openEdit(profile.id)}
                onDelete={() =>
                  void actions.softDeleteVisitorProfile(profile.id)
                }
                onRestore={() =>
                  void actions.restoreVisitorProfile(profile.id)
                }
              />
            ))}
          </tbody>
        </table>
      </div>

      {slice.pagination && slice.pagination.totalPages > 1 && (
        <div
          className="mt-4 flex items-center justify-between text-sm"
          data-testid="visitors-pagination"
        >
          <span>
            Page {slice.pagination.page} of {slice.pagination.totalPages}
            {" — "}
            {slice.pagination.totalItems} total
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className="focus-ring border border-input bg-background px-3 py-1 font-semibold disabled:opacity-50"
              disabled={slice.pagination.page <= 1 || slice.loading}
              onClick={() =>
                void actions.loadVisitorProfiles({
                  page: (slice.pagination?.page ?? 1) - 1,
                  pageSize: slice.pagination?.pageSize,
                })
              }
              data-testid="visitors-prev-page"
            >
              Prev
            </button>
            <button
              type="button"
              className="focus-ring border border-input bg-background px-3 py-1 font-semibold disabled:opacity-50"
              disabled={
                slice.pagination.page >= slice.pagination.totalPages ||
                slice.loading
              }
              onClick={() =>
                void actions.loadVisitorProfiles({
                  page: (slice.pagination?.page ?? 1) + 1,
                  pageSize: slice.pagination?.pageSize,
                })
              }
              data-testid="visitors-next-page"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {showForm && (
        <VisitorAdminForm
          editingProfile={editingProfile}
          inFlight={
            editingProfile
              ? Boolean(slice.mutationInFlight[editingProfile.id])
              : createInFlight
          }
          error={
            editingProfile
              ? slice.mutationErrors[editingProfile.id]
              : createError
          }
          onCancel={closeForm}
          onCreate={async (input) => {
            await actions.createVisitorProfile(input);
          }}
          onUpdate={async (id, patch) => {
            await actions.updateVisitorProfile(id, patch);
          }}
        />
      )}
    </section>
  );
}

function VisitorAdminRow({
  profile,
  inFlight,
  error,
  onEdit,
  onDelete,
  onRestore,
}: {
  profile: VisitorProfileView;
  inFlight: boolean;
  error: GatePassState["visitorProfiles"]["mutationErrors"][string];
  onEdit: () => void;
  onDelete: () => void;
  onRestore: () => void;
}) {
  const tombstoned = Boolean(profile.deletedAt);
  const watch = profile.watchFlag;
  return (
    <tr
      data-testid={`visitor-row-${profile.id}`}
      data-watch={watch ? "true" : undefined}
      data-deleted={tombstoned ? "true" : undefined}
      className={
        // Watch-flagged rows get a thick left accent so they read at a
        // glance even if WATCH text is clipped on a narrow viewport.
        "border-b border-border align-top " +
        (watch ? "border-l-4 border-l-destructive" : "") +
        (tombstoned ? " opacity-60" : "")
      }
    >
      <td className="px-2 py-2 font-semibold">
        {profile.visitorName}
        {watch && (
          <span
            data-testid={`watch-pill-${profile.id}`}
            aria-label="Watch list flag"
            className="ml-2 inline-block border border-destructive bg-destructive/10 px-2 py-0.5 align-middle text-xs font-bold uppercase tracking-widest text-destructive"
          >
            WATCH
          </span>
        )}
      </td>
      <td className="px-2 py-2">{profile.host}</td>
      <td className="px-2 py-2">{profile.unit}</td>
      <td className="px-2 py-2">{profile.plate ?? "—"}</td>
      <td className="px-2 py-2">{profile.phoneE164 ?? "—"}</td>
      <td className="px-2 py-2 text-xs text-muted-foreground">
        {profile.notes ?? ""}
      </td>
      <td className="px-2 py-2 text-xs text-muted-foreground">
        {profile.updatedAt}
        {tombstoned && (
          <div className="text-destructive">
            deleted {profile.deletedAt}
          </div>
        )}
      </td>
      <td className="px-2 py-2 text-right">
        {tombstoned ? (
          <button
            type="button"
            className="focus-ring border border-input bg-background px-2 py-1 text-xs font-semibold disabled:opacity-50"
            onClick={onRestore}
            disabled={inFlight}
            data-testid={`visitor-restore-${profile.id}`}
          >
            {inFlight ? "Restoring…" : "Restore"}
          </button>
        ) : (
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="focus-ring border border-input bg-background px-2 py-1 text-xs font-semibold disabled:opacity-50"
              onClick={onEdit}
              disabled={inFlight}
              data-testid={`visitor-edit-${profile.id}`}
            >
              Edit
            </button>
            <button
              type="button"
              className="focus-ring border border-destructive bg-destructive/10 px-2 py-1 text-xs font-semibold text-destructive disabled:opacity-50"
              onClick={onDelete}
              disabled={inFlight}
              data-testid={`visitor-delete-${profile.id}`}
            >
              {inFlight ? "Working…" : "Delete"}
            </button>
          </div>
        )}
        {error && (
          <div
            role="alert"
            data-testid={`visitor-row-error-${profile.id}`}
            className="mt-1 text-xs font-semibold text-destructive"
          >
            {error.code}: {error.message}
          </div>
        )}
      </td>
    </tr>
  );
}

function VisitorAdminForm({
  editingProfile,
  inFlight,
  error,
  onCancel,
  onCreate,
  onUpdate,
}: {
  editingProfile?: VisitorProfileView;
  inFlight: boolean;
  error: GatePassState["visitorProfiles"]["mutationErrors"][string];
  onCancel: () => void;
  onCreate: (input: CreateVisitorProfileRequest) => Promise<void>;
  onUpdate: (
    id: string,
    patch: UpdateVisitorProfileRequest,
  ) => Promise<void>;
}) {
  const [visitorName, setVisitorName] = useState(
    editingProfile?.visitorName ?? "",
  );
  const [host, setHost] = useState(editingProfile?.host ?? "");
  const [unit, setUnit] = useState(editingProfile?.unit ?? "");
  const [plate, setPlate] = useState(editingProfile?.plate ?? "");
  const [phoneE164, setPhoneE164] = useState(editingProfile?.phoneE164 ?? "");
  const [notes, setNotes] = useState(editingProfile?.notes ?? "");
  const [watchFlag, setWatchFlag] = useState(
    editingProfile?.watchFlag ?? false,
  );
  const [validation, setValidation] = useState<string | null>(null);

  const errorField = error?.field;
  const isEditing = Boolean(editingProfile);

  const handleSubmit = async () => {
    // Client-side guard so we never burn an HTTP roundtrip on an obviously
    // empty form. The server is still the source of truth for any
    // edge-case validation (uniqueness, format, etc.).
    if (!visitorName.trim() || !host.trim() || !unit.trim()) {
      setValidation("Visitor name, host, and unit are required.");
      return;
    }
    setValidation(null);
    if (isEditing && editingProfile) {
      await onUpdate(editingProfile.id, {
        visitorName: visitorName.trim(),
        host: host.trim(),
        unit: unit.trim(),
        plate: plate.trim() || null,
        phoneE164: phoneE164.trim() || null,
        notes: notes.trim() || null,
        watchFlag,
      });
    } else {
      await onCreate({
        visitorName: visitorName.trim(),
        host: host.trim(),
        unit: unit.trim(),
        plate: plate.trim() || undefined,
        phoneE164: phoneE164.trim() || undefined,
        notes: notes.trim() || undefined,
        watchFlag,
      });
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={isEditing ? "Edit visitor profile" : "New visitor profile"}
      data-testid="visitor-form-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4"
    >
      <div className="w-full max-w-2xl border border-border bg-card p-5 shadow-panel">
        <header className="flex items-center justify-between">
          <h3 className="font-display text-2xl font-bold">
            {isEditing ? "Edit visitor" : "New visitor"}
          </h3>
          <button
            type="button"
            className="focus-ring border border-input bg-background px-2 py-1 text-xs"
            onClick={onCancel}
            data-testid="visitor-form-cancel"
          >
            Cancel
          </button>
        </header>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <FormField
            label="Visitor name (required)"
            value={visitorName}
            onChange={setVisitorName}
            invalid={errorField === "visitorName"}
            testid="visitor-form-name"
          />
          <FormField
            label="Host (required)"
            value={host}
            onChange={setHost}
            invalid={errorField === "host"}
            testid="visitor-form-host"
          />
          <FormField
            label="Unit (required)"
            value={unit}
            onChange={setUnit}
            invalid={errorField === "unit"}
            testid="visitor-form-unit"
          />
          <FormField
            label="Plate (optional)"
            value={plate ?? ""}
            onChange={setPlate}
            invalid={errorField === "plate"}
            testid="visitor-form-plate"
          />
          <FormField
            label="Phone (E.164, optional)"
            value={phoneE164 ?? ""}
            onChange={setPhoneE164}
            invalid={errorField === "phoneE164"}
            testid="visitor-form-phone"
          />
          <label className="grid gap-2 text-sm font-semibold md:col-span-2">
            Notes (optional)
            <textarea
              className={`focus-ring min-h-20 border bg-background px-3 py-2 ${errorField === "notes" ? "border-destructive" : "border-input"}`}
              value={notes ?? ""}
              onChange={(e) => setNotes(e.target.value)}
              data-testid="visitor-form-notes"
            />
          </label>
          <label className="flex items-center gap-2 text-sm font-semibold md:col-span-2">
            <input
              type="checkbox"
              checked={watchFlag}
              onChange={(e) => setWatchFlag(e.target.checked)}
              data-testid="visitor-form-watch"
            />
            Watch list flag (visitor needs extra scrutiny)
          </label>
        </div>

        {validation && (
          <p
            role="alert"
            data-testid="visitor-form-validation"
            className="mt-3 text-sm font-semibold text-destructive"
          >
            {validation}
          </p>
        )}

        {error && (
          <p
            role="alert"
            data-testid="visitor-form-error"
            className="mt-3 text-sm font-semibold text-destructive"
          >
            {error.code}: {error.message}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="focus-ring border border-input bg-background px-4 py-2 font-semibold disabled:opacity-50"
            onClick={onCancel}
            disabled={inFlight}
          >
            Close
          </button>
          <button
            type="button"
            className="focus-ring border border-primary bg-primary px-4 py-2 font-display font-bold text-primary-foreground shadow-panel disabled:opacity-50"
            onClick={() => void handleSubmit()}
            disabled={inFlight}
            data-testid="visitor-form-submit"
          >
            {inFlight
              ? "Saving…"
              : isEditing
                ? "Save changes"
                : "Create visitor"}
          </button>
        </div>
      </div>
    </div>
  );
}

function FormField({
  label,
  value,
  onChange,
  invalid,
  testid,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  invalid: boolean;
  testid: string;
}) {
  return (
    <label className="grid gap-2 text-sm font-semibold">
      {label}
      <input
        className={`focus-ring border bg-background px-3 py-2 ${invalid ? "border-destructive" : "border-input"}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testid}
      />
    </label>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-border bg-background p-4 shadow-panel">
      <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 font-display text-3xl font-black">{value}</p>
    </div>
  );
}

// ─── Feature 5 — Shift log aggregation panel ───────────────────
//
// Source: src/docs/specs/shift-log-aggregation.md §8 (UI surface).
//
// Read-only admin view. The form lets an admin tighten the window and
// optionally pin to a single guard. Submitting fires loadShifts; the
// reducer's lastError surfaces below the table without wiping the
// previously-loaded rows — a 500 never silently flashes the admin to
// an empty list (no-silent-success contract).
//
// `localQuery` mirrors the admin's pending edits before they submit;
// the slice's `query` is the canonical filter the controller persists.

export function ShiftLogPanel({ state, actions }: Props) {
  const slice = state.shifts;
  const [localQuery, setLocalQuery] = useState<ShiftsQuery>(() => slice.query);

  // Keep the form in sync if the slice's query is updated externally
  // (e.g. loadShifts(override) persists a window).
  useEffect(() => {
    setLocalQuery(slice.query);
  }, [slice.query]);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void actions.loadShifts(localQuery);
  };

  const onChange = (patch: Partial<ShiftsQuery>) => {
    const next = { ...localQuery, ...patch };
    // Drop empty strings so the API client sees genuine 'omitted'
    // (instead of a literal empty query param).
    for (const key of Object.keys(next) as (keyof ShiftsQuery)[]) {
      if (next[key] === "") delete next[key];
    }
    setLocalQuery(next);
  };

  return (
    <section
      className="border border-border bg-card p-5 shadow-panel"
      data-testid="shift-log-panel"
    >
      <header className="flex flex-col gap-2 md:flex-row md:items-baseline md:justify-between">
        <div>
          <h2 className="font-display text-2xl font-bold">Shift log</h2>
          <p className="text-sm text-muted-foreground">
            Read-only aggregation over entry records and audit events.
          </p>
        </div>
        {slice.window && (
          <p
            className="text-xs font-bold uppercase tracking-widest text-muted-foreground"
            data-testid="shift-log-window-label"
          >
            Window: {slice.window.fromIso} → {slice.window.toIso}
          </p>
        )}
      </header>

      <form
        className="mt-4 grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto]"
        onSubmit={handleSubmit}
      >
        <FormField
          label="From (ISO-8601 UTC)"
          value={localQuery.fromIso ?? ""}
          onChange={(value) => onChange({ fromIso: value })}
          invalid={false}
          testid="shift-log-from"
        />
        <FormField
          label="To (ISO-8601 UTC)"
          value={localQuery.toIso ?? ""}
          onChange={(value) => onChange({ toIso: value })}
          invalid={false}
          testid="shift-log-to"
        />
        <FormField
          label="Guard ID (UUID, optional)"
          value={localQuery.guardId ?? ""}
          onChange={(value) => onChange({ guardId: value })}
          invalid={false}
          testid="shift-log-guard"
        />
        <button
          type="submit"
          className="focus-ring self-end border border-foreground bg-foreground px-4 py-2 text-sm font-semibold text-background"
          data-testid="shift-log-refresh"
          disabled={slice.loading}
        >
          {slice.loading ? "Loading…" : "Refresh"}
        </button>
      </form>

      {slice.lastError && (
        <div
          className="mt-4 border border-destructive bg-destructive/10 p-3 text-sm text-destructive"
          role="alert"
          data-testid="shift-log-error"
        >
          <p className="font-semibold">
            {slice.lastError.code}: {slice.lastError.message}
          </p>
          {slice.lastError.traceId && (
            <p className="mt-1 text-xs opacity-80">
              Trace: <code>{slice.lastError.traceId}</code>
            </p>
          )}
        </div>
      )}

      <div className="mt-4 overflow-x-auto">
        <table
          className="w-full border-collapse text-sm"
          data-testid="shift-log-table"
        >
          <thead>
            <tr className="border-b border-border text-left text-xs font-bold uppercase tracking-widest text-muted-foreground">
              <th className="py-2 pr-3">Guard</th>
              <th className="py-2 pr-3">Badge</th>
              <th className="py-2 pr-3">Entries</th>
              <th className="py-2 pr-3">QR</th>
              <th className="py-2 pr-3">Walk-in</th>
              <th className="py-2 pr-3">Override</th>
              <th className="py-2 pr-3">Auto</th>
              <th className="py-2 pr-3">Denied</th>
              <th className="py-2 pr-3">Expired</th>
            </tr>
          </thead>
          <tbody>
            {slice.rows.length === 0 ? (
              <tr>
                <td
                  colSpan={9}
                  className="py-6 text-center text-sm text-muted-foreground"
                  data-testid="shift-log-empty"
                >
                  No shifts in this window.
                </td>
              </tr>
            ) : (
              slice.rows.map((row) => (
                <tr
                  key={row.guardId}
                  className="border-b border-border"
                  data-testid={`shift-log-row-${row.guardId}`}
                >
                  <td className="py-2 pr-3 font-semibold">{row.guardName}</td>
                  <td className="py-2 pr-3 font-mono text-xs">
                    {row.badgeNumber}
                  </td>
                  <td className="py-2 pr-3 font-mono">{row.totals.entries}</td>
                  <td className="py-2 pr-3 font-mono">{row.totals.qr}</td>
                  <td className="py-2 pr-3 font-mono">{row.totals.walkIn}</td>
                  <td className="py-2 pr-3 font-mono">{row.totals.override}</td>
                  <td className="py-2 pr-3 font-mono">{row.totals.auto}</td>
                  <td className="py-2 pr-3 font-mono">
                    {row.totals.approvalsDenied}
                  </td>
                  <td className="py-2 pr-3 font-mono">
                    {row.totals.approvalsExpired}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── Visitor invitation admin panel (Feature 6 Slice 7) ────────────────
//
// Source: src/docs/specs/guest-qr-ticket.md §7 (UI states), §A6/A8
// (security model — QR rendered client-side, raw token surfaces ONCE).
//
// State machine:
//   idle      → form
//   submitting→ form (disabled) with "Issuing…"
//   issued    → success card (QR PNG + pass URL + raw token) + "Issue another"
//   failed    → form + error banner (code + message + traceId hint)
//
// Default-deny contract: the success card is reachable ONLY when the
// slice status is "issued". Any non-2xx response lands in "failed" via
// the reducer (gatepassReducer.ts case VISITOR_INVITATION_ISSUE_FAILED)
// and the form stays visible with the error code displayed.
export function VisitorInvitationsAdminPanel({ state, actions }: Props) {
  const slice = state.visitorInvitations;
  const [visitorName, setVisitorName] = useState("");
  const [host, setHost] = useState("");
  const [unit, setUnit] = useState("");
  const [plate, setPlate] = useState("");
  const [copied, setCopied] = useState(false);

  const isSubmitting = slice.status === "submitting";
  const isIssued = slice.status === "issued" && slice.lastIssued;
  const issueError = slice.status === "failed" ? slice.lastError : undefined;

  const canSubmit =
    !isSubmitting &&
    visitorName.trim().length > 0 &&
    host.trim().length > 0 &&
    unit.trim().length > 0;

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    const trimmedPlate = plate.trim();
    await actions.issueVisitorInvitation({
      visitorName: visitorName.trim(),
      host: host.trim(),
      unit: unit.trim(),
      plate: trimmedPlate.length > 0 ? trimmedPlate : undefined,
    });
  };

  const onIssueAnother = () => {
    actions.resetVisitorInvitation();
    setVisitorName("");
    setHost("");
    setUnit("");
    setPlate("");
    setCopied(false);
  };

  const onCopyPassUrl = async () => {
    if (!slice.lastIssued) return;
    try {
      await navigator.clipboard.writeText(slice.lastIssued.passUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may be unavailable in some browsers — keep the
      // visible URL so the admin can copy manually. Silent failure
      // here is acceptable because the URL is already on screen.
    }
  };

  return (
    <section
      className="border border-border bg-card p-5 shadow-panel"
      data-testid="visitor-invitations-panel"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-3xl font-bold">Invite visitor</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Issue a single-use QR pass. Share the link or QR with the visitor —
            the guard scans it at the gate.
          </p>
        </div>
      </header>

      {isIssued && slice.lastIssued && (
        <div
          className="mt-4 border border-primary bg-primary/5 p-4"
          data-testid="visitor-invitation-issued"
        >
          <div className="flex flex-wrap items-start gap-5">
            <div
              className="bg-white p-3"
              data-testid="visitor-invitation-qr"
            >
              <QRCodeSVG
                value={slice.lastIssued.passUrl}
                size={160}
                level="M"
                includeMargin
              />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-display text-xl font-bold">
                Pass issued for {slice.lastIssued.visitorName}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Host: {slice.lastIssued.host} · Unit: {slice.lastIssued.unit}
                {slice.lastIssued.plate ? ` · Plate: ${slice.lastIssued.plate}` : ""}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Valid until{" "}
                <time dateTime={slice.lastIssued.expiresAt}>
                  {new Date(slice.lastIssued.expiresAt).toLocaleString()}
                </time>
              </p>

              <div className="mt-3">
                <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
                  Pass URL
                </p>
                <div className="mt-1 flex items-center gap-2">
                  <code
                    className="block min-w-0 flex-1 truncate border border-border bg-background px-2 py-1 text-xs"
                    data-testid="visitor-invitation-pass-url"
                  >
                    {slice.lastIssued.passUrl}
                  </code>
                  <button
                    type="button"
                    className="focus-ring border border-border bg-background px-3 py-1 text-xs font-bold"
                    onClick={onCopyPassUrl}
                    data-testid="visitor-invitation-copy"
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>

              {/* Feature 11 (Stage 4) — PIN backup. Shown EXACTLY ONCE at
                  issue alongside the QR; the PIN never appears in previews or
                  later responses. Guard redeems with pass reference + PIN. */}
              <div className="mt-3 grid gap-3 border border-primary/40 bg-primary/5 p-3 sm:grid-cols-2">
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
                    Pass reference
                  </p>
                  <code
                    className="mt-1 block border border-border bg-background px-2 py-1 font-mono text-lg tracking-widest"
                    data-testid="visitor-invitation-pass-ref"
                  >
                    {slice.lastIssued.passRef}
                  </code>
                </div>
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
                    One-time PIN
                  </p>
                  <code
                    className="mt-1 block border border-border bg-background px-2 py-1 font-mono text-lg tracking-[0.4em]"
                    data-testid="visitor-invitation-pin"
                  >
                    {slice.lastIssued.pin}
                  </code>
                </div>
              </div>

              <p className="mt-3 text-xs italic text-muted-foreground">
                This pass is single-use. The QR and PIN will not be shown again,
                and share the same expiry. Redeeming either invalidates both.
              </p>

              <button
                type="button"
                className="focus-ring mt-4 border border-primary bg-primary px-4 py-2 font-display text-sm font-bold text-primary-foreground"
                onClick={onIssueAnother}
                data-testid="visitor-invitation-reset"
              >
                Issue another
              </button>
            </div>
          </div>
        </div>
      )}

      {!isIssued && (
        <form
          className="mt-4 grid gap-3"
          onSubmit={onSubmit}
          data-testid="visitor-invitation-form"
          noValidate
        >
          {issueError && (
            <div
              role="alert"
              data-testid="visitor-invitation-error"
              className="border border-destructive bg-destructive/10 p-3 text-sm font-semibold text-destructive"
            >
              {issueError.code}: {issueError.message}
              {issueError.traceId ? (
                <span className="ml-2 text-xs font-normal opacity-75">
                  (trace {issueError.traceId})
                </span>
              ) : null}
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-1 text-sm font-semibold">
              Visitor name
              <input
                type="text"
                className="focus-ring border border-border bg-background px-3 py-2"
                value={visitorName}
                onChange={(e) => setVisitorName(e.target.value)}
                disabled={isSubmitting}
                data-testid="visitor-invitation-visitorName"
                required
              />
            </label>
            <label className="grid gap-1 text-sm font-semibold">
              Host
              <input
                type="text"
                className="focus-ring border border-border bg-background px-3 py-2"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                disabled={isSubmitting}
                data-testid="visitor-invitation-host"
                required
              />
            </label>
            <label className="grid gap-1 text-sm font-semibold">
              Unit
              <input
                type="text"
                className="focus-ring border border-border bg-background px-3 py-2"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                disabled={isSubmitting}
                data-testid="visitor-invitation-unit"
                required
              />
            </label>
            <label className="grid gap-1 text-sm font-semibold">
              Plate (optional)
              <input
                type="text"
                className="focus-ring border border-border bg-background px-3 py-2"
                value={plate}
                onChange={(e) => setPlate(e.target.value)}
                disabled={isSubmitting}
                data-testid="visitor-invitation-plate"
              />
            </label>
          </div>

          <div>
            <button
              type="submit"
              className="focus-ring border border-primary bg-primary px-4 py-2 font-display text-sm font-bold text-primary-foreground transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!canSubmit}
              data-testid="visitor-invitation-submit"
            >
              {isSubmitting ? "Issuing…" : "Issue QR pass"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

// ─── Feature 9 — Guard notes ───────────────────────────────────────────
// Source: src/docs/specs/guard-notes.md §4.
//
// Ordered, standardised tags a guard can attach to an entry. Free-text is
// only allowed (and required) for the "other" tag, capped at
// GUARD_NOTE_TEXT_MAX characters — mirrors the server-side Zod schema.

const GUARD_NOTE_TAG_ORDER: GuardNoteTag[] = [
  "delivered_parcel",
  "left_id_at_gate",
  "escorted_by_resident",
  "other",
];

type EntryNotesCellProps = {
  entry: import("../types").GatePassState["exitTracking"]["onPremise"][number];
  inFlight: boolean;
  error?: import("../types").GatePassError;
  onAdd: (body: AddGuardNoteRequest) => Promise<void> | void;
};

// Per-entry note cell: renders existing note badges plus a small
// add-note form. The free-text field only appears for "other" and is
// character-capped in lockstep with the server contract.
function EntryNotesCell({ entry, inFlight, error, onAdd }: EntryNotesCellProps) {
  const [open, setOpen] = useState(false);
  const [tag, setTag] = useState<GuardNoteTag>("delivered_parcel");
  const [text, setText] = useState("");

  const isOther = tag === "other";
  const trimmed = text.trim();
  const canSubmit =
    !inFlight && (isOther ? trimmed.length > 0 && trimmed.length <= GUARD_NOTE_TEXT_MAX : true);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    const body: AddGuardNoteRequest = isOther
      ? { tag, text: trimmed }
      : { tag };
    await onAdd(body);
  };

  // Collapse the form and clear the draft once the note lands (in-flight
  // clears and no error means the dispatch succeeded).
  const noteCount = entry.notes.length;
  useEffect(() => {
    setOpen(false);
    setText("");
    setTag("delivered_parcel");
  }, [noteCount]);

  return (
    <div className="flex flex-col gap-1.5" data-testid={`notes-cell-${entry.id}`}>
      {entry.notes.length > 0 ? (
        <ul className="flex flex-col gap-1" data-testid={`notes-list-${entry.id}`}>
          {entry.notes.map((n) => (
            <li
              key={n.id}
              className="inline-flex items-center gap-1 text-xs"
              data-testid={`note-${n.id}`}
            >
              <StickyNote className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="rounded-sm border border-border px-1.5 py-0.5 font-semibold">
                {GUARD_NOTE_TAG_LABELS[n.tag]}
              </span>
              {n.text && (
                <span className="text-muted-foreground">{n.text}</span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <span
          className="text-xs text-muted-foreground"
          data-testid={`notes-empty-${entry.id}`}
        >
          No notes
        </span>
      )}

      {open ? (
        <form
          className="flex flex-col gap-1.5"
          data-testid={`note-form-${entry.id}`}
          onSubmit={(e) => void handleSubmit(e)}
        >
          <label className="sr-only" htmlFor={`note-tag-${entry.id}`}>
            Note tag
          </label>
          <select
            id={`note-tag-${entry.id}`}
            className="focus-ring border border-border bg-background px-2 py-1 text-xs"
            data-testid={`note-tag-${entry.id}`}
            value={tag}
            disabled={inFlight}
            onChange={(e) => setTag(e.target.value as GuardNoteTag)}
          >
            {GUARD_NOTE_TAG_ORDER.map((t) => (
              <option key={t} value={t}>
                {GUARD_NOTE_TAG_LABELS[t]}
              </option>
            ))}
          </select>

          {isOther && (
            <div className="flex flex-col gap-0.5">
              <label className="sr-only" htmlFor={`note-text-${entry.id}`}>
                Note text
              </label>
              <textarea
                id={`note-text-${entry.id}`}
                className="focus-ring border border-border bg-background px-2 py-1 text-xs"
                data-testid={`note-text-${entry.id}`}
                rows={2}
                maxLength={GUARD_NOTE_TEXT_MAX}
                value={text}
                disabled={inFlight}
                placeholder="Describe the note…"
                onChange={(e) => setText(e.target.value)}
              />
              <span
                className="text-right text-[10px] text-muted-foreground"
                data-testid={`note-count-${entry.id}`}
              >
                {trimmed.length}/{GUARD_NOTE_TEXT_MAX}
              </span>
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              type="submit"
              className="focus-ring inline-flex items-center gap-1 border border-foreground bg-foreground px-2 py-1 text-xs font-semibold text-background disabled:cursor-not-allowed disabled:opacity-50"
              data-testid={`note-save-${entry.id}`}
              disabled={!canSubmit}
            >
              {inFlight ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <MessageSquarePlus className="h-3 w-3" />
              )}
              {inFlight ? "Saving…" : "Save note"}
            </button>
            <button
              type="button"
              className="focus-ring text-xs underline"
              data-testid={`note-cancel-${entry.id}`}
              disabled={inFlight}
              onClick={() => {
                setOpen(false);
                setText("");
                setTag("delivered_parcel");
              }}
            >
              Cancel
            </button>
          </div>

          {error && (
            <p
              className="text-xs text-destructive"
              role="alert"
              data-testid={`note-error-${entry.id}`}
            >
              {error.code}: {error.message}
            </p>
          )}
        </form>
      ) : (
        <button
          type="button"
          className="focus-ring inline-flex items-center gap-1 self-start border border-border px-2 py-1 text-xs font-semibold transition-transform hover:-translate-y-0.5"
          data-testid={`note-add-btn-${entry.id}`}
          onClick={() => setOpen(true)}
        >
          <MessageSquarePlus className="h-3 w-3" />
          Add note
        </button>
      )}
    </div>
  );
}

// ─── Feature 7 — On-premise panel + exit affordance ────────────────────
// Source: src/docs/specs/exit-tracking.md §8.
//
// Renders every entry that has NOT yet been exited. Each row has a
// "Record exit" button that POSTs the exit, removes the row
// optimistically on success, and surfaces per-row errors on failure.
// The panel auto-loads on admin mode entry (controller useEffect).

export function OnPremisePanel({ state, actions }: Props) {
  const slice = state.exitTracking;

  return (
    <section
      className="border border-border bg-card p-5 shadow-panel"
      data-testid="on-premise-panel"
    >
      <header className="flex flex-col gap-2 md:flex-row md:items-baseline md:justify-between">
        <div>
          <h2 className="font-display text-2xl font-bold">Currently on-premise</h2>
          <p className="text-sm text-muted-foreground">
            Visitors who have entered but not yet exited.
          </p>
        </div>
        <button
          className="focus-ring self-start border border-foreground bg-foreground px-4 py-2 text-sm font-semibold text-background disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="on-premise-refresh"
          disabled={slice.loading}
          onClick={() => void actions.loadOnPremise()}
        >
          {slice.loading ? "Loading…" : "Refresh"}
        </button>
      </header>

      {slice.lastError && (
        <div
          className="mt-4 border border-destructive bg-destructive/10 p-3 text-sm text-destructive"
          role="alert"
          data-testid="on-premise-error"
        >
          <p className="font-semibold">
            {slice.lastError.code}: {slice.lastError.message}
          </p>
          {slice.lastError.traceId && (
            <p className="mt-1 text-xs opacity-80">
              Trace: <code>{slice.lastError.traceId}</code>
            </p>
          )}
        </div>
      )}

      {slice.lastExit && (
        <div
          className="mt-4 flex items-center gap-2 border border-success bg-success/10 p-3 text-sm text-success-foreground"
          role="status"
          data-testid="on-premise-exit-success"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>
            Exit recorded — trace <code>{slice.lastExit.traceId}</code>
          </span>
        </div>
      )}

      <div className="mt-4 overflow-x-auto">
        {slice.onPremise.length === 0 && !slice.loading ? (
          <p
            className="py-6 text-center text-sm text-muted-foreground"
            data-testid="on-premise-empty"
          >
            No visitors currently on-premise.
          </p>
        ) : (
          <table className="w-full text-left text-sm" data-testid="on-premise-table">
            <thead>
              <tr className="border-b border-border text-xs font-bold uppercase tracking-widest text-muted-foreground">
                <th className="py-2 pr-3">Visitor</th>
                <th className="py-2 pr-3">Host</th>
                <th className="py-2 pr-3">Unit</th>
                <th className="py-2 pr-3">Plate</th>
                <th className="py-2 pr-3">Method</th>
                <th className="py-2 pr-3">Entered</th>
                <th className="py-2 pr-3">Notes</th>
                <th className="py-2 pr-3">Action</th>
              </tr>
            </thead>
            <tbody>
              {slice.onPremise.map((entry) => {
                const inFlight = !!slice.exitInFlight[entry.id];
                const error = slice.exitErrors[entry.id];
                const noteInFlight = !!slice.noteInFlight[entry.id];
                const noteError = slice.noteErrors[entry.id];
                return (
                  <tr
                    key={entry.id}
                    className="border-b border-border/50"
                    data-testid={`on-premise-row-${entry.id}`}
                  >
                    <td className="py-2 pr-3 font-semibold">{entry.visitorName}</td>
                    <td className="py-2 pr-3">{entry.host}</td>
                    <td className="py-2 pr-3">{entry.unit}</td>
                    <td className="py-2 pr-3 font-mono text-xs">
                      {entry.plate ?? "—"}
                    </td>
                    <td className="py-2 pr-3">
                      <span className="inline-flex items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 text-xs font-semibold">
                        {entry.method}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-xs text-muted-foreground">
                      {entry.createdAt}
                    </td>
                    <td className="py-2 pr-3 align-top">
                      <EntryNotesCell
                        entry={entry}
                        inFlight={noteInFlight}
                        error={noteError}
                        onAdd={(body) => actions.addEntryNote(entry.id, body)}
                      />
                    </td>
                    <td className="py-2 pr-3 align-top">
                      <button
                        className="focus-ring inline-flex items-center gap-1 border border-destructive px-3 py-1 text-xs font-bold text-destructive transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50"
                        data-testid={`exit-btn-${entry.id}`}
                        disabled={inFlight}
                        onClick={() => void actions.recordExit(entry.id)}
                      >
                        {inFlight ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <LogOut className="h-3 w-3" />
                        )}
                        {inFlight ? "Working…" : "Record exit"}
                      </button>
                      {error && (
                        <p
                          className="mt-1 text-xs text-destructive"
                          data-testid={`exit-error-${entry.id}`}
                        >
                          {error.code}: {error.message}
                        </p>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

// ─── Feature 8: Delivery Management ─────────────────────────────────────────
// Source: src/docs/specs/delivery-management.md §5.
//
// Guard quick-entry form + admin-only recent deliveries table.
// The form is a lightweight tile: rider name, unit, category dropdown.
// Category is required for entryKind='delivery' (spec §4).
// The admin table auto-loads on admin mode entry via the controller effect.

const DELIVERY_CATEGORIES: { value: DeliveryCategory; label: string }[] = [
  { value: "parcel", label: "Parcel" },
  { value: "food", label: "Food" },
  { value: "ride", label: "Ride" },
  { value: "gas", label: "Gas" },
  { value: "water", label: "Water" },
  { value: "moving", label: "Moving" },
  { value: "maintenance", label: "Maintenance" },
  { value: "other", label: "Other" },
];

export function DeliveryAdminPanel({ state, actions }: Props) {
  const slice = state.deliveryManagement;
  const [riderName, setRiderName] = useState("");
  const [unit, setUnit] = useState("");
  const [plate, setPlate] = useState("");
  const [category, setCategory] = useState<DeliveryCategory>("parcel");
  const [showForm, setShowForm] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const input: CreateDeliveryEntryRequest = {
      visitorName: riderName.trim(),
      unit: unit.trim(),
      plate: plate.trim() || undefined,
      createdAt: new Date().toISOString(),
      entryKind: "delivery",
      deliveryCategory: category,
    };
    await actions.submitDelivery(input);
  };

  // Close form after successful submit so the success banner becomes visible.
  const lastEntryId = slice.lastEntry?.id;
  useEffect(() => {
    if (lastEntryId) {
      setShowForm(false);
    }
  }, [lastEntryId]);

  const formReset = () => {
    setRiderName("");
    setUnit("");
    setPlate("");
    setCategory("parcel");
    setShowForm(false);
    actions.resetDeliveryForm();
  };

  return (
    <section
      className="border border-border bg-card p-5 shadow-panel"
      data-testid="delivery-panel"
    >
      <header className="flex flex-col gap-2 md:flex-row md:items-baseline md:justify-between">
        <div>
          <h2 className="font-display text-2xl font-bold">
            <Package className="mr-2 inline h-5 w-5" />
            Deliveries
          </h2>
          <p className="text-sm text-muted-foreground">
            Track parcels, food, rides, and service deliveries.
          </p>
        </div>
        <div className="flex gap-2 self-start">
          <button
            className="focus-ring border border-foreground bg-foreground px-4 py-2 text-sm font-semibold text-background disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="delivery-refresh"
            disabled={slice.loading}
            onClick={() => void actions.loadDeliveries()}
          >
            {slice.loading ? "Loading…" : "Refresh"}
          </button>
          {!showForm && !slice.lastEntry && (
            <button
              className="focus-ring border border-foreground px-4 py-2 text-sm font-semibold transition-transform hover:-translate-y-0.5"
              data-testid="delivery-new-btn"
              onClick={() => setShowForm(true)}
            >
              + New delivery
            </button>
          )}
        </div>
      </header>

      {/* ─── Success banner ──────────────────────────────────── */}
      {slice.lastEntry && !showForm && (
        <div
          className="mt-4 flex items-center gap-2 border border-success bg-success/10 p-3 text-sm text-success-foreground"
          role="status"
          data-testid="delivery-success"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>
            Delivery logged — {slice.lastEntry.visitorName} ({slice.lastEntry.deliveryCategory})
          </span>
          <button
            className="ml-auto text-xs underline"
            onClick={formReset}
            data-testid="delivery-dismiss-success"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ─── Quick-entry form ────────────────────────────────── */}
      {showForm && (
        <form
          className="mt-4 border border-border bg-muted/20 p-4"
          data-testid="delivery-form"
          onSubmit={(e) => void handleSubmit(e)}
        >
          {slice.lastError && (
            <div
              className="mb-3 border border-destructive bg-destructive/10 p-2 text-sm text-destructive"
              role="alert"
              data-testid="delivery-form-error"
            >
              {slice.lastError.code}: {slice.lastError.message}
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Rider / Driver name *
              </span>
              <input
                className="mt-1 block w-full border border-border bg-background px-3 py-2 text-sm focus:border-foreground focus:outline-none"
                data-testid="delivery-rider-name"
                value={riderName}
                onChange={(e) => setRiderName(e.target.value)}
                required
              />
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Unit *
              </span>
              <input
                className="mt-1 block w-full border border-border bg-background px-3 py-2 text-sm focus:border-foreground focus:outline-none"
                data-testid="delivery-unit"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                required
              />
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Plate (optional)
              </span>
              <input
                className="mt-1 block w-full border border-border bg-background px-3 py-2 text-sm focus:border-foreground focus:outline-none"
                data-testid="delivery-plate"
                value={plate}
                onChange={(e) => setPlate(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Category *
              </span>
              <select
                className="mt-1 block w-full border border-border bg-background px-3 py-2 text-sm focus:border-foreground focus:outline-none"
                data-testid="delivery-category"
                value={category}
                onChange={(e) => setCategory(e.target.value as DeliveryCategory)}
                required
              >
                {DELIVERY_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="mt-4 flex gap-2">
            <button
              type="submit"
              className="focus-ring border border-foreground bg-foreground px-4 py-2 text-sm font-semibold text-background disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="delivery-submit"
              disabled={slice.submitting}
            >
              {slice.submitting ? "Working…" : "Log delivery"}
            </button>
            <button
              type="button"
              className="focus-ring border border-border px-4 py-2 text-sm"
              data-testid="delivery-cancel"
              onClick={() => {
                setShowForm(false);
                actions.resetDeliveryForm();
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* ─── Recent deliveries table ─────────────────────────── */}
      <div className="mt-4 overflow-x-auto">
        {slice.entries.length === 0 && !slice.loading ? (
          <p
            className="py-6 text-center text-sm text-muted-foreground"
            data-testid="delivery-empty"
          >
            No deliveries recorded yet.
          </p>
        ) : (
          <table className="w-full text-left text-sm" data-testid="delivery-table">
            <thead>
              <tr className="border-b border-border text-xs font-bold uppercase tracking-widest text-muted-foreground">
                <th className="py-2 pr-3">Rider</th>
                <th className="py-2 pr-3">Unit</th>
                <th className="py-2 pr-3">Category</th>
                <th className="py-2 pr-3">Plate</th>
                <th className="py-2 pr-3">Method</th>
                <th className="py-2 pr-3">Time</th>
              </tr>
            </thead>
            <tbody>
              {slice.entries.map((entry) => (
                <tr
                  key={entry.id}
                  className="border-b border-border/50"
                  data-testid={`delivery-row-${entry.id}`}
                >
                  <td className="py-2 pr-3 font-semibold">{entry.visitorName}</td>
                  <td className="py-2 pr-3">{entry.unit}</td>
                  <td className="py-2 pr-3">
                    <span className="inline-flex items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 text-xs font-semibold">
                      {entry.deliveryCategory}
                    </span>
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs">
                    {entry.plate ?? "—"}
                  </td>
                  <td className="py-2 pr-3 text-xs">{entry.method}</td>
                  <td className="py-2 pr-3 text-xs text-muted-foreground">
                    {entry.createdAt}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ─── Error banner (list-level) ───────────────────────── */}
      {slice.lastError && !showForm && (
        <div
          className="mt-4 border border-destructive bg-destructive/10 p-3 text-sm text-destructive"
          role="alert"
          data-testid="delivery-list-error"
        >
          <p className="font-semibold">
            {slice.lastError.code}: {slice.lastError.message}
          </p>
          {slice.lastError.traceId && (
            <p className="mt-1 text-xs opacity-80">
              Trace: <code>{slice.lastError.traceId}</code>
            </p>
          )}
        </div>
      )}
    </section>
  );
}
