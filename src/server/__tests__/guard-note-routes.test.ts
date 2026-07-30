// @vitest-environment node
/**
 * GatePass — Guard Notes Route Handler Tests
 *
 * Source: src/docs/specs/guard-notes.md §4 (API surface).
 * Source: src/server/routes/guard-notes.ts
 *
 * Service-layer behaviour is covered in guard-note-service.test.ts.
 * These tests pin the ROUTE layer:
 *   - Body/param validation → 422 GUARD_NOTE_INVALID_INPUT + field + traceId
 *   - guardId comes from the authenticated request, not the body
 *   - Service success → 201 (create) / 200 (list)
 *   - Service ServiceError → propagated via next()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";

import {
  handleAddEntryNote,
  handleAddExitNote,
  handleListEntryNotes,
} from "../routes/guard-notes";
import * as service from "../services/guard-note-service";
import { ServiceError } from "../services/errors";
import type {
  AddGuardNoteResponse,
  ListGuardNotesResponse,
  GuardNoteView,
} from "../validation/guard-note-schemas";

interface MockCtx {
  req: Request;
  res: Response;
  next: (err?: unknown) => void;
  getStatus(): number;
  getJson(): unknown;
  getNextErr(): unknown;
}

function makeCtx({
  params,
  body,
  guardId,
}: {
  params?: Record<string, string>;
  body?: unknown;
  guardId?: string;
}): MockCtx {
  let statusCode = 200;
  let jsonBody: unknown = null;
  let nextErr: unknown = undefined;

  const req = {
    params: params ?? {},
    body: body ?? {},
    headers: {},
    guardId,
    db: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as Request;

  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: unknown) {
      jsonBody = payload;
      return res;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as Response;

  const next = (err?: unknown) => {
    nextErr = err;
  };

  return {
    req,
    res,
    next,
    getStatus: () => statusCode,
    getJson: () => jsonBody,
    getNextErr: () => nextErr,
  };
}

const GUARD_ID = "22222222-2222-4222-8222-222222222222";
const ENTRY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EXIT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function viewFor(overrides: Partial<GuardNoteView> = {}): GuardNoteView {
  return {
    id: "note-1",
    entryId: ENTRY_ID,
    exitId: null,
    guardId: GUARD_ID,
    tag: "left_id_at_gate",
    text: null,
    createdAt: "2024-06-01T10:31:00.000Z",
    traceId: "trace-abc",
    ...overrides,
  };
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("Route: POST /api/entries/:entryId/notes", () => {
  it("returns 422 when entryId is not a valid UUID", async () => {
    const ctx = makeCtx({
      params: { entryId: "not-a-uuid" },
      body: { tag: "left_id_at_gate" },
      guardId: GUARD_ID,
    });
    await handleAddEntryNote(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(422);
    expect(ctx.getJson()).toMatchObject({
      error: {
        code: "GUARD_NOTE_INVALID_INPUT",
        field: "entryId",
        traceId: expect.stringMatching(/^trace-/),
      },
    });
  });

  it("returns 422 when tag is not a known enum value", async () => {
    const ctx = makeCtx({
      params: { entryId: ENTRY_ID },
      body: { tag: "made_up_tag" },
      guardId: GUARD_ID,
    });
    await handleAddEntryNote(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(422);
    expect(ctx.getJson()).toMatchObject({
      error: { code: "GUARD_NOTE_INVALID_INPUT" },
    });
  });

  it("returns 422 when tag is 'other' but text is empty", async () => {
    const ctx = makeCtx({
      params: { entryId: ENTRY_ID },
      body: { tag: "other", text: "   " },
      guardId: GUARD_ID,
    });
    await handleAddEntryNote(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(422);
    expect(ctx.getJson()).toMatchObject({
      error: { code: "GUARD_NOTE_INVALID_INPUT", field: "text" },
    });
  });

  it("returns 422 when a non-'other' tag supplies free text", async () => {
    const ctx = makeCtx({
      params: { entryId: ENTRY_ID },
      body: { tag: "left_id_at_gate", text: "should not be here" },
      guardId: GUARD_ID,
    });
    await handleAddEntryNote(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(422);
    expect(ctx.getJson()).toMatchObject({
      error: { code: "GUARD_NOTE_INVALID_INPUT", field: "text" },
    });
  });

  it("returns 422 when 'other' text exceeds 280 chars", async () => {
    const ctx = makeCtx({
      params: { entryId: ENTRY_ID },
      body: { tag: "other", text: "x".repeat(281) },
      guardId: GUARD_ID,
    });
    await handleAddEntryNote(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(422);
    expect(ctx.getJson()).toMatchObject({
      error: { code: "GUARD_NOTE_INVALID_INPUT", field: "text" },
    });
  });

  it("returns 201 and uses guardId from the authenticated request, not the body", async () => {
    const spy = vi.spyOn(service, "addGuardNote").mockResolvedValue({
      note: viewFor(),
      traceId: "trace-abc",
    });

    const ctx = makeCtx({
      params: { entryId: ENTRY_ID },
      // an attacker-supplied guardId in the body must be ignored
      body: { tag: "left_id_at_gate", guardId: "attacker-guard" },
      guardId: GUARD_ID,
    });
    await handleAddEntryNote(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(201);
    const body = ctx.getJson() as AddGuardNoteResponse;
    expect(body.note.id).toBe("note-1");
    expect(body.traceId).toBe("trace-abc");
    expect(spy).toHaveBeenCalledWith(
      { kind: "entry", id: ENTRY_ID },
      GUARD_ID,
      { tag: "left_id_at_gate" },
      expect.anything(),
    );
  });

  it("forwards ServiceError (404) via next()", async () => {
    vi.spyOn(service, "addGuardNote").mockRejectedValue(
      new ServiceError(
        "GUARD_NOTE_TARGET_NOT_FOUND",
        "Entry not found",
        404,
        "entryId",
      ),
    );
    const ctx = makeCtx({
      params: { entryId: ENTRY_ID },
      body: { tag: "delivered_parcel" },
      guardId: GUARD_ID,
    });
    await handleAddEntryNote(ctx.req, ctx.res, ctx.next);
    const err = ctx.getNextErr() as ServiceError;
    expect(err).toBeInstanceOf(ServiceError);
    expect(err.statusCode).toBe(404);
  });
});

describe("Route: POST /api/exits/:exitId/notes", () => {
  it("returns 422 when exitId is not a valid UUID", async () => {
    const ctx = makeCtx({
      params: { exitId: "nope" },
      body: { tag: "escorted_by_resident" },
      guardId: GUARD_ID,
    });
    await handleAddExitNote(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(422);
    expect(ctx.getJson()).toMatchObject({
      error: { code: "GUARD_NOTE_INVALID_INPUT", field: "exitId" },
    });
  });

  it("returns 201 for a valid exit note", async () => {
    const spy = vi.spyOn(service, "addGuardNote").mockResolvedValue({
      note: viewFor({ entryId: null, exitId: EXIT_ID }),
      traceId: "trace-def",
    });
    const ctx = makeCtx({
      params: { exitId: EXIT_ID },
      body: { tag: "escorted_by_resident" },
      guardId: GUARD_ID,
    });
    await handleAddExitNote(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(201);
    expect(spy).toHaveBeenCalledWith(
      { kind: "exit", id: EXIT_ID },
      GUARD_ID,
      { tag: "escorted_by_resident" },
      expect.anything(),
    );
  });
});

describe("Route: GET /api/entries/:entryId/notes", () => {
  it("returns 200 with the notes list and count", async () => {
    vi.spyOn(service, "listNotesForEntry").mockResolvedValue({
      notes: [viewFor(), viewFor({ id: "note-2", tag: "other", text: "hi" })],
      traceId: "trace-list",
    });
    const ctx = makeCtx({ params: { entryId: ENTRY_ID }, guardId: GUARD_ID });
    await handleListEntryNotes(ctx.req, ctx.res, ctx.next);

    expect(ctx.getStatus()).toBe(200);
    const body = ctx.getJson() as ListGuardNotesResponse;
    expect(body.notes).toHaveLength(2);
    expect(body.count).toBe(2);
    expect(body.traceId).toBe("trace-list");
  });

  it("returns 422 for a bad entryId", async () => {
    const ctx = makeCtx({ params: { entryId: "bad" }, guardId: GUARD_ID });
    await handleListEntryNotes(ctx.req, ctx.res, ctx.next);
    expect(ctx.getStatus()).toBe(422);
  });

  it("forwards unexpected errors via next()", async () => {
    vi.spyOn(service, "listNotesForEntry").mockRejectedValue(
      new Error("db crashed"),
    );
    const ctx = makeCtx({ params: { entryId: ENTRY_ID }, guardId: GUARD_ID });
    await handleListEntryNotes(ctx.req, ctx.res, ctx.next);
    expect(ctx.getNextErr()).toBeInstanceOf(Error);
  });
});
