/**
 * GatePass — Resident Portal R3 validation and status helpers.
 * Source: src/docs/specs/resident-portal.md §3.4.
 */

import { describe, it, expect } from "vitest";

import {
  CreateRegistrationSchema,
  RegistrationParamsSchema,
} from "../validation/resident-schemas";
import { compactPlate } from "../services/auto-approval-service";
import {
  registrationStatus,
  registrationVisitorName,
} from "../services/unit-registration-service";
import { AuditQuerySchema } from "../validation/audit-schemas";

const DAY_MS = 24 * 3600 * 1000;

describe("CreateRegistrationSchema", () => {
  it("accepts a person with a trimmed name and strips everything else", () => {
    const r = CreateRegistrationSchema.safeParse({
      kind: "person",
      label: "  Mary Njeri ",
      host: "Someone",
      unit: "B-9",
      notes: "x",
      watchFlag: true,
      residentId: "r",
      plate: "KDA 1",
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data).toEqual({ kind: "person", label: "Mary Njeri" });
  });

  it("requires a plate for a vehicle and uppercases it", () => {
    expect(CreateRegistrationSchema.safeParse({ kind: "vehicle", label: "White Vitz" }).success).toBe(false);
    expect(CreateRegistrationSchema.safeParse({ kind: "vehicle", label: "White Vitz", plate: " - " }).success).toBe(false);
    const ok = CreateRegistrationSchema.safeParse({ kind: "vehicle", label: "White Vitz", plate: " kda 123x " });
    expect(ok.success && ok.data).toEqual({ kind: "vehicle", label: "White Vitz", plate: "KDA 123X" });
  });

  it("rejects unknown kinds, empty and over-long labels", () => {
    expect(CreateRegistrationSchema.safeParse({ kind: "pet", label: "Rex" }).success).toBe(false);
    expect(CreateRegistrationSchema.safeParse({ kind: "person", label: "   " }).success).toBe(false);
    expect(CreateRegistrationSchema.safeParse({ kind: "person", label: "x".repeat(61) }).success).toBe(false);
    expect(
      CreateRegistrationSchema.safeParse({ kind: "vehicle", label: "Car", plate: "X".repeat(13) }).success,
    ).toBe(false);
  });

  it("registration ids must be UUIDs", () => {
    expect(RegistrationParamsSchema.safeParse({ id: "not-a-uuid" }).success).toBe(false);
    expect(RegistrationParamsSchema.safeParse({ id: "8d1a6b0e-3b1f-4c55-9a43-0c4c3f5b8a11" }).success).toBe(true);
  });
});

describe("helpers", () => {
  it("compactPlate ignores case, spaces and separators", () => {
    expect(compactPlate("KDA 123X")).toBe("KDA123X");
    expect(compactPlate("kda-123x")).toBe("KDA123X");
    expect(compactPlate(" - ")).toBe("");
  });

  it("registrationStatus: disabled / expired / renew_due (<14 days) / active", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const at = (days: number) => new Date(now.getTime() + days * DAY_MS);
    expect(registrationStatus(false, at(60), now)).toBe("disabled");
    expect(registrationStatus(true, at(-1), now)).toBe("expired");
    expect(registrationStatus(true, at(13.9), now)).toBe("renew_due");
    expect(registrationStatus(true, at(14), now)).toBe("active");
    expect(registrationStatus(true, at(90), now)).toBe("active");
  });

  it("vehicle rules carry the plate in their visitor name", () => {
    expect(registrationVisitorName({ kind: "person", label: "Mary" })).toBe("Mary");
    expect(registrationVisitorName({ kind: "vehicle", label: "White Vitz", plate: "KDA 123X" })).toBe(
      "White Vitz (KDA 123X)",
    );
  });

  it("the audit filter accepts the three registration event types", () => {
    for (const t of [
      "resident_registration_created",
      "resident_registration_removed",
      "resident_registration_renewed",
    ]) {
      expect(AuditQuerySchema.safeParse({ eventType: t }).success).toBe(true);
    }
  });
});
