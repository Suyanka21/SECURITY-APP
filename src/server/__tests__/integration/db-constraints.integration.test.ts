/**
 * GatePass — Database Integration Tests
 *
 * Source: TRUSTLESS-AUDIT-REPORT — "Critical Trust Gap: DB constraints untested"
 * Source: Test-Driven-Development skill — "Validate real DB behavior"
 * Source: Source-Driven-Development skill — "Align with PostgreSQL + Drizzle"
 *
 * These tests run against a REAL PostgreSQL database (Supabase).
 * They validate that database-level constraints enforce business rules
 * independently of application code.
 *
 * HARD RULES TESTED:
 * 1. Entry creation inserts real rows with correct fields
 * 2. Transaction rollback leaves zero orphan rows
 * 3. CHECK constraints reject invalid data at the DB level
 * 4. UNIQUE constraint prevents duplicate offlineId (dedup)
 * 5. FK constraints prevent orphaned references
 *
 * RUN: npx vitest run --config vitest.integration.config.ts
 *
 * PREREQUISITES:
 * - DATABASE_URL environment variable set (Supabase or local PG)
 * - Schema migrated (npx drizzle-kit push)
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  guards,
  entryRecords,
  overrideEvents,
} from "@/db/schema";

// ─── Test DB Connection ──────────────────────────────────────────────────────

let pool: Pool;
let db: ReturnType<typeof drizzle>;

// Test guard ID — created in beforeAll, cleaned up in afterAll
let testGuardId: string;

// Track all created entry IDs for cleanup
const createdEntryIds: string[] = [];
const createdOverrideIds: string[] = [];

beforeAll(async () => {
  // Source-Driven-Development: Use real PostgreSQL via node-postgres Pool
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required for integration tests. " +
        "Set it in .env.test or pass via environment."
    );
  }

  pool = new Pool({ connectionString: databaseUrl, max: 5 });
  db = drizzle(pool);

  // Create a test guard for FK references
  const guardResult = await db
    .insert(guards)
    .values({
      id: randomUUID(),
      badgeNumber: `TEST-INTEG-${Date.now()}`,
      name: "Integration Test Guard",
      isActive: true,
    })
    .returning({ id: guards.id });

  testGuardId = guardResult[0].id;
});

afterEach(async () => {
  // Clean up override events first (FK depends on entry_records)
  if (createdOverrideIds.length > 0) {
    for (const id of createdOverrideIds) {
      try {
        await db.delete(overrideEvents).where(eq(overrideEvents.id, id));
      } catch {
        // Ignore — may not exist if test failed mid-insert
      }
    }
    createdOverrideIds.length = 0;
  }

  // Clean up entry records
  if (createdEntryIds.length > 0) {
    for (const id of createdEntryIds) {
      try {
        await db.delete(entryRecords).where(eq(entryRecords.id, id));
      } catch {
        // Ignore — may not exist if test failed mid-insert
      }
    }
    createdEntryIds.length = 0;
  }
});

afterAll(async () => {
  // Clean up test guard
  if (testGuardId) {
    try {
      await db.delete(guards).where(eq(guards.id, testGuardId));
    } catch {
      // Best effort cleanup
    }
  }

  // Close pool
  if (pool) {
    await pool.end();
  }
});

// ─── Helper ──────────────────────────────────────────────────────────────────

function validEntryRow(overrides: Partial<Record<string, unknown>> = {}) {
  const id = randomUUID();
  createdEntryIds.push(id);
  return {
    id,
    visitorName: "Maya Chen",
    host: "John Doe",
    unit: "18B",
    plate: null,
    reason: "",
    method: "walk-in" as const,
    guardId: testGuardId,
    status: "logged" as const,
    syncState: "synced" as const,
    offlineId: randomUUID(),
    deviceCreatedAt: new Date(),
    traceId: `trace-integ-${randomUUID()}`,
    ...overrides,
  };
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe("Database Integration Tests", () => {
  // ── 1. Entry Creation ─────────────────────────────────────────────────────

  describe("Entry Creation", () => {
    it("inserts a valid entry and returns all fields", async () => {
      const entry = validEntryRow();

      const result = await db
        .insert(entryRecords)
        .values(entry)
        .returning();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(entry.id);
      expect(result[0].visitorName).toBe("Maya Chen");
      expect(result[0].host).toBe("John Doe");
      expect(result[0].unit).toBe("18B");
      expect(result[0].method).toBe("walk-in");
      expect(result[0].guardId).toBe(testGuardId);
      expect(result[0].status).toBe("logged");
      expect(result[0].syncState).toBe("synced");
      expect(result[0].createdAt).toBeInstanceOf(Date);
    });

    it("persists entry that can be read back", async () => {
      const entry = validEntryRow();
      await db.insert(entryRecords).values(entry);

      const rows = await db
        .select()
        .from(entryRecords)
        .where(eq(entryRecords.id, entry.id));

      expect(rows).toHaveLength(1);
      expect(rows[0].visitorName).toBe("Maya Chen");
    });
  });

  // ── 2. Transaction Rollback ───────────────────────────────────────────────

  describe("Transaction Rollback", () => {
    it("rolls back entry when override insert fails (FK violation)", async () => {
      const entryId = randomUUID();
      createdEntryIds.push(entryId);

      let transactionFailed = false;

      try {
        await db.transaction(async (tx) => {
          // Step 1: Insert entry (succeeds)
          await tx.insert(entryRecords).values(
            validEntryRow({ id: entryId, method: "override", reason: "Emergency maintenance needed" })
          );

          // Step 2: Insert override with INVALID guardId (FK violation → rolls back)
          await tx.insert(overrideEvents).values({
            id: randomUUID(),
            entryId,
            guardId: randomUUID(), // Non-existent guard → FK violation
            reason: "Emergency maintenance needed",
            traceId: `trace-integ-${randomUUID()}`,
          });
        });
      } catch {
        transactionFailed = true;
      }

      expect(transactionFailed).toBe(true);

      // Verify: entry was rolled back — no orphan row
      const rows = await db
        .select()
        .from(entryRecords)
        .where(eq(entryRecords.id, entryId));

      expect(rows).toHaveLength(0);
    });
  });

  // ── 3. CHECK Constraint Enforcement ───────────────────────────────────────

  describe("CHECK Constraint Enforcement", () => {
    it("rejects empty visitorName (entry_visitor_name_not_empty)", async () => {
      const entry = validEntryRow({ visitorName: "   " });

      await expect(
        db.insert(entryRecords).values(entry)
      ).rejects.toThrow();
    });

    it("rejects empty host (entry_host_not_empty)", async () => {
      const entry = validEntryRow({ host: "   " });

      await expect(
        db.insert(entryRecords).values(entry)
      ).rejects.toThrow();
    });

    it("rejects empty unit (entry_unit_not_empty)", async () => {
      const entry = validEntryRow({ unit: "" });

      await expect(
        db.insert(entryRecords).values(entry)
      ).rejects.toThrow();
    });

    it("rejects override entry with short reason (entry_override_reason_length)", async () => {
      const entry = validEntryRow({
        method: "override",
        reason: "short", // < 8 chars → violates CHECK
      });

      await expect(
        db.insert(entryRecords).values(entry)
      ).rejects.toThrow();
    });

    it("accepts override entry with valid reason (≥ 8 chars)", async () => {
      const entry = validEntryRow({
        method: "override",
        reason: "Emergency maintenance required",
      });

      const result = await db
        .insert(entryRecords)
        .values(entry)
        .returning();

      expect(result).toHaveLength(1);
      expect(result[0].reason).toBe("Emergency maintenance required");
    });

    it("rejects plate longer than 20 characters (entry_plate_max_length)", async () => {
      const entry = validEntryRow({
        plate: "A".repeat(21), // 21 chars → violates CHECK
      });

      await expect(
        db.insert(entryRecords).values(entry)
      ).rejects.toThrow();
    });

    it("accepts plate with exactly 20 characters", async () => {
      const entry = validEntryRow({ plate: "A".repeat(20) });

      const result = await db
        .insert(entryRecords)
        .values(entry)
        .returning();

      expect(result).toHaveLength(1);
      expect(result[0].plate).toBe("A".repeat(20));
    });
  });

  // ── 4. Duplicate Prevention (UNIQUE offlineId) ────────────────────────────

  describe("Duplicate Prevention", () => {
    it("rejects duplicate offlineId (UNIQUE constraint)", async () => {
      const sharedOfflineId = randomUUID();

      // First insert succeeds
      const entry1 = validEntryRow({ offlineId: sharedOfflineId });
      await db.insert(entryRecords).values(entry1);

      // Second insert with same offlineId → UNIQUE violation
      const entry2 = validEntryRow({ offlineId: sharedOfflineId });

      await expect(
        db.insert(entryRecords).values(entry2)
      ).rejects.toThrow();
    });

    it("allows entries with different offlineIds", async () => {
      const entry1 = validEntryRow();
      const entry2 = validEntryRow();

      await db.insert(entryRecords).values(entry1);
      await db.insert(entryRecords).values(entry2);

      const rows = await db
        .select()
        .from(entryRecords)
        .where(
          sql`${entryRecords.id} IN (${sql.raw(`'${entry1.id}', '${entry2.id}'`)})`
        );

      expect(rows).toHaveLength(2);
    });
  });

  // ── 5. FK Constraint Enforcement ──────────────────────────────────────────

  describe("FK Constraint Enforcement", () => {
    it("rejects entry with non-existent guardId (FK violation)", async () => {
      const entry = validEntryRow({ guardId: randomUUID() });

      await expect(
        db.insert(entryRecords).values(entry)
      ).rejects.toThrow();
    });

    it("rejects override_events with non-existent entryId (FK violation)", async () => {
      const overrideRow = {
        id: randomUUID(),
        entryId: randomUUID(), // Non-existent → FK violation
        guardId: testGuardId,
        reason: "Emergency maintenance needed",
        traceId: `trace-integ-${randomUUID()}`,
      };

      await expect(
        db.insert(overrideEvents).values(overrideRow)
      ).rejects.toThrow();
    });

    it("allows override_events with valid entryId + guardId", async () => {
      // Create entry first
      const entry = validEntryRow({
        method: "override",
        reason: "Emergency maintenance needed",
      });
      await db.insert(entryRecords).values(entry);

      // Create override linked to the entry
      const overrideId = randomUUID();
      createdOverrideIds.push(overrideId);

      const result = await db
        .insert(overrideEvents)
        .values({
          id: overrideId,
          entryId: entry.id,
          guardId: testGuardId,
          reason: "Emergency maintenance needed",
          traceId: `trace-integ-${randomUUID()}`,
        })
        .returning();

      expect(result).toHaveLength(1);
      expect(result[0].entryId).toBe(entry.id);
    });

    it("rejects duplicate override for same entry (UNIQUE entryId on override_events)", async () => {
      // Create entry
      const entry = validEntryRow({
        method: "override",
        reason: "Emergency maintenance needed",
      });
      await db.insert(entryRecords).values(entry);

      // First override succeeds
      const overrideId1 = randomUUID();
      createdOverrideIds.push(overrideId1);
      await db.insert(overrideEvents).values({
        id: overrideId1,
        entryId: entry.id,
        guardId: testGuardId,
        reason: "Emergency maintenance needed",
        traceId: `trace-integ-${randomUUID()}`,
      });

      // Second override for same entry → UNIQUE violation
      const overrideId2 = randomUUID();
      createdOverrideIds.push(overrideId2);

      await expect(
        db.insert(overrideEvents).values({
          id: overrideId2,
          entryId: entry.id, // Same entryId → UNIQUE violation
          guardId: testGuardId,
          reason: "Another override reason here",
          traceId: `trace-integ-${randomUUID()}`,
        })
      ).rejects.toThrow();
    });
  });
});
