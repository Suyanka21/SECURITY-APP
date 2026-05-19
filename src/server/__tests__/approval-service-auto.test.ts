// @vitest-environment node
/**
 * GatePass — Approval Service × Auto-Approval Wiring Tests
 *
 * Source: src/docs/specs/auto-approval.md §5 (state machine extension).
 * Source: src/docs/specs/auto-approval.md §6 (eval algorithm).
 * Source: Trustless-System-Auditor — paired audit on every short-circuit.
 *
 * Why this file:
 *   - approval-service.test.ts exists pre-Feature-3 and verifies the
 *     manual flow stays IDENTICAL when no rule fires. We keep it
 *     unchanged (TDD discipline: never edit a passing test).
 *   - This new file pins the BRANCH the wiring adds:
 *       evaluator returns match=true   → short-circuit, autoApproved=true
 *       evaluator returns EVALUATOR_ERROR → fall through (default-deny)
 *       evaluator returns any non-match → fall through (manual flow)
 *
 * Mock contract:
 *   - We mock the AutoApprovalService.evaluate() seam so the test never
 *     has to fake the SQL lower()-functional-index lookup. Service
 *     behavior is already covered in auto-approval-service.test.ts.
 *   - The mock DB factory accepts an evaluator outcome and a couple of
 *     write-failure switches so we can drive both the happy and the
 *     transaction-rollback paths from a single fixture.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createApprovalRequest,
} from "../services/approval-service";
import * as autoApprovalService from "../services/auto-approval-service";
import {
  approvalRequests,
  entryRecords,
  guards,
} from "@/db/schema";

// ─── Mock DB factory ────────────────────────────────────────────────────────

interface MockOpts {
  guardActive?: boolean;
  /** Throw inside the auto-approval transaction's entry insert. */
  entryInsertError?: Error;
}

function makeMockDB(opts: MockOpts = {}) {
  const { guardActive = true, entryInsertError } = opts;
  const insertedEntries: unknown[] = [];
  const insertedApprovals: unknown[] = [];

  const buildInsert = () =>
    vi.fn().mockImplementation((table: unknown) => ({
      values: vi.fn().mockImplementation((row: unknown) => {
        if (table === entryRecords) {
          if (entryInsertError) return Promise.reject(entryInsertError);
          insertedEntries.push(row);
          return Promise.resolve();
        }
        if (table === approvalRequests) {
          insertedApprovals.push(row);
          return Promise.resolve();
        }
        return Promise.resolve();
      }),
    }));

  return {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => ({
        where: vi.fn().mockImplementation(() => ({
          limit: vi.fn().mockImplementation(() => {
            if (table === guards) {
              return Promise.resolve([
                { id: "guard-1", isActive: guardActive },
              ]);
            }
            if (table === approvalRequests) {
              // No existing row for the offlineId — let the create proceed.
              return Promise.resolve([]);
            }
            return Promise.resolve([]);
          }),
        })),
      })),
    })),
    insert: buildInsert(),
    update: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transaction: vi.fn().mockImplementation(async (cb: any) => {
      const snapEntries = insertedEntries.length;
      const snapApprovals = insertedApprovals.length;
      const tx = {
        insert: buildInsert(),
        update: vi.fn(),
      };
      try {
        await cb(tx);
      } catch (err) {
        // Roll back side effects (mirror Drizzle real behavior)
        insertedEntries.length = snapEntries;
        insertedApprovals.length = snapApprovals;
        throw err;
      }
    }),
    query: {},
    _insertedEntries: insertedEntries,
    _insertedApprovals: insertedApprovals,
  };
}

function makeRuleRow() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    visitorName: "Maya Chen",
    host: "A. Okafor",
    unit: "18B",
    plateRequired: null,
    createdByGuardId: "guard-1",
    active: true,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
    lastMatchedAt: null,
    matchCount: 0,
  };
}

function validInput() {
  return {
    offlineId: "22222222-2222-4222-8222-222222222222",
    draft: {
      visitorName: "Maya Chen",
      host: "A. Okafor",
      unit: "18B",
      plate: "LND-482",
      reason: "",
      method: "walk-in" as const,
    },
  };
}

const fixedClock = { now: () => Date.UTC(2025, 0, 1, 12, 0, 0) };

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

// ─── Match branch ──────────────────────────────────────────────────────────

describe("createApprovalRequest × auto-approval — match", () => {
  it("short-circuits and returns autoApproved=true + an entry record", async () => {
    const rule = makeRuleRow();
    vi.spyOn(autoApprovalService, "evaluate").mockResolvedValue({
      match: true,
      rule,
      reason: null,
    });

    const db = makeMockDB();
    const { response, statusCode, enqueuedNotification } =
      await createApprovalRequest(validInput(), "guard-1", db, fixedClock);

    expect(statusCode).toBe(201);
    expect(response.autoApproved).toBe(true);
    expect(response.entry).not.toBeNull();
    expect(response.entry?.method).toBe("auto");
    expect(response.entry?.status).toBe("logged");
    expect(response.entry?.guardId).toBe("guard-1");
    expect(response.matchedRule).toMatchObject({
      id: rule.id,
      visitorName: rule.visitorName,
      host: rule.host,
      unit: rule.unit,
    });
    expect(enqueuedNotification).toBeNull();

    // Both rows written, inside one transaction (the mock checks both).
    expect(db._insertedEntries).toHaveLength(1);
    expect(db._insertedApprovals).toHaveLength(1);
    // The stored approval is APPROVED, not pending — spec §5.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((db._insertedApprovals[0] as any).status).toBe("approved");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((db._insertedApprovals[0] as any).entryId).toBe(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db._insertedEntries[0] as any).id
    );
  });

  it("rolls back BOTH writes if the entry insert fails (no silent partial)", async () => {
    vi.spyOn(autoApprovalService, "evaluate").mockResolvedValue({
      match: true,
      rule: makeRuleRow(),
      reason: null,
    });

    const db = makeMockDB({ entryInsertError: new Error("DB unreachable") });

    await expect(
      createApprovalRequest(validInput(), "guard-1", db, fixedClock)
    ).rejects.toThrow("DB unreachable");

    expect(db._insertedEntries).toHaveLength(0);
    expect(db._insertedApprovals).toHaveLength(0);
  });

  it("does not enqueue a notification (entry already logged — no resident decision)", async () => {
    vi.spyOn(autoApprovalService, "evaluate").mockResolvedValue({
      match: true,
      rule: makeRuleRow(),
      reason: null,
    });

    const db = makeMockDB();
    const { enqueuedNotification } = await createApprovalRequest(
      validInput(),
      "guard-1",
      db,
      fixedClock
    );

    expect(enqueuedNotification).toBeNull();
  });
});

// ─── Non-match branches (default-deny fall-through) ─────────────────────────

describe("createApprovalRequest × auto-approval — non-match", () => {
  const nonMatchReasons = [
    "NO_RULE",
    "RULE_EXPIRED",
    "RULE_INACTIVE",
    "PLATE_MISMATCH",
    "INPUT_INCOMPLETE",
    "EVALUATOR_ERROR",
  ] as const;

  it.each(nonMatchReasons)(
    "falls through to the manual flow on reason=%s",
    async (reason) => {
      vi.spyOn(autoApprovalService, "evaluate").mockResolvedValue({
        match: false,
        rule: null,
        reason,
      });

      const db = makeMockDB();
      const { response, statusCode } = await createApprovalRequest(
        validInput(),
        "guard-1",
        db,
        fixedClock
      );

      // Manual flow contract: pending row + magicLinkUrl + autoApproved absent/false.
      expect(statusCode).toBe(201);
      expect(response.autoApproved).toBeFalsy();
      expect(response.entry).toBeFalsy();
      expect(response.matchedRule).toBeFalsy();
      expect(response.magicLinkUrl).toMatch(
        /^https?:\/\/.+\/approve\/[0-9a-f-]{36}\?token=[0-9a-f]{64}$/
      );

      // No entry was inserted (manual flow doesn't create entries until /decide).
      expect(db._insertedEntries).toHaveLength(0);
      // The pending approval row was inserted.
      expect(db._insertedApprovals).toHaveLength(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((db._insertedApprovals[0] as any).status).toBe("pending");
    }
  );
});
