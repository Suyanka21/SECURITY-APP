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
import type {
  ApiResult,
  ApprovalRequestView,
  ApprovalStatusResponse,
  CreateApprovalResponse,
  RecognizedVisitorsResponse,
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

function makeApprovalApi(scenario: string): typeof guardApprovalApi {
  const createApproval = async (): Promise<ApiResult<CreateApprovalResponse>> => {
    if (scenario === "approval-create-409") {
      return fail(409, "APPROVAL_DUPLICATE", "An approval is already pending for this entry");
    }
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

const SCENARIOS = [
  { id: "submit-500", label: "S1 · POST /entries → 500" },
  { id: "submit-422-unit", label: "S2 · POST /entries → 422 (field=unit)" },
  { id: "sync-207-partial", label: "S3 · POST /sync → 207 partial" },
  { id: "approval-approved", label: "S4 · Approval → approved+entry (Feature 1)" },
  { id: "approval-denied", label: "S5 · Approval → denied with reason (Feature 1)" },
  { id: "approval-expired", label: "S6 · Approval → expired (lazy, Feature 1)" },
  { id: "approval-create-409", label: "S7 · Approval create → 409 duplicate (Feature 1)" },
  { id: "approval-poll-blip", label: "S8 · Approval poll → transient network blip (Feature 1)" },
  { id: "happy", label: "Happy path (sanity)" },
];

function Harness() {
  const initial =
    new URLSearchParams(location.search).get("scenario") ?? "submit-500";
  const [scenario, setScenario] = useState(initial);
  const api = makeScenarioApi(scenario);
  const approvalApi = makeApprovalApi(scenario);

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
        controller={{ api, approvalApi, approvalPollIntervalMs: 1500 }}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
