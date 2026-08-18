// @vitest-environment node
/**
 * GatePass — Admin Account-Provisioning Service Tests (TDD)
 *
 * Source: src/docs/adr/0001-...md — Decision A1 (admin-provisioned accounts,
 *         server-controlled role, no public signup).
 * Source: src/server/services/account-service.ts
 * Source: Test-Driven-Development skill — behavior, not implementation.
 * Source: Trustless-System-Auditor — the cross-system failure (auth created,
 *         DB insert fails) MUST provably compensate; no orphaned auth users.
 *
 * The Supabase Admin API is injected as a dependency bundle so these tests
 * exercise the real branching without any network I/O.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  provisionAccount,
  generateTemporaryPassword,
  ServiceError,
  type DrizzleDB,
} from "../services/account-service";
import { SupabaseAdminError } from "../auth/supabase-admin";
import type { SupabaseAdminDeps } from "../auth/supabase-admin";
import * as auditLogger from "../services/audit-logger";
import { clearAuditLog, getAuditEventsByType } from "../services/audit-logger";

const ADMIN_GUARD_ID = "22222222-2222-4222-8222-222222222222";

// ─── Mock DB ─────────────────────────────────────────────────────────────────

interface MockDBOpts {
  existingBadges?: string[];
  failInsert?: "unique" | "generic" | false;
  emptyReturning?: boolean;
}

function makeMockDB(opts: MockDBOpts = {}) {
  const inserted: Record<string, unknown>[] = [];

  const selectMock = vi.fn().mockImplementation(() => ({
    from: vi.fn().mockImplementation(() => ({
      where: vi.fn().mockImplementation(async () => {
        // Badge pre-check: return a row per configured existing badge.
        return (opts.existingBadges ?? []).map((b, i) => ({
          id: `existing-${i}`,
          badgeNumber: b,
          name: "Existing",
          isActive: true,
          role: "guard",
          supabaseUserId: `auth-${i}`,
        }));
      }),
    })),
  }));

  const insertMock = vi.fn().mockImplementation(() => ({
    values: vi.fn().mockImplementation((row: Record<string, unknown>) => ({
      returning: vi.fn().mockImplementation(async () => {
        if (opts.failInsert === "unique") {
          throw new Error('duplicate key value violates unique constraint');
        }
        if (opts.failInsert === "generic") {
          throw new Error("some other DB failure");
        }
        if (opts.emptyReturning) return [];
        const r = {
          id: "new-guard-id",
          badgeNumber: row.badgeNumber,
          name: row.name,
          isActive: row.isActive,
          role: row.role,
          supabaseUserId: row.supabaseUserId,
        };
        inserted.push(r);
        return [r];
      }),
    })),
  }));

  return {
    db: { select: selectMock, insert: insertMock } as unknown as DrizzleDB,
    inserted,
  };
}

// ─── Mock Supabase Admin deps ─────────────────────────────────────────────────

function makeAdmin(
  over: Partial<SupabaseAdminDeps> = {},
): { admin: SupabaseAdminDeps; created: string[]; deleted: string[] } {
  const created: string[] = [];
  const deleted: string[] = [];
  const admin: SupabaseAdminDeps = {
    isConfigured: () => true,
    createUser: vi.fn().mockImplementation(async (email: string) => {
      created.push(email);
      return { id: "auth-user-1", email };
    }),
    deleteUser: vi.fn().mockImplementation(async (id: string) => {
      deleted.push(id);
    }),
    ...over,
  };
  return { admin, created, deleted };
}

const VALID = {
  email: "New.Guard@gatepass.test",
  name: "New Guard",
  badgeNumber: "G-777",
  role: "guard" as const,
  password: "correcthorsebattery",
};

beforeEach(() => {
  clearAuditLog();
  vi.restoreAllMocks();
});

// ─── Happy path ──────────────────────────────────────────────────────────────

describe("provisionAccount — success", () => {
  it("creates an auth user then a linked guard row with the server role", async () => {
    const { db, inserted } = makeMockDB();
    const { admin, created } = makeAdmin();

    const { view } = await provisionAccount(ADMIN_GUARD_ID, VALID, db, admin);

    expect(created).toEqual(["new.guard@gatepass.test"]); // normalized
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      badgeNumber: "G-777",
      role: "guard",
      supabaseUserId: "auth-user-1",
      isActive: true,
    });
    expect(view).toMatchObject({
      guardId: "new-guard-id",
      email: "new.guard@gatepass.test",
      badgeNumber: "G-777",
      role: "guard",
      isActive: true,
    });
  });

  it("persists an admin role when the server selects it", async () => {
    const { db, inserted } = makeMockDB();
    const { admin } = makeAdmin();
    await provisionAccount(
      ADMIN_GUARD_ID,
      { ...VALID, role: "admin" },
      db,
      admin,
    );
    expect(inserted[0].role).toBe("admin");
  });

  it("does NOT return a temporaryPassword when the caller supplied one", async () => {
    const { db } = makeMockDB();
    const { admin } = makeAdmin();
    const result = await provisionAccount(ADMIN_GUARD_ID, VALID, db, admin);
    expect(result.temporaryPassword).toBeUndefined();
  });

  it("returns a generated temporaryPassword when the caller omitted one", async () => {
    const { db } = makeMockDB();
    const { admin } = makeAdmin();
    const { password: _omit, ...noPass } = VALID;
    const result = await provisionAccount(ADMIN_GUARD_ID, noPass, db, admin);
    expect(result.temporaryPassword).toBeTypeOf("string");
    expect((result.temporaryPassword as string).length).toBeGreaterThanOrEqual(
      12,
    );
  });

  // Regression: a failing audit write (e.g. an audit enum value missing from
  // the live DB) surfaced as a bare INTERNAL_ERROR, so the admin retried and
  // got a duplicate — the first account had in fact been created.
  it("reports ACCOUNT_CREATED_AUDIT_FAILED when the audit write fails", async () => {
    const { db, inserted } = makeMockDB();
    const { admin, deleted } = makeAdmin();
    vi.spyOn(auditLogger, "emitAuditEvent").mockRejectedValue(
      new Error('invalid input value for enum audit_event_type'),
    );

    await expect(
      provisionAccount(ADMIN_GUARD_ID, VALID, db, admin),
    ).rejects.toMatchObject({
      code: "ACCOUNT_CREATED_AUDIT_FAILED",
      statusCode: 500,
    });

    // The account exists and must NOT be rolled back or retried into a duplicate.
    expect(inserted).toHaveLength(1);
    expect(deleted).toEqual([]);
    await expect(
      provisionAccount(ADMIN_GUARD_ID, VALID, db, admin),
    ).rejects.toMatchObject({ code: "ACCOUNT_CREATED_AUDIT_FAILED" });
  });

  it("tells the admin not to retry when the audit write fails", async () => {
    const { db } = makeMockDB();
    const { admin } = makeAdmin();
    vi.spyOn(auditLogger, "emitAuditEvent").mockRejectedValue(
      new Error("audit down"),
    );

    await expect(
      provisionAccount(ADMIN_GUARD_ID, VALID, db, admin),
    ).rejects.toThrow(/created.*do not retry/is);
  });

  it("writes an account_provisioned audit event carrying NO secret", async () => {
    const { db } = makeMockDB();
    const { admin } = makeAdmin();
    await provisionAccount(ADMIN_GUARD_ID, VALID, db, admin);
    const events = getAuditEventsByType("account_provisioned");
    expect(events).toHaveLength(1);
    const payload = JSON.stringify(events[0].payload).toLowerCase();
    expect(payload).not.toContain("password");
    expect(payload).not.toContain(VALID.password);
    expect(events[0].payload).toMatchObject({ role: "guard", badgeNumber: "G-777" });
  });
});

// ─── Configuration ───────────────────────────────────────────────────────────

describe("provisionAccount — not configured", () => {
  it("throws 503 ACCOUNT_PROVISIONING_UNAVAILABLE and never calls Supabase", async () => {
    const { db } = makeMockDB();
    const { admin, created } = makeAdmin({ isConfigured: () => false });
    await expect(
      provisionAccount(ADMIN_GUARD_ID, VALID, db, admin),
    ).rejects.toMatchObject({
      code: "ACCOUNT_PROVISIONING_UNAVAILABLE",
      statusCode: 503,
    });
    expect(created).toHaveLength(0);
  });
});

// ─── Validation (defensive) ───────────────────────────────────────────────────

describe("provisionAccount — boundary validation", () => {
  it("rejects an invalid role without creating anything", async () => {
    const { db } = makeMockDB();
    const { admin, created } = makeAdmin();
    await expect(
      provisionAccount(
        ADMIN_GUARD_ID,
        { ...VALID, role: "superuser" as never },
        db,
        admin,
      ),
    ).rejects.toMatchObject({ code: "ACCOUNT_INVALID_INPUT", field: "role" });
    expect(created).toHaveLength(0);
  });

  it("rejects an empty name", async () => {
    const { db } = makeMockDB();
    const { admin } = makeAdmin();
    await expect(
      provisionAccount(ADMIN_GUARD_ID, { ...VALID, name: "   " }, db, admin),
    ).rejects.toMatchObject({ code: "ACCOUNT_INVALID_INPUT", field: "name" });
  });
});

// ─── Duplicates ───────────────────────────────────────────────────────────────

describe("provisionAccount — duplicates", () => {
  it("rejects a duplicate badge BEFORE creating an auth user", async () => {
    const { db } = makeMockDB({ existingBadges: ["G-777"] });
    const { admin, created } = makeAdmin();
    await expect(
      provisionAccount(ADMIN_GUARD_ID, VALID, db, admin),
    ).rejects.toMatchObject({
      code: "ACCOUNT_DUPLICATE",
      statusCode: 409,
      field: "badgeNumber",
    });
    expect(created).toHaveLength(0);
  });

  it("maps a Supabase duplicate-email error to 409 ACCOUNT_DUPLICATE", async () => {
    const { db } = makeMockDB();
    const { admin } = makeAdmin({
      createUser: vi
        .fn()
        .mockRejectedValue(new SupabaseAdminError("duplicate", "exists")),
    });
    await expect(
      provisionAccount(ADMIN_GUARD_ID, VALID, db, admin),
    ).rejects.toMatchObject({
      code: "ACCOUNT_DUPLICATE",
      statusCode: 409,
      field: "email",
    });
  });
});

// ─── Cross-system compensation ────────────────────────────────────────────────

describe("provisionAccount — DB insert failure compensation", () => {
  it("deletes the auth user it created when the guard insert fails", async () => {
    const { db } = makeMockDB({ failInsert: "generic" });
    const { admin, created, deleted } = makeAdmin();
    await expect(
      provisionAccount(ADMIN_GUARD_ID, VALID, db, admin),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR", statusCode: 500 });
    expect(created).toHaveLength(1);
    expect(deleted).toEqual(["auth-user-1"]); // compensated
  });

  it("maps a DB unique violation to 409 and still compensates", async () => {
    const { db } = makeMockDB({ failInsert: "unique" });
    const { admin, deleted } = makeAdmin();
    await expect(
      provisionAccount(ADMIN_GUARD_ID, VALID, db, admin),
    ).rejects.toMatchObject({ code: "ACCOUNT_DUPLICATE", statusCode: 409 });
    expect(deleted).toEqual(["auth-user-1"]);
  });

  it("compensates when the insert returns no row", async () => {
    const { db } = makeMockDB({ emptyReturning: true });
    const { admin, deleted } = makeAdmin();
    await expect(
      provisionAccount(ADMIN_GUARD_ID, VALID, db, admin),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR", statusCode: 500 });
    expect(deleted).toEqual(["auth-user-1"]);
  });
});

// ─── Password generator ───────────────────────────────────────────────────────

describe("generateTemporaryPassword", () => {
  it("produces a >=12 char string with mixed classes and is non-deterministic", () => {
    const a = generateTemporaryPassword();
    const b = generateTemporaryPassword();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(12);
    expect(a).toMatch(/[A-Z]/);
    expect(a).toMatch(/[a-z]/);
    expect(a).toMatch(/[0-9]/);
    expect(a).toMatch(/[^A-Za-z0-9]/);
  });
});

void ServiceError;
