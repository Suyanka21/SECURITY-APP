// @vitest-environment node
/**
 * GatePass — Guard Notes Service Tests (TDD, behaviour-first)
 *
 * Source: src/docs/specs/guard-notes.md §§4–6
 * Source: Trustless-System-Auditor — a successful note writes exactly one audit
 *         row; a missing target default-denies (404) and writes NO note.
 * Source: Security-and-Hardening — guard attribution; audit payload excludes
 *         free text (may contain PII).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  addGuardNote,
  listNotesForEntry,
  type DrizzleDB,
} from "../services/guard-note-service";
import { GuardNoteErrorCodes } from "../validation/guard-note-schemas";
import {
  clearAuditLog,
  getAuditEventsByType,
} from "../services/audit-logger";
import { entryRecords, exitRecords, guardNotes } from "@/db/schema";
import type { ServiceError } from "../services/errors";

const GUARD_ID = "guard-west-04";
const ENTRY_ID = "11111111-1111-1111-1111-111111111111";
const EXIT_ID = "22222222-2222-2222-2222-222222222222";

interface MockOpts {
  /** Rows returned when selecting the target entry row. */
  entryRows?: Array<{ id: string }>;
  /** Rows returned when selecting the target exit row. */
  exitRows?: Array<{ id: string }>;
  /** Row returned from insert().values().returning(). */
  insertedRow?: Record<string, unknown> | null;
  /** Rows returned from a listNotesForEntry select. */
  listRows?: Array<Record<string, unknown>>;
}

function makeMockDB(opts: MockOpts = {}) {
  const returningMock = vi
    .fn()
    .mockImplementation(async () =>
      opts.insertedRow === null ? [] : [opts.insertedRow],
    );
  const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });
  const insertMock = vi.fn().mockReturnValue({ values: valuesMock });

  const fromMock = vi.fn().mockImplementation((table: unknown) => {
    if (table === guardNotes) {
      // listNotesForEntry: select().from(guardNotes).where(...) → rows
      return {
        where: vi.fn().mockImplementation(async () => opts.listRows ?? []),
      };
    }
    let rows: unknown[] = [];
    if (table === entryRecords) rows = opts.entryRows ?? [];
    else if (table === exitRecords) rows = opts.exitRows ?? [];
    return {
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockImplementation(async () => rows),
      }),
    };
  });

  const selectMock = vi.fn().mockReturnValue({ from: fromMock });

  return {
    db: {
      select: selectMock,
      insert: insertMock,
    } as unknown as DrizzleDB,
    valuesMock,
    insertMock,
  };
}

function insertedRowFor(overrides: Record<string, unknown> = {}) {
  return {
    id: "note-abc",
    entryId: ENTRY_ID,
    exitId: null,
    guardId: GUARD_ID,
    tag: "left_id_at_gate",
    noteText: null,
    traceId: "trace-xyz",
    createdAt: new Date("2024-06-01T10:31:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  clearAuditLog();
});

describe("addGuardNote — entry target", () => {
  it("inserts a note and returns the view when the entry exists", async () => {
    const { db, valuesMock } = makeMockDB({
      entryRows: [{ id: ENTRY_ID }],
      insertedRow: insertedRowFor(),
    });

    const result = await addGuardNote(
      { kind: "entry", id: ENTRY_ID },
      GUARD_ID,
      { tag: "left_id_at_gate" },
      db,
    );

    expect(result.note.entryId).toBe(ENTRY_ID);
    expect(result.note.exitId).toBeNull();
    expect(result.note.tag).toBe("left_id_at_gate");
    expect(result.note.text).toBeNull();
    expect(result.note.guardId).toBe(GUARD_ID);
    expect(result.traceId).toMatch(/^trace-/);

    // guardId + target came from args, not the body
    const inserted = valuesMock.mock.calls[0][0];
    expect(inserted.guardId).toBe(GUARD_ID);
    expect(inserted.entryId).toBe(ENTRY_ID);
    expect(inserted.exitId).toBeNull();
    expect(inserted.noteText).toBeNull();
  });

  it("persists free text only for the 'other' tag", async () => {
    const { db, valuesMock } = makeMockDB({
      entryRows: [{ id: ENTRY_ID }],
      insertedRow: insertedRowFor({ tag: "other", noteText: "Left a parcel" }),
    });

    const result = await addGuardNote(
      { kind: "entry", id: ENTRY_ID },
      GUARD_ID,
      { tag: "other", text: "Left a parcel" },
      db,
    );

    expect(valuesMock.mock.calls[0][0].noteText).toBe("Left a parcel");
    expect(result.note.text).toBe("Left a parcel");
  });

  it("drops free text for a non-'other' tag even if provided", async () => {
    const { db, valuesMock } = makeMockDB({
      entryRows: [{ id: ENTRY_ID }],
      insertedRow: insertedRowFor(),
    });

    await addGuardNote(
      { kind: "entry", id: ENTRY_ID },
      GUARD_ID,
      // service defends even if the boundary somehow let text through
      { tag: "left_id_at_gate", text: "ignored" },
      db,
    );

    expect(valuesMock.mock.calls[0][0].noteText).toBeNull();
  });

  it("emits exactly one guard_note_added audit event WITHOUT free text", async () => {
    const { db } = makeMockDB({
      entryRows: [{ id: ENTRY_ID }],
      insertedRow: insertedRowFor({ tag: "other", noteText: "PII maybe here" }),
    });

    const result = await addGuardNote(
      { kind: "entry", id: ENTRY_ID },
      GUARD_ID,
      { tag: "other", text: "PII maybe here" },
      db,
    );

    const events = getAuditEventsByType("guard_note_added");
    expect(events).toHaveLength(1);
    expect(events[0].guardId).toBe(GUARD_ID);
    expect(events[0].traceId).toBe(result.traceId);
    expect(events[0].payload).toEqual({
      noteId: "note-abc",
      tag: "other",
      entryId: ENTRY_ID,
    });
    // free text must never reach the audit trail
    expect(JSON.stringify(events[0].payload)).not.toContain("PII maybe here");
  });

  it("default-denies with 404 when the entry does not exist, writing nothing", async () => {
    const { db, insertMock } = makeMockDB({ entryRows: [] });

    try {
      await addGuardNote(
        { kind: "entry", id: ENTRY_ID },
        GUARD_ID,
        { tag: "left_id_at_gate" },
        db,
      );
      expect.fail("should have thrown");
    } catch (err) {
      const sErr = err as ServiceError;
      expect(sErr.statusCode).toBe(404);
      expect(sErr.code).toBe(GuardNoteErrorCodes.GUARD_NOTE_TARGET_NOT_FOUND);
      expect(sErr.field).toBe("entryId");
    }

    expect(insertMock).not.toHaveBeenCalled();
    expect(getAuditEventsByType("guard_note_added")).toHaveLength(0);
  });
});

describe("addGuardNote — exit target", () => {
  it("inserts a note against an existing exit record", async () => {
    const { db, valuesMock } = makeMockDB({
      exitRows: [{ id: EXIT_ID }],
      insertedRow: insertedRowFor({
        entryId: null,
        exitId: EXIT_ID,
        tag: "escorted_by_resident",
      }),
    });

    const result = await addGuardNote(
      { kind: "exit", id: EXIT_ID },
      GUARD_ID,
      { tag: "escorted_by_resident" },
      db,
    );

    expect(result.note.exitId).toBe(EXIT_ID);
    expect(result.note.entryId).toBeNull();
    const inserted = valuesMock.mock.calls[0][0];
    expect(inserted.exitId).toBe(EXIT_ID);
    expect(inserted.entryId).toBeNull();
    expect(getAuditEventsByType("guard_note_added")[0].payload).toEqual({
      noteId: "note-abc",
      tag: "escorted_by_resident",
      exitId: EXIT_ID,
    });
  });

  it("default-denies with 404 when the exit does not exist", async () => {
    const { db, insertMock } = makeMockDB({ exitRows: [] });

    await expect(
      addGuardNote(
        { kind: "exit", id: EXIT_ID },
        GUARD_ID,
        { tag: "escorted_by_resident" },
        db,
      ),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: GuardNoteErrorCodes.GUARD_NOTE_TARGET_NOT_FOUND,
      field: "exitId",
    });
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe("addGuardNote — write invariant", () => {
  it("throws when INSERT ... RETURNING yields no row (no silent success)", async () => {
    const { db } = makeMockDB({
      entryRows: [{ id: ENTRY_ID }],
      insertedRow: null,
    });

    await expect(
      addGuardNote(
        { kind: "entry", id: ENTRY_ID },
        GUARD_ID,
        { tag: "delivered_parcel" },
        db,
      ),
    ).rejects.toMatchObject({ statusCode: 500 });
    // audit is only written after a confirmed row
    expect(getAuditEventsByType("guard_note_added")).toHaveLength(0);
  });
});

describe("listNotesForEntry", () => {
  it("returns notes for an entry, oldest first", async () => {
    const { db } = makeMockDB({
      listRows: [
        {
          id: "n2",
          entryId: ENTRY_ID,
          exitId: null,
          guardId: GUARD_ID,
          tag: "other",
          noteText: "second",
          traceId: "t2",
          createdAt: "2024-06-01T10:32:00.000Z",
        },
        {
          id: "n1",
          entryId: ENTRY_ID,
          exitId: null,
          guardId: GUARD_ID,
          tag: "left_id_at_gate",
          noteText: null,
          traceId: "t1",
          createdAt: "2024-06-01T10:31:00.000Z",
        },
      ],
    });

    const result = await listNotesForEntry(ENTRY_ID, db);

    expect(result.notes).toHaveLength(2);
    expect(result.notes[0].id).toBe("n1");
    expect(result.notes[1].id).toBe("n2");
    expect(result.notes[0].text).toBeNull();
    expect(result.notes[1].text).toBe("second");
  });

  it("returns an empty list when the entry has no notes", async () => {
    const { db } = makeMockDB({ listRows: [] });
    const result = await listNotesForEntry(ENTRY_ID, db);
    expect(result.notes).toEqual([]);
  });
});
