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
import type {
  ApiResult,
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

const SCENARIOS = [
  { id: "submit-500", label: "S1 · POST /entries → 500" },
  { id: "submit-422-unit", label: "S2 · POST /entries → 422 (field=unit)" },
  { id: "sync-207-partial", label: "S3 · POST /sync → 207 partial" },
  { id: "happy", label: "Happy path (sanity)" },
];

function Harness() {
  const initial =
    new URLSearchParams(location.search).get("scenario") ?? "submit-500";
  const [scenario, setScenario] = useState(initial);
  const api = makeScenarioApi(scenario);

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
      <GatePassApp key={scenario} controller={{ api }} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
