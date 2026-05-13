// @vitest-environment node
/**
 * GatePass — Override Service Tests (TDD)
 *
 * Source: GATEPASS DEFINITION §2D, §3
 * Source: gatepass-api-contract.md §3.2 (method=override)
 *
 * Security-and-Hardening: Tests prove every failure path is blocked.
 * TDD: Tests written FIRST, then implementation verified.
 *
 * [C4/S1 FIX] All calls now async — createOverrideEvent awaits audit persistence.
 *
 * FAILURE CHECK verification:
 * - Can override occur without logging? → Tests 7, 8, 9 prove NO
 * - Can reason be bypassed? → Tests 1, 2, 3 prove NO
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createOverrideEvent,
  OverrideError,
} from "../services/override-service";
import {
  clearAuditLog,
  getAuditLog,
  getAuditEventsByType,
} from "../services/audit-logger";

// ─── Test Setup ──────────────────────────────────────────────────────────────

beforeEach(() => {
  clearAuditLog();
});

function validOverrideInput() {
  return {
    entryId: "e1f2a3b4-c5d6-7890-abcd-ef1234567890",
    guardId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    reason: "Emergency maintenance required for unit plumbing",
    traceId: "trace-test-001",
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("OverrideService — Hard Rule Enforcement", () => {
  // ── HARD RULE 1: Override MUST include reason ──────────────────────────

  // Test 1: Short reason → rejected
  it("rejects override with reason shorter than 8 characters", async () => {
    const input = { ...validOverrideInput(), reason: "short" };

    await expect(createOverrideEvent(input)).rejects.toThrow(OverrideError);
    await expect(createOverrideEvent(input)).rejects.toThrow("at least 8 characters");
  });

  // Test 2: Empty reason → rejected
  it("rejects override with empty reason", async () => {
    const input = { ...validOverrideInput(), reason: "" };

    try {
      await createOverrideEvent(input);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OverrideError);
      expect((err as OverrideError).code).toBe("OVERRIDE_REASON_TOO_SHORT");
      expect((err as OverrideError).field).toBe("reason");
    }
  });

  // Test 3: Whitespace-only reason → rejected (trim attack)
  it("rejects override with whitespace-only reason", async () => {
    const input = { ...validOverrideInput(), reason: "         " };

    try {
      await createOverrideEvent(input);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OverrideError);
      expect((err as OverrideError).code).toBe("OVERRIDE_REASON_TOO_SHORT");
    }
  });

  // Test 4: Valid reason (exactly 8 chars) → accepted
  it("accepts override with exactly 8 character reason", async () => {
    const input = { ...validOverrideInput(), reason: "12345678" };
    const result = await createOverrideEvent(input);

    expect(result.reason).toBe("12345678");
    expect(result.auditEventEmitted).toBe(true);
  });

  // ── HARD RULE 2: Override MUST include guard_id ────────────────────────

  // Test 5: Missing guard_id → rejected
  it("rejects override without guard_id", async () => {
    const input = { ...validOverrideInput(), guardId: "" };

    try {
      await createOverrideEvent(input);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OverrideError);
      expect((err as OverrideError).code).toBe("GUARD_ID_MISSING");
    }
  });

  // ── HARD RULE 4: Override CANNOT exist without entry linkage ───────────

  // Test 6: Missing entry_id → rejected
  it("rejects override without entry linkage", async () => {
    const input = { ...validOverrideInput(), entryId: "" };

    try {
      await createOverrideEvent(input);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OverrideError);
      expect((err as OverrideError).code).toBe("ENTRY_LINKAGE_MISSING");
    }
  });

  // ── HARD RULE 3: Override MUST generate audit event ────────────────────

  // Test 7: Successful override emits audit event
  it("emits override_authorized audit event on success", async () => {
    const input = validOverrideInput();
    const result = await createOverrideEvent(input);

    expect(result.auditEventEmitted).toBe(true);

    const events = getAuditEventsByType("override_authorized");
    expect(events.length).toBe(1);
    expect(events[0].guardId).toBe(input.guardId);
    expect(events[0].traceId).toBe(input.traceId);
    expect(events[0].payload).toMatchObject({
      entryId: input.entryId,
      reason: input.reason,
    });
  });

  // Test 8: Failed override (bad reason) STILL emits rejection audit event
  it("emits override_rejected audit event on reason failure", async () => {
    const input = { ...validOverrideInput(), reason: "short" };

    try {
      await createOverrideEvent(input);
    } catch {
      // Expected
    }

    const events = getAuditEventsByType("override_rejected");
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].payload).toMatchObject({
      reason: "REASON_TOO_SHORT",
    });
  });

  // Test 9: Failed override (no guard) STILL emits rejection audit event
  it("emits override_rejected audit event on guard failure", async () => {
    const input = { ...validOverrideInput(), guardId: "" };

    try {
      await createOverrideEvent(input);
    } catch {
      // Expected
    }

    const events = getAuditEventsByType("override_rejected");
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].payload).toMatchObject({
      reason: "GUARD_ID_MISSING",
    });
  });

  // ── Cross-cutting ─────────────────────────────────────────────────────

  // Test 10: Override result contains all required fields
  it("returns complete OverrideResult with all audit fields", async () => {
    const input = validOverrideInput();
    const result = await createOverrideEvent(input);

    expect(result.id).toBeDefined();
    expect(result.id.length).toBeGreaterThan(0);
    expect(result.entryId).toBe(input.entryId);
    expect(result.guardId).toBe(input.guardId);
    expect(result.reason).toBe(input.reason);
    expect(result.createdAt).toBeDefined();
    expect(result.traceId).toBe(input.traceId);
    expect(result.auditEventEmitted).toBe(true);
  });

  // Test 11: Reason is trimmed before storage (no padding bypass)
  it("trims reason whitespace before validation and storage", async () => {
    const input = {
      ...validOverrideInput(),
      reason: "   Emergency plumbing fix needed   ",
    };
    const result = await createOverrideEvent(input);

    expect(result.reason).toBe("Emergency plumbing fix needed");
  });

  // Test 12: Multiple overrides generate unique IDs
  it("generates unique override IDs for each event", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const result = await createOverrideEvent(validOverrideInput());
      ids.add(result.id);
    }
    expect(ids.size).toBe(5);
  });
});

describe("AuditLogger — Override Integration", () => {
  // Test 13: Audit log accumulates events
  it("accumulates override events in audit log", async () => {
    await createOverrideEvent(validOverrideInput());
    await createOverrideEvent(validOverrideInput());

    const log = getAuditLog();
    expect(log.length).toBe(2);
    expect(log.every((e) => e.type === "override_authorized")).toBe(true);
  });

  // Test 14: clearAuditLog resets state
  it("clears audit log for test isolation", async () => {
    await createOverrideEvent(validOverrideInput());
    expect(getAuditLog().length).toBe(1);

    clearAuditLog();
    expect(getAuditLog().length).toBe(0);
  });
});
