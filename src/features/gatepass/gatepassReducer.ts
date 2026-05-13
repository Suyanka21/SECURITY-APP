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
  EntryDraft,
  EntryMethod,
  EntryRecord,
  GatePassAction,
  GatePassError,
  GatePassMode,
  GatePassState,
  SyncResultView,
  Visitor,
} from "./types";

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

    case "FAIL_ACTIVE_ENTRY":
      return {
        ...state,
        mode: "error",
        inFlight: false,
        lastError: { code: "ACTIVE_ENTRY_FAILED", message: action.reason },
        banner: { tone: "danger", message: action.reason },
      };

    case "RESET_FLOW":
      return {
        ...state,
        mode: "home",
        draft: emptyDraft,
        cameraState: "idle",
        qrState: "idle",
        qrToken: "",
        inFlight: false,
        lastError: undefined,
        banner: { tone: "info", message: "Ready for next arrival." },
      };

    default:
      return state;
  }
}
