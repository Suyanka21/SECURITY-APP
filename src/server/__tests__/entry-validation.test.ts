// @vitest-environment node
/**
 * GatePass — Entry Validation Tests (TDD: RED → GREEN)
 *
 * Source: gatepass-api-contract.md §3.2 — Validation Rules + Error Responses
 * Each test maps to a specific contract requirement.
 *
 * TDD Skill: Tests written FIRST. Each test reads like a specification.
 * DAMP over DRY — each test is self-contained and readable.
 */

import { describe, it, expect } from "vitest";
import { validateCreateEntry, EntryErrorCodes } from "../validation/entry-schemas";

// ─── Test Helpers ────────────────────────────────────────────────────────────

/** Returns a valid walk-in entry request body — modify specific fields per test */
function validWalkInEntry() {
  return {
    visitorName: "Maya Chen",
    host: "A. Okafor",
    unit: "18B",
    plate: "LND-482",
    reason: "Visiting host",
    method: "walk-in" as const,
    // [C3 FIX] guardId removed — now comes from verified JWT token
    createdAt: new Date().toISOString(),
  };
}

/** Returns a valid override entry request body */
function validOverrideEntry() {
  return {
    ...validWalkInEntry(),
    method: "override" as const,
    reason: "Emergency maintenance required for unit plumbing",
  };
}

// ─── Validation Tests ────────────────────────────────────────────────────────

describe("CreateEntry Validation", () => {
  // ── Missing Required Fields ──────────────────────────────────────────────

  // Test 1: Missing visitorName
  // Source: contract §3.2 — "422 VISITOR_NAME_REQUIRED: visitorName empty/whitespace"
  it("rejects missing visitorName with VISITOR_NAME_REQUIRED", () => {
    const input = { ...validWalkInEntry(), visitorName: "" };
    const result = validateCreateEntry(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe(EntryErrorCodes.VISITOR_NAME_REQUIRED);
      expect(result.field).toBe("visitorName");
    }
  });

  // Test 2: Whitespace-only visitorName
  // Source: contract §3.2 — "Non-empty after trim"
  // Security: prevents whitespace-only bypass
  it("rejects whitespace-only visitorName with VISITOR_NAME_REQUIRED", () => {
    const input = { ...validWalkInEntry(), visitorName: "   " };
    const result = validateCreateEntry(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe(EntryErrorCodes.VISITOR_NAME_REQUIRED);
    }
  });

  // Test 3: Missing host
  // Source: contract §3.2 — "422 HOST_REQUIRED: host empty/whitespace"
  it("rejects missing host with HOST_REQUIRED", () => {
    const input = { ...validWalkInEntry(), host: "" };
    const result = validateCreateEntry(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe(EntryErrorCodes.HOST_REQUIRED);
      expect(result.field).toBe("host");
    }
  });

  // Test 4: Missing unit
  // Source: contract §3.2 — "422 UNIT_REQUIRED: unit empty/whitespace"
  it("rejects missing unit with UNIT_REQUIRED", () => {
    const input = { ...validWalkInEntry(), unit: "" };
    const result = validateCreateEntry(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe(EntryErrorCodes.UNIT_REQUIRED);
      expect(result.field).toBe("unit");
    }
  });

  // Test 5: guardId in body is IGNORED by schema
  // Source: TRUSTLESS-AUDIT-REPORT [C3] — guardId must come from auth token
  it("ignores guardId in request body (handled by auth middleware)", () => {
    const input = { ...validWalkInEntry(), guardId: "injected-fake-id" };
    const result = validateCreateEntry(input);

    // Schema should still pass — guardId is not validated here
    expect(result.success).toBe(true);
    // guardId from body should NOT appear in validated data
    if (result.success) {
      expect((result.data as any).guardId).toBeUndefined();
    }
  });

  // ── Override Method Validation ───────────────────────────────────────────

  // Test 6: Override with short reason
  // Source: contract §3.2 — "422 OVERRIDE_REASON_TOO_SHORT: method=override AND reason < 8 chars"
  it("rejects override with reason shorter than 8 chars", () => {
    const input = { ...validOverrideEntry(), reason: "short" };
    const result = validateCreateEntry(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe(EntryErrorCodes.OVERRIDE_REASON_TOO_SHORT);
      expect(result.field).toBe("reason");
    }
  });

  // Test 7: Override with 8 spaces (trim attack)
  // Security: whitespace-only reason must be rejected after trimming
  it("rejects override with whitespace-only reason (trim attack)", () => {
    const input = { ...validOverrideEntry(), reason: "        " };
    const result = validateCreateEntry(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe(EntryErrorCodes.OVERRIDE_REASON_TOO_SHORT);
    }
  });

  // ── Invalid Enum Values ──────────────────────────────────────────────────

  // Test 8: Invalid method value
  // Source: contract §3.2 — "Must be one of: qr, walk-in, override, recognized"
  it("rejects invalid method value", () => {
    const input = { ...validWalkInEntry(), method: "teleport" };
    const result = validateCreateEntry(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe(EntryErrorCodes.VALIDATION_ERROR);
      expect(result.field).toBe("method");
    }
  });

  // ── QR Method Cross-Field Validation ─────────────────────────────────────

  // Test 9: QR method without preApprovalId
  // Source: contract §3.2 — "Required when method = qr"
  it("rejects QR method without preApprovalId", () => {
    const input = {
      ...validWalkInEntry(),
      method: "qr" as const,
      // preApprovalId intentionally omitted
    };
    const result = validateCreateEntry(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe(EntryErrorCodes.PRE_APPROVAL_REQUIRED);
      expect(result.field).toBe("preApprovalId");
    }
  });

  // ── Field Length Validation ──────────────────────────────────────────────

  // Test 10: Plate exceeds 20 chars
  // Source: contract §3.2 — "Optional, max 20 chars if provided"
  it("rejects plate exceeding 20 characters", () => {
    const input = { ...validWalkInEntry(), plate: "A".repeat(21) };
    const result = validateCreateEntry(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.field).toBe("plate");
    }
  });

  // ── Happy Paths ──────────────────────────────────────────────────────────

  // Test 11: Valid walk-in entry passes
  it("accepts a valid walk-in entry", () => {
    const input = validWalkInEntry();
    const result = validateCreateEntry(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.visitorName).toBe("Maya Chen");
      expect(result.data.method).toBe("walk-in");
      // [C3 FIX] guardId no longer in schema output
    }
  });

  // Test 12: Valid override entry passes (reason ≥ 8 chars)
  it("accepts a valid override entry with sufficient reason", () => {
    const input = validOverrideEntry();
    const result = validateCreateEntry(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.method).toBe("override");
      expect(result.data.reason.trim().length).toBeGreaterThanOrEqual(8);
    }
  });

  // ── Edge Cases ───────────────────────────────────────────────────────────

  // Test: Valid QR entry with preApprovalId
  it("accepts QR entry with valid preApprovalId", () => {
    const input = {
      ...validWalkInEntry(),
      method: "qr" as const,
      preApprovalId: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
    };
    const result = validateCreateEntry(input);

    expect(result.success).toBe(true);
  });

  // Test: Null plate is acceptable
  it("accepts null plate value", () => {
    const input = { ...validWalkInEntry(), plate: null };
    const result = validateCreateEntry(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.plate).toBeNull();
    }
  });

  // Test: Trims whitespace from visitorName
  it("trims whitespace from visitorName", () => {
    const input = { ...validWalkInEntry(), visitorName: "  Maya Chen  " };
    const result = validateCreateEntry(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.visitorName).toBe("Maya Chen");
    }
  });

  // ── Timestamp Validation [H4 FIX] ──────────────────────────────────────

  // Test 16: Valid recent timestamp passes
  // Source: contract §3.2 — "Valid ISO 8601, max 24 hours old"
  it("accepts a valid recent timestamp", () => {
    const input = { ...validWalkInEntry(), createdAt: new Date().toISOString() };
    const result = validateCreateEntry(input);

    expect(result.success).toBe(true);
  });

  // Test 17: Timestamp older than 24 hours → TIMESTAMP_TOO_OLD
  // Source: TRUSTLESS-AUDIT-REPORT [H4] — "createdAt lacks 24-hour backdating protection"
  // FAILURE CHECK: Can backdated entries still pass? → NO
  it("rejects timestamp older than 24 hours with TIMESTAMP_TOO_OLD", () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const input = { ...validWalkInEntry(), createdAt: twoDaysAgo };
    const result = validateCreateEntry(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe(EntryErrorCodes.TIMESTAMP_TOO_OLD);
      expect(result.field).toBe("createdAt");
    }
  });

  // Test 18: Timestamp in the future → TIMESTAMP_IN_FUTURE
  // Source: Security-and-Hardening — "Prevent future-dated injection"
  it("rejects timestamp in the future with TIMESTAMP_IN_FUTURE", () => {
    const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const input = { ...validWalkInEntry(), createdAt: oneHourFromNow };
    const result = validateCreateEntry(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe(EntryErrorCodes.TIMESTAMP_IN_FUTURE);
      expect(result.field).toBe("createdAt");
    }
  });
});
