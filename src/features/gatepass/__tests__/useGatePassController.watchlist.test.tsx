/**
 * useGatePassController — Feature 12 (Watchlist, Stage 5) behaviour tests.
 *
 * Source: src/docs/specs/watchlist.md §1, §3, §5.
 *
 * The rules pinned here are the ones a passing service test cannot prove:
 *   1. A QR/PIN match does NOT reject the pass — validation still succeeds
 *      and the warning (with the stored reason) reaches the guard.
 *   2. A guard cannot finalise a matched arrival alone: without a named
 *      supervisor + acknowledgement the submission is refused locally and
 *      NO entry request is sent.
 *   3. With the escalation recorded, the entry IS logged — through the
 *      existing override mechanism, so it lands in override_events.
 *   4. A walk-in match never blocks: the entry is logged and the warning is
 *      surfaced afterwards.
 *   5. A match never carries over to the next visitor.
 */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGatePassController } from "../useGatePassController";
import type { GatePassApi } from "@/lib/api/gatepass";
import type {
  ApiResult,
  CreateEntryResponse,
  QrValidateResponse,
  WatchlistMatchView,
} from "@/lib/api/types";

/**
 * Signed-in guard identity for the session. PR A: the controller no longer
 * seeds a placeholder guard, so tests must establish identity explicitly.
 */
const TEST_IDENTITY = {
  guardId: "guard-west-04",
  name: "N. Adeyemi",
  badgeNumber: "G-001",
  role: "guard",
};


function ok<T>(data: T, status = 200): ApiResult<T> {
  return { ok: true, status, data };
}

interface MockApi extends GatePassApi {
  submitEntry: ReturnType<typeof vi.fn>;
  validateQr: ReturnType<typeof vi.fn>;
  validatePin: ReturnType<typeof vi.fn>;
  syncEntries: ReturnType<typeof vi.fn>;
  searchVisitors: ReturnType<typeof vi.fn>;
}

function makeApi(): MockApi {
  return {
    submitEntry: vi.fn(),
    validateQr: vi.fn(),
    validatePin: vi.fn(),
    syncEntries: vi.fn(),
    searchVisitors: vi.fn(),
  } as unknown as MockApi;
}

const MATCH: WatchlistMatchView = {
  matched: true,
  entryId: "wl-1",
  reason: "Barred after an altercation with staff on 2026-01-04.",
  matchedOn: "name",
  requiresEscalation: true,
};

const QR_MATCHED: QrValidateResponse = {
  outcome: "valid",
  visitor: {
    name: "Mara Osei",
    host: "Bola",
    unit: "4A",
    plate: "KJA-019",
    preApprovalId: "preapproval-1",
  },
  expiresAt: new Date("2024-01-01T01:00:00Z").toISOString(),
  watchlistMatch: MATCH,
  traceId: "trace-qr",
};

const SERVER_ENTRY: CreateEntryResponse = {
  entry: {
    id: "server-1",
    visitorName: "Mara Osei",
    host: "Bola",
    unit: "4A",
    plate: null,
    reason: "",
    method: "walk-in",
    guardId: "guard-west-04",
    createdAt: new Date("2024-01-01T00:00:00Z").toISOString(),
    status: "logged",
    syncState: "synced",
  },
  traceId: "trace-entry",
};

function buildController(api: MockApi) {
  let counter = 0;
  return renderHook(() =>
    useGatePassController({
      identity: TEST_IDENTITY,
      api,
      now: () => new Date("2024-01-01T00:00:00Z"),
      generateId: () => {
        counter += 1;
        return `00000000-0000-4000-8000-${counter.toString().padStart(12, "0")}`;
      },
    }),
  );
}

describe("watchlist match on QR/PIN validation", () => {
  let api: MockApi;

  beforeEach(() => {
    api = makeApi();
  });

  it("keeps the pass valid and exposes the warning with the stored reason", async () => {
    api.validateQr.mockResolvedValue(ok(QR_MATCHED));
    const hook = buildController(api);

    await act(async () => {
      await hook.result.current.scanQr("token-1");
    });

    expect(hook.result.current.state.qrState).toBe("valid");
    expect(hook.result.current.state.draft.visitorName).toBe("Mara Osei");
    expect(hook.result.current.state.watchlistMatch).toEqual(MATCH);
    expect(hook.result.current.state.banner.message).toContain("WATCHLIST MATCH");
  });

  it("also surfaces a match from PIN redemption", async () => {
    api.validatePin.mockResolvedValue(ok(QR_MATCHED));
    const hook = buildController(api);

    await act(async () => {
      await hook.result.current.redeemPin("PASS-1", "123456");
    });

    expect(hook.result.current.state.qrState).toBe("valid");
    expect(hook.result.current.state.watchlistMatch).toEqual(MATCH);
  });

  it("refuses to finalise without supervisor escalation and sends no entry", async () => {
    api.validateQr.mockResolvedValue(ok(QR_MATCHED));
    const hook = buildController(api);

    await act(async () => {
      await hook.result.current.scanQr("token-1");
    });
    await act(async () => {
      await hook.result.current.submitEntry();
    });

    expect(api.submitEntry).not.toHaveBeenCalled();
    expect(hook.result.current.state.lastError?.code).toBe(
      "WATCHLIST_ESCALATION_REQUIRED",
    );
    // The guard must stay on the confirmation screen where the form lives.
    expect(hook.result.current.state.mode).not.toBe("error");
    expect(hook.result.current.state.watchlistMatch).toEqual(MATCH);
  });

  it("still refuses when acknowledged without naming a supervisor", async () => {
    api.validateQr.mockResolvedValue(ok(QR_MATCHED));
    const hook = buildController(api);

    await act(async () => {
      await hook.result.current.scanQr("token-1");
    });
    await act(async () => {
      hook.result.current.dispatch({
        type: "WATCHLIST_ESCALATION_UPDATED",
        acknowledged: true,
      });
    });
    await act(async () => {
      await hook.result.current.submitEntry();
    });

    expect(api.submitEntry).not.toHaveBeenCalled();
  });

  it("logs the entry as an override once the supervisor is recorded", async () => {
    api.validateQr.mockResolvedValue(ok(QR_MATCHED));
    api.submitEntry.mockResolvedValue(ok(SERVER_ENTRY, 201));
    const hook = buildController(api);

    await act(async () => {
      await hook.result.current.scanQr("token-1");
    });
    await act(async () => {
      hook.result.current.dispatch({
        type: "WATCHLIST_ESCALATION_UPDATED",
        supervisor: "Sgt. Amina",
        acknowledged: true,
      });
    });
    await act(async () => {
      await hook.result.current.submitEntry();
    });

    expect(api.submitEntry).toHaveBeenCalledTimes(1);
    const body = api.submitEntry.mock.calls[0][0];
    // Reuses the EXISTING override mechanism — no new escalation table.
    expect(body.method).toBe("override");
    expect(body.reason).toContain("Sgt. Amina");
    expect(body.reason).toContain(MATCH.reason);
    expect(hook.result.current.state.mode).toBe("confirmed");
  });
});

describe("watchlist match on walk-in entry", () => {
  let api: MockApi;

  beforeEach(() => {
    api = makeApi();
  });

  async function fillDraft(hook: ReturnType<typeof buildController>) {
    await act(async () => {
      hook.result.current.dispatch({ type: "NAVIGATE", mode: "walkin" });
      hook.result.current.dispatch({
        type: "UPDATE_DRAFT",
        field: "visitorName",
        value: "Mara Osei",
      });
      hook.result.current.dispatch({
        type: "UPDATE_DRAFT",
        field: "host",
        value: "Bola",
      });
      hook.result.current.dispatch({
        type: "UPDATE_DRAFT",
        field: "unit",
        value: "4A",
      });
    });
  }

  it("logs the entry and surfaces the warning afterwards — never denied", async () => {
    api.submitEntry.mockResolvedValue(
      ok({ ...SERVER_ENTRY, watchlistMatch: MATCH }, 201),
    );
    const hook = buildController(api);
    await fillDraft(hook);

    await act(async () => {
      await hook.result.current.submitEntry();
    });

    expect(hook.result.current.state.mode).toBe("confirmed");
    expect(hook.result.current.state.lastEntry?.status).toBe("logged");
    expect(hook.result.current.state.watchlistMatch).toEqual(MATCH);
    expect(hook.result.current.state.banner.message).toContain("Escalate");
  });

  it("clears the warning when the guard resets for the next arrival", async () => {
    api.submitEntry.mockResolvedValue(
      ok({ ...SERVER_ENTRY, watchlistMatch: MATCH }, 201),
    );
    const hook = buildController(api);
    await fillDraft(hook);

    await act(async () => {
      await hook.result.current.submitEntry();
    });
    await act(async () => {
      hook.result.current.dispatch({ type: "RESET_FLOW" });
    });

    expect(hook.result.current.state.watchlistMatch).toBeNull();
    expect(hook.result.current.state.watchlistEscalation).toEqual({
      supervisor: "",
      acknowledged: false,
    });
  });

  it("does not attach a warning when the visitor is not watchlisted", async () => {
    api.submitEntry.mockResolvedValue(ok(SERVER_ENTRY, 201));
    const hook = buildController(api);
    await fillDraft(hook);

    await act(async () => {
      await hook.result.current.submitEntry();
    });

    expect(hook.result.current.state.watchlistMatch).toBeNull();
    expect(hook.result.current.state.banner.message).toContain("Entry logged");
  });
});
