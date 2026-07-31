import { describe, it, expect } from "vitest";
import {
  normalizePlate,
  getPlateComparison,
} from "../plate-verification";

describe("normalizePlate", () => {
  it("upper-cases and strips non-alphanumeric characters", () => {
    expect(normalizePlate("gr 1234-a")).toBe("GR1234A");
    expect(normalizePlate("GR1234A")).toBe("GR1234A");
    expect(normalizePlate("gr-1234 a")).toBe("GR1234A");
  });

  it("returns empty string for null/undefined/blank", () => {
    expect(normalizePlate(null)).toBe("");
    expect(normalizePlate(undefined)).toBe("");
    expect(normalizePlate("   ")).toBe("");
    expect(normalizePlate("-- --")).toBe("");
  });
});

describe("getPlateComparison", () => {
  it("returns 'no-expected' when there is no plate on file", () => {
    expect(getPlateComparison(null, "GR1234A")).toBe("no-expected");
    expect(getPlateComparison("", "GR1234A")).toBe("no-expected");
    expect(getPlateComparison("   ", "GR1234A")).toBe("no-expected");
  });

  it("returns 'no-observed' when a plate is on file but the form is blank", () => {
    expect(getPlateComparison("GR1234A", "")).toBe("no-observed");
    expect(getPlateComparison("GR1234A", null)).toBe("no-observed");
    expect(getPlateComparison("GR1234A", "  ")).toBe("no-observed");
  });

  it("returns 'match' when observed equals expected after normalisation", () => {
    expect(getPlateComparison("GR1234A", "GR1234A")).toBe("match");
    expect(getPlateComparison("GR1234A", "gr 1234-a")).toBe("match");
    expect(getPlateComparison("gr-1234 a", "GR1234A")).toBe("match");
  });

  it("returns 'mismatch' when observed differs from expected", () => {
    expect(getPlateComparison("GR1234A", "GR9999B")).toBe("mismatch");
    expect(getPlateComparison("GR1234A", "GR1234B")).toBe("mismatch");
  });
});
