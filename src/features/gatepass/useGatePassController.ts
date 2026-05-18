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
import { guardApprovalApi } from "@/lib/api/approvals";
import { guardNotificationsApi } from "@/lib/api/notifications";
import type {
  ApiResult,
  ApprovalRequestView,
  ApprovalStatusResponse,
  CreateApprovalResponse,
  CreateEntryResponse,
  NotificationsListResponse,
  NotificationRetryResponse,
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
  NotificationDeliveryView,
  PendingApproval,
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

/**
 * Manual-retry cooldown window. Source: notifications.md §6 — per-
 * approval cap is 1 user-triggered retry. The UI surfaces it as a
 * 30s window so a double-click is absorbed locally instead of
 * counting as a real second click against the server limiter.
 */
const RETRY_COOLDOWN_MS = 30_000;

/**
 * Sanitize a user-typed phone field to a candidate E.164 string.
 *
 * Strips spaces, tabs, hyphens, parens, and dots — the formats a guard
 * is most likely to type given how phone numbers appear in messaging
 * apps and contact cards ("+1 (555) 123-0001", "+1.555.123.0001",
 * "+1-555-123-0001"). Anything else is left alone so the downstream
 * E.164 regex can reject it explicitly rather than the sanitizer
 * silently mangling a typo into a passing-looking number.
 *
 * Source: spec notifications.md §7.1, §11. Sanitizer is intentionally
 * conservative — it never inserts a leading "+", never reinterprets
 * country codes, and never strips digits. If the result fails E.164
 * validation, that's a real failure the guard needs to see.
 */
export function sanitizePhoneInput(raw: string): string {
  return raw.replace(/[\s\-().]/g, "");
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

/**
 * Build the EntryRecord the reducer needs from an approved ApprovalRequestView.
 *
 * Source: spec §7.3 — the entry is created server-side inside the approve
 * transaction, so by the time /status reports approved + entryId, the row
 * exists. The status endpoint returns the sanitized approval view (not the
 * raw entry), so we synthesize an EntryRecord from the approval fields
 * we know match — the same fields would come back from /api/entries.
 */
function entryFromApprovedView(
  approval: ApprovalRequestView
): EntryRecord {
  if (!approval.entryId) {
    throw new Error(
      "entryFromApprovedView called with no entryId \u2014 caller must gate on status='approved' AND entryId"
    );
  }
  return {
    visitorName: approval.visitorName,
    host: approval.host,
    unit: approval.unit,
    plate: approval.plate ?? "",
    reason: approval.reason,
    method: approval.method,
    preApprovalId: undefined,
    id: approval.entryId,
    offlineId: approval.offlineId,
    guardId: approval.requestedByGuardId,
    createdAt: approval.decidedAt ?? approval.expiresAt,
    status: "logged",
    syncState: "synced",
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
  /**
   * Initiate a resident-approval request for the current walk-in draft.
   * Source: spec §7.1. The optional E.164 phone (Feature 2) enables
   * WhatsApp/SMS delivery of the magic link; when absent the server
   * falls back to the legacy hand-copy flow.
   */
  requestApproval: (hostPhoneE164?: string) => Promise<void>;
  /**
   * Manually retry a failed notification (Feature 2). Used by the
   * Resend button in AwaitingApprovalPanel.
   * Source: src/docs/specs/notifications.md §7.3.
   */
  retryNotification: (notificationId: string) => Promise<void>;
}

export interface GatePassControllerOptions {
  api?: typeof gatePassApi;
  /** Optional override for the resident-approval client surface. */
  approvalApi?: typeof guardApprovalApi;
  /**
   * Optional override for the notifications client surface (Feature 2).
   * Source: src/docs/specs/notifications.md §7.
   */
  notificationsApi?: typeof guardNotificationsApi;
  /** Override clock for deterministic tests. */
  now?: () => Date;
  /** Override UUID generator for deterministic tests. */
  generateId?: () => string;
  /**
   * Polling interval for resident-approval status checks (ms). Defaults
   * to 2000 (spec §5). Tests use 0 + manual advancement.
   */
  approvalPollIntervalMs?: number;
  /**
   * Polling interval for notifications delivery (ms). Defaults to 2000
   * (notifications spec §5). The two streams (approval status,
   * notification delivery) poll independently so a transient blip on
   * one cannot mask the other.
   */
  notificationsPollIntervalMs?: number;
}

export function useGatePassController(
  options: GatePassControllerOptions = {}
): GatePassController {
  const api = options.api ?? gatePassApi;
  const approvalApi = options.approvalApi ?? guardApprovalApi;
  const notificationsApi = options.notificationsApi ?? guardNotificationsApi;
  const pollIntervalMs = options.approvalPollIntervalMs ?? 2000;
  const notificationsPollIntervalMs =
    options.notificationsPollIntervalMs ?? 2000;
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
      let qrState: "invalid" | "replayed" | "expired";
      switch (code) {
        case "QR_REPLAYED":
          qrState = "replayed";
          break;
        case "QR_EXPIRED":
          qrState = "expired";
          break;
        default:
          qrState = "invalid";
      }

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

  // ─── Resident approval flow ─────────────────────────────────────
  // Source: src/docs/specs/resident-approval-flow.md §7

  const requestApproval = useCallback(async (hostPhoneE164?: string) => {
    const current = stateRef.current;
    if (current.inFlight) return;

    // Approval is a walk-in extension; QR and override don't go through it.
    if (current.draft.method !== "walk-in") {
      dispatch({
        type: "APPROVAL_REQUEST_FAILED",
        error: {
          code: "APPROVAL_NOT_APPLICABLE",
          message:
            "Resident approval is only for walk-in entries. Use QR or override directly.",
        },
      });
      return;
    }

    // Reuse the same client-side preflight as a regular submission so the
    // guard sees missing-field errors without a server round-trip.
    const validation = validateDraft(current.draft, current.guardId);
    if (validation) {
      dispatch({ type: "APPROVAL_REQUEST_FAILED", error: validation });
      return;
    }

    if (current.network === "offline") {
      // Approval explicitly requires the network — we cannot magic-link
      // a resident offline. Block, and let the guard fall back to
      // override (which is auditable but doesn't need consent).
      dispatch({
        type: "APPROVAL_REQUEST_FAILED",
        error: {
          code: "NETWORK_ERROR",
          message:
            "Resident approval requires a live connection. Use override (with reason) while offline.",
        },
      });
      return;
    }

    const offlineId = newIdRef.current();

    dispatch({ type: "APPROVAL_REQUEST_STARTED" });

    // Feature 2 §7.1: hostPhoneE164 is OPTIONAL on the wire and is only
    // included when the guard typed one. An invalid E.164 here would be
    // rejected by the backend (zod), so we do a defensive client-side
    // check too — if the sanitized value doesn't match, drop the field
    // and surface a validation error (don't silently strip).
    //
    // Slice 8: sanitize common human formats before validating (spaces,
    // dashes, parens, dots). The sanitizer is conservative — it never
    // adds digits or a leading "+", so an invalid input still surfaces
    // a real failure rather than passing on a mangled rewrite.
    const trimmedPhone = hostPhoneE164
      ? sanitizePhoneInput(hostPhoneE164.trim())
      : undefined;
    if (trimmedPhone && !/^\+[1-9]\d{6,14}$/.test(trimmedPhone)) {
      dispatch({
        type: "APPROVAL_REQUEST_FAILED",
        error: {
          code: "HOST_PHONE_INVALID",
          message: "Host phone must be in E.164 format (e.g. +15551230001).",
          field: "hostPhoneE164",
        },
      });
      return;
    }

    const result: ApiResult<CreateApprovalResponse> =
      await approvalApi.createApproval({
        offlineId,
        draft: {
          visitorName: current.draft.visitorName.trim(),
          host: current.draft.host.trim(),
          unit: current.draft.unit.trim(),
          plate:
            current.draft.plate.trim().length > 0
              ? current.draft.plate.trim()
              : null,
          reason: current.draft.reason.trim(),
          method: "walk-in",
        },
        ...(trimmedPhone ? { hostPhoneE164: trimmedPhone } : {}),
      });

    if (!result.ok) {
      dispatch({
        type: "APPROVAL_REQUEST_FAILED",
        error: errorFromApi(result),
      });
      return;
    }

    // Auto-approval branch (Feature 3).
    //
    // Source: src/docs/specs/auto-approval.md §5 — when a matching
    // active rule fires, the server short-circuits the approval and
    // returns autoApproved=true with the full entry record + the rule
    // that fired. We MUST detect this BEFORE constructing a pending
    // approval, otherwise the awaiting-approval UI would briefly flash
    // before being replaced.
    //
    // Defensive parsing: every field is checked. If the server sends a
    // malformed autoApproved=true payload (entry missing, rule missing,
    // entry method !== "auto"), we fall back to APPROVAL_REQUEST_FAILED
    // — never silently treat it as a manual pending approval, never
    // silently land in 'confirmed' on bad data.
    if (result.data.autoApproved === true) {
      const entry = result.data.entry;
      const rule = result.data.matchedRule;
      if (
        !entry ||
        !rule ||
        entry.method !== "auto" ||
        entry.status !== "logged"
      ) {
        dispatch({
          type: "APPROVAL_REQUEST_FAILED",
          error: {
            code: "AUTO_APPROVAL_MALFORMED",
            message:
              "Server signaled auto-approval but the response shape was incomplete. The entry was NOT logged on this device \u2014 retry, or use override (with reason).",
            traceId: result.data.traceId,
          },
        });
        return;
      }
      dispatch({
        type: "APPROVAL_AUTO_APPROVED",
        entry: {
          ...entry,
          plate: entry.plate ?? undefined,
        },
        rule,
      });
      return;
    }

    const approval: PendingApproval = {
      id: result.data.approvalId,
      draft: { ...current.draft },
      magicLinkUrl: result.data.magicLinkUrl,
      expiresAt: result.data.expiresAt,
      status: "pending",
      traceId: result.data.traceId,
    };
    dispatch({ type: "APPROVAL_REQUEST_SUCCEEDED", approval });
  }, [approvalApi]);

  // Poll /status while a resident-approval request is awaiting decision.
  // The server applies lazy expiry on read so we don't need a client-side
  // timeout — the next poll after expiresAt will return status=expired.
  const approvalPollIdRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    const approvalId = state.pendingApproval?.id;
    const status = state.pendingApproval?.status;
    const shouldPoll =
      state.mode === "awaiting-approval" &&
      !!approvalId &&
      status === "pending" &&
      state.network === "online";

    if (!shouldPoll) return;

    let cancelled = false;

    const pollOnce = async () => {
      if (cancelled) return;
      const result: ApiResult<ApprovalStatusResponse> =
        await approvalApi.getApprovalStatus(approvalId!);
      if (cancelled) return;

      if (!result.ok) {
        // Transient transport errors keep the poll loop alive — the
        // next tick will retry. Anything else surfaces as a failed
        // request so the guard sees the backend's error code.
        if (result.status === 0) return;
        dispatch({
          type: "APPROVAL_REQUEST_FAILED",
          error: errorFromApi(result),
        });
        return;
      }

      const view = result.data.approval;

      // Terminal: approved + entry created.
      if (view.status === "approved" && view.entryId) {
        dispatch({
          type: "APPROVAL_RESOLVED",
          entry: entryFromApprovedView(view),
        });
        return;
      }
      // Terminal: denied.
      if (view.status === "denied") {
        dispatch({
          type: "APPROVAL_DENIED",
          reason: view.deniedReason ?? "",
        });
        return;
      }
      // Terminal: expired (lazy flip from the server).
      if (view.status === "expired") {
        dispatch({ type: "APPROVAL_EXPIRED" });
        return;
      }
      // Still pending — update lifecycle pulse, keep polling.
      dispatch({
        type: "APPROVAL_POLLED",
        status: view.status,
        decidedAt: view.decidedAt ?? undefined,
        deniedReason: view.deniedReason ?? undefined,
      });
    };

    // Kick off the first poll immediately so the UI converges fast on
    // approve/deny decisions instead of waiting one interval.
    void pollOnce();
    approvalPollIdRef.current = setInterval(pollOnce, pollIntervalMs);

    return () => {
      cancelled = true;
      if (approvalPollIdRef.current) {
        clearInterval(approvalPollIdRef.current);
        approvalPollIdRef.current = null;
      }
    };
  }, [
    state.mode,
    state.pendingApproval?.id,
    state.pendingApproval?.status,
    state.network,
    approvalApi,
    pollIntervalMs,
  ]);

  // ─── Notification delivery — independent polling stream ───────────
  // Source: src/docs/specs/notifications.md §5, §9 (two-stream policy).
  //
  // This effect polls /api/notifications in PARALLEL with the approval
  // /status effect above. The two streams are deliberately decoupled:
  // a flaky notifications endpoint must not block the approval state
  // from advancing, and an expired approval must not prevent the guard
  // from seeing the final delivery state. Tests pin both behaviors.
  //
  // Polling stops the moment the approval reaches a terminal state
  // (the reducer wipes byApprovalId for that approval id, the
  // pendingApproval slot empties, the effect deps change, the
  // cleanup runs). The 30s sending-stale sweep is the server's
  // responsibility — we just poll.

  const notificationsPollIdRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  useEffect(() => {
    const approvalId = state.pendingApproval?.id;
    const status = state.pendingApproval?.status;
    const shouldPoll =
      state.mode === "awaiting-approval" &&
      !!approvalId &&
      status === "pending" &&
      state.network === "online";

    if (!shouldPoll) return;

    let cancelled = false;

    const pollOnce = async () => {
      if (cancelled) return;
      // Guard: don't dispatch LOADING for a stale approval (the effect
      // cleanup may not have run yet because React schedules it after
      // commit, but if the approval has already left the awaiting state
      // we have no business mutating notifications for it).
      if (stateRef.current.pendingApproval?.id !== approvalId) return;
      dispatch({ type: "NOTIFICATIONS_LOADING" });
      const result: ApiResult<NotificationsListResponse> =
        await notificationsApi.getNotifications(approvalId!);
      if (cancelled) return;
      // Re-check after the await — a terminal approval transition may
      // have landed between the request and the response. Without this
      // guard a late LOADED would re-add notifications the reducer
      // explicitly dropped on APPROVAL_DENIED/RESOLVED/EXPIRED.
      if (stateRef.current.pendingApproval?.id !== approvalId) return;

      if (!result.ok) {
        // Transient transport blip — let the next tick retry, do NOT
        // dispatch FAILED for status=0 because it would briefly blank
        // the lastError surface on every flaky tick.
        if (result.status === 0) return;
        dispatch({
          type: "NOTIFICATIONS_FAILED",
          error: errorFromApi(result),
        });
        return;
      }

      // Cast through the controller-local view type — the wire shape
      // is structurally identical, but the reducer types include the
      // local-only retryInFlight/retryError fields.
      const rows = result.data.notifications as NotificationDeliveryView[];
      dispatch({
        type: "NOTIFICATIONS_LOADED",
        approvalId: approvalId!,
        notifications: rows,
      });
    };

    // First poll fires immediately so the UI converges quickly.
    void pollOnce();
    notificationsPollIdRef.current = setInterval(
      pollOnce,
      notificationsPollIntervalMs,
    );

    return () => {
      cancelled = true;
      if (notificationsPollIdRef.current) {
        clearInterval(notificationsPollIdRef.current);
        notificationsPollIdRef.current = null;
      }
    };
  }, [
    state.mode,
    state.pendingApproval?.id,
    state.pendingApproval?.status,
    state.network,
    notificationsApi,
    notificationsPollIntervalMs,
  ]);

  // Manual resend triggered by the Resend button. Idempotent server-side
  // (the throttle + state checks live there); the controller just plumbs
  // the result back into the reducer. We do NOT swallow errors — the
  // server's RETRY_RATE_LIMITED / NOT_RETRYABLE / TERMINAL etc. each
  // surface on the row's retryError so the UI can act on them.
  const retryNotification = useCallback(
    async (notificationId: string) => {
      dispatch({ type: "NOTIFICATIONS_RETRY_STARTED", notificationId });
      const result: ApiResult<NotificationRetryResponse> =
        await notificationsApi.retryNotification(notificationId);
      if (!result.ok) {
        // Network drop counts as an actionable error here — the guard
        // pressed a button; they need to know it didn't go through.
        dispatch({
          type: "NOTIFICATIONS_RETRY_FAILED",
          notificationId,
          error: errorFromApi(result),
        });
        return;
      }
      const row = result.data.notification as NotificationDeliveryView;
      // 30s cooldown so the UI disables Resend immediately after a
      // successful re-queue. The server still enforces its own
      // RATE_LIMITED check (spec §6) — this is just the local UI
      // guard against a guard double-clicking and the second click
      // racing through before the server-side limiter trips.
      const cooldownUntilMs =
        clockRef.current().getTime() + RETRY_COOLDOWN_MS;
      dispatch({
        type: "NOTIFICATIONS_RETRY_SUCCEEDED",
        approvalId: row.approvalId,
        notification: row,
        cooldownUntilMs,
      });
    },
    [notificationsApi],
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
      requestApproval,
      retryNotification,
    }),
    [
      state,
      submitEntry,
      scanQr,
      syncPending,
      searchVisitors,
      setNetwork,
      requestApproval,
      retryNotification,
    ]
  );
}
