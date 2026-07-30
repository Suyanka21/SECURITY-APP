/**
 * GatePass — Pure reducer.
 *
 * The reducer never performs I/O. All API calls happen in
 * `useGatePassController` (see ./useGatePassController.ts), which
 * dispatches explicit lifecycle actions for every async outcome so the
 * UI cannot ever sit in a half-finished state.
 *
 * Source: React useReducer — https://react.dev/reference/react/useReducer
 * Source: src/docs/gatepass-api-contract.md (endpoints + error codes)
 * Source: src/docs/GATEPASS DEFINITION.md (failure modes, audit rules)
 */

import type {
  DeliveryManagementState,
  EntryDraft,
  EntryMethod,
  EntryRecord,
  ExitTrackingState,
  GatePassAction,
  GatePassError,
  GatePassMode,
  GatePassState,
  NotificationDeliveryView,
  NotificationsState,
  PendingApproval,
  SyncResultView,
  Visitor,
  VisitorProfilesState,
} from "./types";
import type { VisitorProfileView } from "@/lib/api/types";

const emptyDraft: EntryDraft = {
  visitorName: "",
  host: "",
  unit: "",
  plate: "",
  reason: "",
  method: "walk-in",
};

/**
 * Seed list shown before the live `/api/visitors/recognized` call
 * resolves. Real recognized visitors replace this once the search
 * endpoint responds; keeping a small seed avoids an empty home screen
 * during initial load and during fresh offline sessions.
 */
export const recognizedVisitors: Visitor[] = [
  {
    id: "v-101",
    name: "Maya Chen",
    host: "A. Okafor",
    unit: "18B",
    plate: "LND-482",
    lastSeen: "08:42",
    recognition: "pre-approved",
  },
  {
    id: "v-102",
    name: "Dario Miles",
    host: "N. Patel",
    unit: "07C",
    plate: "KJA-019",
    lastSeen: "Yesterday",
    recognition: "frequent",
  },
  {
    id: "v-103",
    name: "Unknown courier",
    host: "Multiple",
    unit: "Service",
    lastSeen: "2 days",
    recognition: "watch",
  },
];

export const DEFAULT_GUARD_ID = "guard-west-04";

export const initialGatePassState: GatePassState = {
  mode: "home",
  guardId: DEFAULT_GUARD_ID,
  network: "online",
  cameraState: "idle",
  qrState: "idle",
  qrToken: "",
  draft: emptyDraft,
  inFlight: false,
  banner: {
    tone: "info",
    message: "Ready for next arrival. Every entry requires a guard audit trail.",
  },
  entries: [],
  pendingSync: [],
  lastSyncResults: [],
  recognizedVisitors,
  searchQuery: "",
  searchLoading: false,
  audit: [`Session opened by ${DEFAULT_GUARD_ID}`],
  notifications: { byApprovalId: {}, loading: false },
  visitorProfiles: {
    byId: {},
    order: [],
    loading: false,
    mutationInFlight: {},
    mutationErrors: {},
    includeDeleted: false,
  },
  visitorInvitations: {
    status: "idle",
  },
  shifts: {
    query: {},
    rows: [],
    loading: false,
  },
  exitTracking: {
    onPremise: [],
    loading: false,
    exitInFlight: {},
    exitErrors: {},
    noteInFlight: {},
    noteErrors: {},
  },
  deliveryManagement: {
    entries: [],
    loading: false,
    submitting: false,
  },
};

/**
 * Client-side preflight validation. Runs before the network call so the
 * guard sees obvious problems without round-tripping the backend. The
 * backend re-validates everything (server is the source of truth).
 */
export function validateDraft(
  draft: EntryDraft,
  guardId: string
): GatePassError | null {
  if (!guardId) {
    return {
      code: "GUARD_ID_MISSING",
      message: "Guard identity missing. Entry cannot be logged.",
    };
  }
  if (!draft.visitorName.trim()) {
    return {
      code: "VISITOR_NAME_REQUIRED",
      message: "Visitor name is required before entry can be logged.",
      field: "visitorName",
    };
  }
  if (!draft.host.trim()) {
    return {
      code: "HOST_REQUIRED",
      message: "Resident or host is required for accountability.",
      field: "host",
    };
  }
  if (!draft.unit.trim()) {
    return {
      code: "UNIT_REQUIRED",
      message: "Unit is required to prevent orphan entries.",
      field: "unit",
    };
  }
  if (draft.method === "override" && draft.reason.trim().length < 8) {
    return {
      code: "OVERRIDE_REASON_TOO_SHORT",
      message: "Manual override requires a meaningful reason (minimum 8 characters).",
      field: "reason",
    };
  }
  return null;
}

function auditLine(entry: EntryRecord): string {
  return `${entry.status}: ${entry.id} by ${entry.guardId} (${entry.syncState})`;
}

/**
 * Drop a single approval's notifications from the slice. Used by the
 * approval-terminal transitions (RESOLVED / DENIED / EXPIRED) so a
 * delivery view never survives onto the next walk-in.
 *
 * Source: src/docs/specs/notifications.md §9 — terminal cleanup.
 */
function dropNotificationsForApproval(
  notifications: NotificationsState,
  approvalId: string,
): NotificationsState {
  if (!(approvalId in notifications.byApprovalId)) return notifications;
  const next: Record<string, NotificationDeliveryView[]> = {
    ...notifications.byApprovalId,
  };
  delete next[approvalId];
  return { ...notifications, byApprovalId: next };
}

/**
 * Merge a list of NotificationDeliveryViews into the slice for one
 * approval. Per-row reducer-local fields (retryInFlight, retryError)
 * are preserved across re-polls when the row's id matches — the wire
 * shape only carries server state, so a re-poll cannot resurface a
 * stale retry banner.
 *
 * Source: src/docs/specs/notifications.md §9 — list update.
 */
function mergeNotificationList(
  prev: NotificationDeliveryView[] | undefined,
  next: NotificationDeliveryView[],
): NotificationDeliveryView[] {
  if (!prev || prev.length === 0) return next;
  const prevById = new Map(prev.map((row) => [row.id, row]));
  return next.map((row) => {
    const previous = prevById.get(row.id);
    if (!previous) return row;
    // Preserve retryInFlight only while the row hasn't transitioned to
    // a new attempts count (otherwise the server already accepted the
    // retry and the in-flight flag should drop).
    const retryInFlight =
      previous.retryInFlight && previous.attempts === row.attempts;
    return {
      ...row,
      ...(retryInFlight ? { retryInFlight } : {}),
      ...(previous.retryError && retryInFlight
        ? { retryError: previous.retryError }
        : {}),
    };
  });
}

/**
 * Maps a navigation target to the correct draft.method.
 *
 * Without normalization, navigating qr -> walkin (or override -> walkin)
 * would carry the prior method into the submission, so a walk-in entry
 * could end up logged as method="qr" or method="override". This is
 * exactly the kind of silent attribution bug the trustless audit warns
 * against — the audit trail must reflect the actual entry channel.
 */
function resolveMethodForMode(
  mode: GatePassMode,
  current: EntryMethod
): EntryMethod {
  if (mode === "qr") return "qr";
  if (mode === "override") return "override";
  // SELECT_VISITOR pre-fills a recognized-visitor walk-in; preserve that
  // so re-navigating to walk-in doesn't reset the method back to plain.
  if (mode === "walkin" && current === "recognized") return "recognized";
  return "walk-in";
}

/**
 * Visitor-profile helpers (Feature 4). All operate on the slice without
 * touching the rest of the GatePassState — the admin slice is
 * orthogonal to the per-walk-in lifecycle.
 *
 * Source: src/docs/specs/visitor-profiles.md §8.
 */

function clearMutationInFlight(
  slice: VisitorProfilesState,
  key: string,
): VisitorProfilesState {
  if (!(key in slice.mutationInFlight)) return slice;
  const nextInFlight = { ...slice.mutationInFlight };
  delete nextInFlight[key];
  return { ...slice, mutationInFlight: nextInFlight };
}

function clearMutationError(
  slice: VisitorProfilesState,
  key: string,
): VisitorProfilesState {
  if (!(key in slice.mutationErrors)) return slice;
  const nextErrors = { ...slice.mutationErrors };
  delete nextErrors[key];
  return { ...slice, mutationErrors: nextErrors };
}

function upsertProfile(
  slice: VisitorProfilesState,
  profile: VisitorProfileView,
  mutationKey: string,
): VisitorProfilesState {
  const isCreate = !(profile.id in slice.byId);
  // Prepend on create so the newest row shows up at the top of the
  // table; replace-in-place on update so the user's scroll position
  // isn't disturbed by a no-op patch.
  const nextOrder = isCreate ? [profile.id, ...slice.order] : slice.order;
  let nextSlice: VisitorProfilesState = {
    ...slice,
    byId: { ...slice.byId, [profile.id]: profile },
    order: nextOrder,
  };
  nextSlice = clearMutationInFlight(nextSlice, mutationKey);
  nextSlice = clearMutationError(nextSlice, mutationKey);
  // For create, the mutation started under VISITOR_PROFILE_NEW_KEY but
  // the server-assigned id is what we'll mutate next time. Make sure
  // we don't leave a stale per-row error under the new id either.
  if (mutationKey !== profile.id) {
    nextSlice = clearMutationError(nextSlice, profile.id);
    nextSlice = clearMutationInFlight(nextSlice, profile.id);
  }
  return nextSlice;
}

function softDeleteProfile(
  slice: VisitorProfilesState,
  profile: VisitorProfileView,
): VisitorProfilesState {
  // The server returns the profile with deletedAt set; replace by id.
  // Drop from `order` unless the admin is currently showing deleted
  // rows — then the row stays in view but visually marked deleted.
  const nextOrder = slice.includeDeleted
    ? slice.order
    : slice.order.filter((id) => id !== profile.id);
  let nextSlice: VisitorProfilesState = {
    ...slice,
    byId: { ...slice.byId, [profile.id]: profile },
    order: nextOrder,
  };
  nextSlice = clearMutationInFlight(nextSlice, profile.id);
  nextSlice = clearMutationError(nextSlice, profile.id);
  return nextSlice;
}

function restoreProfileInSlice(
  slice: VisitorProfilesState,
  profile: VisitorProfileView,
): VisitorProfilesState {
  // Re-add to `order` if missing (e.g. previously dropped by a
  // soft-delete under includeDeleted=false). Move to the top to
  // surface the action; replace byId so deletedAt is now null.
  const nextOrder = slice.order.includes(profile.id)
    ? slice.order
    : [profile.id, ...slice.order];
  let nextSlice: VisitorProfilesState = {
    ...slice,
    byId: { ...slice.byId, [profile.id]: profile },
    order: nextOrder,
  };
  nextSlice = clearMutationInFlight(nextSlice, profile.id);
  nextSlice = clearMutationError(nextSlice, profile.id);
  return nextSlice;
}

function bannerForError(error: GatePassError): GatePassState["banner"] {
  // Rate limit and auth get distinctive tones to nudge the guard's next
  // action (wait vs. re-auth). Everything else surfaces as danger so
  // the form stops dead — never a silent recovery.
  if (
    error.code === "RATE_LIMITED" ||
    error.code === "RATE_LIMIT_EXCEEDED"
  ) {
    return {
      tone: "warning",
      message: `Rate limit reached: ${error.message}`,
    };
  }
  if (
    error.code === "AUTH_REQUIRED" ||
    error.code === "AUTH_TOKEN_MISSING" ||
    error.code === "AUTH_TOKEN_MALFORMED" ||
    error.code === "AUTH_TOKEN_INVALID" ||
    error.code === "AUTH_TOKEN_EXPIRED"
  ) {
    return {
      tone: "danger",
      message: `Authentication required: ${error.message}`,
    };
  }
  return { tone: "danger", message: error.message };
}

export function gatePassReducer(
  state: GatePassState,
  action: GatePassAction
): GatePassState {
  switch (action.type) {
    case "NAVIGATE": {
      // Normalize draft.method against the destination mode so a stale
      // "qr" or "override" method can't leak into a walk-in submission.
      // SELECT_VISITOR sets mode="walkin" + method="recognized"; preserve
      // that since it is a deliberate walk-in variant.
      const method = resolveMethodForMode(action.mode, state.draft.method);
      return {
        ...state,
        mode: action.mode,
        draft: { ...state.draft, method },
        inFlight: false,
        lastError: undefined,
      };
    }

    case "SET_NETWORK":
      return {
        ...state,
        network: action.network,
        banner:
          action.network === "offline"
            ? {
                tone: "warning",
                message:
                  "Offline mode active. Entries are queued and visibly marked until sync.",
              }
            : {
                tone: "success",
                message:
                  "Network restored. Pending entries can be reconciled now.",
              },
      };

    case "START_CAMERA":
      return {
        ...state,
        mode: "qr",
        cameraState: "ready",
        qrState: "idle",
        qrToken: "",
        lastError: undefined,
        banner: {
          tone: "info",
          message: "Camera ready. Scan one QR at a time.",
        },
      };

    case "CAMERA_FAILED":
      return {
        ...state,
        mode: "error",
        cameraState: "failed",
        banner: {
          tone: "danger",
          message:
            "Camera failed. Use walk-in or manual override; do not wave anyone through.",
        },
      };

    case "UPDATE_DRAFT":
      return {
        ...state,
        draft: { ...state.draft, [action.field]: action.value },
      };

    case "UPDATE_QR_TOKEN":
      return { ...state, qrToken: action.value };

    case "UPDATE_SEARCH_QUERY":
      return { ...state, searchQuery: action.value };

    case "SELECT_VISITOR":
      return {
        ...state,
        mode: "walkin",
        draft: {
          visitorName: action.visitor.name,
          host: action.visitor.host,
          unit: action.visitor.unit,
          plate: action.visitor.plate ?? "",
          reason: "Recognized visitor",
          method: "recognized",
        },
        lastError: undefined,
        banner: {
          tone: action.visitor.recognition === "watch" ? "warning" : "info",
          message: `${action.visitor.name} loaded. Confirm details before logging.`,
        },
      };

    case "ENTRY_STARTED":
      return {
        ...state,
        inFlight: true,
        lastError: undefined,
        banner: { tone: "info", message: "Submitting entry…" },
      };

    case "ENTRY_SUCCEEDED": {
      const entry = action.entry;
      return {
        ...state,
        mode: "confirmed",
        inFlight: false,
        lastEntry: entry,
        lastError: undefined,
        entries: [entry, ...state.entries],
        audit: [auditLine(entry), ...state.audit],
        banner: {
          tone: "success",
          message: "Entry logged with guard attribution.",
        },
      };
    }

    case "ENTRY_QUEUED": {
      const entry = action.entry;
      return {
        ...state,
        mode: "confirmed",
        inFlight: false,
        lastEntry: entry,
        lastError: undefined,
        entries: [entry, ...state.entries],
        pendingSync: [entry, ...state.pendingSync],
        audit: [auditLine(entry), ...state.audit],
        banner: {
          tone: "warning",
          message:
            "Entry logged offline and queued for sync. It will reconcile when the network returns.",
        },
      };
    }

    case "ENTRY_FAILED":
      return {
        ...state,
        mode: "error",
        inFlight: false,
        lastError: action.error,
        banner: bannerForError(action.error),
      };

    case "QR_SCAN_STARTED":
      return {
        ...state,
        inFlight: true,
        qrState: "scanning",
        lastError: undefined,
        banner: { tone: "info", message: "Validating QR…" },
      };

    case "QR_SCAN_SUCCEEDED":
      return {
        ...state,
        inFlight: false,
        qrState: "valid",
        draft: action.draft,
        lastError: undefined,
        banner: {
          tone: "success",
          message: "QR verified. Confirm to create the audit record.",
        },
      };

    case "QR_SCAN_FAILED":
      return {
        ...state,
        mode: "error",
        inFlight: false,
        qrState: action.qrState,
        lastError: action.error,
        banner: bannerForError(action.error),
      };

    case "SYNC_STARTED":
      return {
        ...state,
        inFlight: true,
        lastError: undefined,
        lastSyncResults: [],
        banner: { tone: "info", message: "Syncing queued entries…" },
      };

    case "SYNC_COMPLETED": {
      // Merge server-acknowledged entries into the main log. Entries
      // marked `synced` get the server's canonical ID; duplicates keep
      // theirs (already known). Rejected entries stay in pendingSync
      // with `lastError` so the guard sees exactly which ones failed.
      const ackedById = new Map<string, EntryRecord>();
      for (const e of action.newlySynced) {
        if (e.offlineId) ackedById.set(e.offlineId, e);
      }
      const updatedEntries = state.entries.map((existing) => {
        if (!existing.offlineId) return existing;
        const ack = ackedById.get(existing.offlineId);
        if (!ack) return existing;
        return {
          ...existing,
          id: ack.id,
          status: "logged" as const,
          syncState: "synced" as const,
          lastError: undefined,
        };
      });
      const results: SyncResultView[] = action.results.map((r) => {
        const localMatch =
          state.pendingSync.find((e) => e.offlineId === r.offlineId) ??
          state.entries.find((e) => e.offlineId === r.offlineId);
        return {
          ...r,
          visitorName: localMatch?.visitorName ?? "(unknown)",
        };
      });
      const rejectedCount = action.results.filter(
        (r) => r.status === "rejected"
      ).length;
      const syncedCount = action.results.filter(
        (r) => r.status === "synced"
      ).length;
      const banner: GatePassState["banner"] =
        rejectedCount === 0
          ? {
              tone: "success",
              message: `Sync complete. ${syncedCount} entries reconciled.`,
            }
          : {
              tone: "warning",
              message: `Sync partial: ${syncedCount} reconciled, ${rejectedCount} rejected — review the queue.`,
            };
      return {
        ...state,
        inFlight: false,
        entries: updatedEntries,
        pendingSync: action.keptInQueue,
        lastSyncResults: results,
        banner,
        audit: [
          `sync: ${syncedCount} synced / ${action.results.length} total by ${state.guardId}`,
          ...state.audit,
        ],
      };
    }

    case "SYNC_FAILED":
      return {
        ...state,
        inFlight: false,
        lastError: action.error,
        banner: bannerForError(action.error),
      };

    case "VISITORS_LOADING":
      return { ...state, searchLoading: true, lastError: undefined };

    case "VISITORS_LOADED":
      return {
        ...state,
        searchLoading: false,
        lastError: undefined,
        recognizedVisitors: action.visitors,
      };

    case "VISITORS_FAILED":
      return {
        ...state,
        searchLoading: false,
        lastError: action.error,
        banner: bannerForError(action.error),
      };

    // ─── Resident approval lifecycle ──────────────────────────────
    // Source: src/docs/specs/resident-approval-flow.md §6 (reducer contract).
    //
    // Every async outcome of a resident-approval request gets an explicit
    // dispatch — no silent success. The mode transitions trace exactly the
    // state machine in §5 of the spec.

    case "APPROVAL_REQUEST_STARTED":
      return {
        ...state,
        inFlight: true,
        lastError: undefined,
        banner: {
          tone: "info",
          message: "Requesting resident approval\u2026",
        },
      };

    case "APPROVAL_REQUEST_SUCCEEDED": {
      const approval: PendingApproval = action.approval;
      return {
        ...state,
        mode: "awaiting-approval",
        inFlight: false,
        pendingApproval: approval,
        lastError: undefined,
        audit: [
          `approval_requested: ${approval.id} for ${approval.draft.visitorName} by ${state.guardId}`,
          ...state.audit,
        ],
        banner: {
          tone: "info",
          message:
            "Approval link sent. Waiting for resident to approve or deny.",
        },
      };
    }

    case "APPROVAL_REQUEST_FAILED":
      // Note: spec §5 — 422/400/5xx all land in error and the guard's
      // entry is BLOCKED. No fallback to a manual entry path; the guard
      // must explicitly choose override (and provide a reason) if they
      // want to proceed without approval.
      return {
        ...state,
        mode: "error",
        inFlight: false,
        pendingApproval: undefined,
        lastError: action.error,
        banner: bannerForError(action.error),
      };

    case "APPROVAL_POLLED": {
      // Lazy: if no pending approval, ignore the poll — the guard may
      // have reset the flow between the poll request and its response.
      if (!state.pendingApproval) return state;
      // The poll only updates the in-flight approval's status/decidedAt/
      // deniedReason. Terminal transitions (approved/denied/expired) are
      // surfaced via the dedicated RESOLVED/DENIED/EXPIRED actions which
      // also adjust mode + banner; this action is the polling pulse only.
      return {
        ...state,
        pendingApproval: {
          ...state.pendingApproval,
          status: action.status,
          ...(action.decidedAt !== undefined && {
            decidedAt: action.decidedAt,
          }),
          ...(action.deniedReason !== undefined && {
            deniedReason: action.deniedReason,
          }),
        },
      };
    }

    case "APPROVAL_RESOLVED": {
      // Approve path: backend has already inserted the entry inside the
      // approve transaction (spec §7.3). Mirror ENTRY_SUCCEEDED so the
      // entries list + audit reflect the canonical server record.
      const entry = action.entry;
      const priorApprovalId = state.pendingApproval?.id;
      return {
        ...state,
        mode: "confirmed",
        inFlight: false,
        pendingApproval: undefined,
        lastEntry: entry,
        lastError: undefined,
        entries: [entry, ...state.entries],
        audit: [
          `approval_approved: ${entry.id} by ${entry.guardId}`,
          auditLine(entry),
          ...state.audit,
        ],
        banner: {
          tone: "success",
          message: "Resident approved. Entry logged.",
        },
        notifications: priorApprovalId
          ? dropNotificationsForApproval(state.notifications, priorApprovalId)
          : state.notifications,
      };
    }

    case "APPROVAL_DENIED": {
      // Sanitize the resident-provided reason before surfacing in the
      // banner: trim, cap at 200, strip control chars. The server already
      // sanitizes, but defense in depth costs nothing.
      // Strip C0 control chars + DEL. eslint's no-control-regex flags
      // literal escapes, so we build the matcher programmatically.
      const cleanReason = action.reason
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
        .slice(0, 200);
      const approvalId = state.pendingApproval?.id ?? "unknown";
      return {
        ...state,
        mode: "error",
        inFlight: false,
        pendingApproval: undefined,
        lastError: {
          code: "APPROVAL_DENIED",
          message: cleanReason || "Resident denied entry.",
        },
        audit: [
          `approval_denied: ${approvalId} reason="${cleanReason}" by ${state.guardId}`,
          ...state.audit,
        ],
        banner: {
          tone: "danger",
          message: `Resident denied entry${cleanReason ? `: ${cleanReason}` : "."}`,
        },
        notifications:
          approvalId !== "unknown"
            ? dropNotificationsForApproval(state.notifications, approvalId)
            : state.notifications,
      };
    }

    case "APPROVAL_EXPIRED": {
      const approvalId = state.pendingApproval?.id ?? "unknown";
      return {
        ...state,
        mode: "error",
        inFlight: false,
        pendingApproval: undefined,
        lastError: {
          code: "APPROVAL_EXPIRED",
          message:
            "Approval request expired before the resident responded.",
        },
        audit: [
          `approval_expired: ${approvalId} by ${state.guardId}`,
          ...state.audit,
        ],
        banner: {
          tone: "warning",
          message:
            "Approval expired \u2014 re-request or use override (with reason).",
        },
        notifications:
          approvalId !== "unknown"
            ? dropNotificationsForApproval(state.notifications, approvalId)
            : state.notifications,
      };
    }

    case "APPROVAL_AUTO_APPROVED": {
      // Source: src/docs/specs/auto-approval.md §5 (state machine).
      //
      // Backend already wrote the entry inside the createApproval
      // transaction; we land directly in 'confirmed' WITHOUT touching
      // pendingApproval (there is no awaiting state to clear because
      // we never entered it) and prepend the entry into state.entries
      // for list-shape parity with ENTRY_SUCCEEDED / APPROVAL_RESOLVED.
      //
      // Louder audit (spec §3): emit TWO lines — one naming the rule
      // that fired, one for the entry itself — so an auditor reading
      // the local audit log can distinguish auto-approval entries
      // from manual walk-ins at a glance. The server emits three
      // matching audit_event_type rows on the same traceId; the
      // frontend audit is a UI mirror, not the source of truth.
      const entry = action.entry;
      const rule = action.rule;
      return {
        ...state,
        mode: "confirmed",
        inFlight: false,
        // Defensive: if a stale awaiting state somehow exists, clear it.
        pendingApproval: undefined,
        lastEntry: entry,
        lastError: undefined,
        entries: [entry, ...state.entries],
        audit: [
          `auto_approval_matched: rule=${rule.id} visitor="${rule.visitorName}" host="${rule.host}" unit="${rule.unit}" by ${state.guardId}`,
          auditLine(entry),
          ...state.audit,
        ],
        banner: {
          tone: "success",
          message: `Auto-approved by rule \u2014 entry logged for ${entry.visitorName}.`,
        },
      };
    }

    case "FAIL_ACTIVE_ENTRY":
      return {
        ...state,
        mode: "error",
        inFlight: false,
        lastError: { code: "ACTIVE_ENTRY_FAILED", message: action.reason },
        banner: { tone: "danger", message: action.reason },
      };

    case "RESET_FLOW":
      // RESET_FLOW also clears any in-flight approval. Spec §6: only one
      // approval can be active at a time; resetting cancels the local
      // view of it (the backend keeps the row — a late resident decision
      // will still produce an audit row).
      // Notifications slice is wiped here too — re-opening a fresh
      // walk-in must never carry a previous delivery view onto the
      // new approval (spec notifications.md §9 — terminal cleanup).
      return {
        ...state,
        mode: "home",
        draft: emptyDraft,
        cameraState: "idle",
        qrState: "idle",
        qrToken: "",
        inFlight: false,
        lastError: undefined,
        pendingApproval: undefined,
        banner: { tone: "info", message: "Ready for next arrival." },
        notifications: { byApprovalId: {}, loading: false },
      };

    // ─── Notifications lifecycle ─────────────────────────────────────
    // Source: src/docs/specs/notifications.md §9.

    case "NOTIFICATIONS_LOADING":
      // The list call is in flight. We do NOT clear the existing rows
      // here — surfacing the previous (cached) state is better than a
      // gap-then-fill flicker on every 2s poll.
      return {
        ...state,
        notifications: {
          ...state.notifications,
          loading: true,
          lastError: undefined,
        },
      };

    case "NOTIFICATIONS_LOADED": {
      // Atomic guard: only accept LOADED for the currently-pending
      // approval. The controller polls every 2s, so a poll that was
      // in flight when APPROVAL_DENIED/RESOLVED/EXPIRED landed will
      // resolve with stale rows — those must not resurrect the slice
      // the terminal transition just wiped. The reducer is the only
      // place that observes state atomically, so the check has to
      // live here. (Source: spec notifications.md §9 — terminal
      // cleanup must be permanent.)
      if (state.pendingApproval?.id !== action.approvalId) {
        return {
          ...state,
          notifications: {
            ...state.notifications,
            loading: false,
            lastError: undefined,
          },
        };
      }
      const merged = mergeNotificationList(
        state.notifications.byApprovalId[action.approvalId],
        action.notifications,
      );
      return {
        ...state,
        notifications: {
          byApprovalId: {
            ...state.notifications.byApprovalId,
            [action.approvalId]: merged,
          },
          loading: false,
          lastError: undefined,
        },
      };
    }

    case "NOTIFICATIONS_FAILED":
      // List failure does NOT touch byApprovalId — the UI keeps showing
      // the last-known rows so a transient blip doesn't blank the
      // delivery-status block mid-conversation.
      return {
        ...state,
        notifications: {
          ...state.notifications,
          loading: false,
          lastError: action.error,
        },
      };

    case "NOTIFICATIONS_RETRY_STARTED": {
      const next: Record<string, NotificationDeliveryView[]> = {};
      for (const [approvalId, rows] of Object.entries(
        state.notifications.byApprovalId,
      )) {
        next[approvalId] = rows.map((row) =>
          row.id === action.notificationId
            ? { ...row, retryInFlight: true, retryError: undefined }
            : row,
        );
      }
      return {
        ...state,
        notifications: { ...state.notifications, byApprovalId: next },
      };
    }

    case "NOTIFICATIONS_RETRY_SUCCEEDED": {
      // The server returned the fresh row. Overwrite by id, drop the
      // retryInFlight flag, drop any retryError, and stamp the
      // cooldown so the UI disables Resend for ~30s (spec §6).
      const fresh: NotificationDeliveryView = {
        ...action.notification,
        retryInFlight: undefined,
        retryError: undefined,
        retryCooldownUntilMs: action.cooldownUntilMs,
      };
      const existing = state.notifications.byApprovalId[action.approvalId];
      if (!existing) {
        return {
          ...state,
          notifications: {
            ...state.notifications,
            byApprovalId: {
              ...state.notifications.byApprovalId,
              [action.approvalId]: [fresh],
            },
          },
        };
      }
      const replaced = existing.map((row) =>
        row.id === fresh.id ? fresh : row,
      );
      return {
        ...state,
        notifications: {
          ...state.notifications,
          byApprovalId: {
            ...state.notifications.byApprovalId,
            [action.approvalId]: replaced,
          },
        },
      };
    }

    case "NOTIFICATIONS_RETRY_FAILED": {
      const next: Record<string, NotificationDeliveryView[]> = {};
      for (const [approvalId, rows] of Object.entries(
        state.notifications.byApprovalId,
      )) {
        next[approvalId] = rows.map((row) =>
          row.id === action.notificationId
            ? { ...row, retryInFlight: false, retryError: action.error }
            : row,
        );
      }
      return {
        ...state,
        notifications: { ...state.notifications, byApprovalId: next },
      };
    }

    // ─── Visitor profile CRUD lifecycle (Feature 4) ────────────────
    // Source: src/docs/specs/visitor-profiles.md §8.

    case "VISITOR_PROFILES_LIST_STARTED":
      // The list call is in flight. We keep the existing `byId` so the
      // table doesn't blank between pages — same pattern as the
      // notifications poll (see NOTIFICATIONS_LOADING above).
      return {
        ...state,
        visitorProfiles: {
          ...state.visitorProfiles,
          loading: true,
          lastError: undefined,
        },
      };

    case "VISITOR_PROFILES_LIST_LOADED": {
      const nextById: Record<string, VisitorProfileView> = {};
      const nextOrder: string[] = [];
      for (const profile of action.profiles) {
        nextById[profile.id] = profile;
        nextOrder.push(profile.id);
      }
      return {
        ...state,
        visitorProfiles: {
          ...state.visitorProfiles,
          byId: nextById,
          order: nextOrder,
          pagination: action.pagination,
          loading: false,
          lastError: undefined,
        },
      };
    }

    case "VISITOR_PROFILES_LIST_FAILED":
      // List failure leaves byId/order untouched — a transient blip
      // must not blank the admin's working set. The banner surfaces
      // the error so the failure cannot go silent.
      return {
        ...state,
        visitorProfiles: {
          ...state.visitorProfiles,
          loading: false,
          lastError: action.error,
        },
      };

    case "VISITOR_PROFILE_MUTATION_STARTED": {
      const key = action.profileId;
      // Flip the in-flight flag and drop any prior per-row error so
      // the UI's inline error clears the moment the user retries.
      let next = {
        ...state.visitorProfiles,
        mutationInFlight: {
          ...state.visitorProfiles.mutationInFlight,
          [key]: true,
        },
      };
      next = clearMutationError(next, key);
      return { ...state, visitorProfiles: next };
    }

    case "VISITOR_PROFILE_UPSERTED": {
      const mutationKey = action.mutationKey ?? action.profile.id;
      return {
        ...state,
        visitorProfiles: upsertProfile(
          state.visitorProfiles,
          action.profile,
          mutationKey,
        ),
      };
    }

    case "VISITOR_PROFILE_REMOVED":
      return {
        ...state,
        visitorProfiles: softDeleteProfile(
          state.visitorProfiles,
          action.profile,
        ),
      };

    case "VISITOR_PROFILE_RESTORED":
      return {
        ...state,
        visitorProfiles: restoreProfileInSlice(
          state.visitorProfiles,
          action.profile,
        ),
      };

    case "VISITOR_PROFILE_MUTATION_FAILED": {
      // No silent success: per-row error is surfaced inline. The
      // in-flight flag drops so the action button (Save / Delete /
      // Restore) becomes clickable again.
      let next = clearMutationInFlight(
        state.visitorProfiles,
        action.profileId,
      );
      next = {
        ...next,
        mutationErrors: {
          ...next.mutationErrors,
          [action.profileId]: action.error,
        },
      };
      return { ...state, visitorProfiles: next };
    }

    case "VISITOR_PROFILES_TOGGLE_INCLUDE_DELETED":
      // Pure toggle. Clearing lastError avoids carrying a stale list
      // error across the toggle — the next list call will refresh it.
      return {
        ...state,
        visitorProfiles: {
          ...state.visitorProfiles,
          includeDeleted: !state.visitorProfiles.includeDeleted,
          lastError: undefined,
        },
      };

    // ─── Shift log aggregation (Feature 5) ────────────────────────
    // Source: src/docs/specs/shift-log-aggregation.md §7 (reducer
    // contract). Default-deny: a failed load does NOT wipe the
    // previously-loaded rows; lastError surfaces the failure so the UI
    // can render a banner without silently dropping the data.

    case "SHIFTS_QUERY_CHANGED":
      // Pure update of the filter. Clears lastError so the user's next
      // load doesn't surface a stale error from the previous query.
      return {
        ...state,
        shifts: {
          ...state.shifts,
          query: action.query,
          lastError: undefined,
        },
      };

    case "SHIFTS_LIST_STARTED":
      return {
        ...state,
        shifts: {
          ...state.shifts,
          loading: true,
          lastError: undefined,
        },
      };

    case "SHIFTS_LIST_LOADED":
      return {
        ...state,
        shifts: {
          ...state.shifts,
          loading: false,
          window: action.window,
          rows: action.rows,
          lastError: undefined,
        },
      };

    case "SHIFTS_LIST_FAILED":
      // Keep prior rows. Surfacing the error in lastError is required
      // by the trustless contract — a 500 must NOT look like a quiet
      // empty list.
      return {
        ...state,
        shifts: {
          ...state.shifts,
          loading: false,
          lastError: action.error,
        },
      };

    // ─── Visitor invitations (Feature 6 / Guest QR Ticket) ──────────
    // Source: src/docs/specs/guest-qr-ticket.md §7.
    //
    // The slice is admin-only. RESET_FLOW does NOT clear it.
    case "VISITOR_INVITATION_ISSUE_STARTED":
      return {
        ...state,
        visitorInvitations: {
          status: "submitting",
          // Clear prior issued + error so the success card/error banner
          // do not flash stale state during the next submission.
          lastIssued: undefined,
          lastError: undefined,
        },
      };

    case "VISITOR_INVITATION_ISSUE_SUCCEEDED":
      return {
        ...state,
        visitorInvitations: {
          status: "issued",
          lastIssued: action.invitation,
          lastError: undefined,
        },
      };

    case "VISITOR_INVITATION_ISSUE_FAILED":
      // Default-deny: the form lands in "failed", NOT "issued". No
      // partial success path. The error is preserved so the form can
      // re-render the banner without another network call.
      return {
        ...state,
        visitorInvitations: {
          status: "failed",
          lastIssued: undefined,
          lastError: action.error,
        },
      };

    case "VISITOR_INVITATION_RESET":
      // Admin clicked "issue another" or closed the success card.
      // Clears the raw token from memory so it does not linger after
      // it has been delivered to the visitor.
      return {
        ...state,
        visitorInvitations: { status: "idle" },
      };

    // ─── Exit tracking lifecycle (Feature 7) ─────────────────────────
    // Source: src/docs/specs/exit-tracking.md §8.

    case "EXIT_TRACKING_LIST_STARTED":
      return {
        ...state,
        exitTracking: {
          ...state.exitTracking,
          loading: true,
          lastError: undefined,
        },
      };

    case "EXIT_TRACKING_LIST_LOADED":
      return {
        ...state,
        exitTracking: {
          ...state.exitTracking,
          onPremise: action.entries,
          loading: false,
          lastError: undefined,
        },
      };

    case "EXIT_TRACKING_LIST_FAILED":
      // Keep cached onPremise so a transient blip doesn't blank the table.
      return {
        ...state,
        exitTracking: {
          ...state.exitTracking,
          loading: false,
          lastError: action.error,
        },
      };

    case "EXIT_RECORD_STARTED":
      return {
        ...state,
        exitTracking: {
          ...state.exitTracking,
          exitInFlight: {
            ...state.exitTracking.exitInFlight,
            [action.entryId]: true,
          },
          // Clear any previous error for this entry.
          exitErrors: (() => {
            const next = { ...state.exitTracking.exitErrors };
            delete next[action.entryId];
            return next;
          })(),
        },
      };

    case "EXIT_RECORD_SUCCEEDED":
      return {
        ...state,
        exitTracking: {
          ...state.exitTracking,
          // Remove the entry from the on-premise list.
          onPremise: state.exitTracking.onPremise.filter(
            (e) => e.id !== action.entryId,
          ),
          exitInFlight: (() => {
            const next = { ...state.exitTracking.exitInFlight };
            delete next[action.entryId];
            return next;
          })(),
          lastExit: action.exit,
        },
      };

    case "EXIT_RECORD_FAILED":
      return {
        ...state,
        exitTracking: {
          ...state.exitTracking,
          exitInFlight: (() => {
            const next = { ...state.exitTracking.exitInFlight };
            delete next[action.entryId];
            return next;
          })(),
          exitErrors: {
            ...state.exitTracking.exitErrors,
            [action.entryId]: action.error,
          },
        },
      };

    // ─── Guard notes lifecycle (Feature 9) ───────────────────────────
    // Source: src/docs/specs/guard-notes.md §4.

    case "GUARD_NOTE_ADD_STARTED":
      return {
        ...state,
        exitTracking: {
          ...state.exitTracking,
          noteInFlight: {
            ...state.exitTracking.noteInFlight,
            [action.entryId]: true,
          },
          noteErrors: (() => {
            const next = { ...state.exitTracking.noteErrors };
            delete next[action.entryId];
            return next;
          })(),
        },
      };

    case "GUARD_NOTE_ADD_SUCCEEDED":
      return {
        ...state,
        exitTracking: {
          ...state.exitTracking,
          // Append the new note to its entry's note list in place.
          onPremise: state.exitTracking.onPremise.map((e) =>
            e.id === action.entryId
              ? {
                  ...e,
                  notes: [
                    ...e.notes,
                    {
                      id: action.note.id,
                      tag: action.note.tag,
                      text: action.note.text,
                      guardId: action.note.guardId,
                      createdAt: action.note.createdAt,
                    },
                  ],
                }
              : e,
          ),
          noteInFlight: (() => {
            const next = { ...state.exitTracking.noteInFlight };
            delete next[action.entryId];
            return next;
          })(),
        },
      };

    case "GUARD_NOTE_ADD_FAILED":
      return {
        ...state,
        exitTracking: {
          ...state.exitTracking,
          noteInFlight: (() => {
            const next = { ...state.exitTracking.noteInFlight };
            delete next[action.entryId];
            return next;
          })(),
          noteErrors: {
            ...state.exitTracking.noteErrors,
            [action.entryId]: action.error,
          },
        },
      };

    // ─── Feature 8: Delivery Management ─────────────────────────────
    // Source: src/docs/specs/delivery-management.md §5.

    case "DELIVERY_SUBMIT_STARTED":
      return {
        ...state,
        deliveryManagement: {
          ...state.deliveryManagement,
          submitting: true,
          lastError: undefined,
        },
      };

    case "DELIVERY_SUBMIT_SUCCEEDED":
      return {
        ...state,
        deliveryManagement: {
          ...state.deliveryManagement,
          submitting: false,
          lastEntry: action.entry,
          lastError: undefined,
        },
      };

    case "DELIVERY_SUBMIT_FAILED":
      return {
        ...state,
        deliveryManagement: {
          ...state.deliveryManagement,
          submitting: false,
          lastError: action.error,
        },
      };

    case "DELIVERY_SUBMIT_RESET":
      return {
        ...state,
        deliveryManagement: {
          ...state.deliveryManagement,
          submitting: false,
          lastEntry: undefined,
          lastError: undefined,
        },
      };

    case "DELIVERY_LIST_STARTED":
      return {
        ...state,
        deliveryManagement: {
          ...state.deliveryManagement,
          loading: true,
          lastError: undefined,
        },
      };

    case "DELIVERY_LIST_LOADED":
      return {
        ...state,
        deliveryManagement: {
          ...state.deliveryManagement,
          entries: action.entries,
          loading: false,
          lastError: undefined,
        },
      };

    case "DELIVERY_LIST_FAILED":
      return {
        ...state,
        deliveryManagement: {
          ...state.deliveryManagement,
          loading: false,
          lastError: action.error,
        },
      };

    default:
      return state;
  }
}
