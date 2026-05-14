import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Copy,
  ExternalLink,
  LayoutDashboard,
  Loader2,
  MailCheck,
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
import { useEffect, useState } from "react";
import type {
  EntryDraft,
  GatePassAction,
  GatePassState,
  NotificationDeliveryView,
  Visitor,
} from "../types";

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
            disabled={state.inFlight}
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
      </div>
      <EntryForm
        title="QR confirmation"
        state={state}
        dispatch={dispatch}
        actions={actions}
        requireReason={false}
      />
    </section>
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
}: Props & {
  title: string;
  requireReason: boolean;
  showRequestApproval?: boolean;
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
          <p
            data-testid="approval-magic-link"
            className="mt-2 break-all font-mono text-xs text-foreground"
          >
            {approval.magicLinkUrl}
          </p>
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
  return (
    <section
      className="border border-destructive bg-destructive/10 p-6 shadow-panel"
      role="alert"
    >
      <AlertTriangle className="h-12 w-12 text-destructive" />
      <h2 className="mt-4 font-display text-4xl font-black">Entry blocked</h2>
      <p className="mt-2 text-destructive">{state.banner.message}</p>
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
        Most recent: {state.audit[0]}
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
        <ul className="mt-2 grid gap-1 text-sm">
          {state.audit.slice(0, 8).map((line, index) => (
            <li key={`${index}-${line}`} className="border-b border-border py-1">
              {line}
            </li>
          ))}
        </ul>
      </div>
    </section>
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
