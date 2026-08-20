/**
 * GatePass — pending-approval handoff store.
 *
 * The resident approval magic link is opened on the same device as the guard
 * console (the guard hands the phone/tablet over, or clicks "Open"). That
 * navigation unmounts the console, and the awaiting-approval state lived only
 * in memory: coming back, the guard saw "Ready for next arrival" and had no
 * way to learn whether the resident had approved or denied.
 *
 * The awaiting approval is therefore mirrored into localStorage so the console
 * can resume it on mount and resolve it against the server. Only the approval
 * envelope is stored — the same non-secret fields the guard already sees on
 * screen. The single-use magic-link token is NOT part of it.
 */

import type { PendingApproval } from "./types";

const STORAGE_KEY = "gatepass_pending_approval";

/**
 * Stale entries are ignored rather than resumed: a stored approval from a
 * previous shift must not reappear on a fresh console.
 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface StoredHandoff {
  approval: PendingApproval;
  storedAt: number;
}

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    // Private-mode / disabled storage: the console still works, it just
    // cannot resume across a navigation.
    return null;
  }
}

/** Mirror an awaiting approval so it survives leaving the console. */
export function rememberPendingApproval(approval: PendingApproval): void {
  const store = storage();
  if (!store) return;
  try {
    const payload: StoredHandoff = { approval, storedAt: Date.now() };
    store.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Quota or serialization failure — non-fatal.
  }
}

/** Drop the mirror once the approval reaches a terminal state or is reset. */
export function forgetPendingApproval(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    // Non-fatal.
  }
}

/**
 * Read a resumable approval, or null when there is none, it is unreadable, or
 * it is too old to be relevant. Anything unusable is removed so a corrupt
 * value cannot wedge the console on every mount.
 */
export function readPendingApproval(): PendingApproval | null {
  const store = storage();
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<StoredHandoff>;
    const approval = parsed?.approval;
    const storedAt = parsed?.storedAt;
    if (
      !approval ||
      typeof approval.id !== "string" ||
      approval.id.length === 0 ||
      typeof approval.expiresAt !== "string" ||
      !approval.draft ||
      typeof storedAt !== "number" ||
      Date.now() - storedAt > MAX_AGE_MS
    ) {
      forgetPendingApproval();
      return null;
    }
    return approval;
  } catch {
    forgetPendingApproval();
    return null;
  }
}
