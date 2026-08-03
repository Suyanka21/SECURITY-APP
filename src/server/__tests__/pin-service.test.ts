// @vitest-environment node
/**
 * GatePass — One-Time PIN Backup Service Tests (Feature 11 / Stage 4)
 *
 * Source: src/docs/specs/one-time-pin-backup.md §§5–8
 * Source: src/server/services/pin-service.ts
 *
 * Coverage (TDD + Trustless-System-Auditor):
 *   Primitives
 *     G1  generatePin → exactly 6 digits, leading zeros preserved
 *     G2  generatePassRef → 8 Crockford-base32 chars (no I L O U)
 *     G3  hashPin is deterministic, salted by id, peppered (≠ raw PIN)
 *     G4  verifyPin true for correct PIN, false for wrong PIN / null hash
 *   Redemption
 *     R1  correct passRef+PIN → 200 visitor data + marks record used
 *     R2  wrong PIN → 401 PIN_INVALID + increments per-pass counter + audit
 *     R3  Nth wrong PIN → 423 PIN_LOCKED + sets lock + pin_locked audit
 *     R4  locked pass rejects even a CORRECT PIN (lock checked first)
 *     R5  used pass → 409 PIN_REPLAYED (either method already consumed)
 *     R6  expired pass → 410 PIN_EXPIRED
 *     R7  unknown passRef → 404 PIN_NOT_FOUND + audit (no record to lock)
 *     R8  inactive/missing guard → 403 GUARD_SESSION_EXPIRED
 *     R9  legacy row with no pinHash → 404 PIN_NOT_FOUND
 *     R10 no audit payload ever contains the raw PIN or the pin hash
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  generatePin,
  generatePassRef,
  hashPin,
  verifyPin,
  validatePinRedemption,
  MAX_PIN_ATTEMPTS,
} from "../services/pin-service";
import { ServiceError } from "../services/entry-service";
import { guards, authorizationDecisions } from "@/db/schema";
import { clearAuditLog, getAuditLog, getAuditEventsByType } from "../services/audit-logger";

// ─── Mock DB ─────────────────────────────────────────────────────────────────

interface Row {
  id: string;
  visitorName: string;
  host: string;
  unit: string;
  plate: string | null;
  expiresAt: Date;
  isUsed: boolean;
  usedAt: Date | null;
  usedByGuardId: string | null;
  passRef: string | null;
  pinHash: string | null;
  pinFailedAttempts: number;
  pinLockedUntil: Date | null;
}

const GUARD_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const DECISION_ID = "11111111-1111-4111-8111-111111111111";
const PASS_REF = "AB12CD34";

function makeRow(over: Partial<Row> = {}): Row {
  return {
    id: DECISION_ID,
    visitorName: "Maya Chen",
    host: "A. Okafor",
    unit: "18B",
    plate: "LND-482",
    expiresAt: new Date(Date.now() + 3600_000),
    isUsed: false,
    usedAt: null,
    usedByGuardId: null,
    passRef: PASS_REF,
    pinHash: null,
    pinFailedAttempts: 0,
    pinLockedUntil: null,
    ...over,
  };
}

function createMockDB(opts: {
  guardActive?: boolean;
  guardMissing?: boolean;
  row?: Row | null;
  /** Rows RETURNed by the atomic `is_used=false` guarded consume update.
   *  Empty array simulates losing the race to a concurrent redemption. */
  consumeResult?: { id: string }[];
} = {}) {
  const { guardActive = true, guardMissing = false, row = makeRow() } = opts;
  const consumeResult =
    opts.consumeResult ?? [{ id: (row?.id as string) ?? DECISION_ID }];
  const updates: Record<string, unknown>[] = [];

  return {
    select: (...args: unknown[]) => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: () => {
            if (table === guards) {
              return Promise.resolve(
                guardMissing ? [] : [{ id: GUARD_ID, isActive: guardActive }]
              );
            }
            if (table === authorizationDecisions) {
              return Promise.resolve(row ? [row] : []);
            }
            return Promise.resolve([]);
          },
        }),
      }),
      // select({...}) form used by the guard lookup
      _args: args,
    }),
    update: () => ({
      set: (data: Record<string, unknown>) => {
        updates.push(data);
        // `.where()` is awaited directly on the failed-attempt/lock path and
        // chained with `.returning()` on the atomic success-consume path.
        return {
          where: () => ({
            returning: () => Promise.resolve(consumeResult),
            then: (resolve: (v: unknown) => unknown) => resolve(undefined),
          }),
        };
      },
    }),
    insert: () => ({ values: () => Promise.resolve() }),
    query: {},
    _updates: updates,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function input(pin: string, passRef = PASS_REF) {
  return {
    passRef,
    pin,
    scannedAt: new Date().toISOString(),
    guardId: GUARD_ID,
  };
}

beforeEach(() => clearAuditLog());

// ─── Primitives ──────────────────────────────────────────────────────────────

describe("pin-service primitives", () => {
  it("G1: generatePin returns exactly 6 digits", () => {
    for (let i = 0; i < 200; i += 1) {
      const pin = generatePin();
      expect(pin).toMatch(/^[0-9]{6}$/);
    }
  });

  it("G2: generatePassRef returns 8 Crockford-base32 chars (no I L O U)", () => {
    for (let i = 0; i < 200; i += 1) {
      const ref = generatePassRef();
      expect(ref).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    }
  });

  it("G3: hashPin is deterministic, salted by id, and not the raw PIN", () => {
    const h1 = hashPin(DECISION_ID, "123456");
    const h2 = hashPin(DECISION_ID, "123456");
    const hOtherId = hashPin("22222222-2222-4222-8222-222222222222", "123456");
    expect(h1).toBe(h2);
    expect(h1).not.toBe("123456");
    expect(h1).not.toContain("123456");
    expect(h1).not.toBe(hOtherId); // per-record salt
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("G4: verifyPin true for correct PIN, false otherwise", () => {
    const hash = hashPin(DECISION_ID, "654321");
    expect(verifyPin(DECISION_ID, "654321", hash)).toBe(true);
    expect(verifyPin(DECISION_ID, "000000", hash)).toBe(false);
    expect(verifyPin(DECISION_ID, "654321", null)).toBe(false);
    expect(verifyPin("other-id", "654321", hash)).toBe(false);
  });
});

// ─── Redemption ──────────────────────────────────────────────────────────────

describe("validatePinRedemption", () => {
  it("R1: correct passRef+PIN returns visitor data and marks record used", async () => {
    const db = createMockDB({
      row: makeRow({ pinHash: hashPin(DECISION_ID, "112233") }),
    });
    const { response, statusCode } = await validatePinRedemption(input("112233"), db);

    expect(statusCode).toBe(200);
    expect(response.outcome).toBe("valid");
    expect(response.visitor.name).toBe("Maya Chen");
    expect(response.visitor.preApprovalId).toBe(DECISION_ID);
    // Shared consumption — flips is_used just like the QR path.
    expect(db._updates.at(-1)).toMatchObject({
      isUsed: true,
      usedByGuardId: GUARD_ID,
      pinFailedAttempts: 0,
    });
    expect(getAuditEventsByType("pin_redeemed").length).toBe(1);
  });

  it("R2: wrong PIN returns 401 PIN_INVALID and increments the per-pass counter", async () => {
    const db = createMockDB({
      row: makeRow({ pinHash: hashPin(DECISION_ID, "112233"), pinFailedAttempts: 1 }),
    });
    await expect(validatePinRedemption(input("999999"), db)).rejects.toMatchObject({
      code: "PIN_INVALID",
      statusCode: 401,
    });
    expect(db._updates.at(-1)).toMatchObject({ pinFailedAttempts: 2 });
    const failed = getAuditEventsByType("pin_failed");
    expect(failed.length).toBe(1);
    expect(failed[0].payload).toMatchObject({
      reason: "PIN_INVALID",
      attemptsRemaining: MAX_PIN_ATTEMPTS - 2,
    });
  });

  it("R3: the Nth wrong PIN locks the pass and audits pin_locked", async () => {
    const db = createMockDB({
      row: makeRow({
        pinHash: hashPin(DECISION_ID, "112233"),
        pinFailedAttempts: MAX_PIN_ATTEMPTS - 1,
      }),
    });
    await expect(validatePinRedemption(input("999999"), db)).rejects.toMatchObject({
      code: "PIN_LOCKED",
      statusCode: 423,
    });
    const setArg = db._updates.at(-1)!;
    expect(setArg.pinFailedAttempts).toBe(MAX_PIN_ATTEMPTS);
    expect(setArg.pinLockedUntil).toBeInstanceOf(Date);
    expect(getAuditEventsByType("pin_locked").length).toBe(1);
  });

  it("R4: a locked pass rejects even the CORRECT PIN (lock checked first)", async () => {
    const db = createMockDB({
      row: makeRow({
        pinHash: hashPin(DECISION_ID, "112233"),
        pinLockedUntil: new Date(Date.now() + 10 * 60_000),
      }),
    });
    await expect(validatePinRedemption(input("112233"), db)).rejects.toMatchObject({
      code: "PIN_LOCKED",
      statusCode: 423,
    });
    // No consumption update happened.
    expect(db._updates.length).toBe(0);
    expect(getAuditEventsByType("pin_failed")[0].payload).toMatchObject({
      reason: "LOCKED",
    });
  });

  it("R5: an already-used pass returns 409 PIN_REPLAYED", async () => {
    const db = createMockDB({
      row: makeRow({ pinHash: hashPin(DECISION_ID, "112233"), isUsed: true }),
    });
    await expect(validatePinRedemption(input("112233"), db)).rejects.toMatchObject({
      code: "PIN_REPLAYED",
      statusCode: 409,
    });
  });

  it("R5b: a correct PIN losing the consume race (0 rows) returns 409 PIN_REPLAYED", async () => {
    // The record read as unused, but the atomic `is_used=false` guarded
    // update affected 0 rows — a concurrent QR/PIN redemption won. The loser
    // must be rejected as a replay rather than double-consuming.
    const db = createMockDB({
      row: makeRow({ pinHash: hashPin(DECISION_ID, "112233") }),
      consumeResult: [],
    });
    await expect(
      validatePinRedemption(input("112233"), db)
    ).rejects.toMatchObject({ code: "PIN_REPLAYED", statusCode: 409 });
    // No success audit — the redemption did not complete.
    expect(getAuditEventsByType("pin_redeemed").length).toBe(0);
  });

  it("R6: an expired pass returns 410 PIN_EXPIRED", async () => {
    const db = createMockDB({
      row: makeRow({
        pinHash: hashPin(DECISION_ID, "112233"),
        expiresAt: new Date(Date.now() - 1000),
      }),
    });
    await expect(validatePinRedemption(input("112233"), db)).rejects.toMatchObject({
      code: "PIN_EXPIRED",
      statusCode: 410,
    });
  });

  it("R7: an unknown passRef returns 404 PIN_NOT_FOUND and audits the failure", async () => {
    const db = createMockDB({ row: null });
    await expect(validatePinRedemption(input("112233"), db)).rejects.toMatchObject({
      code: "PIN_NOT_FOUND",
      statusCode: 404,
    });
    expect(getAuditEventsByType("pin_failed")[0].payload).toMatchObject({
      reason: "PIN_NOT_FOUND",
    });
  });

  it("R8: an inactive/missing guard returns 403 GUARD_SESSION_EXPIRED", async () => {
    const dbInactive = createMockDB({ guardActive: false });
    await expect(validatePinRedemption(input("112233"), dbInactive)).rejects.toMatchObject({
      code: "GUARD_SESSION_EXPIRED",
      statusCode: 403,
    });
    const dbMissing = createMockDB({ guardMissing: true });
    await expect(validatePinRedemption(input("112233"), dbMissing)).rejects.toMatchObject({
      code: "GUARD_SESSION_EXPIRED",
    });
  });

  it("R9: a legacy row with no pinHash returns 404 PIN_NOT_FOUND", async () => {
    const db = createMockDB({ row: makeRow({ pinHash: null }) });
    await expect(validatePinRedemption(input("112233"), db)).rejects.toMatchObject({
      code: "PIN_NOT_FOUND",
    });
  });

  it("R10: no audit payload ever contains the raw PIN or the pin hash", async () => {
    const pinHash = hashPin(DECISION_ID, "112233");

    // success path
    await validatePinRedemption(
      input("112233"),
      createMockDB({ row: makeRow({ pinHash }) })
    );
    // failure path
    try {
      await validatePinRedemption(
        input("999999"),
        createMockDB({ row: makeRow({ pinHash }) })
      );
    } catch {
      /* expected */
    }

    const serialized = JSON.stringify(getAuditLog());
    expect(serialized).not.toContain("112233");
    expect(serialized).not.toContain("999999");
    expect(serialized).not.toContain(pinHash);
  });

  it("throws ServiceError instances (mapped to structured HTTP by the handler)", async () => {
    const db = createMockDB({ row: null });
    await expect(validatePinRedemption(input("112233"), db)).rejects.toBeInstanceOf(
      ServiceError
    );
  });
});
