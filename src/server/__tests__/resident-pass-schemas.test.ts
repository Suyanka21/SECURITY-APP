// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ResidentIssuePassSchema } from "../validation/resident-schemas";
import {
  RESIDENT_DEFAULT_PASS_TTL_HOURS,
  RESIDENT_MAX_PASS_TTL_HOURS,
} from "../services/resident-pass-service";

describe("ResidentIssuePassSchema", () => {
  it("strips host, unit, phone, role and any identity fields", () => {
    const parsed = ResidentIssuePassSchema.parse({
      visitorName: "  John ",
      host: "Someone else",
      unit: "Z99",
      phone: "+254700000000",
      role: "admin",
      residentId: "x",
      unitId: "y",
    });
    expect(parsed).toEqual({
      visitorName: "John",
      plate: null,
      ttlHours: RESIDENT_DEFAULT_PASS_TTL_HOURS,
    });
  });

  it("caps ttlHours at 48 and rejects 0 / fractions", () => {
    expect(RESIDENT_MAX_PASS_TTL_HOURS).toBe(48);
    expect(ResidentIssuePassSchema.safeParse({ visitorName: "A", ttlHours: 48 }).success).toBe(true);
    for (const ttlHours of [49, 168, 0, 1.5, -1]) {
      expect(ResidentIssuePassSchema.safeParse({ visitorName: "A", ttlHours }).success).toBe(false);
    }
  });

  it("upper-cases the plate and rejects empty/over-long names", () => {
    expect(ResidentIssuePassSchema.parse({ visitorName: "A", plate: "kca 1a" }).plate).toBe("KCA 1A");
    expect(ResidentIssuePassSchema.safeParse({ visitorName: "  " }).success).toBe(false);
    expect(ResidentIssuePassSchema.safeParse({ visitorName: "x".repeat(121) }).success).toBe(false);
    expect(ResidentIssuePassSchema.safeParse({}).success).toBe(false);
  });
});
