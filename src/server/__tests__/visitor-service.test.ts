// @vitest-environment node
/**
 * GatePass — Visitor Service Tests (TDD)
 *
 * Source: gatepass-api-contract.md §3.4
 * Tests visitor lookup, search, pagination, and guard verification.
 */

import { describe, it, expect, vi } from "vitest";
import { validateVisitorParams, VisitorErrorCodes } from "../validation/visitor-schemas";
import { getRecognizedVisitors } from "../services/visitor-service";
import { ServiceError } from "../services/entry-service";
import { guards } from "@/db/schema";

// ─── Mock DB Factory ─────────────────────────────────────────────────────────

function createMockDB(overrides: {
  guardResult?: { id: string; isActive: boolean }[];
  executeResults?: { rows: unknown[] }[];
} = {}) {
  const {
    guardResult = [{ id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", isActive: true }],
    executeResults = [
      { rows: [
        { name: "Maya Chen", host: "A. Okafor", unit: "18B", plate: "LND-482", last_seen: new Date().toISOString(), visit_count: 5, has_qr_entry: false },
        { name: "John Doe", host: "B. Smith", unit: "22A", plate: null, last_seen: new Date().toISOString(), visit_count: 1, has_qr_entry: true },
      ]},
      { rows: [{ total: 2 }] },
    ],
  } = overrides;

  let executeCallCount = 0;

  return {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => ({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockImplementation(() => {
            if (table === guards) return Promise.resolve(guardResult);
            return Promise.resolve([]);
          }),
        }),
      })),
    })),
    execute: vi.fn().mockImplementation(() => {
      const result = executeResults[executeCallCount] ?? { rows: [] };
      executeCallCount++;
      return Promise.resolve(result);
    }),
    query: {},
  };
}

// ─── Validation Tests ────────────────────────────────────────────────────────

describe("Visitor Validation", () => {
  // Test 1: Valid params pass (without guardId — now from auth)
  it("accepts valid query parameters", () => {
    const result = validateVisitorParams({
      // [C3 FIX] guardId removed — now comes from auth middleware
      q: "Maya",
      page: 1,
      pageSize: 20,
    });
    expect(result.success).toBe(true);
  });

  // Test 2: guardId in query is IGNORED by schema
  // Source: TRUSTLESS-AUDIT-REPORT [C3] — guardId handled by auth middleware
  it("ignores guardId in query params (handled by auth middleware)", () => {
    const result = validateVisitorParams({ guardId: "injected-fake-id", q: "Maya" });
    expect(result.success).toBe(true);
  });

  // Test 3: pageSize > 50 clamped
  it("rejects pageSize greater than 50", () => {
    const result = validateVisitorParams({
      pageSize: 100,
    });
    expect(result.success).toBe(false);
  });

  // Test 4: Defaults applied
  it("applies default page and pageSize", () => {
    const result = validateVisitorParams({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.pageSize).toBe(20);
      expect(result.data.q).toBe("");
    }
  });
});

// ─── Service Tests ───────────────────────────────────────────────────────────

describe("VisitorService.getRecognizedVisitors", () => {
  // Test 1: Returns paginated visitors
  it("returns paginated visitors with recognition tags", async () => {
    const db = createMockDB();
    const input = {
      guardId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      q: "",
      page: 1,
      pageSize: 20,
    };

    const { response, statusCode } = await getRecognizedVisitors(input, db);

    expect(statusCode).toBe(200);
    expect(response.visitors).toHaveLength(2);
    expect(response.visitors[0].name).toBe("Maya Chen");
    expect(response.visitors[0].recognition).toBe("frequent"); // 5 visits
    expect(response.visitors[1].recognition).toBe("pre-approved"); // has QR entry
    expect(response.pagination.page).toBe(1);
    expect(response.pagination.pageSize).toBe(20);
    expect(response.traceId).toMatch(/^trace-/);
  });

  // Test 2: Guard not found → GUARD_SESSION_EXPIRED
  it("throws GUARD_SESSION_EXPIRED when guard not found", async () => {
    const db = createMockDB({ guardResult: [] });

    try {
      await getRecognizedVisitors({
        guardId: "invalid-guard-id",
        q: "",
        page: 1,
        pageSize: 20,
      }, db);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe("GUARD_SESSION_EXPIRED");
      expect((err as ServiceError).statusCode).toBe(403);
    }
  });

  // Test 3: Empty result set
  it("returns empty visitors array when no matches", async () => {
    const db = createMockDB({
      executeResults: [
        { rows: [] },
        { rows: [{ total: 0 }] },
      ],
    });

    const { response } = await getRecognizedVisitors({
      guardId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      q: "nonexistent",
      page: 1,
      pageSize: 20,
    }, db);

    expect(response.visitors).toHaveLength(0);
    expect(response.pagination.totalItems).toBe(0);
    expect(response.pagination.totalPages).toBe(0);
  });
});
