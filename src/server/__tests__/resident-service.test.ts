// @vitest-environment node
/**
 * GatePass — Resident Portal R1: pure helpers + input contracts.
 *
 * Source: src/docs/specs/resident-portal.md §2.4 (claim codes), §3 (inputs).
 *
 * DB-backed behaviour (claim lifecycle, lockout, atomicity, scoping, cross-
 * role refusals) is proven against real Postgres over real HTTP in
 * __tests__/integration/resident-portal.integration.test.ts. This file pins
 * the parts that must hold independently of any database:
 *   - codes are unambiguous, normalised the way a human types them, and
 *     never stored raw (HMAC with the PIN pepper — a DB leak alone cannot
 *     be replayed as a code)
 *   - the client-facing schemas accept ONLY the fields the spec allows
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  CLAIM_CODE_LENGTH,
  formatClaimCode,
  generateClaimCode,
  hashClaimCode,
  normalizeClaimCode,
  MAX_CLAIM_ATTEMPTS,
  MAX_CLAIM_CODE_TTL_HOURS,
} from "../services/resident-service";
import {
  ClaimUnitSchema,
  CreateUnitSchema,
  IssueClaimCodeSchema,
} from "../validation/resident-schemas";

beforeAll(() => {
  if (!process.env.PIN_PEPPER) process.env.PIN_PEPPER = "unit-test-pepper-not-for-production";
});

describe("claim-code helpers", () => {
  it("generates 8-char codes from the unambiguous alphabet (no I, L, O, U)", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateClaimCode();
      expect(code).toHaveLength(CLAIM_CODE_LENGTH);
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/);
    }
  });

  it("normalises what a resident types: lowercase, dashes, spaces", () => {
    expect(normalizeClaimCode(" ab12-cd34 ")).toBe("AB12CD34");
    expect(normalizeClaimCode("AB12 CD34")).toBe("AB12CD34");
    expect(formatClaimCode("AB12CD34")).toBe("AB12-CD34");
    expect(normalizeClaimCode(formatClaimCode("AB12CD34"))).toBe("AB12CD34");
  });

  it("hashes are keyed (HMAC), deterministic, and never contain the code", () => {
    const h1 = hashClaimCode("AB12CD34");
    const h2 = hashClaimCode("AB12CD34");
    const other = hashClaimCode("AB12CD35");
    expect(h1).toBe(h2);
    expect(h1).not.toBe(other);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).not.toContain("AB12CD34");
    expect(h1.toUpperCase()).not.toContain("AB12CD34");
  });

  it("policy constants match the approved spec (§10: 5 attempts, ≤7-day codes)", () => {
    expect(MAX_CLAIM_ATTEMPTS).toBe(5);
    expect(MAX_CLAIM_CODE_TTL_HOURS).toBe(7 * 24);
  });
});

describe("resident input contracts — clients cannot name identity, unit, host or role", () => {
  it("ClaimUnitSchema accepts only { code, displayName } and drops everything else", () => {
    const parsed = ClaimUnitSchema.parse({
      code: " ab12-cd34 ",
      displayName: "  Amina ",
      unitId: "attacker-unit",
      unit: "PENTHOUSE",
      host: "someone",
      phoneE164: "+254700000000",
      supabaseUserId: "x",
      role: "admin",
    });
    expect(parsed).toEqual({ code: "ab12-cd34", displayName: "Amina" });
    expect(Object.keys(parsed)).toEqual(["code", "displayName"]);
  });

  it("ClaimUnitSchema refuses empty/short codes and empty names", () => {
    expect(ClaimUnitSchema.safeParse({ code: "AB12", displayName: "A" }).success).toBe(false);
    expect(ClaimUnitSchema.safeParse({ code: "AB12-CD34", displayName: "   " }).success).toBe(false);
    expect(ClaimUnitSchema.safeParse({ displayName: "A" }).success).toBe(false);
  });

  it("CreateUnitSchema accepts a trimmed label only", () => {
    expect(CreateUnitSchema.parse({ label: "  18B ", isActive: false })).toEqual({ label: "18B" });
    expect(CreateUnitSchema.safeParse({ label: "" }).success).toBe(false);
    expect(CreateUnitSchema.safeParse({ label: "x".repeat(33) }).success).toBe(false);
  });

  it("IssueClaimCodeSchema defaults ttlHours to 72 and caps it at 168", () => {
    expect(IssueClaimCodeSchema.parse({})).toEqual({ ttlHours: 72 });
    expect(IssueClaimCodeSchema.parse({ ttlHours: 168 })).toEqual({ ttlHours: 168 });
    expect(IssueClaimCodeSchema.safeParse({ ttlHours: 169 }).success).toBe(false);
    expect(IssueClaimCodeSchema.safeParse({ ttlHours: 0 }).success).toBe(false);
    expect(IssueClaimCodeSchema.safeParse({ ttlHours: 1.5 }).success).toBe(false);
  });
});
