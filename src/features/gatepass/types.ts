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
  | "error";
export type NetworkState = "online" | "offline";
export type EntryMethod = "qr" | "walk-in" | "override" | "recognized";
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
  | { type: "FAIL_ACTIVE_ENTRY"; reason: string }
  | { type: "RESET_FLOW" };

/** Re-exported for callers that already typed against the API shape. */
export type { ApiErrorBody, RecognizedVisitorItem };
