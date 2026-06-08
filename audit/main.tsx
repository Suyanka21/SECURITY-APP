/**
 * Trustless audit harness — NOT shipped to production.
 *
 * Drives the real <GatePassApp /> with deterministic backend stubs so
 * the audit can reproduce specific server responses (500, 422, 207
 * partial sync) without a live database. Selected via ?scenario=<name>.
 */

import { createRoot } from "react-dom/client";
import { useState } from "react";
import "@/index.css";
import { GatePassApp } from "@/features/gatepass/GatePassApp";
import type { GatePassApi } from "@/lib/api/gatepass";
import type { guardApprovalApi } from "@/lib/api/approvals";
import type { guardNotificationsApi } from "@/lib/api/notifications";
import type { visitorProfilesApi } from "@/lib/api/visitor-profiles";
import type { shiftsApi } from "@/lib/api/shifts";
import type {
  ApiResult,
  ApprovalRequestView,
  ApprovalStatusResponse,
  CreateApprovalResponse,
  ListShiftsResponse,
  ListVisitorProfilesResponse,
  NotificationRetryResponse,
  NotificationView,
  NotificationsListResponse,
  RecognizedVisitorsResponse,
  ShiftSummaryView,
  VisitorProfileResponse,
  VisitorProfileView,
} from "@/lib/api/types";

function ok<T>(data: T, status = 200): ApiResult<T> {
  return { ok: true, status, data };
}
function fail(
  status: number,
  code: string,
  message: string,
  field?: string
): ApiResult<never> {
  return {
    ok: false,
    status,
    error: { code, message, field, traceId: `trace-${code}` },
  };
}

const baseSearchOk: ApiResult<RecognizedVisitorsResponse> = ok({
  visitors: [
    {
      id: "v-101",
      name: "Maya Chen",
      host: "A. Okafor",
      unit: "18B",
      plate: "LND-482",
      lastSeen: "08:42",
      recognition: "pre-approved",
    },
  ],
  pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
  traceId: "trace-vis",
});

function makeScenarioApi(scenario: string): GatePassApi {
  const searchVisitors = async () => baseSearchOk;
  const validateQr = async () =>
    fail(404, "QR_NOT_FOUND", "QR code not recognized");

  if (scenario === "submit-500") {
    return {
      submitEntry: async () =>
        fail(
          500,
          "INTERNAL_ERROR",
          "An unexpected error occurred. Trace this with the operations team."
        ),
      syncEntries: async () => fail(500, "INTERNAL_ERROR", "Server is down"),
      validateQr,
      searchVisitors,
    };
  }
  if (scenario === "submit-422-unit") {
    return {
      submitEntry: async () =>
        fail(422, "UNIT_REQUIRED", "Unit is required to prevent orphan entries", "unit"),
      syncEntries: async () => fail(500, "INTERNAL_ERROR", "n/a"),
      validateQr,
      searchVisitors,
    };
  }
  if (scenario === "sync-207-partial") {
    // Two queued entries; one synced, one rejected.
    return {
      submitEntry: async () =>
        fail(0, "NETWORK_ERROR", "Could not reach the GatePass backend."),
      syncEntries: async (input) => {
        const ids = input.entries.map((e) => e.offlineId);
        return ok(
          {
            results: [
              { offlineId: ids[0]!, serverId: "server-A1", status: "synced" as const },
              {
                offlineId: ids[1]!,
                serverId: "",
                status: "rejected" as const,
                error: {
                  code: "VALIDATION_ERROR",
                  message: "Visitor name is on the blocklist",
                },
              },
            ],
            syncedCount: 1,
            duplicateCount: 0,
            rejectedCount: 1,
            traceId: "trace-sync-partial",
          },
          207
        );
      },
      validateQr,
      searchVisitors,
    };
  }
  // Default: everything succeeds for sanity checking.
  return {
    submitEntry: async () =>
      ok({
        entry: {
          id: "server-OK",
          visitorName: "Ada Lovelace",
          host: "Bola",
          unit: "4A",
          plate: null,
          reason: "",
          method: "walk-in" as const,
          guardId: "guard-west-04",
          createdAt: new Date().toISOString(),
          status: "logged" as const,
          syncState: "synced" as const,
        },
        traceId: "trace-ok",
      }),
    syncEntries: async () =>
      ok({
        results: [],
        syncedCount: 0,
        duplicateCount: 0,
        rejectedCount: 0,
        traceId: "trace-empty",
      }),
    validateQr,
    searchVisitors,
  };
}

// ─── Resident approval scenarios (Feature 1) ──────────────────────────
// Source: src/docs/specs/resident-approval-flow.md §5 (state machine)

const APPROVAL_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "a".repeat(64);
const MAGIC_URL = `${location.origin}/approve/${APPROVAL_ID}?token=${TOKEN}`;

function baseApproval(
  overrides: Partial<ApprovalRequestView> = {}
): ApprovalRequestView {
  return {
    id: APPROVAL_ID,
    offlineId: "00000000-0000-4000-8000-000000000001",
    visitorName: "Maya Chen",
    host: "A. Okafor",
    unit: "18B",
    plate: null,
    reason: "",
    method: "walk-in" as const,
    requestedByGuardId: "guard-west-04",
    status: "pending" as const,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    decidedAt: null,
    deniedReason: null,
    entryId: null,
    traceId: "trace-status",
    ...overrides,
  };
}

// ─── Auto-approval scenario fixtures (Feature 3) ──────────────────────
// Source: src/docs/specs/auto-approval.md §3, §5, §6.
const AUTO_RULE_ID = "rule-11111111-1111-4111-8111-111111111111";
const AUTO_ENTRY_ID = "entry-auto-99999999";

function autoApprovedCreateResponse(): CreateApprovalResponse {
  return {
    approvalId: APPROVAL_ID,
    magicLinkUrl: MAGIC_URL,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    traceId: "trace-auto-create",
    autoApproved: true,
    entry: {
      id: AUTO_ENTRY_ID,
      visitorName: "Maya Chen",
      host: "A. Okafor",
      unit: "18B",
      plate: "LND-482",
      reason: "",
      method: "auto",
      guardId: "guard-west-04",
      createdAt: new Date().toISOString(),
      status: "logged",
      syncState: "synced",
    },
    matchedRule: {
      id: AUTO_RULE_ID,
      visitorName: "Maya Chen",
      host: "A. Okafor",
      unit: "18B",
    },
  };
}

function makeApprovalApi(scenario: string): typeof guardApprovalApi {
  const createApproval = async (): Promise<ApiResult<CreateApprovalResponse>> => {
    if (scenario === "approval-create-409") {
      return fail(409, "APPROVAL_DUPLICATE", "An approval is already pending for this entry");
    }
    // A1: rule matches → server short-circuits with autoApproved=true.
    if (scenario === "auto-rule-match") {
      return ok(autoApprovedCreateResponse(), 201);
    }
    // A4: server signals autoApproved=true but the entry payload is
    // malformed. Frontend MUST default-deny — never silently land in
    // 'confirmed'. Spec §5 / §6 trustless contract.
    if (scenario === "auto-malformed") {
      const r = autoApprovedCreateResponse();
      return ok({ ...r, entry: null }, 201);
    }
    // A2 / A3 / A5: server does NOT auto-approve (rule expired / no
    // matching rule / plate-required-mismatch all manifest as a normal
    // manual approval response — the evaluator's non-match decision is
    // server-internal). Manual flow proceeds unchanged.
    return ok(
      {
        approvalId: APPROVAL_ID,
        magicLinkUrl: MAGIC_URL,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        traceId: "trace-create",
      },
      201
    );
  };

  // Status responses are scripted per-scenario. We sequence them so the
  // first poll returns "pending" and the second poll returns the
  // terminal state — proves the polling loop observes the transition.
  let callCount = 0;
  const getApprovalStatus = async (): Promise<ApiResult<ApprovalStatusResponse>> => {
    callCount += 1;
    if (scenario === "approval-approved") {
      if (callCount === 1) {
        return ok({ approval: baseApproval(), traceId: "t1" });
      }
      return ok({
        approval: baseApproval({
          status: "approved",
          decidedAt: new Date().toISOString(),
          entryId: "server-from-approval",
        }),
        traceId: "t2",
      });
    }
    if (scenario === "approval-denied") {
      if (callCount === 1) {
        return ok({ approval: baseApproval(), traceId: "t1" });
      }
      return ok({
        approval: baseApproval({
          status: "denied",
          decidedAt: new Date().toISOString(),
          deniedReason: "Not expected today",
        }),
        traceId: "t2",
      });
    }
    if (scenario === "approval-expired") {
      // Server lazy-flips on read.
      return ok({ approval: baseApproval({ status: "expired" }), traceId: "t" });
    }
    if (scenario === "approval-poll-blip") {
      // First poll: transient transport error. Subsequent polls: still
      // pending. The controller must keep the poll alive and never
      // silently resolve. Demonstrates the no-silent-success contract
      // even under intermittent connectivity.
      if (callCount === 1) {
        return {
          ok: false as const,
          status: 0,
          error: {
            code: "NETWORK_ERROR",
            message: "transient",
            traceId: "trace-blip",
          },
        };
      }
      return ok({ approval: baseApproval(), traceId: "t-pending" });
    }
    return ok({ approval: baseApproval(), traceId: "t" });
  };

  return { createApproval, getApprovalStatus } as unknown as typeof guardApprovalApi;
}

// ─── Notifications scenarios (Feature 2) ─────────────────────────────
// Source: src/docs/specs/notifications.md §5 (state machine) + §7
// (boundary) + §10 (failure scenarios)

function baseNotification(
  overrides: Partial<NotificationView> = {},
): NotificationView {
  return {
    id: "nn-1",
    approvalId: APPROVAL_ID,
    channel: "whatsapp",
    status: "queued",
    attempts: 0,
    targetPhone: "+15551230001",
    templateKey: "approval.request.v1",
    lastErrorCode: null,
    lastProviderResponseCode: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deliveredAt: null,
    failedAt: null,
    ...overrides,
  };
}

function makeNotificationsApi(
  scenario: string,
): typeof guardNotificationsApi {
  let listCount = 0;
  let retryCount = 0;
  const getNotifications = async (): Promise<
    ApiResult<NotificationsListResponse>
  > => {
    listCount += 1;
    // N1: queued → sent. Two polls — proves the row's status advances
    // on screen without a page reload (no silent stalling).
    if (scenario === "notif-queued-to-sent") {
      if (listCount === 1) {
        return ok({
          notifications: [baseNotification({ status: "queued", attempts: 0 })],
          traceId: "tn1",
        });
      }
      return ok({
        notifications: [
          baseNotification({
            status: "sent",
            attempts: 1,
            deliveredAt: new Date().toISOString(),
          }),
        ],
        traceId: "tn2",
      });
    }
    // N2: provider 5xx → row goes failed and the Resend button is the
    // only path forward. Spec §10.A — guard sees the failure, the UI
    // doesn't silently retry forever.
    if (scenario === "notif-provider-5xx") {
      return ok({
        notifications: [
          baseNotification({
            status: "failed",
            attempts: 3,
            lastErrorCode: "PROVIDER_5XX",
            lastProviderResponseCode: 503,
            failedAt: new Date().toISOString(),
          }),
        ],
        traceId: "tn",
      });
    }
    // N3: list 500 — the notifications stream surfaces its own error
    // banner WITHOUT collapsing the approval awaiting panel (spec §5
    // two-stream isolation). The audit must show the approval panel
    // still alive and the resident magic-link still copyable.
    if (scenario === "notif-list-500") {
      return fail(
        500,
        "INTERNAL_ERROR",
        "Notifications service temporarily unavailable.",
      );
    }
    // N4 + N5 — successful retry flow + RATE_LIMITED on second click.
    // First poll returns a failed row; after the user clicks Resend
    // the row stays queued (we simulate the dispatcher hasn't run yet)
    // so the cooldown is the only thing gating a double-retry.
    if (
      scenario === "notif-retry-ok" ||
      scenario === "notif-retry-rate-limited"
    ) {
      return ok({
        notifications: [
          baseNotification({
            status: "failed",
            attempts: 2,
            lastErrorCode: "PROVIDER_5XX",
            lastProviderResponseCode: 503,
            failedAt: new Date().toISOString(),
          }),
        ],
        traceId: "tn",
      });
    }
    // Happy path / fallback for other scenarios — no notifications at
    // all (matches the legacy "no host phone" approval flow).
    return ok({ notifications: [], traceId: "tn-empty" });
  };

  const retryNotification = async (
    id: string,
  ): Promise<ApiResult<NotificationRetryResponse>> => {
    retryCount += 1;
    if (scenario === "notif-retry-rate-limited") {
      // Spec §6 RATE_LIMITED — the first manual retry succeeds, any
      // additional attempt inside the per-approval window is rejected
      // with a 429 so the guard sees the cap, not a silent no-op.
      if (retryCount === 1) {
        return ok(
          {
            notification: baseNotification({
              id,
              status: "queued",
              attempts: 3,
            }),
            traceId: "trace-retry",
          },
          202,
        );
      }
      return fail(
        429,
        "RETRY_RATE_LIMITED",
        "Per-approval manual retry already used. Wait for the next window.",
      );
    }
    if (scenario === "notif-retry-ok") {
      return ok(
        {
          notification: baseNotification({
            id,
            status: "queued",
            attempts: 3,
          }),
          traceId: "trace-retry",
        },
        202,
      );
    }
    // Other scenarios don't expose Resend; this branch is unreachable
    // in practice but defaults to a safe failure.
    return fail(500, "INTERNAL_ERROR", "Retry not configured for scenario.");
  };

  return { getNotifications, retryNotification } as unknown as typeof guardNotificationsApi;
}

// ─── Visitor profile CRUD scenarios (Feature 4) ──────────────────
// Source: src/docs/specs/visitor-profiles.md §4 (API), §6 (UI), §8
// (frontend reducer contract).
//
// Each scenario stubs the EXACT response the server would give under
// the documented failure mode so the audit can prove the frontend
// surfaces it correctly:
//   V1 createProfile → 201 success      → row appended, modal closes
//   V2 createProfile → 409 duplicate    → modal stays open, field hint
//   V3 createProfile → 403 AUTH_FORBIDDEN (guard token, default-deny)
//   V4 softDeleteProfile → 200 success  → row drops or shows tombstone
//   V5 restoreProfile → 409 conflict    → inline error, no row added

const SEED_PROFILE: VisitorProfileView = {
  id: "00000000-0000-4000-8000-0000000000a1",
  visitorName: "Maya Chen",
  host: "A. Okafor",
  unit: "18B",
  plate: "LND-482",
  phoneE164: "+254700000001",
  notes: null,
  watchFlag: false,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-15T00:00:00.000Z",
  deletedAt: null,
};

const SEED_PROFILE_WATCH: VisitorProfileView = {
  ...SEED_PROFILE,
  id: "00000000-0000-4000-8000-0000000000a2",
  visitorName: "Risky Rita",
  plate: null,
  phoneE164: null,
  watchFlag: true,
};

function makeVisitorProfilesApi(
  scenario: string,
): typeof visitorProfilesApi {
  // Default fixture: two profiles seeded so V2/V3/V4/V5 have rows
  // to interact with and the watch-flag visual is visible at a glance.
  const seededList = [SEED_PROFILE_WATCH, SEED_PROFILE];

  const listProfiles = async (): Promise<
    ApiResult<ListVisitorProfilesResponse>
  > =>
    ok({
      profiles: seededList,
      pagination: { page: 1, pageSize: 25, totalItems: 2, totalPages: 1 },
      traceId: "trace-visitors-list",
    });

  const getProfile = async (
    id: string,
  ): Promise<ApiResult<VisitorProfileResponse>> => {
    const found = seededList.find((p) => p.id === id);
    if (!found) return fail(404, "PROFILE_NOT_FOUND", "No such profile.");
    return ok({ profile: found, traceId: "trace-get" });
  };

  const createProfile = async (
    input: { visitorName: string; host: string; unit: string },
  ): Promise<ApiResult<VisitorProfileResponse>> => {
    // V2 — conflict on uniqueness (visitorName + unit + null deletedAt).
    if (scenario === "visitor-create-409") {
      return fail(
        409,
        "PROFILE_DUPLICATE",
        "A profile with this name + unit already exists.",
        "visitorName",
      );
    }
    // V3 — critical default-deny test. requireRole(['admin','senior-guard'])
    // on the server rejects guard tokens with 403 AUTH_FORBIDDEN. The
    // frontend MUST surface this as an inline form error — no row
    // appears in the table, no silent success.
    if (scenario === "visitor-create-403") {
      return fail(
        403,
        "AUTH_FORBIDDEN",
        "Guard tokens cannot mutate visitor profiles.",
      );
    }
    // V1 — happy path.
    return ok(
      {
        profile: {
          ...SEED_PROFILE,
          id: "00000000-0000-4000-8000-0000000000ff",
          visitorName: input.visitorName,
          host: input.host,
          unit: input.unit,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        traceId: "trace-create",
      },
      201,
    );
  };

  const updateProfile = async (
    id: string,
    patch: Partial<VisitorProfileView>,
  ): Promise<ApiResult<VisitorProfileResponse>> =>
    ok({
      profile: {
        ...(seededList.find((p) => p.id === id) ?? SEED_PROFILE),
        ...patch,
        updatedAt: new Date().toISOString(),
      } as VisitorProfileView,
      traceId: "trace-update",
    });

  const softDeleteProfile = async (
    id: string,
  ): Promise<ApiResult<VisitorProfileResponse>> => {
    // V4 — happy-path soft-delete. Returns the row with deletedAt set
    // so the reducer can drop it from `order` (default visibility).
    //
    // The reducer keys updates by `profile.id`, so the stub MUST echo
    // the requested id back — otherwise a freshly-created profile
    // (whose id is not in `seededList`) would be "updated" under the
    // SEED_PROFILE fallback id and the original row's `mutationInFlight`
    // flag would never clear, leaving the Delete button stuck on
    // "Working…" forever. A real server returns the row matching
    // the requested id, never a different one.
    const found = seededList.find((p) => p.id === id) ?? SEED_PROFILE;
    return ok({
      profile: { ...found, id, deletedAt: new Date().toISOString() },
      traceId: "trace-delete",
    });
  };

  const restoreProfile = async (
    id: string,
  ): Promise<ApiResult<VisitorProfileResponse>> => {
    // V5 — the row exists but is not currently soft-deleted, so a
    // restore is a state-transition conflict. The frontend must show
    // an inline error and NOT add a duplicate row.
    if (scenario === "visitor-restore-409") {
      return fail(
        409,
        "PROFILE_RESTORE_CONFLICT",
        "Profile is not in a deleted state — nothing to restore.",
      );
    }
    // Echo the requested id back (see soft-delete note above) so the
    // reducer can locate and update the original row.
    const found = seededList.find((p) => p.id === id) ?? SEED_PROFILE;
    return ok({
      profile: { ...found, id, deletedAt: null },
      traceId: "trace-restore",
    });
  };

  return {
    listProfiles,
    getProfile,
    createProfile,
    updateProfile,
    softDeleteProfile,
    restoreProfile,
  } as unknown as typeof visitorProfilesApi;
}

// ─── Feature 5 — Shift log aggregation scenario fixtures ────────────
// Source: src/docs/specs/shift-log-aggregation.md §10 (audit harness
// scenarios). Two seeded guard rows so SH2 has something meaningful
// to filter against.

const SEED_SHIFT_ROW_A: ShiftSummaryView = {
  guardId: "22222222-2222-4222-8222-222222222222",
  guardName: "A. Okafor",
  badgeNumber: "G-1042",
  totals: {
    entries: 4,
    qr: 2,
    walkIn: 1,
    override: 1,
    recognized: 0,
    auto: 0,
    approvalsDenied: 1,
    approvalsExpired: 0,
    autoApprovalsMatched: 0,
    overrideAuthorized: 1,
  },
};

// Source: src/server/services/shift-log-service.ts:147-172 —
// incrementMethod() always bumps `entries` alongside the per-method
// counter, so the production invariant is
// `entries >= qr + walkIn + override + recognized + auto`
// (equal when every method is known, greater only when an unknown
// method-type slips through). Both SEED_SHIFT_ROW_A and B use known
// methods only, so entries must be EXACTLY the sum of the buckets.
const SEED_SHIFT_ROW_B: ShiftSummaryView = {
  guardId: "33333333-3333-4333-8333-333333333333",
  guardName: "M. Sato",
  badgeNumber: "G-1099",
  totals: {
    entries: 10, // 5 (qr) + 2 (walk-in) + 0 (override) + 0 (recognized) + 3 (auto)
    qr: 5,
    walkIn: 2,
    override: 0,
    recognized: 0,
    auto: 3,
    approvalsDenied: 0,
    approvalsExpired: 2,
    autoApprovalsMatched: 3,
    overrideAuthorized: 0,
  },
};

function makeShiftsApi(scenario: string): typeof shiftsApi {
  const listShifts = async (
    query: { fromIso?: string; toIso?: string; guardId?: string } = {},
  ): Promise<ApiResult<ListShiftsResponse>> => {
    // SH3 — critical default-deny test. requireRole(['admin','senior-
    // guard']) on the server rejects guard tokens with 403
    // AUTH_FORBIDDEN. The frontend MUST surface this as a banner and
    // not silently render an empty table.
    if (scenario === "shifts-list-403") {
      return fail(
        403,
        "AUTH_FORBIDDEN",
        "Guard tokens cannot read shift aggregations.",
      );
    }
    // SH4 — server error. Must surface, must not wipe prior rows.
    if (scenario === "shifts-list-500") {
      return fail(
        500,
        "INTERNAL_ERROR",
        "An unexpected error occurred. Please retry.",
      );
    }
    // SH2 — single-guard filter. When the admin pins guardId in the
    // form and clicks Refresh, the API receives the UUID. The stub
    // narrows the seeded rows so the panel proves the filter is
    // actually forwarded end-to-end.
    if (query.guardId) {
      const found =
        query.guardId === SEED_SHIFT_ROW_A.guardId
          ? [SEED_SHIFT_ROW_A]
          : query.guardId === SEED_SHIFT_ROW_B.guardId
            ? [SEED_SHIFT_ROW_B]
            : [];
      return ok({
        window: {
          fromIso: query.fromIso ?? "2024-02-01T00:00:00.000Z",
          toIso: query.toIso ?? "2024-02-01T08:00:00.000Z",
        },
        shifts: found,
        traceId: "trace-shifts-by-guard",
      });
    }
    // SH1 — happy path. Default window returns both rows sorted by
    // entries DESC (mirroring the server's deterministic sort).
    return ok({
      window: {
        fromIso: query.fromIso ?? "2024-02-01T00:00:00.000Z",
        toIso: query.toIso ?? "2024-02-01T08:00:00.000Z",
      },
      shifts: [SEED_SHIFT_ROW_B, SEED_SHIFT_ROW_A],
      traceId: "trace-shifts-list",
    });
  };

  return { listShifts } as unknown as typeof shiftsApi;
}

const SCENARIOS = [
  { id: "submit-500", label: "S1 · POST /entries → 500" },
  { id: "submit-422-unit", label: "S2 · POST /entries → 422 (field=unit)" },
  { id: "sync-207-partial", label: "S3 · POST /sync → 207 partial" },
  { id: "approval-approved", label: "S4 · Approval → approved+entry (Feature 1)" },
  { id: "approval-denied", label: "S5 · Approval → denied with reason (Feature 1)" },
  { id: "approval-expired", label: "S6 · Approval → expired (lazy, Feature 1)" },
  { id: "approval-create-409", label: "S7 · Approval create → 409 duplicate (Feature 1)" },
  { id: "approval-poll-blip", label: "S8 · Approval poll → transient network blip (Feature 1)" },
  { id: "notif-queued-to-sent", label: "N1 · Notification queued → sent (Feature 2)" },
  { id: "notif-provider-5xx", label: "N2 · Notification provider 5xx (Feature 2)" },
  { id: "notif-list-500", label: "N3 · Notification list 500 — approval still alive (Feature 2)" },
  { id: "notif-retry-ok", label: "N4 · Resend → 202 + cooldown (Feature 2)" },
  { id: "notif-retry-rate-limited", label: "N5 · Resend → 429 RATE_LIMITED (Feature 2)" },
  { id: "auto-rule-match", label: "A1 · Auto-approval rule matches → entry logged (Feature 3)" },
  { id: "auto-rule-expired", label: "A2 · Rule expired → manual flow (Feature 3)" },
  { id: "auto-no-rule", label: "A3 · No matching rule → manual flow (Feature 3)" },
  { id: "auto-malformed", label: "A4 · Malformed autoApproved=true → default-deny (Feature 3)" },
  { id: "auto-plate-mismatch", label: "A5 · plateRequired mismatch → manual flow (Feature 3)" },
  { id: "visitor-create-201", label: "V1 · Create profile → 201 success (Feature 4)" },
  { id: "visitor-create-409", label: "V2 · Create profile → 409 PROFILE_DUPLICATE (Feature 4)" },
  { id: "visitor-create-403", label: "V3 · Create profile → 403 AUTH_FORBIDDEN guard token (Feature 4 — critical default-deny)" },
  { id: "visitor-delete-200", label: "V4 · Soft-delete profile → 200 success (Feature 4)" },
  { id: "visitor-restore-409", label: "V5 · Restore profile → 409 PROFILE_RESTORE_CONFLICT (Feature 4)" },
  { id: "shifts-list-200", label: "SH1 · Shift log → 200 happy path (Feature 5)" },
  { id: "shifts-filter-guard", label: "SH2 · Shift log → single-guard filter (Feature 5)" },
  { id: "shifts-list-403", label: "SH3 · Shift log → 403 AUTH_FORBIDDEN (Feature 5 — critical default-deny)" },
  { id: "shifts-list-500", label: "SH4 · Shift log → 500 INTERNAL_ERROR (Feature 5)" },
  { id: "happy", label: "Happy path (sanity)" },
];

function Harness() {
  const initial =
    new URLSearchParams(location.search).get("scenario") ?? "submit-500";
  const [scenario, setScenario] = useState(initial);
  const api = makeScenarioApi(scenario);
  const approvalApi = makeApprovalApi(scenario);
  const notificationsApi = makeNotificationsApi(scenario);
  const visitorProfilesApi = makeVisitorProfilesApi(scenario);
  const shiftsApi = makeShiftsApi(scenario);

  return (
    <div>
      <div
        style={{
          position: "fixed",
          top: 8,
          right: 8,
          zIndex: 9999,
          background: "rgba(0,0,0,0.85)",
          color: "white",
          padding: "8px 12px",
          fontFamily: "monospace",
          fontSize: 12,
          border: "1px solid #999",
        }}
        data-testid="audit-scenario-picker"
      >
        <strong>AUDIT</strong>{" "}
        <select
          value={scenario}
          onChange={(e) => {
            setScenario(e.target.value);
            const url = new URL(location.href);
            url.searchParams.set("scenario", e.target.value);
            history.replaceState(null, "", url.toString());
          }}
          style={{ background: "#111", color: "white", border: "1px solid #555" }}
        >
          {SCENARIOS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <GatePassApp
        key={scenario}
        controller={{
          api,
          approvalApi,
          notificationsApi,
          visitorProfilesApi,
          shiftsApi,
          approvalPollIntervalMs: 1500,
          notificationsPollIntervalMs: 1500,
        }}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
