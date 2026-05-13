// @vitest-environment node
/**
 * GatePass — Authorization Service Tests (TDD)
 *
 * Source: GATEPASS DEFINITION §3 — "Authorization Layer"
 * Tests all 4 decision branches + denial paths.
 */

import { describe, it, expect } from "vitest";
import { resolveAuthorization } from "../services/authorization-service";
import type { AuthorizationInput } from "../services/authorization-service";

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("AuthorizationService.resolveAuthorization", () => {
  const guardId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

  // ── QR Path ──────────────────────────────────────────────────────────────

  // Test 1: QR with valid preApprovalId → approved
  it("approves QR entry with valid preApprovalId", () => {
    const input: AuthorizationInput = {
      method: "qr",
      guardId,
      preApprovalId: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
    };

    const decision = resolveAuthorization(input);

    expect(decision.outcome).toBe("approved");
    expect(decision.decisionType).toBe("qr");
    expect(decision.preApprovalId).toBe("b2c3d4e5-f6a7-8901-bcde-f12345678901");
    expect(decision.guardId).toBe(guardId);
    expect(decision.traceId).toMatch(/^trace-/);
    expect(decision.decidedAt).toBeDefined();
  });

  // Test 2: QR without preApprovalId → denied
  it("denies QR entry without preApprovalId", () => {
    const input: AuthorizationInput = {
      method: "qr",
      guardId,
      // preApprovalId intentionally omitted
    };

    const decision = resolveAuthorization(input);

    expect(decision.outcome).toBe("denied");
    expect(decision.decisionType).toBe("qr");
    expect(decision.reason).toContain("Pre-approval ID is required");
  });

  // ── Walk-In Path ─────────────────────────────────────────────────────────

  // Test 3: Walk-in → guard-decided approval
  it("approves walk-in entry as guard-decided", () => {
    const input: AuthorizationInput = {
      method: "walk-in",
      guardId,
    };

    const decision = resolveAuthorization(input);

    expect(decision.outcome).toBe("approved");
    expect(decision.decisionType).toBe("walk-in");
    expect(decision.reason).toContain("Guard-authorized");
    expect(decision.preApprovalId).toBeNull();
    expect(decision.guardId).toBe(guardId);
  });

  // ── Override Path ────────────────────────────────────────────────────────

  // Test 4: Override with valid reason → approved
  it("approves override with sufficient reason", () => {
    const input: AuthorizationInput = {
      method: "override",
      guardId,
      reason: "Emergency maintenance required for unit plumbing",
    };

    const decision = resolveAuthorization(input);

    expect(decision.outcome).toBe("approved");
    expect(decision.decisionType).toBe("override");
    expect(decision.reason).toBe("Emergency maintenance required for unit plumbing");
  });

  // Test 5: Override with short reason → denied
  it("denies override with reason shorter than 8 chars", () => {
    const input: AuthorizationInput = {
      method: "override",
      guardId,
      reason: "short",
    };

    const decision = resolveAuthorization(input);

    expect(decision.outcome).toBe("denied");
    expect(decision.decisionType).toBe("override");
    expect(decision.reason).toContain("too short");
  });

  // Test 6: Override with whitespace-only reason → denied
  it("denies override with whitespace-only reason", () => {
    const input: AuthorizationInput = {
      method: "override",
      guardId,
      reason: "        ",
    };

    const decision = resolveAuthorization(input);

    expect(decision.outcome).toBe("denied");
    expect(decision.reason).toContain("too short");
  });

  // ── Recognized Path ──────────────────────────────────────────────────────

  // Test 7: Recognized visitor → guard-confirmed approval
  it("approves recognized visitor as guard-confirmed", () => {
    const input: AuthorizationInput = {
      method: "recognized",
      guardId,
    };

    const decision = resolveAuthorization(input);

    expect(decision.outcome).toBe("approved");
    expect(decision.decisionType).toBe("recognized");
    expect(decision.reason).toContain("recognized visitor");
    expect(decision.guardId).toBe(guardId);
  });

  // ── Cross-Cutting ────────────────────────────────────────────────────────

  // Test 8: Every decision has traceId (no implicit approvals without trace)
  it("generates unique traceId for every decision", () => {
    const methods = ["qr", "walk-in", "override", "recognized"] as const;
    const traceIds = new Set<string>();

    for (const method of methods) {
      const input: AuthorizationInput = {
        method,
        guardId,
        preApprovalId: method === "qr" ? "some-id" : undefined,
        reason: method === "override" ? "Valid reason for override entry" : undefined,
      };

      const decision = resolveAuthorization(input);

      expect(decision.traceId).toMatch(/^trace-/);
      expect(decision.decidedAt).toBeDefined();
      traceIds.add(decision.traceId);
    }

    // All 4 traceIds should be unique
    expect(traceIds.size).toBe(4);
  });
});
