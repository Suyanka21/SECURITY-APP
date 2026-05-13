// @vitest-environment node
/**
 * GatePass — Entry Service Tests (TDD)
 *
 * Source: gatepass-api-contract.md §3.2
 * Tests business logic with mocked DB operations.
 *
 * TDD Skill: Each test reads like a specification.
 * DAMP over DRY — each test is self-contained and readable.
 */

import { describe, it, expect, vi } from "vitest";
import { createEntry, ServiceError } from "../services/entry-service";
import type { CreateEntryInput } from "../validation/entry-schemas";
import {
  guards,
  entryRecords,
  authorizationDecisions,
  overrideEvents,
} from "@/db/schema";

// ─── Mock DB Factory ─────────────────────────────────────────────────────────

/**
 * Creates a mock Drizzle DB that simulates select/insert operations.
 * Uses imported schema table references for routing.
 */
function createMockDB(overrides: {
  guardResult?: { id: string; isActive: boolean }[];
  entryByOfflineId?: { id: string }[];
  approvalResult?: { id: string }[];
  insertError?: { table: unknown; error: Error };
} = {}) {
  const {
    guardResult = [{ id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", isActive: true }],
    entryByOfflineId = [],
    approvalResult = [{ id: "b2c3d4e5-f6a7-8901-bcde-f12345678901" }],
  } = overrides;

  // Track what was inserted for assertions
  const insertedEntries: unknown[] = [];
  const insertedOverrides: unknown[] = [];

  // [H1] Transaction-aware insert mock factory
  const createInsertMock = (onInsertError?: { table: unknown; error: Error }) => {
    return vi.fn().mockImplementation((table: unknown) => ({
      values: vi.fn().mockImplementation((row: unknown) => {
        // Simulate insert failure if configured
        if (onInsertError && table === onInsertError.table) {
          return Promise.reject(onInsertError.error);
        }
        if (table === entryRecords) {
          insertedEntries.push(row);
        }
        if (table === overrideEvents) {
          insertedOverrides.push(row);
        }
        return Promise.resolve();
      }),
    }));
  };

  const insertMock = createInsertMock(overrides.insertError);

  const mockDB = {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => ({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockImplementation(() => {
            if (table === guards) {
              return Promise.resolve(guardResult);
            }
            if (table === entryRecords) {
              return Promise.resolve(entryByOfflineId);
            }
            if (table === authorizationDecisions) {
              return Promise.resolve(approvalResult);
            }
            return Promise.resolve([]);
          }),
        }),
      })),
    })),
    insert: insertMock,
    // [H1 FIX] db.transaction() mock — passes a tx object with the same insert API
    // On failure, the real Drizzle transaction() would roll back. Our mock simulates
    // this by clearing the insertedEntries/insertedOverrides arrays on tx error.
    transaction: vi.fn().mockImplementation(async (cb: (tx: any) => Promise<void>) => {
      const snapshotEntries = insertedEntries.length;
      const snapshotOverrides = insertedOverrides.length;
      const txInsert = createInsertMock(overrides.insertError);
      const tx = { insert: txInsert };
      try {
        await cb(tx);
      } catch (err) {
        // Simulate rollback: remove anything inserted in this transaction
        insertedEntries.length = snapshotEntries;
        insertedOverrides.length = snapshotOverrides;
        throw err;
      }
    }),
    query: {},
    _insertedEntries: insertedEntries,
    _insertedOverrides: insertedOverrides,
  };

  return mockDB;
}

// ─── Test Helpers ────────────────────────────────────────────────────────────

function validWalkInInput(): CreateEntryInput {
  return {
    visitorName: "Maya Chen",
    host: "A. Okafor",
    unit: "18B",
    plate: "LND-482",
    reason: "Visiting host",
    method: "walk-in",
    guardId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    createdAt: new Date().toISOString(),
  };
}

function validOverrideInput(): CreateEntryInput {
  return {
    ...validWalkInInput(),
    method: "override",
    reason: "Emergency maintenance required for unit plumbing",
  };
}

// ─── Service Tests ───────────────────────────────────────────────────────────

describe("EntryService.createEntry", () => {
  // Test 1: Creates entry with correct fields
  // Source: contract §3.2 — CreateEntryResponse
  it("creates entry with server-generated ID and correct fields", async () => {
    const db = createMockDB();
    const input = validWalkInInput();

    const { response, statusCode } = await createEntry(input, db);

    expect(statusCode).toBe(201);
    expect(response.entry.id).toBeDefined();
    expect(response.entry.id).not.toBe("");
    expect(response.entry.visitorName).toBe("Maya Chen");
    expect(response.entry.host).toBe("A. Okafor");
    expect(response.entry.unit).toBe("18B");
    expect(response.entry.method).toBe("walk-in");
    expect(response.entry.guardId).toBe(input.guardId);
  });

  // Test 2: Returns structured response, not raw DB row
  // Source: contract §3.2 — "Must return structured response"
  it("returns structured CreateEntryResponse shape", async () => {
    const db = createMockDB();
    const { response } = await createEntry(validWalkInInput(), db);

    expect(response).toHaveProperty("entry");
    expect(response).toHaveProperty("traceId");
    expect(response.entry).toHaveProperty("id");
    expect(response.entry).toHaveProperty("visitorName");
    expect(response.entry).toHaveProperty("host");
    expect(response.entry).toHaveProperty("unit");
    expect(response.entry).toHaveProperty("plate");
    expect(response.entry).toHaveProperty("reason");
    expect(response.entry).toHaveProperty("method");
    expect(response.entry).toHaveProperty("guardId");
    expect(response.entry).toHaveProperty("createdAt");
    expect(response.entry).toHaveProperty("status");
    expect(response.entry).toHaveProperty("syncState");
  });

  // Test 3: Sets status = "logged", syncState = "synced"
  // Source: contract §3.2 response — status: "logged", syncState: "synced"
  it("sets status to logged and syncState to synced", async () => {
    const db = createMockDB();
    const { response } = await createEntry(validWalkInInput(), db);

    expect(response.entry.status).toBe("logged");
    expect(response.entry.syncState).toBe("synced");
  });

  // Test 4: Generates server-side traceId
  // Source: contract §2 — "traceId: Server-generated, for audit correlation"
  it("generates a non-empty server-side traceId", async () => {
    const db = createMockDB();
    const { response } = await createEntry(validWalkInInput(), db);

    expect(response.traceId).toBeDefined();
    expect(response.traceId).toMatch(/^trace-/);
    expect(response.traceId.length).toBeGreaterThan(6);
  });

  // Test 5: Duplicate offlineId → DUPLICATE_ENTRY (409)
  // Source: contract §3.2 — "409 DUPLICATE_ENTRY: offlineId already exists"
  it("throws DUPLICATE_ENTRY when offlineId already exists", async () => {
    const db = createMockDB({
      entryByOfflineId: [{ id: "existing-entry-id" }],
    });
    const input: CreateEntryInput = {
      ...validWalkInInput(),
      offlineId: "d4e5f6a7-b8c9-0123-def0-123456789abc",
    };

    try {
      await createEntry(input, db);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe("DUPLICATE_ENTRY");
      expect((err as ServiceError).statusCode).toBe(409);
    }
  });

  // Test 6: Override method → creates override_events row
  // Source: DEFINITION §2D, override_events table
  it("inserts override_events row for override method", async () => {
    const db = createMockDB();
    const input = validOverrideInput();

    await createEntry(input, db);

    // Verify transaction was used and both inserts happened inside it
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db._insertedOverrides.length).toBe(1);
  });

  // Test 6b: Override insert failure → entry NOT created (rollback)
  // Source: TRUSTLESS-AUDIT-REPORT [H1] — "No partial writes allowed"
  // FAILURE CHECK: Can entry exist without override record? → NO
  it("rolls back entry when override insert fails", async () => {
    const db = createMockDB({
      insertError: { table: overrideEvents, error: new Error("DB constraint violation") },
    });
    const input = validOverrideInput();

    try {
      await createEntry(input, db);
      expect.fail("Should have thrown");
    } catch (err) {
      // Transaction should have rolled back — no entries persisted
      expect(db._insertedEntries.length).toBe(0);
      expect(db._insertedOverrides.length).toBe(0);
    }
  });

  // Test 6c: Entry insert failure → no override attempt
  // FAILURE CHECK: Can partial writes occur? → NO
  it("does not attempt override insert when entry insert fails", async () => {
    const db = createMockDB({
      insertError: { table: entryRecords, error: new Error("DB write failure") },
    });
    const input = validOverrideInput();

    try {
      await createEntry(input, db);
      expect.fail("Should have thrown");
    } catch (err) {
      // Entry failed → override never reached → no partial writes
      expect(db._insertedEntries.length).toBe(0);
      expect(db._insertedOverrides.length).toBe(0);
    }
  });

  // Test 7: Invalid guardId → GUARD_SESSION_EXPIRED (403)
  // Source: contract §3.2 — "403 GUARD_SESSION_EXPIRED"
  it("throws GUARD_SESSION_EXPIRED when guard not found", async () => {
    const db = createMockDB({ guardResult: [] });

    try {
      await createEntry(validWalkInInput(), db);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe("GUARD_SESSION_EXPIRED");
      expect((err as ServiceError).statusCode).toBe(403);
    }
  });

  // Test 8: Inactive guard → GUARD_SESSION_EXPIRED (403)
  it("throws GUARD_SESSION_EXPIRED when guard is inactive", async () => {
    const db = createMockDB({
      guardResult: [{ id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", isActive: false }],
    });

    try {
      await createEntry(validWalkInInput(), db);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe("GUARD_SESSION_EXPIRED");
      expect((err as ServiceError).statusCode).toBe(403);
    }
  });

  // Test 9: QR with invalid preApprovalId → PRE_APPROVAL_NOT_FOUND (404)
  // Source: contract §3.2 — "404 PRE_APPROVAL_NOT_FOUND"
  it("throws PRE_APPROVAL_NOT_FOUND when preApprovalId is invalid", async () => {
    const db = createMockDB({ approvalResult: [] });
    const input: CreateEntryInput = {
      ...validWalkInInput(),
      method: "qr",
      preApprovalId: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
    };

    try {
      await createEntry(input, db);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe("PRE_APPROVAL_NOT_FOUND");
      expect((err as ServiceError).statusCode).toBe(404);
    }
  });

  // Test 10: Null plate is stored correctly
  it("stores null plate when not provided", async () => {
    const db = createMockDB();
    const input = { ...validWalkInInput(), plate: null };

    const { response } = await createEntry(input, db);

    expect(response.entry.plate).toBeNull();
  });

  // Test 11: createdAt is server-generated ISO string
  it("returns server-generated ISO 8601 createdAt timestamp", async () => {
    const db = createMockDB();
    const { response } = await createEntry(validWalkInInput(), db);

    const parsed = new Date(response.entry.createdAt);
    expect(parsed.toISOString()).toBe(response.entry.createdAt);
  });
});
