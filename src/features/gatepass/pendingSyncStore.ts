/**
 * GatePass — durable offline queue.
 *
 * `pendingSync` used to live only in React state, so anything that unmounted
 * the console (a failed /api/auth/me on wake, a session expiry, a reload)
 * destroyed entries for visitors who were already inside the estate, with no
 * signal to anyone. This module persists the queue so it survives the tab.
 *
 * The record is bound to the guard who created it: a queue is evidence of who
 * logged what, so it is never handed to a different guard. It is local
 * durability only — every entry is still authorised server-side at sync time.
 *
 * Source: React state is lost on unmount by design —
 * https://react.dev/learn/preserving-and-resetting-state
 */

import type { EntryRecord } from "./types";

export const PENDING_SYNC_STORAGE_KEY = "gatepass.pendingSync.v1";

/** Upper bound on persisted entries; the newest are kept. */
export const PENDING_SYNC_MAX_ENTRIES = 200;

interface PersistedQueue {
  guardId: string;
  savedAt: number;
  entries: EntryRecord[];
}

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function clearPendingSync(): void {
  storage()?.removeItem(PENDING_SYNC_STORAGE_KEY);
}

/** Records that are already synced, or that have no idempotency key, cannot
 *  be re-submitted, so persisting them would only risk duplicates. */
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

export function writePendingSync(
  guardId: string | null,
  entries: EntryRecord[],
): void {
  const store = storage();
  if (!store || !guardId) return;

  const durable = dedupe(entries.filter(isDurable)).slice(
    0,
    PENDING_SYNC_MAX_ENTRIES,
  );

  if (durable.length === 0) {
    clearPendingSync();
    return;
  }

  const record: PersistedQueue = {
    guardId,
    savedAt: Date.now(),
    entries: durable,
  };

  try {
    store.setItem(PENDING_SYNC_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // A full store must not break the gate. The in-memory queue still holds
    // the entries for this session.
  }
}

function isEntryRecord(value: unknown, guardId: string): value is EntryRecord {
  if (typeof value !== "object" || value === null) return false;
  const record: Record<string, unknown> = { ...value };

  return (
    typeof record.id === "string" &&
    typeof record.offlineId === "string" &&
    record.guardId === guardId &&
    typeof record.visitorName === "string" &&
    typeof record.host === "string" &&
    typeof record.unit === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.method === "string" &&
    typeof record.status === "string" &&
    (record.syncState === "queued" || record.syncState === "failed")
  );
}

/** Entries this guard queued and never managed to sync. Returns [] for any
 *  malformed, foreign or unreadable record — a broken cache is not a reason
 *  to break sign-in. */
export function readPendingSync(guardId: string | null): EntryRecord[] {
  const store = storage();
  if (!store || !guardId) return [];

  const raw = store.getItem(PENDING_SYNC_STORAGE_KEY);
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

  const entries = record.entries.filter((e): e is EntryRecord =>
    isEntryRecord(e, guardId),
  );

  return dedupe(entries).slice(0, PENDING_SYNC_MAX_ENTRIES);
}
