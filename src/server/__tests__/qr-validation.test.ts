// @vitest-environment node
/**
 * GatePass — QR Validation Tests (TDD)
 *
 * Source: gatepass-api-contract.md §3.1
 * Tests Zod schema validation for POST /api/entries/qr/validate
 */

import { describe, it, expect } from "vitest";
import { validateQrRequest, QrErrorCodes } from "../validation/qr-schemas";

// ─── Test Helpers ────────────────────────────────────────────────────────────

function validQrRequest() {
  return {
    qrToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.valid-token-payload",
    // [C3 FIX] guardId removed — now comes from verified JWT token
    scannedAt: new Date().toISOString(),
  };
}

// ─── Validation Tests ────────────────────────────────────────────────────────

describe("QR Validation Schema", () => {
  // Test 1: Valid QR request passes
  it("accepts a valid QR validation request", () => {
    const result = validateQrRequest(validQrRequest());
    expect(result.success).toBe(true);
  });

  // Test 2: Empty qrToken → QR_MALFORMED
  // Source: contract §3.1 — "400 QR_MALFORMED: Token cannot be parsed"
  it("rejects empty qrToken with QR_MALFORMED", () => {
    const input = { ...validQrRequest(), qrToken: "" };
    const result = validateQrRequest(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe(QrErrorCodes.QR_MALFORMED);
      expect(result.field).toBe("qrToken");
    }
  });

  // Test 3: QR token exceeds 512 chars
  // Source: contract §3.1 — "max 512 chars"
  it("rejects qrToken exceeding 512 characters", () => {
    const input = { ...validQrRequest(), qrToken: "A".repeat(513) };
    const result = validateQrRequest(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe(QrErrorCodes.QR_MALFORMED);
    }
  });

  // Test 4: guardId in body is IGNORED by schema
  // Source: TRUSTLESS-AUDIT-REPORT [C3] — guardId handled by auth middleware
  it("ignores guardId in request body (handled by auth middleware)", () => {
    const input = { ...validQrRequest(), guardId: "injected-fake-id" };
    const result = validateQrRequest(input);

    // Schema should still pass — guardId is not validated here
    expect(result.success).toBe(true);
  });

  // Test 5: Missing scannedAt
  it("rejects missing scannedAt", () => {
    const { scannedAt, ...input } = validQrRequest();
    const result = validateQrRequest(input);

    expect(result.success).toBe(false);
  });

  // Test 6: scannedAt more than 5 minutes in the future
  // Source: contract §3.1 — "not more than 5 minutes in the future"
  it("rejects scannedAt more than 5 minutes in the future", () => {
    const tenMinutesFromNow = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const input = { ...validQrRequest(), scannedAt: tenMinutesFromNow };
    const result = validateQrRequest(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.field).toBe("scannedAt");
    }
  });
});
