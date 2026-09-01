/**
 * GatePass — last-known guard identity cache (offline shift continuity).
 *
 * Why this exists: `GET /api/auth/me` is the only source of identity, and a
 * transport failure used to be treated as "unauthenticated", which dropped a
 * mid-shift guard to the login screen — where they could not sign in, because
 * Supabase password sign-in needs the network. That unmounted the console and
 * silently destroyed the offline queue.
 *
 * What this does NOT do: grant authority. The cache is only ever consulted
 * when (a) a persisted Supabase session exists for the same user, and (b) the
 * `/api/auth/me` call failed at transport level. Every write is still
 * authorized server-side from the JWT when the queue syncs, so a tampered
 * cache buys a fake console, not a real entry. Restoration is additionally
 * limited to the guard console (`guard` / `senior-guard`) — `admin` and the
 * no-guard-profile state have no offline use and are never restored.
 */

import type { AuthMe, AuthRole } from "@/lib/api/me";

const STORAGE_KEY = "gatepass.identity.v1";

/** Roles whose console is useful offline; nothing else is ever restored. */
const RESTORABLE_ROLES: readonly AuthRole[] = ["guard", "senior-guard"];

/** One shift. A stale identity is dropped rather than silently reused. */
export const IDENTITY_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export interface CachedIdentity {
  /** Supabase user the identity was resolved for; a different user is ignored. */
  supabaseUserId: string;
  guardId: string;
  role: AuthRole;
  name: string;
  badgeNumber: string;
  cachedAt: number;
}

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function clearCachedIdentity(): void {
  storage()?.removeItem(STORAGE_KEY);
}

export function writeCachedIdentity(
  supabaseUserId: string | null,
  me: AuthMe,
): void {
  const store = storage();
  if (!store || !supabaseUserId) return;
  // Only the guard console is ever restored offline, so an admin identity is
  // not written at all — nothing to tamper with later.
  if (!isRestorableRole(me.role)) {
    clearCachedIdentity();
    return;
  }
  const record: CachedIdentity = {
    supabaseUserId,
    guardId: me.guardId,
    role: me.role,
    name: me.name,
    badgeNumber: me.badgeNumber,
    cachedAt: Date.now(),
  };
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // A full or unavailable store must never break sign-in.
  }
}

/** Only the two guard-console roles may ever come back from the cache. */
function isRestorableRole(value: unknown): value is AuthRole {
  return (
    typeof value === "string" &&
    RESTORABLE_ROLES.some((role) => role === value)
  );
}

function parse(raw: string): CachedIdentity | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record: Record<string, unknown> = { ...value };

  const { supabaseUserId, guardId, name, badgeNumber, cachedAt, role } = record;
  if (
    typeof supabaseUserId !== "string" ||
    typeof guardId !== "string" ||
    typeof name !== "string" ||
    typeof badgeNumber !== "string" ||
    typeof cachedAt !== "number" ||
    !Number.isFinite(cachedAt) ||
    !isRestorableRole(role)
  ) {
    return null;
  }
  return { supabaseUserId, guardId, role, name, badgeNumber, cachedAt };
}

/**
 * Returns the cached identity only when it belongs to `supabaseUserId`, is
 * within the max age, and names a role whose console is restorable. Anything
 * else (missing, malformed, other user, expired, admin) yields null so the
 * caller stays fail-closed. A rejected record is removed.
 */
export function readCachedIdentity(
  supabaseUserId: string | null,
  now: number = Date.now(),
): CachedIdentity | null {
  const store = storage();
  if (!store || !supabaseUserId) return null;

  const raw = store.getItem(STORAGE_KEY);
  if (!raw) return null;

  const record = parse(raw);
  if (!record) {
    clearCachedIdentity();
    return null;
  }
  if (record.supabaseUserId !== supabaseUserId) return null;
  if (now - record.cachedAt > IDENTITY_CACHE_MAX_AGE_MS) {
    clearCachedIdentity();
    return null;
  }
  return record;
}

/** Shapes a cached record back into the `AuthMe` the app consumes. */
export function cachedIdentityToMe(record: CachedIdentity): AuthMe {
  return {
    guardId: record.guardId,
    role: record.role,
    name: record.name,
    badgeNumber: record.badgeNumber,
    isActive: true,
    traceId: "cached-identity",
  };
}
