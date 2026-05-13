/**
 * GatePass — Side-effect controller.
 *
 * The pure reducer (`gatepassReducer.ts`) cannot perform I/O, so all
 * API calls live here. Each high-level guard action wraps the network
 * call with explicit lifecycle dispatches:
 *
 *   start  → success | offline-queue | error
 *
 * No success path runs without a real backend acknowledgement, and
 * every failure (validation, auth, rate-limit, server, network)
 * surfaces an `ENTRY_FAILED` / `QR_SCAN_FAILED` / `SYNC_FAILED`
 * dispatch so the UI is forced to render an explicit error state.
 *
 * Source: src/docs/gatepass-api-contract.md
 * Source: src/docs/GATEPASS DEFINITION.md — failure mode catalog
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { gatePassApi } from "@/lib/api/gatepass";
import type {
  ApiResult,
  CreateEntryResponse,
  QrValidateResponse,
  RecognizedVisitorsResponse,
  ServerEntry,
  SyncBatchResponse,
  SyncEntryRequest,
} from "@/lib/api/types";
import {
  gatePassReducer,
  initialGatePassState,
  validateDraft,
} from "./gatepassReducer";
import type {
  EntryDraft,
  EntryRecord,
  GatePassError,
  Visitor,
} from "./types";

// ─── Helpers ──────────────────────────────────────────────────────────

function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for very old jsdom — uuid v4-shaped string. Sync endpoint
  // requires UUIDs so we keep the shape valid.
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += "-";
    else if (i === 14) out += "4";
    else if (i === 19) out += hex[8 + Math.floor(Math.random() * 4)];
    else out += hex[Math.floor(Math.random() * 16)];
  }
  return out;
}

function errorFromApi(result: Extract<ApiResult<unknown>, { ok: false }>): GatePassError {
  return {
    code: result.error.code,
    message: result.error.message,
    field: result.error.field,
    traceId: result.error.traceId,
  };
}

function entryFromServer(server: ServerEntry, offlineId?: string): EntryRecord {
  return {
    visitorName: server.visitorName,
    host: server.host,
    unit: server.unit,
    plate: server.plate ?? "",
    reason: server.reason,
    method: server.method,
    preApprovalId: undefined,
    id: server.id,
    offlineId,
    guardId: server.guardId,
    createdAt: server.createdAt,
    status: server.status,
    syncState: server.syncState,
  };
}

function localEntryFromDraft(
  draft: EntryDraft,
  guardId: string,
  createdAt: string,
  offlineId: string
): EntryRecord {
  return {
    visitorName: draft.visitorName.trim(),
    host: draft.host.trim(),
    unit: draft.unit.trim(),
    plate: draft.plate.trim(),
    reason: draft.reason.trim(),
    method: draft.method,
    preApprovalId: draft.preApprovalId,
    id: offlineId,
    offlineId,
    guardId,
    createdAt,
    status: "sync-pending",
    syncState: "queued",
  };
}

// ─── Hook ─────────────────────────────────────────────────────────────

export interface GatePassController {
  state: ReturnType<typeof gatePassReducer>;
  dispatch: React.Dispatch<Parameters<typeof gatePassReducer>[1]>;
  submitEntry: () => Promise<void>;
  scanQr: (token: string) => Promise<void>;
  syncPending: () => Promise<void>;
  searchVisitors: (query?: string) => Promise<void>;
  setNetwork: (network: "online" | "offline") => void;
}

export interface GatePassControllerOptions {
  api?: typeof gatePassApi;
  /** Override clock for deterministic tests. */
  now?: () => Date;
  /** Override UUID generator for deterministic tests. */
  generateId?: () => string;
}

export function useGatePassController(
  options: GatePassControllerOptions = {}
): GatePassController {
  const api = options.api ?? gatePassApi;
  // Pin clock + id generator into refs so callbacks don't re-create on
  // every render (and so tests get the deterministic versions).
  const clockRef = useRef(options.now ?? (() => new Date()));
  clockRef.current = options.now ?? clockRef.current;
  const newIdRef = useRef(options.generateId ?? generateId);
  newIdRef.current = options.generateId ?? newIdRef.current;

  const [state, dispatch] = useReducer(gatePassReducer, initialGatePassState);

  // Keep latest state in a ref so callbacks don't re-create on every
  // state change (avoids re-binding panels each render).
  const stateRef = useRef(state);
  stateRef.current = state;

  const submitEntry = useCallback(async () => {
    const current = stateRef.current;
    if (current.inFlight) return;

    const validation = validateDraft(current.draft, current.guardId);
    if (validation) {
      dispatch({ type: "ENTRY_FAILED", error: validation });
      return;
    }

    const offlineId = newIdRef.current();
    const createdAt = clockRef.current().toISOString();
    const local = localEntryFromDraft(
      current.draft,
      current.guardId,
      createdAt,
      offlineId
    );

    if (current.network === "offline") {
      // Don't even attempt the request — surface the queued state
      // immediately and let `syncPending` reconcile when the network
      // comes back.
      dispatch({ type: "ENTRY_QUEUED", entry: local });
      return;
    }

    dispatch({ type: "ENTRY_STARTED" });

    const result = await api.submitEntry({
      visitorName: local.visitorName,
      host: local.host,
      unit: local.unit,
      plate: local.plate.length > 0 ? local.plate : null,
      reason: local.reason,
      method: local.method,
      createdAt,
      preApprovalId: local.preApprovalId,
      offlineId,
    });

    if (result.ok) {
      dispatch({
        type: "ENTRY_SUCCEEDED",
        entry: entryFromServer(result.data.entry, offlineId),
      });
      return;
    }

    // Network / transport failures get queued — the entry isn't lost.
    if (result.status === 0) {
      dispatch({ type: "ENTRY_QUEUED", entry: local });
      return;
    }

    // Every other failure (auth, validation, rate limit, server, etc.)
    // surfaces an explicit error. The guard sees the backend code and
    // message verbatim.
    dispatch({ type: "ENTRY_FAILED", error: errorFromApi(result) });
  }, [api]);

  const scanQr = useCallback(
    async (token: string) => {
      const current = stateRef.current;
      if (current.inFlight) return;

      const trimmed = token.trim();
      if (trimmed.length === 0) {
        dispatch({
          type: "QR_SCAN_FAILED",
          qrState: "invalid",
          error: {
            code: "QR_MALFORMED",
            message: "QR token is required before validating.",
            field: "qrToken",
          },
        });
        return;
      }

      if (current.network === "offline") {
        dispatch({
          type: "QR_SCAN_FAILED",
          qrState: "invalid",
          error: {
            code: "NETWORK_ERROR",
            message:
              "QR validation requires a live backend connection. Use walk-in or override.",
          },
        });
        return;
      }

      dispatch({ type: "QR_SCAN_STARTED" });

      const result: ApiResult<QrValidateResponse> = await api.validateQr({
        qrToken: trimmed,
        scannedAt: clockRef.current().toISOString(),
      });

      if (result.ok) {
        const v = result.data.visitor;
        dispatch({
          type: "QR_SCAN_SUCCEEDED",
          draft: {
            visitorName: v.name,
            host: v.host,
            unit: v.unit,
            plate: v.plate ?? "",
            reason: "QR pre-approval",
            method: "qr",
            preApprovalId: v.preApprovalId,
          },
        });
        return;
      }

      // Map backend error code → reducer's qrState discriminant so the
      // UI can render the right red banner.
      const code = result.error.code;
      const qrState: "invalid" | "replayed" | "expired" =
        code === "QR_REPLAYED"
          ? "replayed"
          : code === "QR_EXPIRED"
            ? "expired"
            : "invalid";

      dispatch({
        type: "QR_SCAN_FAILED",
        qrState,
        error: errorFromApi(result),
      });
    },
    [api]
  );

  const syncPending = useCallback(async () => {
    const current = stateRef.current;
    if (current.inFlight) return;

    if (current.network === "offline") {
      dispatch({
        type: "SYNC_FAILED",
        error: {
          code: "NETWORK_ERROR",
          message: "Still offline. Sync not attempted.",
        },
      });
      return;
    }

    if (current.pendingSync.length === 0) {
      // Nothing to sync — no-op without a banner change.
      return;
    }

    dispatch({ type: "SYNC_STARTED" });

    const entries: SyncEntryRequest[] = current.pendingSync
      .map((e) => {
        if (!e.offlineId) return null;
        return {
          offlineId: e.offlineId,
          visitorName: e.visitorName,
          host: e.host,
          unit: e.unit,
          plate: e.plate.length > 0 ? e.plate : null,
          reason: e.reason,
          method: e.method,
          createdAt: e.createdAt,
        };
      })
      .filter((e): e is SyncEntryRequest => e !== null);

    const result: ApiResult<SyncBatchResponse> = await api.syncEntries({
      entries,
    });

    if (!result.ok) {
      dispatch({ type: "SYNC_FAILED", error: errorFromApi(result) });
      return;
    }

    // Build the next pending queue: keep only rejected entries (with
    // their error attached). Synced + duplicate are reconciled into the
    // main entries log.
    const resultByOfflineId = new Map(result.data.results.map((r) => [r.offlineId, r]));
    const keptInQueue: EntryRecord[] = [];
    const newlySynced: EntryRecord[] = [];
    for (const e of current.pendingSync) {
      if (!e.offlineId) {
        keptInQueue.push(e);
        continue;
      }
      const r = resultByOfflineId.get(e.offlineId);
      if (!r) {
        // Server didn't include this offlineId — keep it queued and
        // mark it failed so it doesn't silently disappear.
        keptInQueue.push({
          ...e,
          syncState: "failed",
          lastError: {
            code: "SYNC_MISSING_RESULT",
            message: "Server did not return a result for this entry.",
          },
        });
        continue;
      }
      if (r.status === "rejected") {
        keptInQueue.push({
          ...e,
          syncState: "failed",
          lastError: r.error ?? {
            code: "SYNC_REJECTED",
            message: "Entry was rejected during sync.",
          },
        });
        continue;
      }
      // synced or duplicate — promote with server's canonical ID.
      newlySynced.push({
        ...e,
        id: r.serverId,
        status: "logged",
        syncState: "synced",
        lastError: undefined,
      });
    }

    dispatch({
      type: "SYNC_COMPLETED",
      results: result.data.results,
      keptInQueue,
      newlySynced,
    });
  }, [api]);

  const searchVisitors = useCallback(
    async (query?: string) => {
      const q = (query ?? stateRef.current.searchQuery).trim();

      if (stateRef.current.network === "offline") {
        dispatch({
          type: "VISITORS_FAILED",
          error: {
            code: "NETWORK_ERROR",
            message: "Recognized visitor lookup requires a live connection.",
          },
        });
        return;
      }

      dispatch({ type: "VISITORS_LOADING" });

      const result: ApiResult<RecognizedVisitorsResponse> =
        await api.searchVisitors({ q, page: 1, pageSize: 20 });

      if (!result.ok) {
        dispatch({ type: "VISITORS_FAILED", error: errorFromApi(result) });
        return;
      }

      const visitors: Visitor[] = result.data.visitors.map((v) => ({
        id: v.id,
        name: v.name,
        host: v.host,
        unit: v.unit,
        plate: v.plate ?? undefined,
        lastSeen: v.lastSeen,
        recognition: v.recognition,
      }));
      dispatch({ type: "VISITORS_LOADED", visitors });
    },
    [api]
  );

  const setNetwork = useCallback(
    (network: "online" | "offline") => {
      dispatch({ type: "SET_NETWORK", network });
    },
    []
  );

  // Auto-sync on network restore. If the guard toggled back online and
  // there are queued entries, attempt a sync so floating records get
  // reconciled without the guard having to remember to press a button.
  // (Records still cannot vanish silently — every per-entry result is
  // surfaced in `lastSyncResults`.)
  const lastNetwork = useRef(state.network);
  useEffect(() => {
    if (
      lastNetwork.current === "offline" &&
      state.network === "online" &&
      state.pendingSync.length > 0 &&
      !state.inFlight
    ) {
      void syncPending();
    }
    lastNetwork.current = state.network;
  }, [state.network, state.pendingSync.length, state.inFlight, syncPending]);

  return useMemo(
    () => ({
      state,
      dispatch,
      submitEntry,
      scanQr,
      syncPending,
      searchVisitors,
      setNetwork,
    }),
    [state, submitEntry, scanQr, syncPending, searchVisitors, setNetwork]
  );
}
