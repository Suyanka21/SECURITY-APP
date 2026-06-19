// @vitest-environment node
/**
 * GatePass — Delivery Management Service Tests (TDD, behaviour-first)
 *
 * Source: src/docs/specs/delivery-management.md §§3–7
 * Source: Test-Driven-Development — name the state transition, not the impl.
 * Source: Trustless-System-Auditor — every delivery attempt (success or fail)
 *         writes exactly one audit row. No silent success, no silent failure.
 *
 * Mock DB:
 * - createDeliveryEntry: stubs guard lookup, offlineId check, insert.
 * - listDeliveries: stubs execute() with raw SQL result.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  createDeliveryEntry,
  listDeliveries,
  DeliveryErrorCodes,
  type DrizzleDB,
  type CreateDeliveryEntryInput,
} from "../services/delivery-service";
import {
  clearAuditLog,
  getAuditLog,
  getAuditEventsByType,
} from "../services/audit-logger";
import { guards, entryRecords } from "@/db/schema";
import { EntryErrorCodes } from "../validation/entry-schemas";

// ─── Constants ───────────────────────────────────────────────────────────────

const GUARD_ID = "guard-west-04";

function baseInput(overrides: Partial<CreateDeliveryEntryInput> = {}): CreateDeliveryEntryInput {
  return {
    visitorName: "Jumia Rider",
    host: "Reception",
    unit: "18B",
    plate: "KDA-123",
    reason: "",
    method: "walk-in",
    guardId: GUARD_ID,
    createdAt: new Date().toISOString(),
    entryKind: "delivery",
    deliveryCategory: "parcel",
    ...overrides,
  };
}

// ─── Mock DB factory ─────────────────────────────────────────────────────────

interface MockDBOpts {
  guardActive?: boolean;
  guardExists?: boolean;
  offlineIdExists?: boolean;
  insertFail?: boolean;
  deliveryRows?: any[];
}

function makeMockDB(opts: MockDBOpts = {}) {
  const {
    guardActive = true,
    guardExists = true,
    offlineIdExists = false,
    insertFail = false,
    deliveryRows = [],
  } = opts;

  const insertValuesMock = vi.fn().mockImplementation(async () => {
    if (insertFail) throw new Error("DB insert failed");
  });
  const insertMock = vi.fn().mockReturnValue({ values: insertValuesMock });

  const limitMock = vi.fn();
  const whereMock = vi.fn().mockReturnValue({ limit: limitMock });
  const fromMock = vi.fn().mockImplementation((table: unknown) => {
    return { where: whereMock };
  });
  const selectMock = vi.fn().mockReturnValue({ from: fromMock });

  // Configure guard lookup
  limitMock.mockImplementation(async () => {
    // Determine which table based on call order
    const lastFrom = fromMock.mock.calls[fromMock.mock.calls.length - 1]?.[0];

    if (lastFrom === guards) {
      if (!guardExists) return [];
      return [{ id: GUARD_ID, isActive: guardActive }];
    }
    if (lastFrom === entryRecords) {
      if (offlineIdExists) return [{ id: "existing-entry" }];
      return [];
    }
    return [];
  });

  const txInsertMock = vi.fn().mockReturnValue({
    values: vi.fn().mockResolvedValue(undefined),
  });
  const transactionMock = vi.fn().mockImplementation(async (fn: any) => {
    if (insertFail) {
      await fn({
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockRejectedValue(new Error("DB insert failed")),
        }),
      });
    } else {
      await fn({ insert: txInsertMock });
    }
  });

  const executeMock = vi.fn().mockResolvedValue(deliveryRows);

  return {
    db: {
      select: selectMock,
      insert: insertMock,
      query: {},
      execute: executeMock,
      transaction: transactionMock,
    } as unknown as DrizzleDB,
    mocks: { selectMock, insertMock, fromMock, whereMock, limitMock, transactionMock, executeMock, txInsertMock },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("delivery-service — createDeliveryEntry", () => {
  beforeEach(() => {
    clearAuditLog();
  });

  it("creates a delivery entry on happy path (entryKind=delivery, category=parcel)", async () => {
    const { db } = makeMockDB();
    const result = await createDeliveryEntry(baseInput(), db);

    expect(result.statusCode).toBe(201);
    expect(result.response.entry.entryKind).toBe("delivery");
    expect(result.response.entry.deliveryCategory).toBe("parcel");
    expect(result.response.entry.visitorName).toBe("Jumia Rider");
    expect(result.response.entry.status).toBe("logged");
    expect(result.response.traceId).toMatch(/^trace-/);

    const auditEvents = getAuditEventsByType("delivery_entry_logged");
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].payload).toMatchObject({
      entryKind: "delivery",
      deliveryCategory: "parcel",
    });
  });

  it("rejects INVALID_ENTRY_KIND for unknown entryKind", async () => {
    const { db } = makeMockDB();
    const input = baseInput({ entryKind: "spaceship" });

    await expect(createDeliveryEntry(input, db)).rejects.toMatchObject({
      code: DeliveryErrorCodes.INVALID_ENTRY_KIND,
      statusCode: 422,
      field: "entryKind",
    });

    const blocked = getAuditEventsByType("delivery_entry_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0].payload.reason).toBe("INVALID_ENTRY_KIND");
  });

  it("rejects DELIVERY_CATEGORY_REQUIRED when entryKind=delivery but no category", async () => {
    const { db } = makeMockDB();
    const input = baseInput({ deliveryCategory: "" });

    await expect(createDeliveryEntry(input, db)).rejects.toMatchObject({
      code: DeliveryErrorCodes.DELIVERY_CATEGORY_REQUIRED,
      statusCode: 422,
      field: "deliveryCategory",
    });

    const blocked = getAuditEventsByType("delivery_entry_blocked");
    expect(blocked).toHaveLength(1);
  });

  it("rejects DELIVERY_CATEGORY_REQUIRED for invalid category value", async () => {
    const { db } = makeMockDB();
    const input = baseInput({ deliveryCategory: "weapons" });

    await expect(createDeliveryEntry(input, db)).rejects.toMatchObject({
      code: DeliveryErrorCodes.DELIVERY_CATEGORY_REQUIRED,
      statusCode: 422,
      field: "deliveryCategory",
    });
  });

  it("rejects CATEGORY_WITHOUT_DELIVERY_KIND when visitor sends category", async () => {
    const { db } = makeMockDB();
    const input = baseInput({ entryKind: "visitor", deliveryCategory: "parcel" });

    await expect(createDeliveryEntry(input, db)).rejects.toMatchObject({
      code: DeliveryErrorCodes.CATEGORY_WITHOUT_DELIVERY_KIND,
      statusCode: 422,
      field: "deliveryCategory",
    });

    const blocked = getAuditEventsByType("delivery_entry_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0].payload.reason).toBe("CATEGORY_WITHOUT_DELIVERY_KIND");
  });

  it("rejects GUARD_SESSION_EXPIRED for unknown guard", async () => {
    const { db } = makeMockDB({ guardExists: false });

    await expect(createDeliveryEntry(baseInput(), db)).rejects.toMatchObject({
      code: EntryErrorCodes.GUARD_SESSION_EXPIRED,
      statusCode: 403,
    });
  });

  it("rejects GUARD_SESSION_EXPIRED for inactive guard", async () => {
    const { db } = makeMockDB({ guardActive: false });

    await expect(createDeliveryEntry(baseInput(), db)).rejects.toMatchObject({
      code: EntryErrorCodes.GUARD_SESSION_EXPIRED,
      statusCode: 403,
    });
  });

  it("rejects DUPLICATE_ENTRY for existing offlineId", async () => {
    const { db } = makeMockDB({ offlineIdExists: true });
    const input = baseInput({ offlineId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });

    await expect(createDeliveryEntry(input, db)).rejects.toMatchObject({
      code: EntryErrorCodes.DUPLICATE_ENTRY,
      statusCode: 409,
    });
  });

  it("accepts all 8 valid delivery categories", async () => {
    const categories = [
      "parcel", "food", "ride", "gas",
      "water", "moving", "maintenance", "other",
    ] as const;

    for (const cat of categories) {
      clearAuditLog();
      const { db } = makeMockDB();
      const result = await createDeliveryEntry(
        baseInput({ deliveryCategory: cat }),
        db,
      );
      expect(result.response.entry.deliveryCategory).toBe(cat);
    }
  });

  it("sets host to the provided value (guard can customize)", async () => {
    const { db } = makeMockDB();
    const result = await createDeliveryEntry(
      baseInput({ host: "Mrs. Kamau, 12A" }),
      db,
    );
    expect(result.response.entry.host).toBe("Mrs. Kamau, 12A");
  });

  it("surfaces DB insert failure (no silent success)", async () => {
    const { db } = makeMockDB({ insertFail: true });

    await expect(createDeliveryEntry(baseInput(), db)).rejects.toThrow(
      "DB insert failed",
    );

    // No delivery_entry_logged audit event should exist
    const logged = getAuditEventsByType("delivery_entry_logged");
    expect(logged).toHaveLength(0);
  });

  it("audit trail always contains entryKind and deliveryCategory on success", async () => {
    const { db } = makeMockDB();
    await createDeliveryEntry(baseInput({ deliveryCategory: "food" }), db);

    const events = getAuditLog();
    const deliveryEvents = events.filter(
      (e) => e.type === "delivery_entry_logged",
    );
    expect(deliveryEvents).toHaveLength(1);
    expect(deliveryEvents[0].payload).toMatchObject({
      entryKind: "delivery",
      deliveryCategory: "food",
    });
  });
});

describe("delivery-service — listDeliveries", () => {
  beforeEach(() => {
    clearAuditLog();
  });

  it("returns delivery entries from DB", async () => {
    const rows = [
      {
        id: "d-001",
        visitor_name: "Jumia Rider",
        host: "Reception",
        unit: "18B",
        plate: "KDA-123",
        delivery_category: "parcel",
        method: "walk-in",
        guard_id: GUARD_ID,
        created_at: new Date("2024-06-01T09:30:00Z"),
      },
    ];
    const { db } = makeMockDB({ deliveryRows: rows });
    const result = await listDeliveries(db);

    expect(result.entries).toHaveLength(1);
    expect(result.count).toBe(1);
    expect(result.entries[0].visitorName).toBe("Jumia Rider");
    expect(result.entries[0].deliveryCategory).toBe("parcel");
    expect(result.entries[0].createdAt).toBe("2024-06-01T09:30:00.000Z");
    expect(result.traceId).toMatch(/^trace-/);
  });

  it("returns empty list when no deliveries exist", async () => {
    const { db } = makeMockDB({ deliveryRows: [] });
    const result = await listDeliveries(db);

    expect(result.entries).toHaveLength(0);
    expect(result.count).toBe(0);
  });

  it("maps string created_at correctly", async () => {
    const rows = [
      {
        id: "d-002",
        visitor_name: "Bolt Driver",
        host: "Reception",
        unit: "07C",
        plate: null,
        delivery_category: "ride",
        method: "walk-in",
        guard_id: GUARD_ID,
        created_at: "2024-06-01T10:15:00.000Z",
      },
    ];
    const { db } = makeMockDB({ deliveryRows: rows });
    const result = await listDeliveries(db);

    expect(result.entries[0].createdAt).toBe("2024-06-01T10:15:00.000Z");
  });
});
