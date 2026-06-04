// @vitest-environment node
/**
 * GatePass — Shift Log Service Tests (TDD, behaviour-first)
 *
 * Source: src/docs/specs/shift-log-aggregation.md §§3–5, §11
 * Source: Test-Driven-Development — name the state transition, not the impl.
 * Source: Trustless-System-Auditor — read-only; no audit row should be
 *         written by listShifts under any input.
 *
 * Mock DB returns canned arrays per source table. Each test asserts the
 * observable shape of the response: window echo, deterministic order,
 * empty-array on zero activity, and 422 on invalid windows.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  listShifts,
  ShiftErrorCodes,
  type ShiftQuery,
  type DrizzleDB,
} from "../services/shift-log-service";
import {
  clearAuditLog,
  getAuditLog,
} from "../services/audit-logger";
import { entryRecords, auditEvents, guards } from "@/db/schema";

// ─── Mock DB factory ─────────────────────────────────────────────────────────

interface MockDBOpts {
  entries?: Array<{ guardId: string; method: string }>;
  events?: Array<{ guardId: string; eventType: string }>;
  guards?: Array<{ id: string; name: string; badgeNumber: string }>;
  failOn?: "entries" | "events" | "guards";
}

function makeMockDB(opts: MockDBOpts = {}) {
  const fromMock = vi.fn().mockImplementation((table: unknown) => {
    let target: "entries" | "events" | "guards" | "unknown" = "unknown";
    if (table === entryRecords) target = "entries";
    else if (table === auditEvents) target = "events";
    else if (table === guards) target = "guards";

    const result =
      target === "entries"
        ? opts.entries ?? []
        : target === "events"
          ? opts.events ?? []
          : target === "guards"
            ? opts.guards ?? []
            : [];

    return {
      where: vi.fn().mockImplementation(async () => {
        if (opts.failOn === target) {
          throw new Error(`DB transient on ${target}`);
        }
        return result;
      }),
    };
  });

  return {
    db: {
      select: vi.fn().mockImplementation(() => ({ from: fromMock })),
    } as unknown as DrizzleDB,
    fromMock,
  };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const VALID_WINDOW: ShiftQuery = {
  fromIso: "2024-01-15T00:00:00.000Z",
  toIso: "2024-01-16T00:00:00.000Z",
};

beforeEach(() => {
  clearAuditLog();
});

// ─── Window validation ──────────────────────────────────────────────────────

describe("listShifts — window validation", () => {
  it("rejects an inverted window with SHIFT_WINDOW_INVALID (422)", async () => {
    const { db } = makeMockDB();

    await expect(
      listShifts(
        { fromIso: "2024-01-16T00:00:00.000Z", toIso: "2024-01-15T00:00:00.000Z" },
        db
      )
    ).rejects.toMatchObject({
      code: ShiftErrorCodes.SHIFT_WINDOW_INVALID,
      statusCode: 422,
    });
  });

  it("rejects an equal-bound window (from == to) with SHIFT_WINDOW_INVALID", async () => {
    const { db } = makeMockDB();

    await expect(
      listShifts(
        { fromIso: "2024-01-15T00:00:00.000Z", toIso: "2024-01-15T00:00:00.000Z" },
        db
      )
    ).rejects.toMatchObject({
      code: ShiftErrorCodes.SHIFT_WINDOW_INVALID,
      statusCode: 422,
    });
  });

  it("rejects an unparseable ISO string with SHIFT_WINDOW_INVALID", async () => {
    const { db } = makeMockDB();

    await expect(
      listShifts({ fromIso: "not-a-date", toIso: "also-not" }, db)
    ).rejects.toMatchObject({
      code: ShiftErrorCodes.SHIFT_WINDOW_INVALID,
    });
  });

  it("rejects a window wider than 31 days with SHIFT_WINDOW_TOO_LARGE", async () => {
    const { db } = makeMockDB();

    await expect(
      listShifts(
        { fromIso: "2024-01-01T00:00:00.000Z", toIso: "2024-02-02T00:00:00.000Z" },
        db
      )
    ).rejects.toMatchObject({
      code: ShiftErrorCodes.SHIFT_WINDOW_TOO_LARGE,
      statusCode: 422,
    });
  });

  it("accepts exactly 31 days as the boundary", async () => {
    const { db } = makeMockDB();

    const result = await listShifts(
      { fromIso: "2024-01-01T00:00:00.000Z", toIso: "2024-02-01T00:00:00.000Z" },
      db
    );
    expect(result.shifts).toEqual([]);
    expect(result.window.fromIso).toBe("2024-01-01T00:00:00.000Z");
    expect(result.window.toIso).toBe("2024-02-01T00:00:00.000Z");
  });
});

// ─── Empty + happy path ─────────────────────────────────────────────────────

describe("listShifts — happy path", () => {
  it("returns an empty shifts array when neither table has rows in the window", async () => {
    const { db } = makeMockDB();
    const result = await listShifts(VALID_WINDOW, db);
    expect(result.shifts).toEqual([]);
    expect(Array.isArray(result.shifts)).toBe(true);
  });

  it("aggregates one row per guard with totals matching the entry+event mix", async () => {
    const { db } = makeMockDB({
      entries: [
        { guardId: "g1", method: "qr" },
        { guardId: "g1", method: "qr" },
        { guardId: "g1", method: "walk-in" },
        { guardId: "g1", method: "override" },
      ],
      events: [
        { guardId: "g1", eventType: "auto_approval_matched" },
        { guardId: "g1", eventType: "override_authorized" },
        { guardId: "g1", eventType: "approval_denied" },
      ],
      guards: [{ id: "g1", name: "A. Okafor", badgeNumber: "G-1042" }],
    });

    const result = await listShifts(VALID_WINDOW, db);

    expect(result.shifts).toHaveLength(1);
    expect(result.shifts[0]).toEqual({
      guardId: "g1",
      guardName: "A. Okafor",
      badgeNumber: "G-1042",
      totals: {
        entries: 4,
        qr: 2,
        walkIn: 1,
        override: 1,
        recognized: 0,
        auto: 0,
        approvalsDenied: 1,
        approvalsExpired: 0,
        autoApprovalsMatched: 1,
        overrideAuthorized: 1,
      },
    });
  });

  it("emits one row per guard for a multi-guard window", async () => {
    const { db } = makeMockDB({
      entries: [
        { guardId: "g1", method: "qr" },
        { guardId: "g2", method: "walk-in" },
        { guardId: "g2", method: "walk-in" },
      ],
      events: [],
      guards: [
        { id: "g1", name: "A. Okafor", badgeNumber: "G-1042" },
        { id: "g2", name: "M. Patel", badgeNumber: "G-1043" },
      ],
    });

    const result = await listShifts(VALID_WINDOW, db);
    expect(result.shifts.map((s) => s.guardId)).toEqual(["g2", "g1"]); // entries desc
  });

  it("orders deterministically: entries desc, then badgeNumber asc on ties", async () => {
    const { db } = makeMockDB({
      entries: [
        { guardId: "g1", method: "qr" },
        { guardId: "g2", method: "qr" },
        { guardId: "g3", method: "qr" },
      ],
      events: [],
      guards: [
        { id: "g1", name: "A", badgeNumber: "B-200" },
        { id: "g2", name: "B", badgeNumber: "A-100" },
        { id: "g3", name: "C", badgeNumber: "C-300" },
      ],
    });

    const result = await listShifts(VALID_WINDOW, db);
    // All tied on 1 entry, so badgeNumber alphabetic wins.
    expect(result.shifts.map((s) => s.badgeNumber)).toEqual([
      "A-100",
      "B-200",
      "C-300",
    ]);
  });

  it("excludes guards with zero activity in the window", async () => {
    const { db } = makeMockDB({
      entries: [{ guardId: "g1", method: "qr" }],
      events: [],
      // Note: g2 exists in the guards table but had no activity — still excluded.
      guards: [
        { id: "g1", name: "A", badgeNumber: "G-1" },
        { id: "g2", name: "B", badgeNumber: "G-2" },
      ],
    });

    const result = await listShifts(VALID_WINDOW, db);
    expect(result.shifts).toHaveLength(1);
    expect(result.shifts[0].guardId).toBe("g1");
  });

  it("synthesises a display row when a guard is missing from the guards table", async () => {
    // Trustless: never silently drop a row of activity even if the join fails.
    const { db } = makeMockDB({
      entries: [{ guardId: "g-orphan", method: "qr" }],
      events: [],
      guards: [],
    });

    const result = await listShifts(VALID_WINDOW, db);
    expect(result.shifts).toHaveLength(1);
    expect(result.shifts[0]).toMatchObject({
      guardId: "g-orphan",
      guardName: "(unknown guard)",
      badgeNumber: "(unknown)",
    });
    expect(result.shifts[0].totals.entries).toBe(1);
  });

  it("counts only the relevant audit event types and ignores noise", async () => {
    const { db } = makeMockDB({
      entries: [],
      events: [
        // Relevant
        { guardId: "g1", eventType: "approval_denied" },
        { guardId: "g1", eventType: "approval_expired" },
        // Not relevant — must NOT inflate totals.entries either
        { guardId: "g1", eventType: "qr_scan_succeeded" },
      ],
      guards: [{ id: "g1", name: "A", badgeNumber: "G-1" }],
    });

    const result = await listShifts(VALID_WINDOW, db);
    expect(result.shifts).toHaveLength(1);
    expect(result.shifts[0].totals).toMatchObject({
      entries: 0,
      approvalsDenied: 1,
      approvalsExpired: 1,
    });
  });

  it("echoes the window back, normalised to ISO strings", async () => {
    const { db } = makeMockDB();
    const result = await listShifts(VALID_WINDOW, db);
    expect(result.window).toEqual({
      fromIso: "2024-01-15T00:00:00.000Z",
      toIso: "2024-01-16T00:00:00.000Z",
    });
  });

  it("does NOT emit any audit event (read-only contract)", async () => {
    const { db } = makeMockDB({
      entries: [{ guardId: "g1", method: "qr" }],
      events: [],
      guards: [{ id: "g1", name: "A", badgeNumber: "G-1" }],
    });
    await listShifts(VALID_WINDOW, db);
    expect(getAuditLog()).toHaveLength(0);
  });
});

// ─── DB failure surfaces, never silently swallowed ──────────────────────────

describe("listShifts — DB failure surfaces", () => {
  it("propagates entry_records DB errors so the route can map them to 500", async () => {
    const { db } = makeMockDB({ failOn: "entries" });
    await expect(listShifts(VALID_WINDOW, db)).rejects.toThrow(
      "DB transient on entries"
    );
  });

  it("propagates audit_events DB errors", async () => {
    const { db } = makeMockDB({ failOn: "events" });
    await expect(listShifts(VALID_WINDOW, db)).rejects.toThrow(
      "DB transient on events"
    );
  });
});
