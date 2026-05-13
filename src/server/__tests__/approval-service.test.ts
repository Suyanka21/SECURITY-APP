// @vitest-environment node
/**
 * GatePass — Approval Service Tests (TDD)
 *
 * Source: src/docs/specs/resident-approval-flow.md §§5–9
 * Source: Test-Driven-Development skill — "failing test first; behavior, not impl"
 * Source: Trustless-System-Auditor skill — every failure path is provable
 *
 * Each test reads like a specification — DAMP over DRY, no shared mutable state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createApprovalRequest,
  decideApprovalRequest,
  getApprovalStatus,
  hashToken,
  ServiceError,
} from "../services/approval-service";
import {
  approvalRequests,
  entryRecords,
  guards,
} from "@/db/schema";

// ─── Mock DB factory ─────────────────────────────────────────────────────────

interface ApprovalRowState {
  id: string;
  offlineId: string;
  visitorName: string;
  host: string;
  unit: string;
  plate: string | null;
  reason: string;
  method: "walk-in";
  requestedByGuardId: string;
  tokenHash: string | null;
  status: "pending" | "approved" | "denied" | "expired";
  decidedAt: Date | null;
  deniedReason: string | null;
  entryId: string | null;
  expiresAt: Date;
  createdAt: Date;
  traceId: string;
}

interface MockDBOpts {
  guardActive?: boolean;
  guardExists?: boolean;
  approval?: ApprovalRowState | null;
  duplicateOfflineId?: boolean;
  /** Fail the entry insert inside the approve transaction */
  entryInsertError?: Error;
}

function makeMockDB(opts: MockDBOpts = {}) {
  const {
    guardActive = true,
    guardExists = true,
    approval = null,
    duplicateOfflineId = false,
    entryInsertError,
  } = opts;

  let storedApproval: ApprovalRowState | null = approval;
  const insertedEntries: unknown[] = [];
  const insertedApprovals: unknown[] = [];

  const buildInsertMock = (insideTx: boolean) =>
    vi.fn().mockImplementation((table: unknown) => ({
      values: vi.fn().mockImplementation((row: unknown) => {
        if (table === entryRecords) {
          if (entryInsertError) return Promise.reject(entryInsertError);
          insertedEntries.push(row);
          return Promise.resolve();
        }
        if (table === approvalRequests) {
          insertedApprovals.push(row);
          storedApproval = row as ApprovalRowState;
          return Promise.resolve();
        }
        return Promise.resolve();
      }),
      _insideTx: insideTx,
    }));

  const updateMock = vi.fn().mockImplementation((table: unknown) => ({
    set: vi.fn().mockImplementation((patch: Partial<ApprovalRowState>) => ({
      where: vi.fn().mockImplementation(() => {
        if (table === approvalRequests && storedApproval) {
          // Only apply if the WHERE matched our single row & it was pending.
          // The service narrows by id + status='pending'; we honor that here.
          if (storedApproval.status === "pending" || patch.status === "expired") {
            storedApproval = { ...storedApproval, ...patch };
          }
        }
        return Promise.resolve();
      }),
    })),
  }));

  return {
    select: vi.fn().mockImplementation((..._args: unknown[]) => ({
      from: vi.fn().mockImplementation((table: unknown) => ({
        where: vi.fn().mockImplementation(() => ({
          limit: vi.fn().mockImplementation(() => {
            if (table === guards) {
              if (!guardExists) return Promise.resolve([]);
              return Promise.resolve([
                { id: "guard-1", isActive: guardActive },
              ]);
            }
            if (table === approvalRequests) {
              // Duplicate offlineId path — only fired during INSERT preflight
              // because the spec inserts a row + checks for existing one.
              if (duplicateOfflineId && !storedApproval) {
                return Promise.resolve([{ id: "approval-existing" }]);
              }
              if (storedApproval) return Promise.resolve([storedApproval]);
              return Promise.resolve([]);
            }
            return Promise.resolve([]);
          }),
        })),
      })),
    })),
    insert: buildInsertMock(false),
    update: updateMock,
    transaction: vi.fn().mockImplementation(async (cb: any) => {
      const snapshotEntries = insertedEntries.length;
      const snapshotApproval = storedApproval ? { ...storedApproval } : null;
      const tx = {
        insert: buildInsertMock(true),
        update: updateMock,
      };
      try {
        await cb(tx);
      } catch (err) {
        // Roll back side effects
        insertedEntries.length = snapshotEntries;
        storedApproval = snapshotApproval;
        throw err;
      }
    }),
    query: {},
    _getApproval: () => storedApproval,
    _insertedEntries: insertedEntries,
    _insertedApprovals: insertedApprovals,
    _updateMock: updateMock,
  };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function validCreateInput() {
  return {
    offlineId: "11111111-1111-4111-8111-111111111111",
    draft: {
      visitorName: "Maya Chen",
      host: "A. Okafor",
      unit: "18B",
      plate: "LND-482",
      reason: "Visiting host",
      method: "walk-in" as const,
    },
  };
}

function pendingApproval(overrides: Partial<ApprovalRowState> = {}): ApprovalRowState {
  const expires = new Date(Date.now() + 300_000);
  return {
    id: "approval-1",
    offlineId: "11111111-1111-4111-8111-111111111111",
    visitorName: "Maya Chen",
    host: "A. Okafor",
    unit: "18B",
    plate: "LND-482",
    reason: "",
    method: "walk-in",
    requestedByGuardId: "guard-1",
    tokenHash: hashToken("a".repeat(64)),
    status: "pending",
    decidedAt: null,
    deniedReason: null,
    entryId: null,
    expiresAt: expires,
    createdAt: new Date(),
    traceId: "trace-1",
    ...overrides,
  };
}

// Freeze the clock for deterministic expiry tests.
let frozenMs = 0;
const fixedClock = { now: () => frozenMs };

beforeEach(() => {
  frozenMs = Date.UTC(2025, 0, 1, 12, 0, 0); // 2025-01-01T12:00:00Z
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── createApprovalRequest ────────────────────────────────────────────────────

describe("ApprovalService.createApprovalRequest", () => {
  it("inserts a pending row and returns a magic-link URL with the raw token", async () => {
    const db = makeMockDB();
    const { response, statusCode } = await createApprovalRequest(
      validCreateInput(),
      "guard-1",
      db,
      fixedClock
    );

    expect(statusCode).toBe(201);
    expect(response.approvalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.magicLinkUrl).toMatch(
      /^https?:\/\/.+\/approve\/[0-9a-f-]{36}\?token=[0-9a-f]{64}$/
    );
    expect(response.traceId).toMatch(/^trace-/);

    const inserted = db._insertedApprovals[0] as ApprovalRowState;
    expect(inserted.status).toBe("pending");
    expect(inserted.requestedByGuardId).toBe("guard-1");
    expect(inserted.offlineId).toBe(validCreateInput().offlineId);
    expect(inserted.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect((inserted as any).tokenHash).not.toEqual(response.magicLinkUrl);
  });

  it("never stores the raw token — only SHA-256(token)", async () => {
    const db = makeMockDB();
    const { response } = await createApprovalRequest(
      validCreateInput(),
      "guard-1",
      db,
      fixedClock
    );

    const tokenFromUrl = new URL(response.magicLinkUrl).searchParams.get("token")!;
    const inserted = db._insertedApprovals[0] as ApprovalRowState;
    expect(inserted.tokenHash).toBe(hashToken(tokenFromUrl));
    expect(inserted.tokenHash).not.toBe(tokenFromUrl);
  });

  it("returns 403 GUARD_SESSION_EXPIRED when the guard is inactive", async () => {
    const db = makeMockDB({ guardActive: false });
    await expect(
      createApprovalRequest(validCreateInput(), "guard-1", db, fixedClock)
    ).rejects.toMatchObject({
      code: "GUARD_SESSION_EXPIRED",
      statusCode: 403,
    });
  });

  it("returns 403 GUARD_SESSION_EXPIRED when the guard is unknown", async () => {
    const db = makeMockDB({ guardExists: false });
    await expect(
      createApprovalRequest(validCreateInput(), "guard-1", db, fixedClock)
    ).rejects.toBeInstanceOf(ServiceError);
  });

  it("returns 409 APPROVAL_DUPLICATE when the offlineId already has a row", async () => {
    const db = makeMockDB({ duplicateOfflineId: true });
    await expect(
      createApprovalRequest(validCreateInput(), "guard-1", db, fixedClock)
    ).rejects.toMatchObject({
      code: "APPROVAL_DUPLICATE",
      statusCode: 409,
      field: "offlineId",
    });
  });
});

// ─── getApprovalStatus ────────────────────────────────────────────────────────

describe("ApprovalService.getApprovalStatus", () => {
  it("returns the pending approval view without leaking the tokenHash", async () => {
    const db = makeMockDB({ approval: pendingApproval() });
    const { response } = await getApprovalStatus(
      "approval-1",
      "guard-1",
      db,
      fixedClock
    );

    expect(response.approval.status).toBe("pending");
    expect(response.approval.id).toBe("approval-1");
    expect((response.approval as any).tokenHash).toBeUndefined();
  });

  it("returns 404 APPROVAL_NOT_FOUND when the row is missing", async () => {
    const db = makeMockDB({ approval: null });
    await expect(
      getApprovalStatus("approval-missing", "guard-1", db, fixedClock)
    ).rejects.toMatchObject({
      code: "APPROVAL_NOT_FOUND",
      statusCode: 404,
    });
  });

  it("returns 403 APPROVAL_GUARD_MISMATCH when read by a different guard", async () => {
    const db = makeMockDB({
      approval: pendingApproval({ requestedByGuardId: "guard-OTHER" }),
    });
    await expect(
      getApprovalStatus("approval-1", "guard-1", db, fixedClock)
    ).rejects.toMatchObject({
      code: "APPROVAL_GUARD_MISMATCH",
      statusCode: 403,
    });
  });

  it("lazily flips pending → expired when read past expires_at", async () => {
    const expiredRow = pendingApproval({
      expiresAt: new Date(frozenMs - 1_000),
    });
    const db = makeMockDB({ approval: expiredRow });

    const { response } = await getApprovalStatus(
      "approval-1",
      "guard-1",
      db,
      fixedClock
    );

    expect(response.approval.status).toBe("expired");
    expect(response.approval.decidedAt).not.toBeNull();
    expect(db._updateMock).toHaveBeenCalled();
    // After flip, the stored row reflects the new status.
    expect(db._getApproval()?.status).toBe("expired");
    expect(db._getApproval()?.tokenHash).toBeNull();
  });

  it("does NOT flip a non-pending row even if past expires_at", async () => {
    const db = makeMockDB({
      approval: pendingApproval({
        status: "approved",
        decidedAt: new Date(frozenMs - 10_000),
        entryId: "entry-1",
        tokenHash: null,
        expiresAt: new Date(frozenMs - 1_000),
      }),
    });
    const { response } = await getApprovalStatus(
      "approval-1",
      "guard-1",
      db,
      fixedClock
    );
    expect(response.approval.status).toBe("approved");
    expect(db._updateMock).not.toHaveBeenCalled();
  });
});

// ─── decideApprovalRequest (deny path) ────────────────────────────────────────

describe("ApprovalService.decideApprovalRequest — deny", () => {
  it("transitions pending → denied with a sanitized reason and wipes the token", async () => {
    const raw = "a".repeat(64);
    const db = makeMockDB({ approval: pendingApproval({ tokenHash: hashToken(raw) }) });

    const { response } = await decideApprovalRequest(
      "approval-1",
      raw,
      "deny",
      "  not\u0007 expected  ",
      db,
      fixedClock
    );

    expect(response.approval.status).toBe("denied");
    expect(response.approval.deniedReason).toBe("not expected");
    expect(response.entry).toBeNull();

    const stored = db._getApproval()!;
    expect(stored.status).toBe("denied");
    expect(stored.tokenHash).toBeNull();
    expect(stored.deniedReason).toBe("not expected");
    expect(stored.decidedAt).toBeInstanceOf(Date);
  });

  it("returns 422 APPROVAL_DENY_REASON_REQUIRED when reason is empty after sanitization", async () => {
    const raw = "b".repeat(64);
    const db = makeMockDB({ approval: pendingApproval({ tokenHash: hashToken(raw) }) });

    await expect(
      decideApprovalRequest("approval-1", raw, "deny", "   \u0007 ", db, fixedClock)
    ).rejects.toMatchObject({
      code: "APPROVAL_DENY_REASON_REQUIRED",
      statusCode: 422,
      field: "reason",
    });
  });
});

// ─── decideApprovalRequest (approve path) ─────────────────────────────────────

describe("ApprovalService.decideApprovalRequest — approve", () => {
  it("transactionally creates an entry record and flips pending → approved", async () => {
    const raw = "c".repeat(64);
    const db = makeMockDB({ approval: pendingApproval({ tokenHash: hashToken(raw) }) });

    const { response, statusCode } = await decideApprovalRequest(
      "approval-1",
      raw,
      "approve",
      undefined,
      db,
      fixedClock
    );

    expect(statusCode).toBe(200);
    expect(response.approval.status).toBe("approved");
    expect(response.approval.entryId).toBeTruthy();
    expect(response.entry).not.toBeNull();
    expect(response.entry!.id).toBe(response.approval.entryId);
    expect(response.entry!.method).toBe("walk-in");

    expect(db._insertedEntries.length).toBe(1);
    const stored = db._getApproval()!;
    expect(stored.status).toBe("approved");
    expect(stored.tokenHash).toBeNull();
    expect(stored.entryId).toBeTruthy();
    expect(db.transaction).toHaveBeenCalled();
  });

  it("rolls back the approval transition if the entry insert fails (no silent partial write)", async () => {
    const raw = "d".repeat(64);
    const db = makeMockDB({
      approval: pendingApproval({ tokenHash: hashToken(raw) }),
      entryInsertError: new Error("entry insert exploded"),
    });

    await expect(
      decideApprovalRequest("approval-1", raw, "approve", undefined, db, fixedClock)
    ).rejects.toThrow("entry insert exploded");

    const stored = db._getApproval()!;
    expect(stored.status).toBe("pending");
    expect(stored.entryId).toBeNull();
    expect(stored.tokenHash).not.toBeNull();
    expect(db._insertedEntries.length).toBe(0);
  });
});

// ─── decideApprovalRequest (token + state error paths) ────────────────────────

describe("ApprovalService.decideApprovalRequest — error paths", () => {
  it("returns 404 APPROVAL_NOT_FOUND when the approval id is unknown", async () => {
    const db = makeMockDB({ approval: null });
    await expect(
      decideApprovalRequest("approval-missing", "x".repeat(64), "approve", undefined, db, fixedClock)
    ).rejects.toMatchObject({ code: "APPROVAL_NOT_FOUND", statusCode: 404 });
  });

  it("returns 409 APPROVAL_ALREADY_DECIDED on a second decide attempt", async () => {
    const db = makeMockDB({
      approval: pendingApproval({
        status: "approved",
        decidedAt: new Date(frozenMs - 10_000),
        entryId: "entry-1",
        tokenHash: null,
      }),
    });

    await expect(
      decideApprovalRequest("approval-1", "e".repeat(64), "deny", "redo", db, fixedClock)
    ).rejects.toMatchObject({ code: "APPROVAL_ALREADY_DECIDED", statusCode: 409 });
  });

  it("returns 410 APPROVAL_EXPIRED and flips the row when called past expires_at", async () => {
    const raw = "f".repeat(64);
    const db = makeMockDB({
      approval: pendingApproval({
        tokenHash: hashToken(raw),
        expiresAt: new Date(frozenMs - 1_000),
      }),
    });

    await expect(
      decideApprovalRequest("approval-1", raw, "approve", undefined, db, fixedClock)
    ).rejects.toMatchObject({ code: "APPROVAL_EXPIRED", statusCode: 410 });

    expect(db._getApproval()?.status).toBe("expired");
  });

  it("returns 401 APPROVAL_TOKEN_INVALID when the supplied token does not hash to the stored hash", async () => {
    const db = makeMockDB({
      approval: pendingApproval({ tokenHash: hashToken("right-token-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz") }),
    });

    await expect(
      decideApprovalRequest(
        "approval-1",
        "0".repeat(64),
        "approve",
        undefined,
        db,
        fixedClock
      )
    ).rejects.toMatchObject({ code: "APPROVAL_TOKEN_INVALID", statusCode: 401 });
  });
});
