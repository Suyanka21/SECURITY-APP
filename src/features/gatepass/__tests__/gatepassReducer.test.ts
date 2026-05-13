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

  // CodeRabbit: NAVIGATE used to carry over the prior draft.method, so a
  // qr -> walkin or override -> walkin transition could log a walk-in
  // entry as method="qr" or method="override". The audit trail must
  // reflect the actual channel; normalize on navigation.
  describe("NAVIGATE normalizes draft.method against destination", () => {
    it("resets stale qr method to walk-in when navigating to walkin", () => {
      const fromQr: GatePassState = {
        ...initialGatePassState,
        mode: "qr",
        draft: { ...initialGatePassState.draft, method: "qr" },
      };
      const next = gatePassReducer(fromQr, { type: "NAVIGATE", mode: "walkin" });
      expect(next.mode).toBe("walkin");
      expect(next.draft.method).toBe("walk-in");
    });

    it("resets stale override method to walk-in when navigating to walkin", () => {
      const fromOverride: GatePassState = {
        ...initialGatePassState,
        mode: "override",
        draft: { ...initialGatePassState.draft, method: "override" },
      };
      const next = gatePassReducer(fromOverride, {
        type: "NAVIGATE",
        mode: "walkin",
      });
      expect(next.draft.method).toBe("walk-in");
    });

    it("preserves the recognized method when re-navigating to walkin after SELECT_VISITOR", () => {
      const fromRecognized: GatePassState = {
        ...initialGatePassState,
        mode: "walkin",
        draft: { ...initialGatePassState.draft, method: "recognized" },
      };
      const next = gatePassReducer(fromRecognized, {
        type: "NAVIGATE",
        mode: "walkin",
      });
      expect(next.draft.method).toBe("recognized");
    });

    it("sets method=qr when navigating to qr regardless of prior method", () => {
      const fromOverride: GatePassState = {
        ...initialGatePassState,
        draft: { ...initialGatePassState.draft, method: "override" },
      };
      const next = gatePassReducer(fromOverride, { type: "NAVIGATE", mode: "qr" });
      expect(next.draft.method).toBe("qr");
    });

    it("sets method=override when navigating to override regardless of prior method", () => {
      const fromQr: GatePassState = {
        ...initialGatePassState,
        draft: { ...initialGatePassState.draft, method: "qr" },
      };
      const next = gatePassReducer(fromQr, { type: "NAVIGATE", mode: "override" });
      expect(next.draft.method).toBe("override");
    });
  });

  // CodeRabbit: a stale ENTRY_FAILED or VISITORS_FAILED left lastError
  // hanging in state after a recovery/success transition. The banner
  // moved on but UI surfaces that read lastError directly would still
  // see the old failure. Every success/recovery transition must clear it.
  describe("clears lastError on recovery and success transitions", () => {
    const erroredState: GatePassState = {
      ...initialGatePassState,
      mode: "error",
      lastError: { code: "INTERNAL_ERROR", message: "stale" },
    };

    it("START_CAMERA clears stale lastError", () => {
      const next = gatePassReducer(erroredState, { type: "START_CAMERA" });
      expect(next.lastError).toBeUndefined();
    });

    it("SELECT_VISITOR clears stale lastError", () => {
      const next = gatePassReducer(erroredState, {
        type: "SELECT_VISITOR",
        visitor: recognizedVisitors[0],
      });
      expect(next.lastError).toBeUndefined();
    });

    it("VISITORS_LOADED clears stale lastError", () => {
      const next = gatePassReducer(
        { ...erroredState, searchLoading: true },
        { type: "VISITORS_LOADED", visitors: recognizedVisitors }
      );
      expect(next.lastError).toBeUndefined();
    });

    it("NAVIGATE clears stale lastError (already covered, regression guard)", () => {
      const next = gatePassReducer(erroredState, {
        type: "NAVIGATE",
        mode: "home",
      });
      expect(next.lastError).toBeUndefined();
    });
  });

  // ─── Resident approval lifecycle (Feature 1) ──────────────────────────
  // Source: src/docs/specs/resident-approval-flow.md §6, §11
  describe("Approval lifecycle (Feature 1)", () => {
    const baseApproval = {
      id: "11111111-1111-4111-8111-111111111111",
      draft: {
        visitorName: "Maya",
        host: "Host",
        unit: "1A",
        plate: "",
        reason: "",
        method: "walk-in" as const,
      },
      magicLinkUrl: "http://localhost:5173/approve/11111111-1111-4111-8111-111111111111?token=" + "a".repeat(64),
      expiresAt: new Date("2024-01-01T00:05:00Z").toISOString(),
      status: "pending" as const,
      traceId: "trace-1",
    };

    it("APPROVAL_REQUEST_STARTED flips to inFlight and clears errors", () => {
      const errored: GatePassState = {
        ...initialGatePassState,
        lastError: { code: "PRIOR", message: "stale" },
      };
      const next = gatePassReducer(errored, { type: "APPROVAL_REQUEST_STARTED" });
      expect(next.inFlight).toBe(true);
      expect(next.lastError).toBeUndefined();
      expect(next.banner.tone).toBe("info");
    });

    it("APPROVAL_REQUEST_SUCCEEDED enters awaiting-approval with pendingApproval populated", () => {
      const next = gatePassReducer(initialGatePassState, {
        type: "APPROVAL_REQUEST_SUCCEEDED",
        approval: baseApproval,
      });
      expect(next.mode).toBe("awaiting-approval");
      expect(next.inFlight).toBe(false);
      expect(next.pendingApproval).toEqual(baseApproval);
      expect(next.audit[0]).toContain("approval_requested");
      expect(next.audit[0]).toContain(baseApproval.id);
    });

    it("APPROVAL_REQUEST_FAILED flips to error and clears pendingApproval (no silent recovery)", () => {
      const withPending: GatePassState = {
        ...initialGatePassState,
        mode: "awaiting-approval",
        pendingApproval: baseApproval,
      };
      const next = gatePassReducer(withPending, {
        type: "APPROVAL_REQUEST_FAILED",
        error: { code: "SERVER_ERROR", message: "500" },
      });
      expect(next.mode).toBe("error");
      expect(next.pendingApproval).toBeUndefined();
      expect(next.lastError?.code).toBe("SERVER_ERROR");
      expect(next.banner.tone).toBe("danger");
    });

    it("APPROVAL_POLLED updates the in-flight status without losing magic link", () => {
      const withPending: GatePassState = {
        ...initialGatePassState,
        mode: "awaiting-approval",
        pendingApproval: baseApproval,
      };
      const next = gatePassReducer(withPending, {
        type: "APPROVAL_POLLED",
        status: "pending",
      });
      // Status unchanged on a pending->pending poll; the magic link and
      // expiresAt must NOT be touched (UI countdown depends on them).
      expect(next.pendingApproval?.status).toBe("pending");
      expect(next.pendingApproval?.magicLinkUrl).toBe(baseApproval.magicLinkUrl);
      expect(next.pendingApproval?.expiresAt).toBe(baseApproval.expiresAt);
    });

    it("APPROVAL_POLLED is a no-op when no approval is pending (guard reset between poll and response)", () => {
      const next = gatePassReducer(initialGatePassState, {
        type: "APPROVAL_POLLED",
        status: "pending",
      });
      expect(next).toBe(initialGatePassState);
    });

    it("APPROVAL_RESOLVED logs the entry and clears pendingApproval", () => {
      const withPending: GatePassState = {
        ...initialGatePassState,
        mode: "awaiting-approval",
        pendingApproval: baseApproval,
      };
      const entry = makeEntry({ visitorName: "Maya", id: "entry-1" });
      const next = gatePassReducer(withPending, {
        type: "APPROVAL_RESOLVED",
        entry,
      });
      expect(next.mode).toBe("confirmed");
      expect(next.pendingApproval).toBeUndefined();
      expect(next.lastEntry?.id).toBe("entry-1");
      expect(next.entries[0].id).toBe("entry-1");
      expect(next.audit[0]).toContain("approval_approved");
    });

    it("APPROVAL_DENIED flips to error, sanitizes the reason, includes it in the banner", () => {
      const withPending: GatePassState = {
        ...initialGatePassState,
        mode: "awaiting-approval",
        pendingApproval: baseApproval,
      };
      // Resident-provided reason with control chars + extra whitespace.
      const next = gatePassReducer(withPending, {
        type: "APPROVAL_DENIED",
        reason: "  Not expected today\u0007  ",
      });
      expect(next.mode).toBe("error");
      expect(next.pendingApproval).toBeUndefined();
      expect(next.lastError?.code).toBe("APPROVAL_DENIED");
      expect(next.banner.message).toContain("Not expected today");
      // The control char (\u0007) must be stripped.
      expect(next.banner.message).not.toContain("\u0007");
      expect(next.audit[0]).toContain("approval_denied");
    });

    it("APPROVAL_DENIED with empty reason still produces a useful banner", () => {
      const withPending: GatePassState = {
        ...initialGatePassState,
        mode: "awaiting-approval",
        pendingApproval: baseApproval,
      };
      const next = gatePassReducer(withPending, {
        type: "APPROVAL_DENIED",
        reason: "   ",
      });
      expect(next.banner.message).toBe("Resident denied entry.");
      expect(next.lastError?.message).toBe("Resident denied entry.");
    });

    it("APPROVAL_EXPIRED flips to error with the expiry banner and clears pendingApproval", () => {
      const withPending: GatePassState = {
        ...initialGatePassState,
        mode: "awaiting-approval",
        pendingApproval: baseApproval,
      };
      const next = gatePassReducer(withPending, { type: "APPROVAL_EXPIRED" });
      expect(next.mode).toBe("error");
      expect(next.pendingApproval).toBeUndefined();
      expect(next.lastError?.code).toBe("APPROVAL_EXPIRED");
      expect(next.banner.tone).toBe("warning");
      expect(next.audit[0]).toContain("approval_expired");
    });

    it("RESET_FLOW clears any in-flight approval", () => {
      const withPending: GatePassState = {
        ...initialGatePassState,
        mode: "awaiting-approval",
        pendingApproval: baseApproval,
      };
      const next = gatePassReducer(withPending, { type: "RESET_FLOW" });
      expect(next.pendingApproval).toBeUndefined();
      expect(next.mode).toBe("home");
    });
  });

  // ─── Feature 2 — Notifications lifecycle ────────────────────────────
  // Source: src/docs/specs/notifications.md §9.
  describe("Notifications lifecycle (Feature 2)", () => {
    const APPROVAL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const APPROVAL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    const baseApproval = {
      id: APPROVAL_A,
      draft: {
        visitorName: "Maya",
        host: "Host",
        unit: "1A",
        plate: "",
        reason: "",
        method: "walk-in" as const,
      },
      magicLinkUrl: `http://localhost:5173/approve/${APPROVAL_A}?token=${"a".repeat(64)}`,
      expiresAt: new Date("2024-01-01T00:05:00Z").toISOString(),
      status: "pending" as const,
      traceId: "trace-app-a",
    };

    function makeRow(over: Partial<{
      id: string;
      approvalId: string;
      channel: "whatsapp" | "sms";
      status:
        | "queued"
        | "sending"
        | "delivered"
        | "failed"
        | "permanently_failed";
      attempts: number;
      lastErrorCode: string | null;
      lastProviderResponseCode: number | null;
      deliveredAt: string | null;
      failedAt: string | null;
    }> = {}) {
      return {
        id: "n-1",
        approvalId: APPROVAL_A,
        channel: "whatsapp" as const,
        status: "queued" as const,
        attempts: 0,
        targetPhone: "+15551230001",
        templateKey: "approval.magic_link",
        lastErrorCode: null,
        lastProviderResponseCode: null,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        deliveredAt: null,
        failedAt: null,
        ...over,
      };
    }

    it("starts with an empty notifications slice", () => {
      expect(initialGatePassState.notifications).toEqual({
        byApprovalId: {},
        loading: false,
      });
    });

    it("NOTIFICATIONS_LOADING sets loading=true and clears lastError without dropping rows", () => {
      const seeded: GatePassState = {
        ...initialGatePassState,
        notifications: {
          byApprovalId: { [APPROVAL_A]: [makeRow()] },
          loading: false,
          lastError: { code: "X", message: "old" },
        },
      };
      const next = gatePassReducer(seeded, { type: "NOTIFICATIONS_LOADING" });
      expect(next.notifications.loading).toBe(true);
      expect(next.notifications.lastError).toBeUndefined();
      // Existing rows must be preserved during the in-flight poll.
      expect(next.notifications.byApprovalId[APPROVAL_A]).toHaveLength(1);
    });

    it("NOTIFICATIONS_LOADED replaces rows for one approval without touching others", () => {
      const seeded: GatePassState = {
        ...initialGatePassState,
        notifications: {
          byApprovalId: {
            [APPROVAL_A]: [makeRow({ id: "n-old", status: "queued" })],
            [APPROVAL_B]: [makeRow({ id: "n-b", approvalId: APPROVAL_B })],
          },
          loading: true,
        },
      };
      const fresh = [
        makeRow({ id: "n-old", status: "delivered" }),
        makeRow({ id: "n-2", channel: "sms" }),
      ];
      const next = gatePassReducer(seeded, {
        type: "NOTIFICATIONS_LOADED",
        approvalId: APPROVAL_A,
        notifications: fresh,
      });
      expect(next.notifications.loading).toBe(false);
      expect(next.notifications.byApprovalId[APPROVAL_A]).toHaveLength(2);
      expect(next.notifications.byApprovalId[APPROVAL_A][0].status).toBe(
        "delivered",
      );
      // Other approval untouched.
      expect(next.notifications.byApprovalId[APPROVAL_B]).toHaveLength(1);
      expect(next.notifications.byApprovalId[APPROVAL_B][0].id).toBe("n-b");
    });

    it("NOTIFICATIONS_LOADED preserves retryInFlight across re-polls when attempts unchanged", () => {
      const seeded: GatePassState = {
        ...initialGatePassState,
        notifications: {
          byApprovalId: {
            [APPROVAL_A]: [
              makeRow({ id: "n-1", attempts: 1, retryInFlight: true } as never),
            ],
          },
          loading: false,
        },
      };
      const next = gatePassReducer(seeded, {
        type: "NOTIFICATIONS_LOADED",
        approvalId: APPROVAL_A,
        notifications: [makeRow({ id: "n-1", attempts: 1 })],
      });
      expect(next.notifications.byApprovalId[APPROVAL_A][0].retryInFlight).toBe(
        true,
      );
    });

    it("NOTIFICATIONS_LOADED drops retryInFlight when attempts advances (server accepted)", () => {
      const seeded: GatePassState = {
        ...initialGatePassState,
        notifications: {
          byApprovalId: {
            [APPROVAL_A]: [
              makeRow({ id: "n-1", attempts: 1, retryInFlight: true } as never),
            ],
          },
          loading: false,
        },
      };
      const next = gatePassReducer(seeded, {
        type: "NOTIFICATIONS_LOADED",
        approvalId: APPROVAL_A,
        notifications: [makeRow({ id: "n-1", attempts: 2 })],
      });
      expect(
        next.notifications.byApprovalId[APPROVAL_A][0].retryInFlight,
      ).toBeUndefined();
    });

    it("NOTIFICATIONS_FAILED records lastError without clearing existing rows", () => {
      const seeded: GatePassState = {
        ...initialGatePassState,
        notifications: {
          byApprovalId: { [APPROVAL_A]: [makeRow()] },
          loading: true,
        },
      };
      const next = gatePassReducer(seeded, {
        type: "NOTIFICATIONS_FAILED",
        error: { code: "INTERNAL_ERROR", message: "boom" },
      });
      expect(next.notifications.loading).toBe(false);
      expect(next.notifications.lastError?.code).toBe("INTERNAL_ERROR");
      expect(next.notifications.byApprovalId[APPROVAL_A]).toHaveLength(1);
    });

    it("NOTIFICATIONS_RETRY_STARTED flags one row across all approvals", () => {
      const seeded: GatePassState = {
        ...initialGatePassState,
        notifications: {
          byApprovalId: {
            [APPROVAL_A]: [
              makeRow({ id: "n-1" }),
              makeRow({ id: "n-2" }),
            ],
          },
          loading: false,
        },
      };
      const next = gatePassReducer(seeded, {
        type: "NOTIFICATIONS_RETRY_STARTED",
        notificationId: "n-2",
      });
      expect(
        next.notifications.byApprovalId[APPROVAL_A][0].retryInFlight,
      ).toBeUndefined();
      expect(next.notifications.byApprovalId[APPROVAL_A][1].retryInFlight).toBe(
        true,
      );
    });

    it("NOTIFICATIONS_RETRY_SUCCEEDED overwrites by id and drops retryInFlight", () => {
      const seeded: GatePassState = {
        ...initialGatePassState,
        notifications: {
          byApprovalId: {
            [APPROVAL_A]: [
              makeRow({ id: "n-1", retryInFlight: true } as never),
            ],
          },
          loading: false,
        },
      };
      const next = gatePassReducer(seeded, {
        type: "NOTIFICATIONS_RETRY_SUCCEEDED",
        approvalId: APPROVAL_A,
        notification: makeRow({ id: "n-1", attempts: 2, status: "queued" }),
      });
      const row = next.notifications.byApprovalId[APPROVAL_A][0];
      expect(row.attempts).toBe(2);
      expect(row.retryInFlight).toBeUndefined();
      expect(row.retryError).toBeUndefined();
    });

    it("NOTIFICATIONS_RETRY_FAILED records retryError + drops retryInFlight on that row", () => {
      const seeded: GatePassState = {
        ...initialGatePassState,
        notifications: {
          byApprovalId: {
            [APPROVAL_A]: [
              makeRow({ id: "n-1", retryInFlight: true } as never),
              makeRow({ id: "n-2" }),
            ],
          },
          loading: false,
        },
      };
      const next = gatePassReducer(seeded, {
        type: "NOTIFICATIONS_RETRY_FAILED",
        notificationId: "n-1",
        error: { code: "RETRY_RATE_LIMITED", message: "too soon" },
      });
      const row = next.notifications.byApprovalId[APPROVAL_A][0];
      expect(row.retryInFlight).toBe(false);
      expect(row.retryError?.code).toBe("RETRY_RATE_LIMITED");
      // Sibling rows untouched.
      expect(
        next.notifications.byApprovalId[APPROVAL_A][1].retryInFlight,
      ).toBeUndefined();
    });

    it("APPROVAL_RESOLVED drops notifications for the resolved approval only", () => {
      const seeded: GatePassState = {
        ...initialGatePassState,
        mode: "awaiting-approval",
        pendingApproval: baseApproval,
        notifications: {
          byApprovalId: {
            [APPROVAL_A]: [makeRow()],
            [APPROVAL_B]: [makeRow({ approvalId: APPROVAL_B, id: "n-b" })],
          },
          loading: false,
        },
      };
      const entry = {
        id: "e-1",
        offlineId: APPROVAL_A,
        visitorName: "Maya",
        host: "Host",
        unit: "1A",
        plate: "",
        reason: "",
        method: "walk-in" as const,
        status: "confirmed" as const,
        syncState: "synced" as const,
        guardId: initialGatePassState.guardId,
        timestamp: new Date().toISOString(),
      };
      const next = gatePassReducer(seeded, {
        type: "APPROVAL_RESOLVED",
        entry,
      });
      expect(next.notifications.byApprovalId[APPROVAL_A]).toBeUndefined();
      expect(next.notifications.byApprovalId[APPROVAL_B]).toHaveLength(1);
    });

    it("APPROVAL_DENIED drops notifications for the denied approval", () => {
      const seeded: GatePassState = {
        ...initialGatePassState,
        mode: "awaiting-approval",
        pendingApproval: baseApproval,
        notifications: {
          byApprovalId: { [APPROVAL_A]: [makeRow()] },
          loading: false,
        },
      };
      const next = gatePassReducer(seeded, {
        type: "APPROVAL_DENIED",
        reason: "Resident said no",
      });
      expect(next.notifications.byApprovalId[APPROVAL_A]).toBeUndefined();
    });

    it("APPROVAL_EXPIRED drops notifications for the expired approval", () => {
      const seeded: GatePassState = {
        ...initialGatePassState,
        mode: "awaiting-approval",
        pendingApproval: baseApproval,
        notifications: {
          byApprovalId: { [APPROVAL_A]: [makeRow()] },
          loading: false,
        },
      };
      const next = gatePassReducer(seeded, { type: "APPROVAL_EXPIRED" });
      expect(next.notifications.byApprovalId[APPROVAL_A]).toBeUndefined();
    });

    it("RESET_FLOW wipes the entire notifications slice", () => {
      const seeded: GatePassState = {
        ...initialGatePassState,
        notifications: {
          byApprovalId: {
            [APPROVAL_A]: [makeRow()],
            [APPROVAL_B]: [makeRow({ approvalId: APPROVAL_B, id: "n-b" })],
          },
          loading: true,
          lastError: { code: "X", message: "stale" },
        },
      };
      const next = gatePassReducer(seeded, { type: "RESET_FLOW" });
      expect(next.notifications).toEqual({ byApprovalId: {}, loading: false });
    });
  });
});
