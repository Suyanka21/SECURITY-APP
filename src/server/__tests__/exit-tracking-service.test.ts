// @vitest-environment node
/**
 * GatePass — Exit Tracking Service Tests (TDD, behaviour-first)
 *
 * Source: src/docs/specs/exit-tracking.md §§5–7
 * Source: Test-Driven-Development — name the state transition, not the impl.
 * Source: Trustless-System-Auditor — every exit attempt (success or fail)
 *         writes exactly one audit row. No silent success, no silent failure.
 *
 * Mock DB:
 * - recordExit: stubs select().from(entryRecords), select().from(exitRecords),
 *   and insert(exitRecords).values().
 * - listOnPremise: stubs execute() for the entries query and select() for the
 *   guard-notes query.
 *
 * The service never queries the guards table — auth is upstream.
 */

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  recordExit,
  listOnPremise,
  ExitErrorCodes,
  type DrizzleDB,
} from "../services/exit-tracking-service";
import {
  clearAuditLog,
  getAuditLog,
  getAuditEventsByType,
} from "../services/audit-logger";
import { entryRecords, exitRecords } from "@/db/schema";

// ─── Constants ───────────────────────────────────────────────────────────────

const GUARD_ID = "guard-west-04";
const ENTRY_ID = "entry-aaa-111";
const OTHER_ENTRY_ID = "entry-bbb-222";

// ─── Mock DB factory ─────────────────────────────────────────────────────────

interface MockDBOpts {
  /** Rows returned from select().from(entryRecords) */
  entryRows?: Array<{ id: string }>;
  /** Rows returned from select().from(exitRecords) */
  exitRows?: Array<{ id: string }>;
  /** If set, insert will throw */
  insertFail?: boolean;
  /** If set, select on the given table will throw */
  failOn?: "entry" | "exit";
}

function makeMockDB(opts: MockDBOpts = {}) {
  const insertValuesMock = vi.fn().mockImplementation(async () => {
    if (opts.insertFail) {
      throw new Error("DB insert failed");
    }
  });
  const insertMock = vi.fn().mockReturnValue({ values: insertValuesMock });

  const fromMock = vi.fn().mockImplementation((table: unknown) => {
    let rows: unknown[] = [];
    let fail = false;
    if (table === entryRecords) {
      rows = opts.entryRows ?? [];
      fail = opts.failOn === "entry";
    } else if (table === exitRecords) {
      rows = opts.exitRows ?? [];
      fail = opts.failOn === "exit";
    }

    return {
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockImplementation(async () => {
          if (fail) throw new Error("DB select failed");
          return rows;
        }),
      }),
    };
  });

  const selectMock = vi.fn().mockReturnValue({ from: fromMock });

  return {
    db: {
      select: selectMock,
      insert: insertMock,
      query: {},
      execute: vi.fn(),
    } as unknown as DrizzleDB,
    insertValuesMock,
    insertMock,
    selectMock,
    fromMock,
  };
}

// ─── listOnPremise mock DB ───────────────────────────────────────────────────

function makeOnPremiseMockDB(rows: unknown[] = [], noteRows: unknown[] = []) {
  // The entries query is raw SQL via execute(); the guard-notes query is a
  // typed select() so the entry IDs are bound as individual parameters
  // (a raw `= ANY(${ids})` binds the array as one scalar and Postgres rejects
  // it — see the "binds each entry id" test below).
  const whereMock = vi.fn().mockReturnValue({
    orderBy: vi.fn().mockResolvedValue(noteRows),
  });
  const selectMock = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({ where: whereMock }),
  });
  return {
    whereMock,
    db: {
      select: selectMock,
      insert: vi.fn(),
      query: {},
      execute: vi.fn().mockResolvedValue({ rows }),
    } as unknown as DrizzleDB,
  };
}

// ─── Audit helpers ───────────────────────────────────────────────────────────

function getExitRecordedEvents() {
  return getAuditEventsByType("exit_recorded");
}

function getExitBlockedEvents() {
  return getAuditEventsByType("exit_blocked");
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  clearAuditLog();
});

// ─── recordExit ──────────────────────────────────────────────────────────────

describe("recordExit", () => {
  // Happy path
  it("creates an exit record when entry exists and has no prior exit", async () => {
    const { db } = makeMockDB({
      entryRows: [{ id: ENTRY_ID }],
      exitRows: [],
    });

    const result = await recordExit(ENTRY_ID, GUARD_ID, db);

    expect(result.exit.entryId).toBe(ENTRY_ID);
    expect(result.exit.guardId).toBe(GUARD_ID);
    expect(result.exit.id).toBeTruthy();
    expect(result.exit.traceId).toMatch(/^trace-/);
    expect(result.exit.createdAt).toBeTruthy();
    expect(result.traceId).toBe(result.exit.traceId);
  });

  it("emits exit_recorded audit event on success", async () => {
    const { db } = makeMockDB({
      entryRows: [{ id: ENTRY_ID }],
      exitRows: [],
    });

    const result = await recordExit(ENTRY_ID, GUARD_ID, db);
    const events = getExitRecordedEvents();

    expect(events).toHaveLength(1);
    expect(events[0].guardId).toBe(GUARD_ID);
    expect(events[0].traceId).toBe(result.traceId);
    expect(events[0].payload).toEqual({
      entryId: ENTRY_ID,
      exitId: result.exit.id,
    });
  });

  it("inserts exactly one row into exit_records", async () => {
    const { db, insertMock, insertValuesMock } = makeMockDB({
      entryRows: [{ id: ENTRY_ID }],
      exitRows: [],
    });

    const result = await recordExit(ENTRY_ID, GUARD_ID, db);

    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    const insertedRow = insertValuesMock.mock.calls[0][0];
    expect(insertedRow.entryId).toBe(ENTRY_ID);
    expect(insertedRow.guardId).toBe(GUARD_ID);
    expect(insertedRow.id).toBe(result.exit.id);
  });

  // Default-deny: no open entry
  it("throws EXIT_NO_OPEN_ENTRY when entry does not exist", async () => {
    const { db } = makeMockDB({ entryRows: [], exitRows: [] });

    await expect(recordExit("nonexistent-id", GUARD_ID, db)).rejects.toThrow(
      "No entry found",
    );

    const events = getExitBlockedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({
      entryId: "nonexistent-id",
      code: ExitErrorCodes.EXIT_NO_OPEN_ENTRY,
    });
  });

  it("returns status 404 for EXIT_NO_OPEN_ENTRY", async () => {
    const { db } = makeMockDB({ entryRows: [], exitRows: [] });

    try {
      await recordExit("nonexistent-id", GUARD_ID, db);
      expect.fail("should have thrown");
    } catch (err: unknown) {
      const sErr = err as import("../services/errors").ServiceError;
      expect(sErr.statusCode).toBe(404);
      expect(sErr.code).toBe(ExitErrorCodes.EXIT_NO_OPEN_ENTRY);
      expect(sErr.field).toBe("entryId");
    }
  });

  it("does not insert any exit row when entry is missing", async () => {
    const { db, insertMock } = makeMockDB({ entryRows: [], exitRows: [] });

    try {
      await recordExit("nonexistent-id", GUARD_ID, db);
    } catch {
      // expected
    }

    expect(insertMock).not.toHaveBeenCalled();
  });

  // Default-deny: already exited
  it("throws EXIT_ALREADY_RECORDED when exit already exists", async () => {
    const { db } = makeMockDB({
      entryRows: [{ id: ENTRY_ID }],
      exitRows: [{ id: "exit-existing" }],
    });

    await expect(recordExit(ENTRY_ID, GUARD_ID, db)).rejects.toThrow(
      "already been recorded",
    );

    const events = getExitBlockedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({
      entryId: ENTRY_ID,
      code: ExitErrorCodes.EXIT_ALREADY_RECORDED,
    });
  });

  it("returns status 409 for EXIT_ALREADY_RECORDED", async () => {
    const { db } = makeMockDB({
      entryRows: [{ id: ENTRY_ID }],
      exitRows: [{ id: "exit-existing" }],
    });

    try {
      await recordExit(ENTRY_ID, GUARD_ID, db);
      expect.fail("should have thrown");
    } catch (err: unknown) {
      const sErr = err as import("../services/errors").ServiceError;
      expect(sErr.statusCode).toBe(409);
      expect(sErr.code).toBe(ExitErrorCodes.EXIT_ALREADY_RECORDED);
    }
  });

  it("does not insert any exit row when entry already has an exit", async () => {
    const { db, insertMock } = makeMockDB({
      entryRows: [{ id: ENTRY_ID }],
      exitRows: [{ id: "exit-existing" }],
    });

    try {
      await recordExit(ENTRY_ID, GUARD_ID, db);
    } catch {
      // expected
    }

    expect(insertMock).not.toHaveBeenCalled();
  });

  // Audit: no audit event types leak across scenarios
  it("does not emit exit_recorded on failure paths", async () => {
    const { db: db1 } = makeMockDB({ entryRows: [], exitRows: [] });
    try { await recordExit("missing", GUARD_ID, db1); } catch { /* expected */ }

    const { db: db2 } = makeMockDB({
      entryRows: [{ id: ENTRY_ID }],
      exitRows: [{ id: "exit-existing" }],
    });
    try { await recordExit(ENTRY_ID, GUARD_ID, db2); } catch { /* expected */ }

    expect(getExitRecordedEvents()).toHaveLength(0);
    expect(getExitBlockedEvents()).toHaveLength(2);
  });

  // Guard attribution
  it("records the exit guard (may differ from entry guard)", async () => {
    const EXIT_GUARD = "guard-east-01";
    const { db } = makeMockDB({
      entryRows: [{ id: ENTRY_ID }],
      exitRows: [],
    });

    const result = await recordExit(ENTRY_ID, EXIT_GUARD, db);
    expect(result.exit.guardId).toBe(EXIT_GUARD);
  });

  // DB failure propagation
  it("propagates DB insert errors (no silent failure)", async () => {
    const { db } = makeMockDB({
      entryRows: [{ id: ENTRY_ID }],
      exitRows: [],
      insertFail: true,
    });

    await expect(recordExit(ENTRY_ID, GUARD_ID, db)).rejects.toThrow(
      "DB insert failed",
    );
  });

  // Trace ID format
  it("generates a unique trace ID per call", async () => {
    const { db: db1 } = makeMockDB({
      entryRows: [{ id: ENTRY_ID }],
      exitRows: [],
    });
    const { db: db2 } = makeMockDB({
      entryRows: [{ id: OTHER_ENTRY_ID }],
      exitRows: [],
    });

    const r1 = await recordExit(ENTRY_ID, GUARD_ID, db1);
    const r2 = await recordExit(OTHER_ENTRY_ID, GUARD_ID, db2);

    expect(r1.traceId).not.toBe(r2.traceId);
    expect(r1.traceId).toMatch(/^trace-/);
    expect(r2.traceId).toMatch(/^trace-/);
  });
});

// ─── listOnPremise ───────────────────────────────────────────────────────────

describe("listOnPremise", () => {
  it("returns entries from the LEFT JOIN exclusion query", async () => {
    const rows = [
      {
        id: ENTRY_ID,
        visitorName: "Maya Chen",
        host: "A. Okafor",
        unit: "18B",
        plate: "LND-482",
        method: "walk-in",
        guardId: GUARD_ID,
        createdAt: new Date("2024-06-01T10:30:00Z"),
      },
    ];
    const { db } = makeOnPremiseMockDB(rows);

    const result = await listOnPremise(db);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual({
      id: ENTRY_ID,
      visitorName: "Maya Chen",
      host: "A. Okafor",
      unit: "18B",
      plate: "LND-482",
      method: "walk-in",
      guardId: GUARD_ID,
      createdAt: "2024-06-01T10:30:00.000Z",
      notes: [],
    });
    expect(result.count).toBe(1);
    expect(result.traceId).toMatch(/^trace-/);
  });

  it("returns empty array when no entries are on-premise", async () => {
    const { db } = makeOnPremiseMockDB([]);

    const result = await listOnPremise(db);

    expect(result.entries).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("handles null plate values", async () => {
    const rows = [
      {
        id: ENTRY_ID,
        visitorName: "Pedestrian",
        host: "B. Smith",
        unit: "2A",
        plate: null,
        method: "qr",
        guardId: GUARD_ID,
        createdAt: "2024-06-01T10:30:00.000Z",
      },
    ];
    const { db } = makeOnPremiseMockDB(rows);

    const result = await listOnPremise(db);

    expect(result.entries[0].plate).toBeNull();
  });

  it("handles multiple on-premise entries", async () => {
    const rows = [
      {
        id: ENTRY_ID,
        visitorName: "Maya Chen",
        host: "A. Okafor",
        unit: "18B",
        plate: "LND-482",
        method: "walk-in",
        guardId: GUARD_ID,
        createdAt: "2024-06-01T10:30:00.000Z",
      },
      {
        id: OTHER_ENTRY_ID,
        visitorName: "Dario Miles",
        host: "N. Patel",
        unit: "07C",
        plate: "KJA-019",
        method: "qr",
        guardId: GUARD_ID,
        createdAt: "2024-06-01T11:00:00.000Z",
      },
    ];
    const { db } = makeOnPremiseMockDB(rows);

    const result = await listOnPremise(db);

    expect(result.entries).toHaveLength(2);
    expect(result.count).toBe(2);
  });

  it("does not emit any audit event (read-only operation)", async () => {
    const { db } = makeOnPremiseMockDB([]);

    await listOnPremise(db);

    expect(getAuditLog()).toHaveLength(0);
  });

  it("attaches guard notes to their entries (Feature 9)", async () => {
    const rows = [
      {
        id: ENTRY_ID,
        visitorName: "Maya Chen",
        host: "A. Okafor",
        unit: "18B",
        plate: "LND-482",
        method: "walk-in",
        guardId: GUARD_ID,
        createdAt: "2024-06-01T10:30:00.000Z",
      },
      {
        id: OTHER_ENTRY_ID,
        visitorName: "Dario Miles",
        host: "N. Patel",
        unit: "07C",
        plate: null,
        method: "qr",
        guardId: GUARD_ID,
        createdAt: "2024-06-01T11:00:00.000Z",
      },
    ];
    const noteRows = [
      {
        id: "note-1",
        entryId: ENTRY_ID,
        tag: "left_id_at_gate",
        text: null,
        guardId: GUARD_ID,
        createdAt: "2024-06-01T10:31:00.000Z",
      },
      {
        id: "note-2",
        entryId: ENTRY_ID,
        tag: "other",
        text: "Escalated to supervisor",
        guardId: GUARD_ID,
        createdAt: "2024-06-01T10:32:00.000Z",
      },
    ];
    const { db } = makeOnPremiseMockDB(rows, noteRows);

    const result = await listOnPremise(db);

    const first = result.entries.find((e) => e.id === ENTRY_ID);
    const second = result.entries.find((e) => e.id === OTHER_ENTRY_ID);
    expect(first?.notes).toHaveLength(2);
    expect(first?.notes[0].tag).toBe("left_id_at_gate");
    expect(first?.notes[1].text).toBe("Escalated to supervisor");
    expect(second?.notes).toEqual([]);
  });

  it("handles DB response without .rows wrapper (array directly)", async () => {
    const rows = [
      {
        id: ENTRY_ID,
        visitorName: "Test",
        host: "Host",
        unit: "1A",
        plate: null,
        method: "walk-in",
        guardId: GUARD_ID,
        createdAt: "2024-06-01T10:30:00.000Z",
      },
    ];
    const { db } = makeOnPremiseMockDB([]);
    // Return the array directly (no .rows wrapper)
    (db.execute as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(rows);

    const result = await listOnPremise(db);
    expect(result.entries).toHaveLength(1);
  });

  // Regression: the guard-notes lookup used a raw `entry_id = ANY(${ids})`,
  // which binds the whole array as ONE parameter. Postgres rejected it with
  // `malformed array literal`, so the entire on-premise list returned 500 as
  // soon as a single visitor was on premise. Every entry ID must be bound as
  // its own parameter.
  it("binds each entry id as its own parameter in the guard-notes lookup", async () => {
    const rows = [ENTRY_ID, OTHER_ENTRY_ID].map((id, i) => ({
      id,
      visitorName: `Visitor ${i}`,
      host: "Host",
      unit: "1A",
      plate: null,
      method: "walk-in",
      guardId: GUARD_ID,
      createdAt: "2024-06-01T10:30:00.000Z",
    }));
    const { db, whereMock } = makeOnPremiseMockDB(rows);

    await listOnPremise(db);

    expect(whereMock).toHaveBeenCalledTimes(1);
    const predicate = whereMock.mock.calls[0][0] as SQL;
    const query = new PgDialect().sqlToQuery(predicate);
    expect(query.params).toEqual([ENTRY_ID, OTHER_ENTRY_ID]);
    expect(query.sql).toMatch(/in \(\$1, \$2\)/i);
  });
});
