/**
 * GatePass — durable offline queue.
 *
 * `pendingSync` used to live only in React state, so anything that unmounted
 * the console (a failed /api/auth/me on wake, a session expiry, a reload)
 * destroyed entries for visitors who were already inside the estate, with no
 * signal to anyone. This module persists the queue so it survives the tab.
 *
 * Each guard has their own storage key: a queue is evidence of who logged
 * what, so it is never handed to — or overwritten by — a different guard on
 * the same device. It is local durability only — every entry is still
 * authorised server-side at sync time.
 *
 * Writes merge rather than replace: entries already in storage that this
 * mount has never seen (another tab of the same guard) are kept, entries
 * this mount has seen and dropped (synced) are removed.
 *
 * Source: React state is lost on unmount by design —
 * https://react.dev/learn/preserving-and-resetting-state
 */

import type { EntryMethod, EntryRecord, EntryStatus } from "./types";

export const PENDING_SYNC_STORAGE_PREFIX = "gatepass.pendingSync.v1:";

/** Upper bound on persisted entries per guard; the newest are kept. */
export const PENDING_SYNC_MAX_ENTRIES = 200;

interface PersistedQueue {
  guardId: string;
  savedAt: number;
  entries: EntryRecord[];
}

export function pendingSyncStorageKey(guardId: string): string {
  return `${PENDING_SYNC_STORAGE_PREFIX}${guardId}`;
}

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function clearPendingSync(guardId: string | null): void {
  if (!guardId) return;
  storage()?.removeItem(pendingSyncStorageKey(guardId));
}

function isDurable(entry: EntryRecord): boolean {
  return (
    typeof entry.offlineId === "string" &&
    entry.offlineId.length > 0 &&
    entry.syncState !== "synced"
  );
}

function dedupe(entries: EntryRecord[]): EntryRecord[] {
  const seen = new Set<string>();
  const out: EntryRecord[] = [];
  for (const entry of entries) {
    const key = entry.offlineId;
    if (typeof key !== "string" || seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/**
 * Persist this mount's queue for `guardId`.
 *
 * `seenOfflineIds` is every offlineId this mount has ever held. Stored entries
 * outside that set belong to another tab and are preserved; stored entries
 * inside it but absent from `entries` were synced here and are dropped.
 */
export function writePendingSync(
  guardId: string | null,
  entries: EntryRecord[],
  seenOfflineIds: ReadonlySet<string> = new Set(),
): void {
  const store = storage();
  if (!store || !guardId) return;

  const mine = entries.filter(isDurable);
  const foreign = readPendingSync(guardId).filter(
    (e) => typeof e.offlineId === "string" && !seenOfflineIds.has(e.offlineId),
  );

  const durable = dedupe([...mine, ...foreign]).slice(
    0,
    PENDING_SYNC_MAX_ENTRIES,
  );

  if (durable.length === 0) {
    clearPendingSync(guardId);
    return;
  }

  const record: PersistedQueue = {
    guardId,
    savedAt: Date.now(),
    entries: durable,
  };

  try {
    store.setItem(pendingSyncStorageKey(guardId), JSON.stringify(record));
  } catch {
    // A full store must not break the gate. The in-memory queue still holds
    // the entries for this session.
  }
}

const METHODS: ReadonlySet<EntryMethod> = new Set([
  "qr",
  "walk-in",
  "override",
  "recognized",
  "auto",
]);
const STATUSES: ReadonlySet<EntryStatus> = new Set([
  "draft",
  "pending",
  "approved",
  "denied",
  "logged",
  "sync-pending",
  "failed",
]);

const MAX_FIELD_LENGTH = 500;

function shortString(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_FIELD_LENGTH;
}

function isMethod(value: unknown): value is EntryMethod {
  return typeof value === "string" && METHODS.has(value as EntryMethod);
}

function isStatus(value: unknown): value is EntryStatus {
  return typeof value === "string" && STATUSES.has(value as EntryStatus);
}

/**
 * Rebuild an EntryRecord from untrusted storage. Every consumed field is
 * checked and only known fields are copied, so nothing else stored under the
 * key can ride along into state or a sync request.
 */
function parseEntry(value: unknown, guardId: string): EntryRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const r: Record<string, unknown> = { ...value };

  if (
    !shortString(r.id) ||
    !shortString(r.offlineId) ||
    r.offlineId.length === 0 ||
    r.guardId !== guardId ||
    !shortString(r.visitorName) ||
    !shortString(r.host) ||
    !shortString(r.unit) ||
    !shortString(r.plate) ||
    !shortString(r.reason) ||
    !shortString(r.createdAt) ||
    Number.isNaN(Date.parse(r.createdAt)) ||
    !isMethod(r.method) ||
    !isStatus(r.status) ||
    (r.syncState !== "queued" && r.syncState !== "failed")
  ) {
    return null;
  }

  const entry: EntryRecord = {
    id: r.id,
    offlineId: r.offlineId,
    guardId,
    visitorName: r.visitorName,
    host: r.host,
    unit: r.unit,
    plate: r.plate,
    reason: r.reason,
    createdAt: r.createdAt,
    method: r.method,
    status: r.status,
    syncState: r.syncState,
  };

  if (shortString(r.preApprovalId)) entry.preApprovalId = r.preApprovalId;

  if (typeof r.lastError === "object" && r.lastError !== null) {
    const err: Record<string, unknown> = { ...r.lastError };
    if (shortString(err.code) && shortString(err.message)) {
      entry.lastError = { code: err.code, message: err.message };
    }
  }

  return entry;
}

export function readPendingSync(guardId: string | null): EntryRecord[] {
  const store = storage();
  if (!store || !guardId) return [];

  const raw = store.getItem(pendingSyncStorageKey(guardId));
  if (!raw) return [];

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }

  if (typeof value !== "object" || value === null) return [];
  const record: Record<string, unknown> = { ...value };
  if (record.guardId !== guardId || !Array.isArray(record.entries)) return [];

  const entries: EntryRecord[] = [];
  for (const item of record.entries) {
    const entry = parseEntry(item, guardId);
    if (entry) entries.push(entry);
  }

  return dedupe(entries).slice(0, PENDING_SYNC_MAX_ENTRIES);
}
