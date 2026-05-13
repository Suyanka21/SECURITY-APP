/**
 * Pure reducer tests. The reducer never calls the API; it only
 * processes lifecycle actions dispatched by the controller. We test the
 * three guarantees the contract makes about state transitions:
 *
 * 1. Validation failures surface as explicit errors that block confirmation.
 * 2. Server acknowledgements produce one — and only one — logged entry.
 * 3. Offline queueing keeps records visible until sync reconciles them.
 *
 * Behavior that depends on I/O (validation gating, offline auto-queue,
 * partial sync handling) is covered in the controller tests instead.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_GUARD_ID,
  gatePassReducer,
  initialGatePassState,
  recognizedVisitors,
  validateDraft,
} from "../gatepassReducer";
import type { EntryRecord, GatePassState } from "../types";

function makeEntry(
  overrides: Partial<EntryRecord> = {}
): EntryRecord {
  return {
    visitorName: "Ada Lovelace",
    host: "Bola",
    unit: "4A",
    plate: "",
    reason: "",
    method: "walk-in",
    id: "server-1",
    offlineId: "00000000-0000-4000-8000-000000000001",
    guardId: DEFAULT_GUARD_ID,
    createdAt: new Date("2024-01-01T00:00:00Z").toISOString(),
    status: "logged",
    syncState: "synced",
    ...overrides,
  };
}

describe("validateDraft", () => {
  it("requires visitor name, host, unit, and an explicit override reason", () => {
    expect(validateDraft({ visitorName: "", host: "", unit: "", plate: "", reason: "", method: "walk-in" }, DEFAULT_GUARD_ID)?.code).toBe("VISITOR_NAME_REQUIRED");
    expect(validateDraft({ visitorName: "Ada", host: "", unit: "", plate: "", reason: "", method: "walk-in" }, DEFAULT_GUARD_ID)?.code).toBe("HOST_REQUIRED");
    expect(validateDraft({ visitorName: "Ada", host: "Bola", unit: "", plate: "", reason: "", method: "walk-in" }, DEFAULT_GUARD_ID)?.code).toBe("UNIT_REQUIRED");
    expect(validateDraft({ visitorName: "Ada", host: "Bola", unit: "4A", plate: "", reason: "short", method: "override" }, DEFAULT_GUARD_ID)?.code).toBe("OVERRIDE_REASON_TOO_SHORT");
    expect(validateDraft({ visitorName: "Ada", host: "Bola", unit: "4A", plate: "", reason: "Plumbing emergency in service core", method: "override" }, DEFAULT_GUARD_ID)).toBeNull();
  });

  it("refuses to validate when guard identity is missing", () => {
    const error = validateDraft({ visitorName: "Ada", host: "Bola", unit: "4A", plate: "", reason: "", method: "walk-in" }, "");
    expect(error?.code).toBe("GUARD_ID_MISSING");
  });
});

describe("gatePassReducer", () => {
  it("ENTRY_FAILED moves to the error mode and exposes the field for highlighting", () => {
    const state = gatePassReducer(initialGatePassState, {
      type: "ENTRY_FAILED",
      error: {
        code: "VISITOR_NAME_REQUIRED",
        message: "Visitor name is required",
        field: "visitorName",
      },
    });
    expect(state.mode).toBe("error");
    expect(state.banner.message).toContain("Visitor name is required");
    expect(state.lastError?.field).toBe("visitorName");
    expect(state.entries).toHaveLength(0);
  });

  it("ENTRY_SUCCEEDED records exactly one entry with guard attribution and a server ID", () => {
    const state = gatePassReducer(initialGatePassState, {
      type: "ENTRY_SUCCEEDED",
      entry: makeEntry({ id: "server-abc" }),
    });
    expect(state.mode).toBe("confirmed");
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].id).toBe("server-abc");
    expect(state.entries[0].guardId).toBe(DEFAULT_GUARD_ID);
    expect(state.entries[0].status).toBe("logged");
    expect(state.pendingSync).toHaveLength(0);
  });

  it("ENTRY_QUEUED keeps the entry visible in both the log and the pending sync queue", () => {
    const queued = gatePassReducer(initialGatePassState, {
      type: "ENTRY_QUEUED",
      entry: makeEntry({ status: "sync-pending", syncState: "queued" }),
    });
    expect(queued.mode).toBe("confirmed");
    expect(queued.entries).toHaveLength(1);
    expect(queued.pendingSync).toHaveLength(1);
    expect(queued.banner.message).toContain("queued for sync");
  });

  it("QR_SCAN_FAILED maps replay codes to a visible banner without ever logging an entry", () => {
    const state = gatePassReducer(initialGatePassState, {
      type: "QR_SCAN_FAILED",
      qrState: "replayed",
      error: {
        code: "QR_REPLAYED",
        message: "This QR code has already been used",
      },
    });
    expect(state.mode).toBe("error");
    expect(state.qrState).toBe("replayed");
    expect(state.entries).toHaveLength(0);
    expect(state.banner.message).toContain("already been used");
  });

  it("CAMERA_FAILED is an explicit blocked state with fallback paths", () => {
    const failed = gatePassReducer(initialGatePassState, { type: "CAMERA_FAILED" });
    expect(failed.mode).toBe("error");
    expect(failed.banner.message).toContain("Camera failed");
  });

  it("loads recognized visitors into a confirmable draft without auto-approving", () => {
    const state = gatePassReducer(initialGatePassState, {
      type: "SELECT_VISITOR",
      visitor: recognizedVisitors[0],
    });
    expect(state.mode).toBe("walkin");
    expect(state.draft.method).toBe("recognized");
    expect(state.entries).toHaveLength(0);
  });

  it("SYNC_COMPLETED promotes acked entries and keeps rejected ones queued with their error", () => {
    const queued: GatePassState = {
      ...initialGatePassState,
      pendingSync: [
        makeEntry({
          id: "offline-1",
          offlineId: "11111111-1111-4111-8111-111111111111",
          status: "sync-pending",
          syncState: "queued",
        }),
        makeEntry({
          id: "offline-2",
          offlineId: "22222222-2222-4222-8222-222222222222",
          visitorName: "Rejected guest",
          status: "sync-pending",
          syncState: "queued",
        }),
      ],
      entries: [
        makeEntry({
          id: "offline-1",
          offlineId: "11111111-1111-4111-8111-111111111111",
          status: "sync-pending",
          syncState: "queued",
        }),
      ],
    };

    const next = gatePassReducer(queued, {
      type: "SYNC_COMPLETED",
      results: [
        { offlineId: "11111111-1111-4111-8111-111111111111", serverId: "server-1", status: "synced" },
        {
          offlineId: "22222222-2222-4222-8222-222222222222",
          serverId: "",
          status: "rejected",
          error: { code: "VALIDATION_ERROR", message: "Bad data" },
        },
      ],
      keptInQueue: [
        {
          ...queued.pendingSync[1],
          syncState: "failed",
          lastError: { code: "VALIDATION_ERROR", message: "Bad data" },
        },
      ],
      newlySynced: [
        {
          ...queued.pendingSync[0],
          id: "server-1",
          status: "logged",
          syncState: "synced",
        },
      ],
    });

    expect(next.pendingSync).toHaveLength(1);
    expect(next.pendingSync[0].syncState).toBe("failed");
    expect(next.pendingSync[0].lastError?.code).toBe("VALIDATION_ERROR");
    expect(next.entries[0].id).toBe("server-1");
    expect(next.entries[0].syncState).toBe("synced");
    expect(next.lastSyncResults).toHaveLength(2);
    expect(next.banner.tone).toBe("warning");
    expect(next.banner.message).toContain("1 reconciled");
    expect(next.banner.message).toContain("1 rejected");
  });

  it("RATE_LIMITED maps to a warning banner so the guard can wait, not bypass", () => {
    const state = gatePassReducer(initialGatePassState, {
      type: "ENTRY_FAILED",
      error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many requests" },
    });
    expect(state.banner.tone).toBe("warning");
    expect(state.banner.message).toContain("Rate limit");
  });
});
