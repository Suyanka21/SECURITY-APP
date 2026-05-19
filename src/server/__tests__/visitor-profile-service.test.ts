// @vitest-environment node
/**
 * GatePass — Visitor Profile Service Tests (TDD)
 *
 * Source: src/docs/specs/visitor-profiles.md §§3–7
 * Source: Test-Driven-Development — "failing test first; behavior, not impl"
 * Source: Trustless-System-Auditor — every mutation writes exactly one audit
 *         row; reads write none; empty patch writes none.
 *
 * Each test names a state transition, not an implementation detail.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createVisitorProfile,
  updateVisitorProfile,
  listVisitorProfiles,
  getVisitorProfile,
  softDeleteVisitorProfile,
  restoreVisitorProfile,
  ServiceError,
  type VisitorProfileRow,
} from "../services/visitor-profile-service";
import {
  clearAuditLog,
  getAuditEventsByType,
} from "../services/audit-logger";

// ─── Mock DB factory ─────────────────────────────────────────────────────────

interface MockDBOpts {
  profiles?: VisitorProfileRow[];
  failSelect?: boolean;
  failInsert?: boolean;
  failUpdate?: boolean;
  /**
   * Sequenced results for the select() chain. selectResults[i] is what
   * the i-th `select().from().where(...)` call returns. Use this to
   * model the service's multi-select code paths (by-id followed by
   * identity-clash) deterministically. If undefined or exhausted, the
   * mock falls back to returning the full `profiles` array.
   */
  selectResults?: VisitorProfileRow[][];
}

function makeMockDB(opts: MockDBOpts = {}) {
  const profiles: VisitorProfileRow[] = [...(opts.profiles ?? [])];
  let selectCallCount = 0;

  const fromAwaitable = vi.fn().mockImplementation(() => {
    const chain: any = {
      where: vi.fn().mockImplementation(async () => {
        if (opts.failSelect) throw new Error("DB transient");
        const idx = selectCallCount;
        selectCallCount += 1;
        if (opts.selectResults && idx < opts.selectResults.length) {
          return opts.selectResults[idx];
        }
        return profiles.slice();
      }),
    };
    Object.defineProperty(chain, "then", {
      get: () => (resolve: (rows: VisitorProfileRow[]) => void) =>
        resolve(profiles.slice()),
    });
    return chain;
  });

  const selectAwaitableMock = vi.fn().mockImplementation(() => ({
    from: fromAwaitable,
  }));

  const insertMock = vi.fn().mockImplementation(() => ({
    values: vi
      .fn()
      .mockImplementation((row: Partial<VisitorProfileRow>) => ({
        returning: vi.fn().mockImplementation(async () => {
          if (opts.failInsert) throw new Error("DB insert failed");
          const inserted: VisitorProfileRow = {
            id: `profile-${profiles.length + 1}`,
            visitorName: row.visitorName ?? "",
            host: row.host ?? "",
            unit: row.unit ?? "",
            plate: row.plate ?? null,
            phoneE164: row.phoneE164 ?? null,
            notes: row.notes ?? null,
            watchFlag: row.watchFlag ?? false,
            createdByGuardId: row.createdByGuardId ?? "guard-1",
            createdAt: row.createdAt ?? new Date(),
            updatedAt: row.updatedAt ?? new Date(),
            deletedAt: row.deletedAt ?? null,
            deletedByGuardId: row.deletedByGuardId ?? null,
          };
          profiles.push(inserted);
          return [inserted];
        }),
      })),
  }));

  const updateWithReturning = vi.fn().mockImplementation(() => ({
    set: vi
      .fn()
      .mockImplementation((patch: Partial<VisitorProfileRow>) => ({
        where: vi.fn().mockImplementation((_clause: unknown) => ({
          returning: vi.fn().mockImplementation(async () => {
            if (opts.failUpdate) throw new Error("DB update failed");
            if (profiles.length === 0) return [];
            profiles[0] = { ...profiles[0], ...patch };
            return [profiles[0]];
          }),
        })),
      })),
  }));

  return {
    profiles,
    db: {
      select: selectAwaitableMock,
      insert: insertMock,
      update: updateWithReturning,
      transaction: vi.fn(),
      query: {},
    } as any,
  };
}

function profileRow(
  overrides: Partial<VisitorProfileRow> = {}
): VisitorProfileRow {
  return {
    id: "profile-1",
    visitorName: "Maya Chen",
    host: "Alex Park",
    unit: "12A",
    plate: null,
    phoneE164: null,
    notes: null,
    watchFlag: false,
    createdByGuardId: "guard-1",
    createdAt: new Date(Date.now() - 60 * 60 * 1000),
    updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    deletedAt: null,
    deletedByGuardId: null,
    ...overrides,
  };
}

// ─── createVisitorProfile() ──────────────────────────────────────────────────

describe("createVisitorProfile()", () => {
  beforeEach(() => {
    clearAuditLog();
  });

  it("creates a profile and emits visitor_profile_created", async () => {
    const { db } = makeMockDB();
    const view = await createVisitorProfile(
      "guard-1",
      {
        visitorName: "Maya Chen",
        host: "Alex Park",
        unit: "12A",
      },
      db
    );
    expect(view.id).toBeDefined();
    expect(view.visitorName).toBe("Maya Chen");
    expect(view.watchFlag).toBe(false);
    expect(view.deletedAt).toBeNull();

    const events = getAuditEventsByType("visitor_profile_created");
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      profileId: view.id,
      visitorName: "Maya Chen",
    });
  });

  it("422 PROFILE_INVALID_INPUT when visitorName is empty", async () => {
    const { db } = makeMockDB();
    await expect(
      createVisitorProfile(
        "guard-1",
        { visitorName: " ", host: "Alex", unit: "12A" },
        db
      )
    ).rejects.toMatchObject({
      code: "PROFILE_INVALID_INPUT",
      statusCode: 422,
      field: "visitorName",
    });
  });

  it("422 PROFILE_INVALID_INPUT when unit exceeds 32 chars", async () => {
    const { db } = makeMockDB();
    await expect(
      createVisitorProfile(
        "guard-1",
        { visitorName: "Maya", host: "Alex", unit: "x".repeat(33) },
        db
      )
    ).rejects.toMatchObject({ code: "PROFILE_INVALID_INPUT", field: "unit" });
  });

  it("422 PROFILE_INVALID_INPUT when phoneE164 is malformed", async () => {
    const { db } = makeMockDB();
    await expect(
      createVisitorProfile(
        "guard-1",
        {
          visitorName: "Maya",
          host: "Alex",
          unit: "12A",
          phoneE164: "not-a-phone",
        },
        db
      )
    ).rejects.toMatchObject({
      code: "PROFILE_INVALID_INPUT",
      field: "phoneE164",
    });
  });

  it("accepts a valid E.164 phone", async () => {
    const { db } = makeMockDB();
    const view = await createVisitorProfile(
      "guard-1",
      {
        visitorName: "Maya",
        host: "Alex",
        unit: "12A",
        phoneE164: "+15551230001",
      },
      db
    );
    expect(view.phoneE164).toBe("+15551230001");
  });

  it("409 PROFILE_DUPLICATE when an active profile with same triple exists", async () => {
    const existing = profileRow();
    const { db } = makeMockDB({
      profiles: [existing],
      // Single select call: the duplicate identity check returns the
      // existing active profile.
      selectResults: [[existing]],
    });
    await expect(
      createVisitorProfile(
        "guard-1",
        { visitorName: "Maya Chen", host: "Alex Park", unit: "12A" },
        db
      )
    ).rejects.toMatchObject({
      code: "PROFILE_DUPLICATE",
      statusCode: 409,
    });
  });

  it("allows re-adding the same identity after soft-delete", async () => {
    const deleted = profileRow({
      deletedAt: new Date(),
      deletedByGuardId: "guard-1",
    });
    const { db } = makeMockDB({
      profiles: [deleted],
      // Identity check returns [] because deleted rows are filtered out
      // by the WHERE deleted_at IS NULL clause in the real query.
      selectResults: [[]],
    });
    const view = await createVisitorProfile(
      "guard-1",
      { visitorName: "Maya Chen", host: "Alex Park", unit: "12A" },
      db
    );
    expect(view.id).toBeDefined();
    expect(view.deletedAt).toBeNull();
  });

  it("normalises trimmed input fields before write", async () => {
    const { db } = makeMockDB();
    const view = await createVisitorProfile(
      "guard-1",
      {
        visitorName: "  Maya  ",
        host: "  Alex  ",
        unit: "  12A  ",
        notes: "  hello  ",
      },
      db
    );
    expect(view.visitorName).toBe("Maya");
    expect(view.notes).toBe("hello");
  });

  it("creates with watchFlag=true when requested", async () => {
    const { db } = makeMockDB();
    const view = await createVisitorProfile(
      "guard-1",
      {
        visitorName: "Maya",
        host: "Alex",
        unit: "12A",
        watchFlag: true,
      },
      db
    );
    expect(view.watchFlag).toBe(true);
    const events = getAuditEventsByType("visitor_profile_created");
    expect(events[0].payload.watchFlag).toBe(true);
  });
});

// ─── updateVisitorProfile() ──────────────────────────────────────────────────

describe("updateVisitorProfile()", () => {
  beforeEach(() => {
    clearAuditLog();
  });

  it("applies a patch and emits visitor_profile_updated with a diff", async () => {
    const before = profileRow();
    const { db } = makeMockDB({ profiles: [before] });
    const view = await updateVisitorProfile(
      "guard-1",
      before.id,
      { watchFlag: true, notes: "deliveries only" },
      db
    );
    expect(view.watchFlag).toBe(true);
    expect(view.notes).toBe("deliveries only");

    const events = getAuditEventsByType("visitor_profile_updated");
    expect(events).toHaveLength(1);
    const diff = events[0].payload.diff as Record<string, unknown>;
    expect(diff.watchFlag).toEqual({ before: false, after: true });
    expect(diff.notes).toEqual({ before: null, after: "deliveries only" });
  });

  it("no-op patch returns 200 with unchanged profile and DOES NOT emit audit", async () => {
    const before = profileRow({ watchFlag: true });
    const { db } = makeMockDB({ profiles: [before] });
    const view = await updateVisitorProfile(
      "guard-1",
      before.id,
      { watchFlag: true }, // same as current
      db
    );
    expect(view.watchFlag).toBe(true);
    expect(getAuditEventsByType("visitor_profile_updated")).toHaveLength(0);
  });

  it("404 when the profile id is unknown", async () => {
    const { db } = makeMockDB({ profiles: [] });
    await expect(
      updateVisitorProfile(
        "guard-1",
        "00000000-0000-0000-0000-000000000000",
        { watchFlag: true },
        db
      )
    ).rejects.toMatchObject({ code: "PROFILE_NOT_FOUND", statusCode: 404 });
  });

  it("404 when the profile has been soft-deleted", async () => {
    const deleted = profileRow({
      deletedAt: new Date(),
      deletedByGuardId: "guard-1",
    });
    const { db } = makeMockDB({ profiles: [deleted] });
    await expect(
      updateVisitorProfile("guard-1", deleted.id, { watchFlag: true }, db)
    ).rejects.toMatchObject({ code: "PROFILE_NOT_FOUND", statusCode: 404 });
  });

  it("422 PROFILE_INVALID_INPUT when phoneE164 patch is malformed", async () => {
    const before = profileRow();
    const { db } = makeMockDB({ profiles: [before] });
    await expect(
      updateVisitorProfile(
        "guard-1",
        before.id,
        { phoneE164: "1234" }, // missing +
        db
      )
    ).rejects.toMatchObject({
      code: "PROFILE_INVALID_INPUT",
      field: "phoneE164",
    });
  });

  it("409 PROFILE_DUPLICATE when rename clashes with another active profile", async () => {
    const subject = profileRow({ id: "profile-1" });
    const other = profileRow({
      id: "profile-2",
      visitorName: "Other Visitor",
      host: "Alex Park",
      unit: "12A",
    });
    const { db } = makeMockDB({
      profiles: [subject, other],
      // Call #1: by-id lookup returns [subject]. Call #2: identity-clash
      // returns [other].
      selectResults: [[subject], [other]],
    });
    await expect(
      updateVisitorProfile(
        "guard-1",
        subject.id,
        { visitorName: "Other Visitor" },
        db
      )
    ).rejects.toMatchObject({
      code: "PROFILE_DUPLICATE",
      statusCode: 409,
    });
  });
});

// ─── listVisitorProfiles() ───────────────────────────────────────────────────

describe("listVisitorProfiles()", () => {
  it("returns paginated active profiles by default (excludes soft-deleted)", async () => {
    const active = profileRow({ id: "p-1", visitorName: "Active One" });
    const deleted = profileRow({
      id: "p-2",
      visitorName: "Deleted One",
      deletedAt: new Date(),
      deletedByGuardId: "guard-1",
    });
    const { db } = makeMockDB({
      profiles: [active, deleted],
      // The list endpoint emits one select with deleted_at IS NULL —
      // the mock represents that filter explicitly here.
      selectResults: [[active]],
    });
    const result = await listVisitorProfiles({}, db);
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0].visitorName).toBe("Active One");
    expect(result.pagination.totalItems).toBe(1);
  });

  it("returns soft-deleted rows when includeDeleted=true", async () => {
    const active = profileRow({ id: "p-1", visitorName: "Active" });
    const deleted = profileRow({
      id: "p-2",
      visitorName: "Deleted",
      deletedAt: new Date(),
      deletedByGuardId: "guard-1",
    });
    const { db } = makeMockDB({
      profiles: [active, deleted],
    });
    const result = await listVisitorProfiles({ includeDeleted: true }, db);
    expect(result.profiles).toHaveLength(2);
  });

  it("paginates correctly when totalItems > pageSize", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      profileRow({
        id: `p-${i + 1}`,
        visitorName: `Visitor ${i + 1}`,
        updatedAt: new Date(Date.now() - i * 1000),
      })
    );
    const { db } = makeMockDB({
      profiles: rows,
      // Both list calls run the same active-only query — return the full
      // active set both times.
      selectResults: [rows, rows],
    });
    const page1 = await listVisitorProfiles({ pageSize: 2, page: 1 }, db);
    expect(page1.profiles).toHaveLength(2);
    expect(page1.pagination.totalPages).toBe(3);
    const page2 = await listVisitorProfiles({ pageSize: 2, page: 2 }, db);
    expect(page2.profiles).toHaveLength(2);
    expect(page2.profiles[0].id).not.toBe(page1.profiles[0].id);
  });

  it("never emits an audit event on read", async () => {
    clearAuditLog();
    const { db } = makeMockDB({ profiles: [profileRow()] });
    await listVisitorProfiles({}, db);
    expect(getAuditEventsByType("visitor_profile_created")).toHaveLength(0);
    expect(getAuditEventsByType("visitor_profile_updated")).toHaveLength(0);
  });
});

// ─── getVisitorProfile() ─────────────────────────────────────────────────────

describe("getVisitorProfile()", () => {
  it("returns the profile when found", async () => {
    const row = profileRow();
    const { db } = makeMockDB({ profiles: [row] });
    const view = await getVisitorProfile(row.id, db);
    expect(view.id).toBe(row.id);
    expect(view.visitorName).toBe(row.visitorName);
  });

  it("404 PROFILE_NOT_FOUND when id is unknown", async () => {
    const { db } = makeMockDB({ profiles: [] });
    await expect(
      getVisitorProfile("00000000-0000-0000-0000-000000000000", db)
    ).rejects.toMatchObject({ code: "PROFILE_NOT_FOUND", statusCode: 404 });
  });
});

// ─── softDeleteVisitorProfile() ──────────────────────────────────────────────

describe("softDeleteVisitorProfile()", () => {
  beforeEach(() => {
    clearAuditLog();
  });

  it("soft-deletes an active profile and emits visitor_profile_soft_deleted", async () => {
    const row = profileRow();
    const { db } = makeMockDB({ profiles: [row] });
    const view = await softDeleteVisitorProfile("guard-2", row.id, db);
    expect(view.deletedAt).not.toBeNull();
    expect(getAuditEventsByType("visitor_profile_soft_deleted")).toHaveLength(
      1
    );
  });

  it("is idempotent — deleting again does NOT write a second audit row", async () => {
    const row = profileRow({
      deletedAt: new Date(),
      deletedByGuardId: "guard-2",
    });
    const { db } = makeMockDB({ profiles: [row] });
    const view = await softDeleteVisitorProfile("guard-2", row.id, db);
    expect(view.deletedAt).not.toBeNull();
    expect(getAuditEventsByType("visitor_profile_soft_deleted")).toHaveLength(
      0
    );
  });

  it("404 when the profile id is unknown", async () => {
    const { db } = makeMockDB({ profiles: [] });
    await expect(
      softDeleteVisitorProfile(
        "guard-1",
        "00000000-0000-0000-0000-000000000000",
        db
      )
    ).rejects.toMatchObject({ code: "PROFILE_NOT_FOUND", statusCode: 404 });
  });
});

// ─── restoreVisitorProfile() ─────────────────────────────────────────────────

describe("restoreVisitorProfile()", () => {
  beforeEach(() => {
    clearAuditLog();
  });

  it("restores a soft-deleted profile and emits visitor_profile_restored", async () => {
    const row = profileRow({
      deletedAt: new Date(),
      deletedByGuardId: "guard-2",
    });
    const { db } = makeMockDB({
      profiles: [row],
      // Call #1: by-id returns the soft-deleted row.
      // Call #2: clash check returns [] (no other active profile).
      selectResults: [[row], []],
    });
    const view = await restoreVisitorProfile("guard-1", row.id, db);
    expect(view.deletedAt).toBeNull();
    expect(getAuditEventsByType("visitor_profile_restored")).toHaveLength(1);
  });

  it("409 PROFILE_RESTORE_CONFLICT when identity is already taken", async () => {
    const deleted = profileRow({
      id: "p-1",
      deletedAt: new Date(),
      deletedByGuardId: "guard-2",
    });
    const conflicting = profileRow({
      id: "p-2",
      // same identity, active
    });
    const { db } = makeMockDB({
      profiles: [deleted, conflicting],
      // Call #1: by-id returns [deleted]. Call #2: clash returns [conflicting].
      selectResults: [[deleted], [conflicting]],
    });
    await expect(
      restoreVisitorProfile("guard-1", deleted.id, db)
    ).rejects.toMatchObject({
      code: "PROFILE_RESTORE_CONFLICT",
      statusCode: 409,
    });
  });

  it("idempotent — restoring an already-active profile does NOT emit audit", async () => {
    const row = profileRow();
    const { db } = makeMockDB({ profiles: [row] });
    const view = await restoreVisitorProfile("guard-1", row.id, db);
    expect(view.deletedAt).toBeNull();
    expect(getAuditEventsByType("visitor_profile_restored")).toHaveLength(0);
  });

  it("404 when the profile id is unknown", async () => {
    const { db } = makeMockDB({ profiles: [] });
    await expect(
      restoreVisitorProfile(
        "guard-1",
        "00000000-0000-0000-0000-000000000000",
        db
      )
    ).rejects.toMatchObject({ code: "PROFILE_NOT_FOUND", statusCode: 404 });
  });
});

// ─── ServiceError export ─────────────────────────────────────────────────────

describe("ServiceError export", () => {
  it("re-exports ServiceError so callers don't double-import", () => {
    const err = new ServiceError("X", "msg", 500);
    expect(err.code).toBe("X");
    expect(err.statusCode).toBe(500);
  });
});
