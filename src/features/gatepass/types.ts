import type {
  ApiErrorBody,
  DeliveryCategory,
  DeliveryListEntryView,
  DeliveryEntryView,
  ExitRecordView,
  OnPremiseEntryView,
  RecognizedVisitorItem,
  ShiftSummaryView,
  SyncEntryResult,
  VisitorInvitationIssuedView,
  VisitorProfileView,
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

/**
 * Pagination block mirrored from ListVisitorProfilesResponse.pagination.
 * Stored alongside the list so the UI can render Prev/Next without
 * holding it in a separate ref.
 */
export type VisitorProfilesPagination = {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
};

/**
 * Admin-only slice maintaining the visitor-profile CRUD list state.
 * Source: src/docs/specs/visitor-profiles.md §8 (frontend reducer).
 *
 * Lifecycle (one slice cycle = one list call + zero-or-more mutations):
 *   LIST_STARTED
 *     → LIST_LOADED  (replaces byId/order/pagination, clears loading + lastError)
 *     | LIST_FAILED   (sets lastError, keeps cached byId so a transient blip
 *                      doesn't blank the table)
 *
 *   MUTATION_STARTED (id | "__new__")
 *     → UPSERTED      (server confirmed create or update)
 *     | REMOVED       (server confirmed soft-delete; row keeps deletedAt set)
 *     | RESTORED      (server confirmed restore; deletedAt cleared)
 *     | MUTATION_FAILED (per-row error, NO silent success allowed)
 *
 * Soft-deleted rows are kept in byId so the UI can still render them
 * when the includeDeleted toggle is on. The `order` list drops them by
 * default; restoring re-adds the id to the top of `order`.
 *
 * RESET_FLOW does NOT clear this slice — it belongs to the admin
 * subview, not the per-walk-in lifecycle.
 */
export type VisitorProfilesState = {
  byId: Record<string, VisitorProfileView>;
  order: string[];
  pagination?: VisitorProfilesPagination;
  loading: boolean;
  /**
   * Per-id mutation in-flight flag. The literal key `"__new__"` tracks
   * a create call (the server-assigned id isn't known until success).
   */
  mutationInFlight: Record<string, boolean>;
  lastError?: GatePassError;
  /**
   * Per-id structured error. Cleared by the matching MUTATION_STARTED;
   * surfaced inline by the row UI. Never silently dropped.
   */
  mutationErrors: Record<string, GatePassError>;
  /** UI toggle. The list call passes this through to the API query. */
  includeDeleted: boolean;
};

export const VISITOR_PROFILE_NEW_KEY = "__new__";

/**
 * Source: src/docs/specs/guest-qr-ticket.md §7 (Frontend state).
 *
 * The visitor-invitation slice is the admin-form state for issuing a
 * single-use guest QR pass. It is intentionally lean:
 *
 *   - `status` drives the form's idle/submitting/issued/error UI.
 *   - `lastIssued` carries the raw token + pass URL EXACTLY ONCE,
 *     received from the server's 201 response. It is cleared on
 *     RESET (when the admin closes the success card) so the raw
 *     token does not sit in memory longer than necessary.
 *   - `lastError` is structured so the form can re-surface it on the
 *     next render (e.g. AUTH_FORBIDDEN if a guard token slipped
 *     through, INVITATION_INVALID_INPUT for validation).
 *
 * RESET_FLOW does NOT clear this slice — it belongs to the admin
 * subview, not the per-walk-in lifecycle.
 */
export type VisitorInvitationsState = {
  status: "idle" | "submitting" | "issued" | "failed";
  /** Last successfully issued invitation. RAW TOKEN included — see notes. */
  lastIssued?: VisitorInvitationIssuedView;
  lastError?: GatePassError;
};

/**
 * Source: src/docs/specs/shift-log-aggregation.md §7.
 *
 * The shift log slice is intentionally narrow: a query describes the
 * admin's current filter, a window mirrors what the server actually
 * computed, rows hold the deterministic summary, and lastError carries
 * the most-recent failure so the UI can surface it without losing the
 * previously-loaded rows (no-silent-success).
 */
export type ShiftsQuery = {
  /** ISO-8601 UTC inclusive lower bound. Optional — server defaults. */
  fromIso?: string;
  /** ISO-8601 UTC exclusive upper bound. Optional — server defaults. */
  toIso?: string;
  /** Optional single-guard filter (UUID). */
  guardId?: string;
};

export type ShiftsState = {
  /** What the admin asked for; sent to the server on the next refresh. */
  query: ShiftsQuery;
  /** What the server actually computed over (echoed from the response). */
  window?: { fromIso: string; toIso: string };
  rows: ShiftSummaryView[];
  loading: boolean;
  lastError?: GatePassError;
};

/**
 * Admin-only exit tracking state (Feature 7).
 * Source: src/docs/specs/exit-tracking.md §8.
 *
 * Lifecycle:
 *   EXIT_TRACKING_LIST_STARTED
 *     → EXIT_TRACKING_LIST_LOADED  (replaces onPremise + count, clears loading)
 *     | EXIT_TRACKING_LIST_FAILED  (sets lastError, keeps cached onPremise)
 *
 *   EXIT_RECORD_STARTED (entryId)
 *     → EXIT_RECORD_SUCCEEDED (removes entry from onPremise, sets lastExit)
 *     | EXIT_RECORD_FAILED   (sets per-entry error, no silent failure)
 *
 * RESET_FLOW does NOT clear this slice — it belongs to the admin
 * subview, not the per-walk-in lifecycle.
 */
export type ExitTrackingState = {
  onPremise: OnPremiseEntryView[];
  loading: boolean;
  lastError?: GatePassError;
  /** Per-entry exit-in-flight flag. */
  exitInFlight: Record<string, boolean>;
  /** Per-entry exit error. */
  exitErrors: Record<string, GatePassError>;
  /** Last successfully recorded exit (for the confirmation banner). */
  lastExit?: ExitRecordView;
};

/**
 * Admin-only delivery management state (Feature 8).
 * Source: src/docs/specs/delivery-management.md §5.
 *
 * Lifecycle:
 *   DELIVERY_SUBMIT_STARTED
 *     → DELIVERY_SUBMIT_SUCCEEDED (sets lastEntry, clears form)
 *     | DELIVERY_SUBMIT_FAILED   (sets lastError, form stays open)
 *
 *   DELIVERY_LIST_STARTED
 *     → DELIVERY_LIST_LOADED  (replaces entries list)
 *     | DELIVERY_LIST_FAILED  (sets lastError, keeps cached entries)
 *
 * RESET_FLOW does NOT clear this slice.
 */
export type DeliveryManagementState = {
  entries: DeliveryListEntryView[];
  loading: boolean;
  submitting: boolean;
  lastError?: GatePassError;
  lastEntry?: DeliveryEntryView;
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
  /**
   * Admin-only visitor-profile CRUD list state (Feature 4).
   * Source: src/docs/specs/visitor-profiles.md §8.
   */
  visitorProfiles: VisitorProfilesState;
  /**
   * Admin-only visitor-invitation form slice (Feature 6).
   * Source: src/docs/specs/guest-qr-ticket.md §7.
   */
  visitorInvitations: VisitorInvitationsState;
  /**
   * Admin-only shift log aggregation slice (Feature 5).
   * Source: src/docs/specs/shift-log-aggregation.md §7.
   *
   * Read-only view: query describes what the admin asked for; window
   * is what the server actually computed over (so a 422 doesn't
   * silently shift the displayed bounds). `rows` is sorted server-side.
   *
   * RESET_FLOW does NOT clear this slice — it belongs to the admin
   * subview, not the per-walk-in lifecycle.
   */
  shifts: ShiftsState;
  /**
   * Admin-only exit tracking state (Feature 7).
   * Source: src/docs/specs/exit-tracking.md §8.
   */
  exitTracking: ExitTrackingState;
  /**
   * Admin-only delivery management state (Feature 8).
   * Source: src/docs/specs/delivery-management.md §5.
   */
  deliveryManagement: DeliveryManagementState;
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
    }
  // ─── Visitor profile CRUD lifecycle (Feature 4) ─────────────────
  // Source: src/docs/specs/visitor-profiles.md §8.
  | { type: "VISITOR_PROFILES_LIST_STARTED" }
  | {
      type: "VISITOR_PROFILES_LIST_LOADED";
      profiles: VisitorProfileView[];
      pagination: VisitorProfilesPagination;
    }
  | { type: "VISITOR_PROFILES_LIST_FAILED"; error: GatePassError }
  /**
   * profileId = an existing profile id for update/delete/restore, or
   * the sentinel VISITOR_PROFILE_NEW_KEY ("__new__") for create.
   */
  | { type: "VISITOR_PROFILE_MUTATION_STARTED"; profileId: string }
  /**
   * Handles both create AND update. The reducer checks `state.visitorProfiles.byId[profile.id]`
   * to decide whether to prepend to `order` (create) or replace in place (update).
   *
   * `mutationKey` lets the controller pass through the original key that started
   * the mutation (e.g. "__new__" for create), so MUTATION_STARTED → UPSERTED
   * clears the right `mutationInFlight` entry. If omitted, the reducer
   * defaults to `profile.id`.
   */
  | {
      type: "VISITOR_PROFILE_UPSERTED";
      profile: VisitorProfileView;
      mutationKey?: string;
    }
  | { type: "VISITOR_PROFILE_REMOVED"; profile: VisitorProfileView }
  | { type: "VISITOR_PROFILE_RESTORED"; profile: VisitorProfileView }
  | {
      type: "VISITOR_PROFILE_MUTATION_FAILED";
      profileId: string;
      error: GatePassError;
    }
  | { type: "VISITOR_PROFILES_TOGGLE_INCLUDE_DELETED" }
  // ─── Shift log aggregation lifecycle (Feature 5) ────────────────
  // Source: src/docs/specs/shift-log-aggregation.md §7.
  | {
      type: "SHIFTS_QUERY_CHANGED";
      query: ShiftsQuery;
    }
  | { type: "SHIFTS_LIST_STARTED" }
  | {
      type: "SHIFTS_LIST_LOADED";
      window: { fromIso: string; toIso: string };
      rows: ShiftSummaryView[];
    }
  | { type: "SHIFTS_LIST_FAILED"; error: GatePassError }
  // ─── Visitor invitation lifecycle (Feature 6 / Guest QR Ticket) ────
  // Source: src/docs/specs/guest-qr-ticket.md §7.
  //
  // Default-deny: ISSUE_FAILED is the ONLY path a non-201 response can
  // take. There is NO success branch that swallows a malformed payload.
  | { type: "VISITOR_INVITATION_ISSUE_STARTED" }
  | {
      type: "VISITOR_INVITATION_ISSUE_SUCCEEDED";
      invitation: VisitorInvitationIssuedView;
    }
  | { type: "VISITOR_INVITATION_ISSUE_FAILED"; error: GatePassError }
  | { type: "VISITOR_INVITATION_RESET" }
  // ─── Exit tracking lifecycle (Feature 7) ───────────────────────
  // Source: src/docs/specs/exit-tracking.md §8.
  | { type: "EXIT_TRACKING_LIST_STARTED" }
  | {
      type: "EXIT_TRACKING_LIST_LOADED";
      entries: OnPremiseEntryView[];
      count: number;
      traceId: string;
    }
  | { type: "EXIT_TRACKING_LIST_FAILED"; error: GatePassError }
  | { type: "EXIT_RECORD_STARTED"; entryId: string }
  | { type: "EXIT_RECORD_SUCCEEDED"; exit: ExitRecordView; entryId: string }
  | { type: "EXIT_RECORD_FAILED"; entryId: string; error: GatePassError }
  // ─── Delivery management lifecycle (Feature 8) ───────────────
  // Source: src/docs/specs/delivery-management.md §5.
  | { type: "DELIVERY_SUBMIT_STARTED" }
  | {
      type: "DELIVERY_SUBMIT_SUCCEEDED";
      entry: DeliveryEntryView;
    }
  | { type: "DELIVERY_SUBMIT_FAILED"; error: GatePassError }
  | { type: "DELIVERY_SUBMIT_RESET" }
  | { type: "DELIVERY_LIST_STARTED" }
  | {
      type: "DELIVERY_LIST_LOADED";
      entries: DeliveryListEntryView[];
      count: number;
      traceId: string;
    }
  | { type: "DELIVERY_LIST_FAILED"; error: GatePassError };

/** Re-exported for callers that already typed against the API shape. */
export type { ApiErrorBody, RecognizedVisitorItem };
