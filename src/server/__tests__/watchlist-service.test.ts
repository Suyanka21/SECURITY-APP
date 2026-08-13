// @vitest-environment node
/**
 * GatePass — Watchlist Service Tests (Feature 12 / Stage 5, behaviour-first)
 *
 * Source: src/docs/specs/watchlist.md §§2–4, §6, §7
 * Source: Trustless-System-Auditor — the dangerous failure here is a warning
 *         that silently disappears, or a warning that turns into a block.
 *         Both are asserted against explicitly.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  checkWatchlistForEntry,
  computeReviewDueAt,
  createWatchlistEntry,
  findWatchlistMatch,
  isReviewOverdue,
  listWatchlistEntries,
  removeWatchlistEntry,
  reviewWatchlistEntry,
  type DrizzleDB,
} from "../services/watchlist-service";
import {
  WATCHLIST_REVIEW_INTERVAL_DAYS,
  WatchlistErrorCodes,
} from "../validation/watchlist-schemas";
import { clearAuditLog, getAuditEventsByType } from "../services/audit-logger";
import type { ServiceError } from "../services/errors";

const ADMIN_ID = "admin-01";
const ENTRY_UUID = "33333333-3333-3333-3333-333333333333";

function rowFor(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: ENTRY_UUID,
    subjectName: "JOHN DOE",
    subjectNameDisplay: "John Doe",
    subjectPlate: null,
    reason: "Attempted forced entry on 12 Dec",
    status: "active",
    addedByGuardId: ADMIN_ID,
    lastReviewedAt: now,
    reviewDueAt: computeReviewDueAt(now),
    removedByGuardId: null,
    removedReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

interface MockOpts {
  /** Rows returned by any select on watchlist_entries. */
  selectRows?: Array<Record<string, unknown>>;
  /** Row(s) returned by insert(...).returning(). */
  insertedRow?: Record<string, unknown> | null;
  /** Row(s) returned by update(...).returning(). */
  updatedRow?: Record<string, unknown> | null;
  /** Makes every select throw — simulates a watchlist lookup outage. */
  selectThrows?: boolean;
}

function makeMockDB(opts: MockOpts = {}) {
  const rows = opts.selectRows ?? [];

  const insertReturning = vi
    .fn()
    .mockImplementation(async () =>
      opts.insertedRow === null ? [] : [opts.insertedRow ?? rowFor()],
    );
  const valuesMock = vi.fn().mockReturnValue({ returning: insertReturning });
  const insertMock = vi.fn().mockReturnValue({ values: valuesMock });

  const updateReturning = vi
    .fn()
    .mockImplementation(async () =>
      opts.updatedRow === null ? [] : [opts.updatedRow ?? rowFor()],
    );
  const whereUpdate = vi.fn().mockReturnValue({ returning: updateReturning });
  const setMock = vi.fn().mockReturnValue({ where: whereUpdate });
  const updateMock = vi.fn().mockReturnValue({ set: setMock });

  // select().from() must satisfy BOTH shapes used by the service:
  //   awaited directly (list / match)  and  .where(...).limit(1) (load one)
  const fromMock = vi.fn().mockImplementation(() => {
    if (opts.selectThrows) {
      throw new Error("watchlist lookup unavailable");
    }
    const whereResult = Object.assign(Promise.resolve(rows), {
      limit: vi.fn().mockImplementation(async () => rows),
    });
    const builder = Object.assign(Promise.resolve(rows), {
      where: vi.fn().mockReturnValue(whereResult),
    });
    return builder;
  });

  const selectMock = vi.fn().mockReturnValue({ from: fromMock });

  return {
    db: {
      select: selectMock,
      insert: insertMock,
      update: updateMock,
    } as unknown as DrizzleDB,
    valuesMock,
    setMock,
  };
}

beforeEach(() => {
  clearAuditLog();
});

// ─── Create ──────────────────────────────────────────────────────────────────

describe("createWatchlistEntry", () => {
  it("stores the normalized name, the display name and the mandatory reason", async () => {
    const { db, valuesMock } = makeMockDB({ insertedRow: rowFor() });

    const result = await createWatchlistEntry(
      { subjectName: "  john   doe ", reason: "Attempted forced entry on 12 Dec" },
      ADMIN_ID,
      db,
    );

    const inserted = valuesMock.mock.calls[0][0];
    expect(inserted.subjectName).toBe("JOHN DOE");
    expect(inserted.subjectNameDisplay).toBe("john   doe");
    expect(inserted.reason).toBe("Attempted forced entry on 12 Dec");
    expect(inserted.status).toBe("active");
    expect(result.entry.reason).toBe("Attempted forced entry on 12 Dec");
  });

  it("attributes the entry to the authenticated guard, never to client input", async () => {
    const { db, valuesMock } = makeMockDB({ insertedRow: rowFor() });

    await createWatchlistEntry(
      {
        subjectName: "John Doe",
        reason: "Trespass",
        // A hostile client cannot smuggle identity through the payload —
        // the service only ever reads the guardId argument.
        ...({ addedByGuardId: "someone-else" } as Record<string, unknown>),
      },
      ADMIN_ID,
      db,
    );

    expect(valuesMock.mock.calls[0][0].addedByGuardId).toBe(ADMIN_ID);
  });

  it("normalizes the optional plate and leaves it null when absent", async () => {
    const { db, valuesMock } = makeMockDB({ insertedRow: rowFor() });

    await createWatchlistEntry(
      { subjectName: "John Doe", subjectPlate: "gr 1234-a", reason: "Trespass" },
      ADMIN_ID,
      db,
    );
    expect(valuesMock.mock.calls[0][0].subjectPlate).toBe("GR1234A");

    const second = makeMockDB({ insertedRow: rowFor() });
    await createWatchlistEntry(
      { subjectName: "John Doe", reason: "Trespass" },
      ADMIN_ID,
      second.db,
    );
    expect(second.valuesMock.mock.calls[0][0].subjectPlate).toBeNull();
  });

  it("sets the review clock to now + the review interval", async () => {
    const { db, valuesMock } = makeMockDB({ insertedRow: rowFor() });

    await createWatchlistEntry(
      { subjectName: "John Doe", reason: "Trespass" },
      ADMIN_ID,
      db,
    );

    const inserted = valuesMock.mock.calls[0][0];
    const gapMs =
      new Date(inserted.reviewDueAt).getTime() -
      new Date(inserted.lastReviewedAt).getTime();
    expect(gapMs).toBe(WATCHLIST_REVIEW_INTERVAL_DAYS * 24 * 60 * 60 * 1000);
  });

  it("writes exactly one watchlist_entry_added audit event", async () => {
    const { db } = makeMockDB({ insertedRow: rowFor() });

    await createWatchlistEntry(
      { subjectName: "John Doe", reason: "Trespass" },
      ADMIN_ID,
      db,
    );

    const events = getAuditEventsByType("watchlist_entry_added");
    expect(events).toHaveLength(1);
    expect(events[0].guardId).toBe(ADMIN_ID);
    expect(events[0].payload).toMatchObject({ watchlistEntryId: ENTRY_UUID });
  });
});

// ─── Review model (spec §7, Option 2) ────────────────────────────────────────

describe("review model", () => {
  it("flags an entry overdue only once its review date has passed", () => {
    const past = rowFor({ reviewDueAt: new Date("2020-01-01T00:00:00.000Z") });
    const future = rowFor({ reviewDueAt: new Date("2999-01-01T00:00:00.000Z") });

    expect(isReviewOverdue(past)).toBe(true);
    expect(isReviewOverdue(future)).toBe(false);
  });

  it("never marks a removed entry overdue — removal ends the lifecycle", () => {
    const removed = rowFor({
      status: "removed",
      reviewDueAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    expect(isReviewOverdue(removed)).toBe(false);
  });

  it("resets the review clock on reconfirmation and audits it", async () => {
    const overdue = rowFor({ reviewDueAt: new Date("2020-01-01T00:00:00.000Z") });
    const { db, setMock } = makeMockDB({
      selectRows: [overdue],
      updatedRow: rowFor(),
    });

    await reviewWatchlistEntry(ENTRY_UUID, {}, ADMIN_ID, db);

    const patch = setMock.mock.calls[0][0];
    expect(patch.lastReviewedAt).toBeInstanceOf(Date);
    expect(new Date(patch.reviewDueAt).getTime()).toBeGreaterThan(Date.now());
    // An empty body is a valid review: "still warranted".
    expect(patch.reason).toBeUndefined();

    const events = getAuditEventsByType("watchlist_entry_reviewed");
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ wasOverdue: true });
  });

  it("can revise the reason during a review", async () => {
    const { db, setMock } = makeMockDB({
      selectRows: [rowFor()],
      updatedRow: rowFor({ reason: "Updated: barred by estate manager" }),
    });

    const result = await reviewWatchlistEntry(
      ENTRY_UUID,
      { reason: "Updated: barred by estate manager" },
      ADMIN_ID,
      db,
    );

    expect(setMock.mock.calls[0][0].reason).toBe("Updated: barred by estate manager");
    expect(result.entry.reason).toBe("Updated: barred by estate manager");
  });

  it("refuses to review a removed entry instead of silently resurrecting it", async () => {
    const { db } = makeMockDB({
      selectRows: [rowFor({ status: "removed", removedByGuardId: ADMIN_ID, removedReason: "Cleared" })],
    });

    await expect(
      reviewWatchlistEntry(ENTRY_UUID, {}, ADMIN_ID, db),
    ).rejects.toMatchObject({
      code: WatchlistErrorCodes.WATCHLIST_ALREADY_REMOVED,
      statusCode: 409,
    });
    expect(getAuditEventsByType("watchlist_entry_reviewed")).toHaveLength(0);
  });

  it("404s on an unknown id rather than treating it as a no-op", async () => {
    const { db } = makeMockDB({ selectRows: [] });

    const err = (await reviewWatchlistEntry(ENTRY_UUID, {}, ADMIN_ID, db).catch(
      (e: ServiceError) => e,
    )) as ServiceError;

    expect(err.code).toBe(WatchlistErrorCodes.WATCHLIST_NOT_FOUND);
    expect(err.statusCode).toBe(404);
  });
});

// ─── Removal ─────────────────────────────────────────────────────────────────

describe("removeWatchlistEntry", () => {
  it("soft-removes with attribution and reason, and audits it", async () => {
    const { db, setMock } = makeMockDB({
      selectRows: [rowFor()],
      updatedRow: rowFor({
        status: "removed",
        removedByGuardId: ADMIN_ID,
        removedReason: "Resolved with the resident",
      }),
    });

    const result = await removeWatchlistEntry(
      ENTRY_UUID,
      { removedReason: "Resolved with the resident" },
      ADMIN_ID,
      db,
    );

    const patch = setMock.mock.calls[0][0];
    expect(patch.status).toBe("removed");
    expect(patch.removedByGuardId).toBe(ADMIN_ID);
    expect(patch.removedReason).toBe("Resolved with the resident");
    expect(result.entry.status).toBe("removed");
    expect(getAuditEventsByType("watchlist_entry_removed")).toHaveLength(1);
  });

  it("rejects a second removal (409) instead of rewriting the removal record", async () => {
    const { db } = makeMockDB({
      selectRows: [
        rowFor({ status: "removed", removedByGuardId: ADMIN_ID, removedReason: "Cleared" }),
      ],
    });

    await expect(
      removeWatchlistEntry(ENTRY_UUID, { removedReason: "again" }, ADMIN_ID, db),
    ).rejects.toMatchObject({
      code: WatchlistErrorCodes.WATCHLIST_ALREADY_REMOVED,
    });
  });

  it("treats losing a concurrent-removal race as a 409, not a success", async () => {
    const { db } = makeMockDB({
      selectRows: [rowFor()],
      updatedRow: null, // conditional UPDATE matched zero rows
    });

    await expect(
      removeWatchlistEntry(ENTRY_UUID, { removedReason: "Cleared" }, ADMIN_ID, db),
    ).rejects.toMatchObject({
      code: WatchlistErrorCodes.WATCHLIST_ALREADY_REMOVED,
    });
    expect(getAuditEventsByType("watchlist_entry_removed")).toHaveLength(0);
  });
});

// ─── List ────────────────────────────────────────────────────────────────────

describe("listWatchlistEntries", () => {
  it("derives reviewOverdue per row and counts overdue actives", async () => {
    const { db } = makeMockDB({
      selectRows: [
        rowFor({ id: "a", reviewDueAt: new Date("2020-01-01T00:00:00.000Z") }),
        rowFor({ id: "b", reviewDueAt: new Date("2999-01-01T00:00:00.000Z") }),
      ],
    });

    const result = await listWatchlistEntries(
      { status: "active", needsReview: false },
      db,
    );

    expect(result.entries.map((e) => e.reviewOverdue)).toEqual([true, false]);
    expect(result.overdueCount).toBe(1);
  });

  it("exposes the display name, not the normalized matching form", async () => {
    const { db } = makeMockDB({ selectRows: [rowFor()] });

    const result = await listWatchlistEntries(
      { status: "all", needsReview: false },
      db,
    );

    expect(result.entries[0].subjectName).toBe("John Doe");
  });
});

// ─── Matching ────────────────────────────────────────────────────────────────

describe("findWatchlistMatch", () => {
  it("matches on a normalized name regardless of case and spacing", async () => {
    const { db } = makeMockDB({ selectRows: [rowFor()] });

    const match = await findWatchlistMatch(
      { visitorName: "  john   DOE ", plate: null },
      db,
    );

    expect(match).toMatchObject({
      matched: true,
      entryId: ENTRY_UUID,
      matchedOn: "name",
      requiresEscalation: true,
      reason: "Attempted forced entry on 12 Dec",
    });
  });

  it("matches on plate alone when the name differs", async () => {
    const { db } = makeMockDB({
      selectRows: [rowFor({ subjectName: "SOMEONE ELSE", subjectPlate: "GR1234A" })],
    });

    const match = await findWatchlistMatch(
      { visitorName: "John Doe", plate: "gr-1234 a" },
      db,
    );

    expect(match?.matchedOn).toBe("plate");
  });

  it("prefers the most specific match (name+plate) when several rows hit", async () => {
    const { db } = makeMockDB({
      selectRows: [
        rowFor({ id: "name-only" }),
        rowFor({ id: "both", subjectPlate: "GR1234A" }),
      ],
    });

    const match = await findWatchlistMatch(
      { visitorName: "John Doe", plate: "GR1234A" },
      db,
    );

    expect(match?.entryId).toBe("both");
    expect(match?.matchedOn).toBe("name+plate");
  });

  it("returns null when nothing matches", async () => {
    const { db } = makeMockDB({ selectRows: [] });
    expect(
      await findWatchlistMatch({ visitorName: "Nobody", plate: null }, db),
    ).toBeNull();
  });

  it("returns null when there is nothing to match on", async () => {
    const { db } = makeMockDB({ selectRows: [rowFor()] });
    expect(await findWatchlistMatch({ visitorName: "", plate: "" }, db)).toBeNull();
  });

  it("still matches an entry that is overdue for review — overdue never silences a warning", async () => {
    const { db } = makeMockDB({
      selectRows: [rowFor({ reviewDueAt: new Date("2020-01-01T00:00:00.000Z") })],
    });

    const match = await findWatchlistMatch(
      { visitorName: "John Doe", plate: null },
      db,
    );

    expect(match).not.toBeNull();
  });
});

describe("checkWatchlistForEntry", () => {
  it("audits the match as a warning that requires escalation — never as a denial", async () => {
    const { db } = makeMockDB({ selectRows: [rowFor()] });

    const match = await checkWatchlistForEntry(
      { visitorName: "John Doe", plate: null },
      "guard-77",
      "trace-1",
      db,
    );

    expect(match?.requiresEscalation).toBe(true);
    const events = getAuditEventsByType("watchlist_matched");
    expect(events).toHaveLength(1);
    expect(events[0].guardId).toBe("guard-77");
    expect(events[0].payload).toMatchObject({
      watchlistEntryId: ENTRY_UUID,
      matchedOn: "name",
      outcome: "warned_requires_escalation",
    });
  });

  it("emits no audit event and no warning when there is no match", async () => {
    const { db } = makeMockDB({ selectRows: [] });

    expect(
      await checkWatchlistForEntry(
        { visitorName: "Nobody", plate: null },
        "guard-77",
        "trace-1",
        db,
      ),
    ).toBeNull();
    expect(getAuditEventsByType("watchlist_matched")).toHaveLength(0);
  });

  it("degrades to no warning (never throws) if the lookup fails — a gate operation must not break", async () => {
    const { db } = makeMockDB({ selectThrows: true });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      checkWatchlistForEntry(
        { visitorName: "John Doe", plate: null },
        "guard-77",
        "trace-1",
        db,
      ),
    ).resolves.toBeNull();

    // Degrading must not be silent — "no warning shown" has to be traceable to
    // a lookup failure rather than to an absent watchlist entry.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain("trace-1");
    spy.mockRestore();
  });
});
