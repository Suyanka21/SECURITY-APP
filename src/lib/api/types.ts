/**
 * GatePass — Shared API types
 *
 * Source: src/docs/gatepass-api-contract.md §2 (APIError) + §3 endpoints
 *
 * Mirrors the backend contract so the frontend can rely on the same field
 * names, error codes, and status codes.
 */

export type EntryMethod = "qr" | "walk-in" | "override" | "recognized";
export type EntryStatus =
  | "draft"
  | "pending"
  | "approved"
  | "denied"
  | "logged"
  | "sync-pending"
  | "failed";
export type EntrySyncState = "synced" | "queued" | "failed";
export type RecognitionTag = "pre-approved" | "frequent" | "watch";

/** Shared error shape returned by every endpoint. Contract §2. */
export interface ApiErrorBody {
  code: string;
  message: string;
  field?: string;
  traceId: string;
}

/**
 * Discriminated result of an API call.
 *
 * Callers must handle both branches — there is no thrown-exception path
 * for expected HTTP failures (4xx/5xx). Only programmer errors (e.g. bad
 * URL) throw.
 */
export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: ApiErrorBody };

// ─── Entry creation (POST /api/entries) — contract §3.2 ───────────────

export interface CreateEntryRequest {
  visitorName: string;
  host: string;
  unit: string;
  plate: string | null;
  reason: string;
  method: EntryMethod;
  createdAt: string;
  preApprovalId?: string;
  offlineId?: string;
}

export interface ServerEntry {
  id: string;
  visitorName: string;
  host: string;
  unit: string;
  plate: string | null;
  reason: string;
  method: EntryMethod;
  guardId: string;
  createdAt: string;
  status: "logged";
  syncState: "synced";
}

export interface CreateEntryResponse {
  entry: ServerEntry;
  traceId: string;
}

// ─── QR validation (POST /api/entries/qr/validate) — contract §3.1 ────

export interface QrValidateRequest {
  qrToken: string;
  scannedAt: string;
}

export interface QrValidateResponse {
  outcome: "valid";
  visitor: {
    name: string;
    host: string;
    unit: string;
    plate: string | null;
    preApprovalId: string;
  };
  expiresAt: string;
  traceId: string;
}

// ─── PIN redemption (POST /api/entries/pin/validate) — Feature 11 ─────
// Backup path when the QR can't be scanned: pass reference + 6-digit PIN.
// Redeems the SAME authorization_decisions record as the QR, so the
// success response reuses QrValidateResponse.

export interface PinValidateRequest {
  passRef: string;
  pin: string;
  scannedAt: string;
}

export type PinValidateResponse = QrValidateResponse;

// ─── Sync batch (POST /api/entries/sync) — contract §3.3 ──────────────

export interface SyncEntryRequest {
  offlineId: string;
  visitorName: string;
  host: string;
  unit: string;
  plate: string | null;
  reason: string;
  method: EntryMethod;
  createdAt: string;
}

export interface SyncBatchRequest {
  entries: SyncEntryRequest[];
}

export interface SyncEntryResult {
  offlineId: string;
  serverId: string;
  status: "synced" | "duplicate" | "rejected";
  error?: { code: string; message: string };
}

export interface SyncBatchResponse {
  results: SyncEntryResult[];
  syncedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  traceId: string;
}

// ─── Visitor search (GET /api/visitors/recognized) — contract §3.4 ────

export interface RecognizedVisitorsRequest {
  q?: string;
  page?: number;
  pageSize?: number;
}

export interface RecognizedVisitorItem {
  id: string;
  name: string;
  host: string;
  unit: string;
  plate: string | null;
  lastSeen: string;
  recognition: RecognitionTag;
}

export interface RecognizedVisitorsResponse {
  visitors: RecognizedVisitorItem[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
  traceId: string;
}

// ─── Resident approval flow — contract: spec §7 ───────────────────────
// Source: src/docs/specs/resident-approval-flow.md §7.1, §7.2, §7.3
//
// The approval lifecycle is the FIRST excluded-feature being added back
// per src/docs/remaining-features-rollout.md. The frontend reducer reacts
// to status transitions via polling; the resident's magic-link page is
// served by the same frontend at /approve/:id.

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";
export type ApprovalDecision = "approve" | "deny";

/** Sanitized approval view — server NEVER includes tokenHash. */
export interface ApprovalRequestView {
  id: string;
  offlineId: string;
  visitorName: string;
  host: string;
  unit: string;
  plate: string | null;
  reason: string;
  method: "walk-in";
  requestedByGuardId: string;
  status: ApprovalStatus;
  expiresAt: string;
  decidedAt: string | null;
  deniedReason: string | null;
  entryId: string | null;
  traceId: string;
}

// POST /api/approvals — spec §7.1
export interface CreateApprovalRequest {
  offlineId: string;
  draft: {
    visitorName: string;
    host: string;
    unit: string;
    plate?: string | null;
    reason?: string;
    method: "walk-in";
  };
  /** Optional E.164 — drives Feature 2 notifications (notifications.md §7.1). */
  hostPhoneE164?: string;
}

// ─── Notifications (Feature 2) ──────────────────────────────────────────────
// Source: src/docs/specs/notifications.md §7

export type NotificationChannel = "whatsapp" | "sms";
export type NotificationStatus =
  | "queued"
  | "sending"
  | "delivered"
  | "failed"
  | "permanently_failed";

/**
 * Sanitized notification view — the server NEVER includes
 * `renderedBody` or `idempotencyKey` (PII discipline, spec §3).
 * Matches NotificationView in server validation/notification-schemas.ts.
 */
export interface NotificationView {
  id: string;
  approvalId: string;
  channel: NotificationChannel;
  status: NotificationStatus;
  attempts: number;
  targetPhone: string;
  templateKey: string;
  lastErrorCode: string | null;
  lastProviderResponseCode: number | null;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
  failedAt: string | null;
}

// GET /api/notifications?approvalId=:id
export interface NotificationsListResponse {
  notifications: NotificationView[];
  traceId: string;
}

// POST /api/notifications/:id/retry
export interface NotificationRetryResponse {
  notification: NotificationView;
  traceId: string;
}

export interface CreateApprovalResponse {
  approvalId: string;
  magicLinkUrl: string;
  expiresAt: string;
  traceId: string;
  /**
   * Source: src/docs/specs/auto-approval.md §5 — Feature 3.
   *
   * Optional. When `true`, the server short-circuited the manual approval
   * flow because an active auto-approval rule matched the (visitorName,
   * host, unit) triple. In that case `entry` is populated with the canonical
   * server-side EntryRecord (method='auto') and `matchedRule` carries the
   * rule that fired. When absent or `false`, the response is the standard
   * pending-approval shape (no `entry`, no `matchedRule`).
   *
   * Backward-compatible: pre-Feature-3 clients read `undefined` and follow
   * the awaiting-approval path as before.
   */
  autoApproved?: boolean;
  /**
   * Populated only when `autoApproved === true`. Mirrors the EntryRecord
   * shape from POST /api/entries so the frontend reducer can plug it into
   * its entries list without translation. `method` is always `"auto"`.
   */
  entry?: {
    id: string;
    visitorName: string;
    host: string;
    unit: string;
    plate: string | null;
    reason: string;
    method: "auto";
    guardId: string;
    createdAt: string;
    status: "logged";
    syncState: "synced";
  } | null;
  /**
   * Populated only when `autoApproved === true`. The minimal rule view the
   * frontend needs to render "Auto-approved by rule …" in the UI / audit.
   */
  matchedRule?: {
    id: string;
    visitorName: string;
    host: string;
    unit: string;
  } | null;
}

// GET /api/approvals/:id/status — spec §7.2
export interface ApprovalStatusResponse {
  approval: ApprovalRequestView;
  traceId: string;
}

// POST /api/approvals/:id/decide — spec §7.3
export interface DecideApprovalRequest {
  token: string;
  decision: ApprovalDecision;
  reason?: string;
}

export interface DecideApprovalResponse {
  approval: ApprovalRequestView;
  /** Populated only on approve — null on deny. */
  entry: ServerEntry | null;
  traceId: string;
}

// ─── Visitor profiles (Feature 4) ───────────────────────────────────────────
// Source: src/docs/specs/visitor-profiles.md §4

/**
 * The PII-bearing view returned by every visitor-profile endpoint.
 * Mirrors VisitorProfileView in server validation/visitor-profile-schemas.ts.
 * `deletedAt` is non-null only when the profile is soft-deleted.
 */
export interface VisitorProfileView {
  id: string;
  visitorName: string;
  host: string;
  unit: string;
  plate: string | null;
  phoneE164: string | null;
  notes: string | null;
  watchFlag: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CreateVisitorProfileRequest {
  visitorName: string;
  host: string;
  unit: string;
  plate?: string | null;
  phoneE164?: string | null;
  notes?: string | null;
  watchFlag?: boolean;
}

export interface UpdateVisitorProfileRequest {
  visitorName?: string;
  host?: string;
  unit?: string;
  plate?: string | null;
  phoneE164?: string | null;
  notes?: string | null;
  watchFlag?: boolean;
}

export interface ListVisitorProfilesQuery {
  host?: string;
  unit?: string;
  /** Free-text search across visitorName/host/unit/plate. */
  q?: string;
  page?: number;
  pageSize?: number;
  /** When true, returns soft-deleted rows as well. Default: false. */
  includeDeleted?: boolean;
}

export interface VisitorProfileResponse {
  profile: VisitorProfileView;
  traceId: string;
}

export interface ListVisitorProfilesResponse {
  profiles: VisitorProfileView[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
  traceId: string;
}

// ─── Shift log aggregation (Feature 5) ──────────────────────────────────────
// Source: src/docs/specs/shift-log-aggregation.md §4

export interface ShiftTotalsView {
  entries: number;
  qr: number;
  walkIn: number;
  override: number;
  recognized: number;
  auto: number;
  approvalsDenied: number;
  approvalsExpired: number;
  autoApprovalsMatched: number;
  overrideAuthorized: number;
}

export interface ShiftSummaryView {
  guardId: string;
  guardName: string;
  badgeNumber: string;
  totals: ShiftTotalsView;
}

export interface ListShiftsQuery {
  /** ISO-8601 UTC inclusive lower bound. Omit to default to today UTC midnight. */
  fromIso?: string;
  /** ISO-8601 UTC exclusive upper bound. Omit to default to now. */
  toIso?: string;
  /** Optional single-guard filter (UUID). */
  guardId?: string;
}

export interface ListShiftsResponse {
  window: { fromIso: string; toIso: string };
  shifts: ShiftSummaryView[];
  traceId: string;
}

// ─── Visitor invitations (Feature 6 — Guest QR Ticket) ──────────────────────
// Source: src/docs/specs/guest-qr-ticket.md §6

/**
 * Raw token returned EXACTLY ONCE in the issue response.
 * 256 bits base64url-encoded (43 chars). Server stores SHA-256 hash only.
 */
export interface VisitorInvitationIssuedView {
  id: string;
  qrToken: string;
  passUrl: string;
  /**
   * Feature 11 (Stage 4) — One-Time PIN Backup. Both are returned EXACTLY
   * ONCE, at issue, as an alternate way to redeem the same pass. passRef is
   * a non-secret 8-char reference; pin is the secret 6-digit code (the
   * server stores only its HMAC).
   */
  passRef: string;
  pin: string;
  expiresAt: string;
  issuedAt: string;
  visitorName: string;
  host: string;
  unit: string;
  plate: string | null;
}

/**
 * Safe display payload returned by the public preview endpoint.
 * Deliberately omits id, qrTokenHash, isUsed, usedAt — these are
 * implementation details that MUST NOT leak to the visitor's device.
 */
export interface VisitorInvitationPreviewView {
  visitorName: string;
  host: string;
  unit: string;
  plate: string | null;
  expiresAt: string;
}

export interface IssueVisitorInvitationRequest {
  visitorName: string;
  host: string;
  unit: string;
  plate?: string | null;
  /** Optional override of the default TTL (24h). Server clamps to [1, 168]. */
  ttlHours?: number;
}

export interface IssueVisitorInvitationResponse {
  invitation: VisitorInvitationIssuedView;
  traceId: string;
}

export interface PreviewVisitorInvitationResponse {
  invitation: VisitorInvitationPreviewView;
}

// ─── Exit tracking (Feature 7 — Exit Tracking) ──────────────────────────────
// Source: src/docs/specs/exit-tracking.md §6

export interface ExitRecordView {
  id: string;
  entryId: string;
  guardId: string;
  createdAt: string;
  traceId: string;
}

export interface RecordExitResponse {
  exit: ExitRecordView;
  traceId: string;
}

export interface OnPremiseEntryView {
  id: string;
  visitorName: string;
  host: string;
  unit: string;
  plate: string | null;
  method: EntryMethod;
  guardId: string;
  createdAt: string;
  /** Guard notes attached to this entry (Feature 9). Empty when none. */
  notes: OnPremiseNoteView[];
}

/** A guard note as surfaced on an on-premise row (Feature 9). */
export interface OnPremiseNoteView {
  id: string;
  tag: GuardNoteTag;
  text: string | null;
  guardId: string;
  createdAt: string;
}

export interface ListOnPremiseResponse {
  entries: OnPremiseEntryView[];
  count: number;
  traceId: string;
}

// ─── Guard notes (Feature 9 — Guard Notes) ──────────────────────────────────
// Source: src/docs/specs/guard-notes.md §§3–4

export type GuardNoteTag =
  | "delivered_parcel"
  | "left_id_at_gate"
  | "escorted_by_resident"
  | "other";

/** Human-readable labels for the predefined tags (client display). */
export const GUARD_NOTE_TAG_LABELS: Record<GuardNoteTag, string> = {
  delivered_parcel: "Delivered parcel",
  left_id_at_gate: "Left ID at gate",
  escorted_by_resident: "Escorted by resident",
  other: "Other",
};

export const GUARD_NOTE_TEXT_MAX = 280;

export interface GuardNoteView {
  id: string;
  entryId: string | null;
  exitId: string | null;
  guardId: string;
  tag: GuardNoteTag;
  text: string | null;
  createdAt: string;
  traceId: string;
}

export interface AddGuardNoteRequest {
  tag: GuardNoteTag;
  text?: string;
}

export interface AddGuardNoteResponse {
  note: GuardNoteView;
  traceId: string;
}

export interface ListGuardNotesResponse {
  notes: GuardNoteView[];
  count: number;
  traceId: string;
}

// ─── Feature 8: Delivery Management ─────────────────────────────────────────
// Source: src/docs/specs/delivery-management.md §§4–5

export type EntryKind = "visitor" | "delivery";
export type DeliveryCategory =
  | "parcel" | "food" | "ride" | "gas"
  | "water" | "moving" | "maintenance" | "other";

export interface CreateDeliveryEntryRequest {
  visitorName: string;
  host?: string;
  unit: string;
  plate?: string | null;
  reason?: string;
  method?: EntryMethod;
  createdAt: string;
  entryKind: EntryKind;
  deliveryCategory?: DeliveryCategory;
  offlineId?: string;
}

export interface DeliveryEntryView {
  id: string;
  visitorName: string;
  host: string;
  unit: string;
  plate: string | null;
  reason: string;
  method: string;
  guardId: string;
  createdAt: string;
  status: "logged";
  syncState: "synced";
  entryKind: EntryKind;
  deliveryCategory: DeliveryCategory;
}

export interface CreateDeliveryEntryResponse {
  entry: DeliveryEntryView;
  traceId: string;
}

export interface DeliveryListEntryView {
  id: string;
  visitorName: string;
  host: string;
  unit: string;
  plate: string | null;
  deliveryCategory: DeliveryCategory;
  method: string;
  guardId: string;
  createdAt: string;
}

export interface ListDeliveriesResponse {
  entries: DeliveryListEntryView[];
  count: number;
  traceId: string;
}
