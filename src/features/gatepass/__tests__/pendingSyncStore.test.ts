/**
 * Offline queue durability — persistence layer.
 *
 * An entry queued offline is a real visitor who is already inside the
 * estate. Until it syncs, the browser tab is the only record of it, so the
 * queue has to survive the console unmounting (a failed /api/auth/me, a
 * session expiry, a reload).
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { EntryRecord } from "../types";
import {
  PENDING_SYNC_MAX_ENTRIES,
  PENDING_SYNC_STORAGE_KEY,
  clearPendingSync,
  readPendingSync,
  writePendingSync,
} from "../pendingSyncStore";

const GUARD = "11111111-1111-4111-8111-111111111111";
const OTHER_GUARD = "22222222-2222-4222-8222-222222222222";

function entry(overrides: Partial<EntryRecord> = {}): EntryRecord {
  return {
    id: "offline-1",
    offlineId: "offline-1",
    guardId: GUARD,
    visitorName: "Ada Lovelace",
    host: "Bola",
    unit: "4A",
    plate: "",
    reason: "",
    method: "walk-in",
    createdAt: "2024-01-01T00:00:00.000Z",
    status: "logged",
    syncState: "queued",
    ...overrides,
  };
}

describe("pendingSyncStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips a queued entry for the same guard", () => {
    writePendingSync(GUARD, [entry()]);
    const restored = readPendingSync(GUARD);

    expect(restored).toHaveLength(1);
    expect(restored[0].offlineId).toBe("offline-1");
    expect(restored[0].visitorName).toBe("Ada Lovelace");
    expect(restored[0].syncState).toBe("queued");
  });

  it("keeps a failed entry — a rejected record is not a discarded one", () => {
    writePendingSync(GUARD, [
      entry({ syncState: "failed", lastError: { code: "X", message: "no" } }),
    ]);

    const restored = readPendingSync(GUARD);
    expect(restored).toHaveLength(1);
    expect(restored[0].syncState).toBe("failed");
    expect(restored[0].lastError?.code).toBe("X");
  });

  it("never hands one guard another guard's queue", () => {
    writePendingSync(OTHER_GUARD, [entry({ guardId: OTHER_GUARD })]);

    expect(readPendingSync(GUARD)).toEqual([]);
    // The other guard's queue is left intact for when they sign back in.
    expect(readPendingSync(OTHER_GUARD)).toHaveLength(1);
  });

  it("returns nothing when no guard is known yet", () => {
    writePendingSync(GUARD, [entry()]);
    expect(readPendingSync(null)).toEqual([]);
  });

  it("drops records the queue cannot sync (no offlineId)", () => {
    writePendingSync(GUARD, [entry({ offlineId: undefined })]);
    expect(readPendingSync(GUARD)).toEqual([]);
  });

  it("drops already-synced records — only unsynced work is durable", () => {
    writePendingSync(GUARD, [entry({ syncState: "synced" })]);
    expect(readPendingSync(GUARD)).toEqual([]);
  });

  it("de-duplicates by offlineId", () => {
    writePendingSync(GUARD, [entry(), entry()]);
    expect(readPendingSync(GUARD)).toHaveLength(1);
  });

  it("caps the queue so a pathological session cannot fill the store", () => {
    const many = Array.from({ length: PENDING_SYNC_MAX_ENTRIES + 10 }, (_, i) =>
      entry({ id: `offline-${i}`, offlineId: `offline-${i}` }),
    );
    writePendingSync(GUARD, many);

    expect(readPendingSync(GUARD)).toHaveLength(PENDING_SYNC_MAX_ENTRIES);
  });

  it("writing an empty queue clears the record", () => {
    writePendingSync(GUARD, [entry()]);
    writePendingSync(GUARD, []);

    expect(window.localStorage.getItem(PENDING_SYNC_STORAGE_KEY)).toBeNull();
  });

  it("rejects malformed JSON without throwing", () => {
    window.localStorage.setItem(PENDING_SYNC_STORAGE_KEY, "{not json");
    expect(readPendingSync(GUARD)).toEqual([]);
  });

  it("rejects a record whose fields are the wrong shape", () => {
    window.localStorage.setItem(
      PENDING_SYNC_STORAGE_KEY,
      JSON.stringify({
        guardId: GUARD,
        savedAt: Date.now(),
        entries: [{ offlineId: 5, visitorName: null }],
      }),
    );

    expect(readPendingSync(GUARD)).toEqual([]);
  });

  it("rejects an entry attributed to a different guard than the record", () => {
    window.localStorage.setItem(
      PENDING_SYNC_STORAGE_KEY,
      JSON.stringify({
        guardId: GUARD,
        savedAt: Date.now(),
        entries: [entry({ guardId: OTHER_GUARD })],
      }),
    );

    expect(readPendingSync(GUARD)).toEqual([]);
  });

  // Note: sign-out deliberately does NOT clear the queue — unsynced entries
  // are real visitors, and they wait for their guard to come back.
  it("clears explicitly", () => {
    writePendingSync(GUARD, [entry()]);
    clearPendingSync();
    expect(readPendingSync(GUARD)).toEqual([]);
  });
});
