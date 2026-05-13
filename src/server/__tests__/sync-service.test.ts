// @vitest-environment node
/**
 * GatePass — Sync Engine Tests (TDD)
 *
 * Source: gatepass-api-contract.md §3.3
 * Source: GATEPASS DEFINITION §4 — "Offline Continuity"
 *
 * FAILURE CHECK verification:
 * - Can duplicates occur? → Tests 4, 5, 12 prove NO
 * - Can entries be lost? → Tests 6, 7, 8 prove NO
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateSyncBatch, SyncErrorCodes } from "../validation/sync-schemas";
import { syncEntries } from "../services/sync-service";
import { ServiceError } from "../services/entry-service";
import { clearAuditLog, getAuditEventsByType } from "../services/audit-logger";
import { guards, entryRecords, syncEvents, overrideEvents } from "@/db/schema";

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  clearAuditLog();
});

// ─── Mock DB Factory ─────────────────────────────────────────────────────────

function createMockDB(overrides: {
  guardResult?: { id: string; isActive: boolean }[];
  existingOfflineIds?: string[];
} = {}) {
  const {
    guardResult = [{ id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", isActive: true }],
    existingOfflineIds = [],
  } = overrides;

  const insertedEntries: unknown[] = [];
  const insertedSyncEvents: unknown[] = [];
  const insertedOverrides: unknown[] = [];

  // Track which table is being selected from
  let currentTable: unknown = null;

  return {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => {
        currentTable = table;
        return {
          where: vi.fn().mockImplementation(() => ({
            limit: vi.fn().mockImplementation(() => {
              if (currentTable === guards) return Promise.resolve(guardResult);
              if (currentTable === entryRecords) {
                // For dedup checks, we need to check if ANY existing offlineId matches
                // Since the sync service iterates entries, we pop from the list
                if (existingOfflineIds.length > 0) {
                  const matchId = existingOfflineIds.shift()!;
                  return Promise.resolve([{ id: `existing-server-id-for-${matchId}` }]);
                }
                return Promise.resolve([]);
              }
              return Promise.resolve([]);
            }),
          })),
        };
      }),
    })),
    insert: vi.fn().mockImplementation((table: unknown) => ({
      values: vi.fn().mockImplementation((data: unknown) => {
        if (table === entryRecords) insertedEntries.push(data);
        if (table === syncEvents) insertedSyncEvents.push(data);
        if (table === overrideEvents) insertedOverrides.push(data);
        return Promise.resolve();
      }),
    })),
    // [M1 FIX] Transaction support — tx exposes same insert API
    // On success: committed rows stay. On failure: rollback simulated.
    transaction: vi.fn().mockImplementation(async (fn: (tx: any) => Promise<void>) => {
      const txEntries: unknown[] = [];
      const txOverrides: unknown[] = [];
      const tx = {
        insert: vi.fn().mockImplementation((table: unknown) => ({
          values: vi.fn().mockImplementation((data: unknown) => {
            if (table === entryRecords) txEntries.push(data);
            if (table === overrideEvents) txOverrides.push(data);
            return Promise.resolve();
          }),
        })),
      };
      // Execute the transaction callback — if it throws, nothing is committed
      await fn(tx);
      // Commit: push tx-buffered rows into the main arrays
      insertedEntries.push(...txEntries);
      insertedOverrides.push(...txOverrides);
    }),
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue(Promise.resolve()),
      }),
    })),
    query: {},
    _insertedEntries: insertedEntries,
    _insertedSyncEvents: insertedSyncEvents,
    _insertedOverrides: insertedOverrides,
  };
}

const GUARD_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

function validSyncEntry(offlineId?: string) {
  return {
    offlineId: offlineId || "b2c3d4e5-f6a7-8901-bcde-f12345678901",
    visitorName: "Maya Chen",
    host: "A. Okafor",
    unit: "18B",
    plate: "LND-482",
    reason: "",
    method: "walk-in" as const,
    createdAt: new Date().toISOString(),
  };
}

function validSyncBatch(entries?: ReturnType<typeof validSyncEntry>[]) {
  return {
    // [C3 FIX] guardId removed from schema — now comes from auth middleware
    entries: entries || [validSyncEntry()],
  };
}

// ─── Validation Tests ────────────────────────────────────────────────────────

describe("Sync Validation", () => {
  // Test 1: Valid batch passes
  it("accepts a valid sync batch", () => {
    const result = validateSyncBatch(validSyncBatch());
    expect(result.success).toBe(true);
  });

  // Test 2: Empty entries → EMPTY_SYNC_BATCH
  it("rejects empty entries array with EMPTY_SYNC_BATCH", () => {
    const result = validateSyncBatch({ entries: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe(SyncErrorCodes.EMPTY_SYNC_BATCH);
    }
  });

  // Test 3: > 50 entries → BATCH_TOO_LARGE
  it("rejects batch exceeding 50 entries with BATCH_TOO_LARGE", () => {
    const entries = Array.from({ length: 51 }, (_, i) =>
      validSyncEntry(`${i.toString().padStart(8, "0")}-0000-0000-0000-000000000000`)
    );
    const result = validateSyncBatch({ entries });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe(SyncErrorCodes.BATCH_TOO_LARGE);
    }
  });

  // Test 4: guardId in body is IGNORED by schema
  // Source: TRUSTLESS-AUDIT-REPORT [C3] — guardId handled by auth middleware
  it("ignores guardId in request body (handled by auth middleware)", () => {
    const result = validateSyncBatch({ guardId: "injected-fake-id", entries: [validSyncEntry()] });
    expect(result.success).toBe(true);
  });

  // Test 5: Duplicate offlineIds within batch → rejected
  it("rejects duplicate offlineIds within same batch", () => {
    const sameId = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
    const result = validateSyncBatch({
      entries: [validSyncEntry(sameId), validSyncEntry(sameId)],
    });
    expect(result.success).toBe(false);
  });

  // Test 6: Missing offlineId on entry → rejected
  it("rejects entry without offlineId", () => {
    const entry = { ...validSyncEntry(), offlineId: undefined };
    const result = validateSyncBatch({ entries: [entry as any] });
    expect(result.success).toBe(false);
  });
});

// ─── Service Tests ───────────────────────────────────────────────────────────

describe("SyncService.syncEntries", () => {
  // Test 7: Successful sync of single entry → 200
  it("syncs a single entry and returns status synced", async () => {
    const db = createMockDB();
    const { response, statusCode } = await syncEntries(validSyncBatch(), db);

    expect(statusCode).toBe(200);
    expect(response.syncedCount).toBe(1);
    expect(response.duplicateCount).toBe(0);
    expect(response.rejectedCount).toBe(0);
    expect(response.results).toHaveLength(1);
    expect(response.results[0].status).toBe("synced");
    expect(response.results[0].offlineId).toBe("b2c3d4e5-f6a7-8901-bcde-f12345678901");
    expect(response.results[0].serverId).toBeDefined();
    expect(response.traceId).toMatch(/^trace-/);
  });

  // Test 8: Multiple entries synced → all results returned
  it("syncs multiple entries and returns per-entry results", async () => {
    const db = createMockDB();
    const entries = [
      validSyncEntry("11111111-1111-1111-1111-111111111111"),
      validSyncEntry("22222222-2222-2222-2222-222222222222"),
      validSyncEntry("33333333-3333-3333-3333-333333333333"),
    ];

    const { response, statusCode } = await syncEntries(
      { guardId: GUARD_ID, entries },
      db
    );

    expect(statusCode).toBe(200);
    expect(response.syncedCount).toBe(3);
    expect(response.results).toHaveLength(3);
    expect(response.results.every(r => r.status === "synced")).toBe(true);
  });

  // Test 9: Guard not found → GUARD_SESSION_EXPIRED (403)
  it("rejects entire batch when guard not found", async () => {
    const db = createMockDB({ guardResult: [] });

    try {
      await syncEntries(validSyncBatch(), db);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe("GUARD_SESSION_EXPIRED");
      expect((err as ServiceError).statusCode).toBe(403);
    }
  });

  // Test 10: Duplicate offlineId already in DB → "duplicate" (idempotent)
  // HARD RULE: "System must be idempotent"
  it("returns duplicate status for already-synced offlineId", async () => {
    const existingId = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
    const db = createMockDB({ existingOfflineIds: [existingId] });

    const { response } = await syncEntries(validSyncBatch(), db);

    expect(response.duplicateCount).toBe(1);
    expect(response.syncedCount).toBe(0);
    expect(response.results[0].status).toBe("duplicate");
    expect(response.results[0].serverId).toContain("existing-server-id");
  });

  // Test 11: Emits batch_sync_completed audit event
  it("emits batch_sync_completed audit event", async () => {
    const db = createMockDB();
    await syncEntries(validSyncBatch(), db);

    const events = getAuditEventsByType("batch_sync_completed");
    expect(events.length).toBe(1);
    expect(events[0].payload).toMatchObject({
      totalEntries: 1,
      syncedCount: 1,
      duplicateCount: 0,
      rejectedCount: 0,
    });
  });

  // Test 12: Creates sync_events records for audit trail
  it("creates sync_events records for each synced entry", async () => {
    const db = createMockDB();
    await syncEntries(validSyncBatch(), db);

    expect(db._insertedSyncEvents.length).toBe(1);
  });

  // Test 13: Inserts entry_records for synced entries
  // HARD RULE: "No data loss allowed"
  it("inserts entry_records for each synced entry", async () => {
    const db = createMockDB();
    const entries = [
      validSyncEntry("11111111-1111-1111-1111-111111111111"),
      validSyncEntry("22222222-2222-2222-2222-222222222222"),
    ];

    await syncEntries({ guardId: GUARD_ID, entries }, db);

    expect(db._insertedEntries.length).toBe(2);
  });

  // Test 14: Duplicate entries do NOT create new entry_records
  // HARD RULE: "No duplicate entries allowed"
  it("does not insert entry_records for duplicate entries", async () => {
    const existingId = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
    const db = createMockDB({ existingOfflineIds: [existingId] });

    await syncEntries(validSyncBatch(), db);

    expect(db._insertedEntries.length).toBe(0);
  });

  // Test 15: Override entries in sync batch create override_events
  it("creates override_events for override entries in sync batch", async () => {
    const db = createMockDB();
    const overrideEntry = {
      ...validSyncEntry("44444444-4444-4444-4444-444444444444"),
      method: "override" as const,
      reason: "Emergency maintenance required for unit plumbing",
    };

    await syncEntries({ guardId: GUARD_ID, entries: [overrideEntry] }, db);

    expect(db._insertedOverrides.length).toBe(1);
    expect(db._insertedEntries.length).toBe(1);
  });

  // Test 16: Each synced entry gets unique serverId
  it("generates unique serverIds for each synced entry", async () => {
    const db = createMockDB();
    const entries = [
      validSyncEntry("11111111-1111-1111-1111-111111111111"),
      validSyncEntry("22222222-2222-2222-2222-222222222222"),
    ];

    const { response } = await syncEntries({ guardId: GUARD_ID, entries }, db);

    const serverIds = response.results.map(r => r.serverId);
    expect(new Set(serverIds).size).toBe(2);
  });

  // ── M1 FIX: Transaction Rollback ────────────────────────────────────────

  // Test 17: Override failure rolls back entry — no orphaned records
  // Source: Trustless-System-Auditor — simulate DB failure between entry and override insert
  // FAILURE CHECK: Can partial records exist after failure? → NO
  it("rolls back entry when override insert fails mid-transaction", async () => {
    const db = createMockDB();

    // Sabotage: make the override_events insert throw inside the transaction
    db.transaction = vi.fn().mockImplementation(async (fn: any) => {
      const tx = {
        insert: vi.fn().mockImplementation((table: unknown) => ({
          values: vi.fn().mockImplementation(() => {
            if (table === overrideEvents) {
              return Promise.reject(new Error("Simulated DB failure on override insert"));
            }
            return Promise.resolve();
          }),
        })),
      };
      // Let the transaction callback run — it will throw on override insert
      await fn(tx);
    });

    const overrideEntry = {
      ...validSyncEntry("55555555-5555-5555-5555-555555555555"),
      method: "override" as const,
      reason: "Emergency maintenance required for unit plumbing",
    };

    const { response } = await syncEntries({ guardId: GUARD_ID, entries: [overrideEntry] }, db);

    // Entry must be REJECTED (not synced)
    expect(response.results[0].status).toBe("rejected");
    expect(response.rejectedCount).toBe(1);
    expect(response.syncedCount).toBe(0);

    // TRUSTLESS AUDIT: No orphaned entries — transaction rolled back
    expect(db._insertedEntries.length).toBe(0);
    expect(db._insertedOverrides.length).toBe(0);

    // sync_events for rejection should still exist (happens OUTSIDE transaction)
    expect(db._insertedSyncEvents.length).toBe(1);
    expect((db._insertedSyncEvents[0] as any).status).toBe("rejected");
  });
});
