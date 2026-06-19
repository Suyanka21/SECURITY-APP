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
import { VISITOR_PROFILE_NEW_KEY } from "../types";
import type { VisitorProfileView } from "@/lib/api/types";

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

  // ─── Feature 3 — Auto-approval short-circuit ───────────────────────
  // Source: src/docs/specs/auto-approval.md §5 (state machine extension).
  describe("Auto-approval lifecycle (Feature 3)", () => {
    const autoRule = {
      id: "rule-11111111-1111-4111-8111-111111111111",
      visitorName: "Maya Chen",
      host: "A. Okafor",
      unit: "18B",
    };

    it("APPROVAL_AUTO_APPROVED lands in 'confirmed' WITHOUT awaiting-approval", () => {
      const entry = makeEntry({
        visitorName: "Maya Chen",
        id: "entry-auto-1",
        method: "auto",
      });
      const next = gatePassReducer(initialGatePassState, {
        type: "APPROVAL_AUTO_APPROVED",
        entry,
        rule: autoRule,
      });

      expect(next.mode).toBe("confirmed");
      expect(next.inFlight).toBe(false);
      expect(next.pendingApproval).toBeUndefined();
      expect(next.lastError).toBeUndefined();
      expect(next.lastEntry?.id).toBe("entry-auto-1");
      expect(next.lastEntry?.method).toBe("auto");
      expect(next.entries[0].id).toBe("entry-auto-1");
      expect(next.banner.tone).toBe("success");
      expect(next.banner.message).toContain("Auto-approved");
      expect(next.banner.message).toContain("Maya Chen");
    });

    it("APPROVAL_AUTO_APPROVED emits paired audit lines (rule + entry)", () => {
      // Spec §3 louder audit: the local audit log must surface
      // BOTH the rule that fired AND the entry that was logged so
      // an auditor reading the UI can tell auto from manual.
      const entry = makeEntry({
        visitorName: "Maya Chen",
        id: "entry-auto-2",
        method: "auto",
      });
      const next = gatePassReducer(initialGatePassState, {
        type: "APPROVAL_AUTO_APPROVED",
        entry,
        rule: autoRule,
      });

      // Two new audit lines, in this order: rule first, entry second.
      expect(next.audit[0]).toContain("auto_approval_matched");
      expect(next.audit[0]).toContain(autoRule.id);
      expect(next.audit[0]).toContain('visitor="Maya Chen"');
      expect(next.audit[0]).toContain('host="A. Okafor"');
      expect(next.audit[0]).toContain('unit="18B"');
      // The second audit line is the entry-level line (auditLine()).
      expect(next.audit[1]).toContain("entry-auto-2");
    });

    it("APPROVAL_AUTO_APPROVED clears stale lastError + stale awaiting state", () => {
      // Defense in depth: if the reducer is asked to short-circuit
      // while a leftover pending approval still exists in state (e.g.
      // the user navigated back into a stale walk-in form), the auto
      // path MUST overwrite — not silently merge — that state.
      const stalePending: GatePassState = {
        ...initialGatePassState,
        mode: "awaiting-approval",
        pendingApproval: {
          id: "stale-approval-id",
          draft: {
            visitorName: "Stale",
            host: "Stale",
            unit: "Stale",
            plate: "",
            reason: "",
            method: "walk-in",
          },
          magicLinkUrl: "http://example.com/approve/stale",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          status: "pending",
          traceId: "trace-stale",
        },
        lastError: { code: "ANYTHING_OLD", message: "stale" },
      };
      const entry = makeEntry({
        visitorName: "Maya Chen",
        id: "entry-auto-3",
        method: "auto",
      });
      const next = gatePassReducer(stalePending, {
        type: "APPROVAL_AUTO_APPROVED",
        entry,
        rule: autoRule,
      });

      expect(next.mode).toBe("confirmed");
      expect(next.pendingApproval).toBeUndefined();
      expect(next.lastError).toBeUndefined();
    });

    it("APPROVAL_AUTO_APPROVED prepends to entries — never mutates the existing list", () => {
      const existing = makeEntry({ id: "existing-1" });
      const seeded: GatePassState = {
        ...initialGatePassState,
        entries: [existing],
      };
      const newEntry = makeEntry({
        id: "entry-auto-4",
        visitorName: "Maya Chen",
        method: "auto",
      });
      const next = gatePassReducer(seeded, {
        type: "APPROVAL_AUTO_APPROVED",
        entry: newEntry,
        rule: autoRule,
      });

      expect(next.entries).toHaveLength(2);
      expect(next.entries[0].id).toBe("entry-auto-4");
      expect(next.entries[1].id).toBe("existing-1");
      // Immutability: the original entries array reference is not
      // reused — required so React renders pick up the change.
      expect(next.entries).not.toBe(seeded.entries);
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

    it("NOTIFICATIONS_LOADED for a non-pending approval is rejected (no resurrection after terminal)", () => {
      // The controller may race a late LOADED in after APPROVAL_DENIED
      // has wiped the slice. The reducer is the atomic guard: if the
      // pending approval isn't `action.approvalId`, the rows must not
      // come back.
      const seeded: GatePassState = {
        ...initialGatePassState,
        pendingApproval: undefined,
        notifications: { byApprovalId: {}, loading: true },
      };
      const next = gatePassReducer(seeded, {
        type: "NOTIFICATIONS_LOADED",
        approvalId: APPROVAL_A,
        notifications: [makeRow()],
      });
      expect(next.notifications.byApprovalId[APPROVAL_A]).toBeUndefined();
      // But the loading flag still flips off so a stuck spinner can't linger.
      expect(next.notifications.loading).toBe(false);
    });

    it("NOTIFICATIONS_LOADED replaces rows for one approval without touching others", () => {
      const seeded: GatePassState = {
        ...initialGatePassState,
        pendingApproval: baseApproval,
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
        pendingApproval: baseApproval,
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
        pendingApproval: baseApproval,
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
        cooldownUntilMs: 1_000_000,
      });
      const row = next.notifications.byApprovalId[APPROVAL_A][0];
      expect(row.attempts).toBe(2);
      expect(row.retryInFlight).toBeUndefined();
      expect(row.retryError).toBeUndefined();
      // Slice 8: cooldown is stamped on the row so the UI can disable
      // Resend for ~30s (spec §6 user-triggered retry cap).
      expect(row.retryCooldownUntilMs).toBe(1_000_000);
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

  // ---------------------------------------------------------------
  // Feature 4 — Visitor profile CRUD reducer (spec §8).
  //
  // The slice is admin-only. RESET_FLOW must NOT touch it.
  // No silent success is tolerated: every MUTATION_STARTED has to land
  // on exactly one of UPSERTED / REMOVED / RESTORED / MUTATION_FAILED.
  // ---------------------------------------------------------------
  describe("visitor profile CRUD lifecycle", () => {
    const PROFILE_A_ID = "00000000-0000-4000-8000-0000000000a1";
    const PROFILE_B_ID = "00000000-0000-4000-8000-0000000000b2";

    function makeProfile(
      overrides: Partial<VisitorProfileView> = {},
    ): VisitorProfileView {
      return {
        id: PROFILE_A_ID,
        visitorName: "Maya Chen",
        host: "A. Okafor",
        unit: "18B",
        plate: "LND-482",
        phoneE164: "+254700000001",
        notes: null,
        watchFlag: false,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        deletedAt: null,
        ...overrides,
      };
    }

    function seededState(
      overrides: Partial<GatePassState["visitorProfiles"]> = {},
    ): GatePassState {
      return {
        ...initialGatePassState,
        visitorProfiles: {
          ...initialGatePassState.visitorProfiles,
          ...overrides,
        },
      };
    }

    it("LIST_STARTED sets loading and clears any stale lastError", () => {
      const seeded = seededState({
        lastError: { code: "INTERNAL_ERROR", message: "oops" },
      });
      const next = gatePassReducer(seeded, {
        type: "VISITOR_PROFILES_LIST_STARTED",
      });
      expect(next.visitorProfiles.loading).toBe(true);
      expect(next.visitorProfiles.lastError).toBeUndefined();
    });

    it("LIST_LOADED replaces byId/order/pagination atomically", () => {
      const p1 = makeProfile();
      const p2 = makeProfile({
        id: PROFILE_B_ID,
        visitorName: "Dario Miles",
        host: "N. Patel",
        unit: "07C",
      });
      const next = gatePassReducer(
        seededState({ loading: true }),
        {
          type: "VISITOR_PROFILES_LIST_LOADED",
          profiles: [p1, p2],
          pagination: { page: 1, pageSize: 25, totalItems: 2, totalPages: 1 },
        },
      );
      expect(next.visitorProfiles.byId).toEqual({
        [PROFILE_A_ID]: p1,
        [PROFILE_B_ID]: p2,
      });
      expect(next.visitorProfiles.order).toEqual([PROFILE_A_ID, PROFILE_B_ID]);
      expect(next.visitorProfiles.pagination).toEqual({
        page: 1,
        pageSize: 25,
        totalItems: 2,
        totalPages: 1,
      });
      expect(next.visitorProfiles.loading).toBe(false);
      expect(next.visitorProfiles.lastError).toBeUndefined();
    });

    it("LIST_FAILED preserves cached rows and surfaces the error", () => {
      const seeded = seededState({
        byId: { [PROFILE_A_ID]: makeProfile() },
        order: [PROFILE_A_ID],
        loading: true,
      });
      const next = gatePassReducer(seeded, {
        type: "VISITOR_PROFILES_LIST_FAILED",
        error: { code: "INTERNAL_ERROR", message: "boom" },
      });
      expect(next.visitorProfiles.loading).toBe(false);
      expect(next.visitorProfiles.lastError).toEqual({
        code: "INTERNAL_ERROR",
        message: "boom",
      });
      // Cached rows survive a transient failure.
      expect(next.visitorProfiles.order).toEqual([PROFILE_A_ID]);
      expect(next.visitorProfiles.byId[PROFILE_A_ID]).toBeDefined();
    });

    it("MUTATION_STARTED flips in-flight and clears any prior per-row error", () => {
      const seeded = seededState({
        mutationErrors: {
          [PROFILE_A_ID]: { code: "INTERNAL_ERROR", message: "old" },
        },
      });
      const next = gatePassReducer(seeded, {
        type: "VISITOR_PROFILE_MUTATION_STARTED",
        profileId: PROFILE_A_ID,
      });
      expect(next.visitorProfiles.mutationInFlight[PROFILE_A_ID]).toBe(true);
      expect(
        next.visitorProfiles.mutationErrors[PROFILE_A_ID],
      ).toBeUndefined();
    });

    it("UPSERTED on create prepends to order and clears __new__ in-flight", () => {
      // Simulates: dispatch MUTATION_STARTED("__new__") then UPSERTED with
      // mutationKey="__new__" once the server returns the new profile.
      const started = gatePassReducer(initialGatePassState, {
        type: "VISITOR_PROFILE_MUTATION_STARTED",
        profileId: VISITOR_PROFILE_NEW_KEY,
      });
      expect(
        started.visitorProfiles.mutationInFlight[VISITOR_PROFILE_NEW_KEY],
      ).toBe(true);
      const fresh = makeProfile({ id: PROFILE_B_ID });
      const next = gatePassReducer(started, {
        type: "VISITOR_PROFILE_UPSERTED",
        profile: fresh,
        mutationKey: VISITOR_PROFILE_NEW_KEY,
      });
      expect(next.visitorProfiles.byId[PROFILE_B_ID]).toEqual(fresh);
      expect(next.visitorProfiles.order).toEqual([PROFILE_B_ID]);
      expect(
        next.visitorProfiles.mutationInFlight[VISITOR_PROFILE_NEW_KEY],
      ).toBeUndefined();
    });

    it("UPSERTED on update replaces byId in place and does NOT reorder", () => {
      const original = makeProfile();
      const seeded = seededState({
        byId: {
          [PROFILE_A_ID]: original,
          [PROFILE_B_ID]: makeProfile({ id: PROFILE_B_ID }),
        },
        order: [PROFILE_A_ID, PROFILE_B_ID],
        mutationInFlight: { [PROFILE_A_ID]: true },
      });
      const patched = makeProfile({
        watchFlag: true,
        updatedAt: "2024-02-01T00:00:00.000Z",
      });
      const next = gatePassReducer(seeded, {
        type: "VISITOR_PROFILE_UPSERTED",
        profile: patched,
      });
      expect(next.visitorProfiles.byId[PROFILE_A_ID]).toEqual(patched);
      // Scroll position preserved — no reorder on update.
      expect(next.visitorProfiles.order).toEqual([PROFILE_A_ID, PROFILE_B_ID]);
      expect(
        next.visitorProfiles.mutationInFlight[PROFILE_A_ID],
      ).toBeUndefined();
    });

    it("REMOVED drops from order when includeDeleted=false but keeps the row in byId", () => {
      const seeded = seededState({
        byId: { [PROFILE_A_ID]: makeProfile() },
        order: [PROFILE_A_ID],
        mutationInFlight: { [PROFILE_A_ID]: true },
        includeDeleted: false,
      });
      const tombstoned = makeProfile({
        deletedAt: "2024-02-01T00:00:00.000Z",
      });
      const next = gatePassReducer(seeded, {
        type: "VISITOR_PROFILE_REMOVED",
        profile: tombstoned,
      });
      expect(next.visitorProfiles.order).toEqual([]);
      expect(next.visitorProfiles.byId[PROFILE_A_ID]).toEqual(tombstoned);
      expect(
        next.visitorProfiles.mutationInFlight[PROFILE_A_ID],
      ).toBeUndefined();
    });

    it("REMOVED keeps the row in order when includeDeleted=true so the admin sees the tombstone", () => {
      const seeded = seededState({
        byId: { [PROFILE_A_ID]: makeProfile() },
        order: [PROFILE_A_ID],
        includeDeleted: true,
      });
      const tombstoned = makeProfile({
        deletedAt: "2024-02-01T00:00:00.000Z",
      });
      const next = gatePassReducer(seeded, {
        type: "VISITOR_PROFILE_REMOVED",
        profile: tombstoned,
      });
      expect(next.visitorProfiles.order).toEqual([PROFILE_A_ID]);
      expect(next.visitorProfiles.byId[PROFILE_A_ID].deletedAt).toBe(
        "2024-02-01T00:00:00.000Z",
      );
    });

    it("RESTORED clears deletedAt and re-adds the row to order if missing", () => {
      // Soft-deleted row was dropped from `order` by an earlier REMOVED.
      const tombstoned = makeProfile({
        deletedAt: "2024-02-01T00:00:00.000Z",
      });
      const seeded = seededState({
        byId: { [PROFILE_A_ID]: tombstoned },
        order: [],
      });
      const restored = makeProfile({ deletedAt: null });
      const next = gatePassReducer(seeded, {
        type: "VISITOR_PROFILE_RESTORED",
        profile: restored,
      });
      expect(next.visitorProfiles.byId[PROFILE_A_ID].deletedAt).toBeNull();
      expect(next.visitorProfiles.order).toEqual([PROFILE_A_ID]);
    });

    it("MUTATION_FAILED records the per-row error and clears in-flight (no silent success)", () => {
      const seeded = seededState({
        byId: { [PROFILE_A_ID]: makeProfile() },
        order: [PROFILE_A_ID],
        mutationInFlight: { [PROFILE_A_ID]: true },
      });
      const next = gatePassReducer(seeded, {
        type: "VISITOR_PROFILE_MUTATION_FAILED",
        profileId: PROFILE_A_ID,
        error: {
          code: "AUTH_FORBIDDEN",
          message: "Guard tokens cannot mutate profiles.",
          traceId: "trace-1",
        },
      });
      expect(
        next.visitorProfiles.mutationInFlight[PROFILE_A_ID],
      ).toBeUndefined();
      expect(next.visitorProfiles.mutationErrors[PROFILE_A_ID]).toEqual({
        code: "AUTH_FORBIDDEN",
        message: "Guard tokens cannot mutate profiles.",
        traceId: "trace-1",
      });
      // The row in byId is NOT mutated — the failed write must not
      // appear to have succeeded.
      expect(next.visitorProfiles.byId[PROFILE_A_ID].watchFlag).toBe(false);
    });

    it("TOGGLE_INCLUDE_DELETED flips the flag and clears stale list error", () => {
      const seeded = seededState({
        includeDeleted: false,
        lastError: { code: "INTERNAL_ERROR", message: "stale" },
      });
      const next = gatePassReducer(seeded, {
        type: "VISITOR_PROFILES_TOGGLE_INCLUDE_DELETED",
      });
      expect(next.visitorProfiles.includeDeleted).toBe(true);
      expect(next.visitorProfiles.lastError).toBeUndefined();
      const back = gatePassReducer(next, {
        type: "VISITOR_PROFILES_TOGGLE_INCLUDE_DELETED",
      });
      expect(back.visitorProfiles.includeDeleted).toBe(false);
    });

    it("RESET_FLOW leaves the admin slice untouched (it belongs to a different lifecycle)", () => {
      const seeded = seededState({
        byId: { [PROFILE_A_ID]: makeProfile() },
        order: [PROFILE_A_ID],
        pagination: { page: 1, pageSize: 25, totalItems: 1, totalPages: 1 },
        includeDeleted: true,
      });
      const next = gatePassReducer(seeded, { type: "RESET_FLOW" });
      expect(next.visitorProfiles.order).toEqual([PROFILE_A_ID]);
      expect(next.visitorProfiles.byId[PROFILE_A_ID]).toBeDefined();
      expect(next.visitorProfiles.includeDeleted).toBe(true);
      expect(next.visitorProfiles.pagination).toEqual({
        page: 1,
        pageSize: 25,
        totalItems: 1,
        totalPages: 1,
      });
    });
  });

  // ─── Feature 5 — Shift log aggregation ────────────────────────────────────
  // Source: src/docs/specs/shift-log-aggregation.md §7 (reducer contract).
  describe("shift log slice (Feature 5)", () => {
    const GUARD_ID = "22222222-2222-4222-8222-222222222222";

    function makeRow(over: Partial<{ entries: number }> = {}) {
      return {
        guardId: GUARD_ID,
        guardName: "A. Okafor",
        badgeNumber: "G-1042",
        totals: {
          entries: over.entries ?? 1,
          qr: 1,
          walkIn: 0,
          override: 0,
          recognized: 0,
          auto: 0,
          approvalsDenied: 0,
          approvalsExpired: 0,
          autoApprovalsMatched: 0,
          overrideAuthorized: 0,
        },
      };
    }

    it("seeds the empty shifts slice on initial state", () => {
      expect(initialGatePassState.shifts).toEqual({
        query: {},
        rows: [],
        loading: false,
      });
    });

    it("SHIFTS_QUERY_CHANGED updates the filter and clears stale lastError", () => {
      const seeded: GatePassState = {
        ...initialGatePassState,
        shifts: {
          ...initialGatePassState.shifts,
          lastError: { code: "INTERNAL_ERROR", message: "stale" },
        },
      };
      const next = gatePassReducer(seeded, {
        type: "SHIFTS_QUERY_CHANGED",
        query: {
          fromIso: "2024-01-15T00:00:00.000Z",
          toIso: "2024-01-16T00:00:00.000Z",
          guardId: GUARD_ID,
        },
      });
      expect(next.shifts.query).toEqual({
        fromIso: "2024-01-15T00:00:00.000Z",
        toIso: "2024-01-16T00:00:00.000Z",
        guardId: GUARD_ID,
      });
      expect(next.shifts.lastError).toBeUndefined();
      // Rows / loading untouched by query edit.
      expect(next.shifts.rows).toEqual([]);
      expect(next.shifts.loading).toBe(false);
    });

    it("SHIFTS_LIST_STARTED flips loading and clears lastError, preserving prior rows", () => {
      const prevRows = [makeRow()];
      const seeded: GatePassState = {
        ...initialGatePassState,
        shifts: {
          query: {},
          rows: prevRows,
          loading: false,
          lastError: { code: "INTERNAL_ERROR", message: "old" },
        },
      };
      const next = gatePassReducer(seeded, { type: "SHIFTS_LIST_STARTED" });
      expect(next.shifts.loading).toBe(true);
      expect(next.shifts.lastError).toBeUndefined();
      // Prior rows preserved so the UI does not blank during refresh.
      expect(next.shifts.rows).toBe(prevRows);
    });

    it("SHIFTS_LIST_LOADED stores window + rows, clears loading and lastError", () => {
      const seeded: GatePassState = {
        ...initialGatePassState,
        shifts: {
          query: {},
          rows: [],
          loading: true,
          lastError: { code: "INTERNAL_ERROR", message: "old" },
        },
      };
      const rows = [makeRow({ entries: 3 }), makeRow({ entries: 1 })];
      const next = gatePassReducer(seeded, {
        type: "SHIFTS_LIST_LOADED",
        window: {
          fromIso: "2024-01-15T00:00:00.000Z",
          toIso: "2024-01-15T18:00:00.000Z",
        },
        rows,
      });
      expect(next.shifts.loading).toBe(false);
      expect(next.shifts.lastError).toBeUndefined();
      expect(next.shifts.window).toEqual({
        fromIso: "2024-01-15T00:00:00.000Z",
        toIso: "2024-01-15T18:00:00.000Z",
      });
      expect(next.shifts.rows).toBe(rows);
    });

    it("SHIFTS_LIST_FAILED records lastError, clears loading, and KEEPS prior rows (no silent wipe)", () => {
      const prevRows = [makeRow({ entries: 2 })];
      const prevWindow = {
        fromIso: "2024-01-15T00:00:00.000Z",
        toIso: "2024-01-15T18:00:00.000Z",
      };
      const seeded: GatePassState = {
        ...initialGatePassState,
        shifts: {
          query: {},
          window: prevWindow,
          rows: prevRows,
          loading: true,
        },
      };
      const next = gatePassReducer(seeded, {
        type: "SHIFTS_LIST_FAILED",
        error: {
          code: "INTERNAL_ERROR",
          message: "An unexpected error occurred",
          traceId: "trace-x",
        },
      });
      expect(next.shifts.loading).toBe(false);
      expect(next.shifts.lastError).toEqual({
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
        traceId: "trace-x",
      });
      // Prior rows + window preserved — a failure must not look like
      // a silent empty list.
      expect(next.shifts.rows).toBe(prevRows);
      expect(next.shifts.window).toBe(prevWindow);
    });

    it("RESET_FLOW leaves the shifts slice untouched (admin lifecycle, not walk-in)", () => {
      const rows = [makeRow()];
      const seeded: GatePassState = {
        ...initialGatePassState,
        shifts: {
          query: { guardId: GUARD_ID },
          window: {
            fromIso: "2024-01-15T00:00:00.000Z",
            toIso: "2024-01-15T18:00:00.000Z",
          },
          rows,
          loading: false,
        },
      };
      const next = gatePassReducer(seeded, { type: "RESET_FLOW" });
      expect(next.shifts.rows).toBe(rows);
      expect(next.shifts.query).toEqual({ guardId: GUARD_ID });
      expect(next.shifts.window).toEqual({
        fromIso: "2024-01-15T00:00:00.000Z",
        toIso: "2024-01-15T18:00:00.000Z",
      });
    });
  });

  // ─── Feature 6 — visitor invitation slice ─────────────────────────
  // Source: src/docs/specs/guest-qr-ticket.md §7 + gatepassReducer.ts
  // The default-deny invariant: ISSUE_FAILED must NEVER leave the
  // slice in "issued" — no path can land the form on a success card
  // unless the server returned a real 201 with an invitation payload.

  describe("visitor invitation slice", () => {
    const INVITATION_ID = "66666666-6666-4666-8666-666666666666";
    const RAW_TOKEN = "TEST_RAW_TOKEN_FORTY_THREE_CHARS_ABCDEFGHIJ";
    function makeIssued() {
      return {
        id: INVITATION_ID,
        qrToken: RAW_TOKEN,
        passUrl: `https://gate.example.com/pass/${RAW_TOKEN}`,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        issuedAt: new Date().toISOString(),
        visitorName: "Maya Chen",
        host: "A. Okafor",
        unit: "18B",
        plate: null,
      };
    }

    it("initial state is idle with no lastIssued / lastError", () => {
      expect(initialGatePassState.visitorInvitations).toEqual({
        status: "idle",
      });
    });

    it("VISITOR_INVITATION_ISSUE_STARTED clears prior issued + error and enters submitting", () => {
      const seeded: GatePassState = {
        ...initialGatePassState,
        visitorInvitations: {
          status: "issued",
          lastIssued: makeIssued(),
          lastError: { code: "PRIOR", message: "stale" },
        },
      };
      const next = gatePassReducer(seeded, {
        type: "VISITOR_INVITATION_ISSUE_STARTED",
      });
      expect(next.visitorInvitations.status).toBe("submitting");
      expect(next.visitorInvitations.lastIssued).toBeUndefined();
      expect(next.visitorInvitations.lastError).toBeUndefined();
    });

    it("VISITOR_INVITATION_ISSUE_SUCCEEDED lands in 'issued' with the full invitation view", () => {
      const inv = makeIssued();
      const next = gatePassReducer(initialGatePassState, {
        type: "VISITOR_INVITATION_ISSUE_SUCCEEDED",
        invitation: inv,
      });
      expect(next.visitorInvitations.status).toBe("issued");
      expect(next.visitorInvitations.lastIssued).toEqual(inv);
      expect(next.visitorInvitations.lastError).toBeUndefined();
    });

    it("VISITOR_INVITATION_ISSUE_FAILED lands in 'failed' with the error (default-deny: NOT in 'issued')", () => {
      const seeded: GatePassState = {
        ...initialGatePassState,
        visitorInvitations: { status: "submitting" },
      };
      const next = gatePassReducer(seeded, {
        type: "VISITOR_INVITATION_ISSUE_FAILED",
        error: {
          code: "AUTH_FORBIDDEN",
          message: "Guard tokens cannot mint invitations",
          traceId: "trace-403",
        },
      });
      expect(next.visitorInvitations.status).toBe("failed");
      expect(next.visitorInvitations.status).not.toBe("issued");
      expect(next.visitorInvitations.lastIssued).toBeUndefined();
      expect(next.visitorInvitations.lastError).toEqual({
        code: "AUTH_FORBIDDEN",
        message: "Guard tokens cannot mint invitations",
        traceId: "trace-403",
      });
    });

    it("VISITOR_INVITATION_RESET clears the slice back to idle (drops raw token from memory)", () => {
      const seeded: GatePassState = {
        ...initialGatePassState,
        visitorInvitations: {
          status: "issued",
          lastIssued: makeIssued(),
        },
      };
      const next = gatePassReducer(seeded, {
        type: "VISITOR_INVITATION_RESET",
      });
      expect(next.visitorInvitations).toEqual({ status: "idle" });
      // Critical: the raw token is no longer reachable from state.
      expect(JSON.stringify(next.visitorInvitations)).not.toContain(RAW_TOKEN);
    });

    it("RESET_FLOW does NOT clear the visitor-invitation slice (admin subview, not per-walk-in)", () => {
      const inv = makeIssued();
      const seeded: GatePassState = {
        ...initialGatePassState,
        visitorInvitations: { status: "issued", lastIssued: inv },
      };
      const next = gatePassReducer(seeded, { type: "RESET_FLOW" });
      expect(next.visitorInvitations.status).toBe("issued");
      expect(next.visitorInvitations.lastIssued).toEqual(inv);
    });

    it("default-deny: an ISSUE_FAILED following a stale ISSUE_SUCCEEDED clears lastIssued", () => {
      const seeded: GatePassState = {
        ...initialGatePassState,
        visitorInvitations: { status: "issued", lastIssued: makeIssued() },
      };
      const next = gatePassReducer(seeded, {
        type: "VISITOR_INVITATION_ISSUE_FAILED",
        error: { code: "INTERNAL_ERROR", message: "kaboom" },
      });
      // The form MUST NOT display the prior issued card after a failed retry.
      expect(next.visitorInvitations.lastIssued).toBeUndefined();
      expect(next.visitorInvitations.status).toBe("failed");
    });
  });

  // ─── Feature 7 — Exit tracking lifecycle ─────────────────────────────
  // Source: src/docs/specs/exit-tracking.md §8.

  describe("Exit tracking lifecycle (Feature 7)", () => {
    const ENTRY_ID = "entry-aaa-111";
    const EXIT_VIEW = {
      id: "exit-1",
      entryId: ENTRY_ID,
      guardId: DEFAULT_GUARD_ID,
      createdAt: "2024-06-01T10:30:00.000Z",
      traceId: "trace-exit-1",
    };
    const ON_PREMISE_ENTRY = {
      id: ENTRY_ID,
      visitorName: "Maya Chen",
      host: "A. Okafor",
      unit: "18B",
      plate: "LND-482" as string | null,
      method: "walk-in" as const,
      guardId: DEFAULT_GUARD_ID,
      createdAt: "2024-06-01T10:00:00.000Z",
    };

    it("EXIT_TRACKING_LIST_STARTED sets loading=true and clears lastError", () => {
      const seeded: GatePassState = {
        ...initialGatePassState,
        exitTracking: {
          ...initialGatePassState.exitTracking,
          lastError: { code: "OLD", message: "stale" },
        },
      };
      const next = gatePassReducer(seeded, { type: "EXIT_TRACKING_LIST_STARTED" });
      expect(next.exitTracking.loading).toBe(true);
      expect(next.exitTracking.lastError).toBeUndefined();
    });

    it("EXIT_TRACKING_LIST_LOADED replaces onPremise and clears loading", () => {
      const seeded: GatePassState = {
        ...initialGatePassState,
        exitTracking: { ...initialGatePassState.exitTracking, loading: true },
      };
      const next = gatePassReducer(seeded, {
        type: "EXIT_TRACKING_LIST_LOADED",
        entries: [ON_PREMISE_ENTRY],
        count: 1,
        traceId: "trace-list",
      });
      expect(next.exitTracking.onPremise).toEqual([ON_PREMISE_ENTRY]);
      expect(next.exitTracking.loading).toBe(false);
      expect(next.exitTracking.lastError).toBeUndefined();
    });

    it("EXIT_TRACKING_LIST_FAILED sets lastError but keeps cached onPremise", () => {
      const seeded: GatePassState = {
        ...initialGatePassState,
        exitTracking: {
          ...initialGatePassState.exitTracking,
          onPremise: [ON_PREMISE_ENTRY],
          loading: true,
        },
      };
      const next = gatePassReducer(seeded, {
        type: "EXIT_TRACKING_LIST_FAILED",
        error: { code: "INTERNAL_ERROR", message: "boom" },
      });
      expect(next.exitTracking.loading).toBe(false);
      expect(next.exitTracking.lastError?.code).toBe("INTERNAL_ERROR");
      // Cached rows survive.
      expect(next.exitTracking.onPremise).toEqual([ON_PREMISE_ENTRY]);
    });

    it("EXIT_RECORD_STARTED sets exitInFlight and clears previous error for that entry", () => {
      const seeded: GatePassState = {
        ...initialGatePassState,
        exitTracking: {
          ...initialGatePassState.exitTracking,
          exitErrors: { [ENTRY_ID]: { code: "OLD", message: "stale" } },
        },
      };
      const next = gatePassReducer(seeded, {
        type: "EXIT_RECORD_STARTED",
        entryId: ENTRY_ID,
      });
      expect(next.exitTracking.exitInFlight[ENTRY_ID]).toBe(true);
      expect(next.exitTracking.exitErrors[ENTRY_ID]).toBeUndefined();
    });

    it("EXIT_RECORD_SUCCEEDED removes entry from onPremise and sets lastExit", () => {
      const seeded: GatePassState = {
        ...initialGatePassState,
        exitTracking: {
          ...initialGatePassState.exitTracking,
          onPremise: [ON_PREMISE_ENTRY],
          exitInFlight: { [ENTRY_ID]: true },
        },
      };
      const next = gatePassReducer(seeded, {
        type: "EXIT_RECORD_SUCCEEDED",
        exit: EXIT_VIEW,
        entryId: ENTRY_ID,
      });
      expect(next.exitTracking.onPremise).toEqual([]);
      expect(next.exitTracking.exitInFlight[ENTRY_ID]).toBeUndefined();
      expect(next.exitTracking.lastExit).toEqual(EXIT_VIEW);
    });

    it("EXIT_RECORD_FAILED clears exitInFlight and sets per-entry error", () => {
      const seeded: GatePassState = {
        ...initialGatePassState,
        exitTracking: {
          ...initialGatePassState.exitTracking,
          onPremise: [ON_PREMISE_ENTRY],
          exitInFlight: { [ENTRY_ID]: true },
        },
      };
      const next = gatePassReducer(seeded, {
        type: "EXIT_RECORD_FAILED",
        entryId: ENTRY_ID,
        error: { code: "EXIT_NO_OPEN_ENTRY", message: "No entry found" },
      });
      expect(next.exitTracking.exitInFlight[ENTRY_ID]).toBeUndefined();
      expect(next.exitTracking.exitErrors[ENTRY_ID]?.code).toBe("EXIT_NO_OPEN_ENTRY");
      // On-premise list is NOT modified on failure.
      expect(next.exitTracking.onPremise).toEqual([ON_PREMISE_ENTRY]);
    });

    it("EXIT_RECORD_SUCCEEDED does not remove other entries from onPremise", () => {
      const otherEntry = { ...ON_PREMISE_ENTRY, id: "entry-bbb-222", visitorName: "Dario Miles" };
      const seeded: GatePassState = {
        ...initialGatePassState,
        exitTracking: {
          ...initialGatePassState.exitTracking,
          onPremise: [ON_PREMISE_ENTRY, otherEntry],
          exitInFlight: { [ENTRY_ID]: true },
        },
      };
      const next = gatePassReducer(seeded, {
        type: "EXIT_RECORD_SUCCEEDED",
        exit: EXIT_VIEW,
        entryId: ENTRY_ID,
      });
      expect(next.exitTracking.onPremise).toEqual([otherEntry]);
    });

    it("RESET_FLOW does NOT clear exitTracking (admin subview, not per-walk-in)", () => {
      const seeded: GatePassState = {
        ...initialGatePassState,
        exitTracking: {
          ...initialGatePassState.exitTracking,
          onPremise: [ON_PREMISE_ENTRY],
          lastExit: EXIT_VIEW,
        },
      };
      const next = gatePassReducer(seeded, { type: "RESET_FLOW" });
      expect(next.exitTracking.onPremise).toEqual([ON_PREMISE_ENTRY]);
      expect(next.exitTracking.lastExit).toEqual(EXIT_VIEW);
    });
  });
});
