import type {
  ApiErrorBody,
  RecognizedVisitorItem,
  SyncEntryResult,
} from "@/lib/api/types";

export type GatePassMode =
  | "home"
  | "qr"
  | "walkin"
  | "override"
  | "search"
  | "admin"
  | "confirmed"
  | "awaiting-approval"
  | "error";
export type NetworkState = "online" | "offline";
/**
 * How a visitor entry was logged.
 *
 * Source:
 *   - "qr"/"walk-in"/"override"/"recognized" — gatepass-api-contract.md §3.2
 *   - "auto" — src/docs/specs/auto-approval.md §3 (data model)
 *
 * "auto" is set by the server ONLY when an auto-approval rule fires and
 * short-circuits the manual approval flow. The frontend never authors
 * an entry with method='auto' on the way out; it only RECEIVES one.
 */
export type EntryMethod = "qr" | "walk-in" | "override" | "recognized" | "auto";
export type EntryStatus =
  | "draft"
  | "pending"
  | "approved"
  | "denied"
  | "logged"
  | "sync-pending"
  | "failed";

export type Visitor = {
  id: string;
  name: string;
  host: string;
  unit: string;
  plate?: string;
  lastSeen: string;
  recognition: "pre-approved" | "frequent" | "watch";
};

export type EntryDraft = {
  visitorName: string;
  host: string;
  unit: string;
  plate: string;
  reason: string;
  method: EntryMethod;
  /** Server-assigned pre-approval ID, populated after a successful QR scan. */
  preApprovalId?: string;
};

export type EntryRecord = EntryDraft & {
  /** Server-issued canonical ID once synced. For offline queue entries
   *  this is set to the offlineId until sync replaces it. */
  id: string;
  /** Stable client-generated UUID used as the idempotency key during
   *  sync. Required for all locally-queued entries; optional after the
   *  server has acknowledged the entry. */
  offlineId?: string;
  guardId: string;
  createdAt: string;
  status: EntryStatus;
  syncState: "synced" | "queued" | "failed";
  /** Last error surfaced for this record (e.g. rejection from /sync). */
  lastError?: { code: string; message: string };
};

/** UI-visible error derived from an API failure or local validation. */
export type GatePassError = {
  code: string;
  message: string;
  field?: string;
  traceId?: string;
};

/** Per-entry sync outcome surfaced in the pending sync drawer. */
export type SyncResultView = SyncEntryResult & {
  visitorName: string;
};

/**
 * Active resident-approval request the guard is currently awaiting.
 * Source: src/docs/specs/resident-approval-flow.md §6.
 *
 * Only one approval can be in-flight at a time (a guard cannot start a
 * new walk-in while a previous resident approval is still pending —
 * forces them to deal with the outstanding one first).
 */
export type PendingApproval = {
  id: string;
  draft: EntryDraft;
  magicLinkUrl: string;
  expiresAt: string;
  status: "pending" | "approved" | "denied" | "expired";
  decidedAt?: string;
  deniedReason?: string;
  traceId: string;
};

/**
 * Per-approval delivery view used by the UI's delivery-status block.
 *
 * Source: src/docs/specs/notifications.md §6 (NotificationView wire
 * shape) + §9 (state machine). Mirrors the server's NotificationView
 * but drops PII fields (rendered_body, idempotency_key never reach
 * the wire).
 *
 * `lastError` and `retryInFlight` are reducer-local UI fields, NOT
 * part of the wire shape. They surface the controller's per-retry
 * lifecycle so the Resend button can disable itself in flight and
 * show the most recent failure without re-rendering on every poll.
 */
export type NotificationDeliveryView = {
  id: string;
  approvalId: string;
  channel: "whatsapp" | "sms";
  status:
    | "queued"
    | "sending"
    | "delivered"
    | "failed"
    | "permanently_failed";
  attempts: number;
  targetPhone: string;
  templateKey: string;
  lastErrorCode: string | null;
  lastProviderResponseCode: number | null;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
  failedAt: string | null;
  /** Reducer-local: set while a manual retry is in-flight. */
  retryInFlight?: boolean;
  /** Reducer-local: surfaces the most recent retry-side error to the UI. */
  retryError?: GatePassError;
  /**
   * Reducer-local: epoch ms until which Resend is disabled. Set by
   * NOTIFICATIONS_RETRY_SUCCEEDED to enforce the 30s cooldown (spec
   * notifications.md §6 — per-approval cap = 1 user-triggered retry,
   * which we soften to a cooldown so the UI doesn't silently swallow
   * a second click).
   */
  retryCooldownUntilMs?: number;
};

/**
 * Per-approval notifications slice.
 *
 * `byApprovalId` is keyed by the approval id so the polling loop in
 * useGatePassController can dispatch independently of approval-status
 * results — a transient notifications failure must never mask the
 * approval's status and vice-versa (spec §5, two-stream policy).
 *
 * `loading` and `lastError` are scoped to the in-flight list call.
 * Per-row retry state lives on the NotificationDeliveryView itself.
 */
export type NotificationsState = {
  byApprovalId: Record<string, NotificationDeliveryView[]>;
  loading: boolean;
  lastError?: GatePassError;
};

export type GatePassState = {
  mode: GatePassMode;
  guardId: string;
  network: NetworkState;
  cameraState: "idle" | "ready" | "failed";
  qrState: "idle" | "scanning" | "valid" | "invalid" | "replayed" | "expired";
  qrToken: string;
  draft: EntryDraft;
  inFlight: boolean;
  banner: {
    tone: "info" | "success" | "warning" | "danger";
    message: string;
  };
  lastEntry?: EntryRecord;
  lastError?: GatePassError;
  entries: EntryRecord[];
  pendingSync: EntryRecord[];
  lastSyncResults: SyncResultView[];
  recognizedVisitors: Visitor[];
  searchQuery: string;
  searchLoading: boolean;
  audit: string[];
  /**
   * In-flight resident approval. Cleared when the approval resolves
   * (RESOLVED), is denied (DENIED), expires (EXPIRED), or the guard
   * explicitly resets the flow.
   * Source: spec §6.
   */
  pendingApproval?: PendingApproval;
  /**
   * Per-approval notification deliveries (Feature 2).
   * Source: src/docs/specs/notifications.md §9.
   *
   * Cleared on RESET_FLOW and on approval-terminal transitions
   * (RESOLVED / DENIED / EXPIRED) so a stale delivery view never
   * survives onto the next walk-in.
   */
  notifications: NotificationsState;
};

export type GatePassAction =
  | { type: "NAVIGATE"; mode: GatePassMode }
  | { type: "SET_NETWORK"; network: NetworkState }
  | { type: "START_CAMERA" }
  | { type: "CAMERA_FAILED" }
  | { type: "UPDATE_DRAFT"; field: keyof EntryDraft; value: string }
  | { type: "UPDATE_QR_TOKEN"; value: string }
  | { type: "UPDATE_SEARCH_QUERY"; value: string }
  | { type: "SELECT_VISITOR"; visitor: Visitor }
  | { type: "ENTRY_STARTED" }
  | { type: "ENTRY_SUCCEEDED"; entry: EntryRecord }
  | { type: "ENTRY_QUEUED"; entry: EntryRecord }
  | { type: "ENTRY_FAILED"; error: GatePassError }
  | { type: "QR_SCAN_STARTED" }
  | {
      type: "QR_SCAN_SUCCEEDED";
      draft: EntryDraft;
    }
  | {
      type: "QR_SCAN_FAILED";
      qrState: "invalid" | "replayed" | "expired";
      error: GatePassError;
    }
  | { type: "SYNC_STARTED" }
  | {
      type: "SYNC_COMPLETED";
      results: SyncEntryResult[];
      keptInQueue: EntryRecord[];
      newlySynced: EntryRecord[];
    }
  | { type: "SYNC_FAILED"; error: GatePassError }
  | { type: "VISITORS_LOADING" }
  | { type: "VISITORS_LOADED"; visitors: Visitor[] }
  | { type: "VISITORS_FAILED"; error: GatePassError }
  // ─── Resident approval lifecycle ─────────────────────────────────
  // Source: src/docs/specs/resident-approval-flow.md §6.
  | { type: "APPROVAL_REQUEST_STARTED" }
  | {
      type: "APPROVAL_REQUEST_SUCCEEDED";
      approval: PendingApproval;
    }
  | { type: "APPROVAL_REQUEST_FAILED"; error: GatePassError }
  | {
      type: "APPROVAL_POLLED";
      status: "pending" | "approved" | "denied" | "expired";
      decidedAt?: string;
      deniedReason?: string;
    }
  | { type: "APPROVAL_RESOLVED"; entry: EntryRecord }
  | { type: "APPROVAL_DENIED"; reason: string }
  | { type: "APPROVAL_EXPIRED" }
  /**
   * Auto-approval short-circuited the request: backend already wrote
   * the entry inside the createApproval transaction. No awaiting state
   * is ever observed, no resident decision is pending, no polling is
   * needed. The reducer must:
   *   - skip 'awaiting-approval' and land directly in 'confirmed'
   *   - prepend the entry into state.entries (mirroring ENTRY_SUCCEEDED
   *     and APPROVAL_RESOLVED for list-shape parity)
   *   - emit a distinct audit line so the auditor can tell auto from
   *     manual approval at a glance (spec §3 louder audit)
   *   - DO NOT enqueue any notification — backend wrote nothing
   *
   * Source: src/docs/specs/auto-approval.md §5 (state machine),
   *         §6 (frontend reducer contract).
   */
  | {
      type: "APPROVAL_AUTO_APPROVED";
      entry: EntryRecord;
      rule: { id: string; visitorName: string; host: string; unit: string };
    }
  | { type: "FAIL_ACTIVE_ENTRY"; reason: string }
  | { type: "RESET_FLOW" }
  // ─── Notifications lifecycle ─────────────────────────────────────
  // Source: src/docs/specs/notifications.md §9.
  | { type: "NOTIFICATIONS_LOADING" }
  | {
      type: "NOTIFICATIONS_LOADED";
      approvalId: string;
      notifications: NotificationDeliveryView[];
    }
  | { type: "NOTIFICATIONS_FAILED"; error: GatePassError }
  | { type: "NOTIFICATIONS_RETRY_STARTED"; notificationId: string }
  | {
      type: "NOTIFICATIONS_RETRY_SUCCEEDED";
      approvalId: string;
      notification: NotificationDeliveryView;
      /**
       * Epoch ms at which the cooldown expires. Injected by the
       * controller (which owns the clock) so the reducer stays pure.
       */
      cooldownUntilMs: number;
    }
  | {
      type: "NOTIFICATIONS_RETRY_FAILED";
      notificationId: string;
      error: GatePassError;
    };

/** Re-exported for callers that already typed against the API shape. */
export type { ApiErrorBody, RecognizedVisitorItem };
