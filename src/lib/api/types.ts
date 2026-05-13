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
