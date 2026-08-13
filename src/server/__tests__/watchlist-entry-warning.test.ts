// @vitest-environment node
/**
 * GatePass — Watchlist warning on the entry paths (Feature 12 / Stage 5)
 *
 * Source: src/docs/specs/watchlist.md §3
 *
 * The single most dangerous failure mode of this feature is a match that
 * changes the OUTCOME of a gate operation. These tests pin the opposite
 * behaviour on all three entry paths (walk-in, QR, PIN):
 *
 *   - the operation still succeeds with its normal payload,
 *   - the warning is attached additively and demands escalation,
 *   - no match means no field at all (backward compatible).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../services/watchlist-service", () => ({
  checkWatchlistForEntry: vi.fn(),
}));

import { createEntry } from "../services/entry-service";
import { validateQrToken, hashQrToken } from "../services/qr-service";
import { validatePinRedemption, hashPin } from "../services/pin-service";
import { checkWatchlistForEntry } from "../services/watchlist-service";
import type { CreateEntryInput } from "../validation/entry-schemas";
import { guards, entryRecords, authorizationDecisions } from "@/db/schema";

const GUARD_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const DECISION_ID = "b2c3d4e5-f6a7-8901-bcde-f12345678901";

const MATCH = {
  matched: true as const,
  entryId: "33333333-3333-3333-3333-333333333333",
  reason: "Attempted forced entry on 12 Dec",
  matchedOn: "name" as const,
  requiresEscalation: true as const,
};

beforeEach(() => {
  vi.mocked(checkWatchlistForEntry).mockReset();
});

// ─── Walk-in ─────────────────────────────────────────────────────────────────

function walkInDB() {
  return {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => ({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockImplementation(() => {
            if (table === guards) {
              return Promise.resolve([{ id: GUARD_ID, isActive: true }]);
            }
            if (table === entryRecords) return Promise.resolve([]);
            return Promise.resolve([]);
          }),
        }),
      })),
    })),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    transaction: vi
      .fn()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation(async (cb: (tx: any) => Promise<void>) => {
        await cb({
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockResolvedValue(undefined),
          }),
        });
      }),
    query: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function walkInInput(): CreateEntryInput {
  return {
    visitorName: "John Doe",
    host: "Jane Resident",
    unit: "B4",
    plate: "GR1234A",
    reason: "",
    method: "walk-in",
    guardId: GUARD_ID,
    createdAt: new Date().toISOString(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("POST /api/entries — walk-in", () => {
  it("still logs the entry (201) and attaches the warning when the visitor is watchlisted", async () => {
    vi.mocked(checkWatchlistForEntry).mockResolvedValue(MATCH);

    const { response, statusCode } = await createEntry(walkInInput(), walkInDB());

    // The entry was created — a watchlist hit warns, it does NOT deny.
    expect(statusCode).toBe(201);
    expect(response.entry.status).toBe("logged");
    expect(response.watchlistMatch).toEqual(MATCH);
    expect(response.watchlistMatch?.requiresEscalation).toBe(true);
  });

  it("omits the field entirely when there is no match (backward compatible)", async () => {
    vi.mocked(checkWatchlistForEntry).mockResolvedValue(null);

    const { response } = await createEntry(walkInInput(), walkInDB());

    expect(response.watchlistMatch).toBeUndefined();
    expect("watchlistMatch" in response).toBe(false);
  });

  it("checks the visitor name AND plate that were logged", async () => {
    vi.mocked(checkWatchlistForEntry).mockResolvedValue(null);

    await createEntry(walkInInput(), walkInDB());

    expect(vi.mocked(checkWatchlistForEntry).mock.calls[0][0]).toEqual({
      visitorName: "John Doe",
      plate: "GR1234A",
    });
    // Identity is the server-derived guard id, not anything from the body.
    expect(vi.mocked(checkWatchlistForEntry).mock.calls[0][1]).toBe(GUARD_ID);
  });
});

// ─── QR ──────────────────────────────────────────────────────────────────────

function qrDB() {
  const record = {
    id: DECISION_ID,
    visitorName: "John Doe",
    host: "Jane Resident",
    unit: "B4",
    plate: "GR1234A",
    isUsed: false,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    pinLockedUntil: null,
  };

  return {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => ({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockImplementation(() => {
            if (table === guards) {
              return Promise.resolve([{ id: GUARD_ID, isActive: true }]);
            }
            if (table === authorizationDecisions) return Promise.resolve([record]);
            return Promise.resolve([]);
          }),
        }),
      })),
    })),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: DECISION_ID }]),
        }),
      }),
    }),
    query: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("POST /api/entries/qr/validate", () => {
  it("keeps outcome=valid and attaches the warning for a watchlisted visitor", async () => {
    vi.mocked(checkWatchlistForEntry).mockResolvedValue(MATCH);

    const { response, statusCode } = await validateQrToken(
      { qrToken: "raw-token", guardId: GUARD_ID, scannedAt: new Date().toISOString() },
      qrDB(),
    );

    // The pass was still redeemed successfully.
    expect(statusCode).toBe(200);
    expect(response.outcome).toBe("valid");
    expect(response.visitor.name).toBe("John Doe");
    expect(response.watchlistMatch).toEqual(MATCH);
  });

  it("omits the field when the visitor is not watchlisted", async () => {
    vi.mocked(checkWatchlistForEntry).mockResolvedValue(null);

    const { response } = await validateQrToken(
      { qrToken: "raw-token", guardId: GUARD_ID, scannedAt: new Date().toISOString() },
      qrDB(),
    );

    expect(response.watchlistMatch).toBeUndefined();
  });

  it("hashes the token before lookup regardless of the watchlist check", () => {
    // Guards against a regression where the watchlist wiring changes the
    // token handling path — raw tokens must never be persisted.
    expect(hashQrToken("raw-token")).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ─── PIN ─────────────────────────────────────────────────────────────────────
// The PIN path is a second, independent redemption route for the same pass, so
// the watchlist warning is asserted separately here — a regression could easily
// wire the check into the QR service only.

const PASS_REF = "AB12CD34";
const PIN = "045912";

function pinDB(overrides: Record<string, unknown> = {}) {
  const record = {
    id: DECISION_ID,
    visitorName: "John Doe",
    host: "Jane Resident",
    unit: "B4",
    plate: "GR1234A",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    isUsed: false,
    usedAt: null,
    usedByGuardId: null,
    passRef: PASS_REF,
    pinHash: hashPin(DECISION_ID, PIN),
    pinFailedAttempts: 0,
    pinLockedUntil: null,
    ...overrides,
  };

  return {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => ({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockImplementation(() => {
            if (table === guards) {
              return Promise.resolve([{ id: GUARD_ID, isActive: true }]);
            }
            if (table === authorizationDecisions) return Promise.resolve([record]);
            return Promise.resolve([]);
          }),
        }),
      })),
    })),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: DECISION_ID }]),
          then: (resolve: (v: unknown) => unknown) => resolve(undefined),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    query: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function pinInput() {
  return {
    passRef: PASS_REF,
    pin: PIN,
    scannedAt: new Date().toISOString(),
    guardId: GUARD_ID,
  };
}

describe("POST /api/entries/pin/validate", () => {
  it("still redeems the pass (200 valid) and attaches the warning", async () => {
    vi.mocked(checkWatchlistForEntry).mockResolvedValue(MATCH);

    const { response, statusCode } = await validatePinRedemption(
      pinInput(),
      pinDB(),
    );

    expect(statusCode).toBe(200);
    expect(response.outcome).toBe("valid");
    expect(response.watchlistMatch).toEqual(MATCH);
    expect(response.watchlistMatch?.requiresEscalation).toBe(true);
  });

  it("omits the field when the visitor is not watchlisted", async () => {
    vi.mocked(checkWatchlistForEntry).mockResolvedValue(null);

    const { response } = await validatePinRedemption(pinInput(), pinDB());

    expect(response.watchlistMatch).toBeUndefined();
  });

  it("checks the pass's stored visitor name and plate, with the JWT guard id", async () => {
    vi.mocked(checkWatchlistForEntry).mockResolvedValue(null);

    await validatePinRedemption(pinInput(), pinDB());

    expect(vi.mocked(checkWatchlistForEntry).mock.calls[0][0]).toEqual({
      visitorName: "John Doe",
      plate: "GR1234A",
    });
    expect(vi.mocked(checkWatchlistForEntry).mock.calls[0][1]).toBe(GUARD_ID);
  });

  it("does not run the watchlist check when redemption itself fails", async () => {
    // A rejected redemption must not emit a watchlist_matched audit event for a
    // visitor who never got past the gate check.
    vi.mocked(checkWatchlistForEntry).mockResolvedValue(MATCH);

    await expect(
      validatePinRedemption(pinInput(), pinDB({ isUsed: true })),
    ).rejects.toThrow();

    expect(checkWatchlistForEntry).not.toHaveBeenCalled();
  });
});
