/**
 * GatePass — auth-role context (DB-verified), separate from onboarding-role.
 *
 * Source: src/docs/specs/auth-and-role-routing.md §2, §6, §7 and
 *         src/docs/adr/0001-...md.
 *
 * This context owns the **auth-role** namespace only:
 *   - it authenticates via Supabase (issues the JWT the backend verifies),
 *   - it resolves the role from GET /api/auth/me (guards.role) — never from the
 *     Supabase session/metadata,
 *   - it decides nothing about onboarding tutorials (that is useOnboarding's
 *     localStorage-backed onboarding-role, kept structurally separate here).
 *
 * Status machine:
 *   loading          — resolving the current session/role
 *   unauthenticated  — no valid session/token → show Login
 *   authenticated    — /api/auth/me returned a role → route by role
 *   no-guard-profile — a valid Supabase session exists but no linked guard row
 *                      (403 AUTH_NO_GUARD_LINK) → explicit not-available state,
 *                      never the guard console.
 *
 * Transport failures are NOT logouts. A network drop mid-shift used to resolve
 * to `unauthenticated`, which swapped the console for a login screen the guard
 * could not use offline and destroyed the pending offline queue with it. A
 * transport-level failure now keeps an already-proven identity (or restores the
 * last-known guard identity for the same Supabase user) with
 * `identityVerified: false`; 401/403 still clear everything immediately, and a
 * session that never proved an identity stays fail-closed. See identityCache.ts.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabase";
import { setAuthToken } from "@/lib/api/auth";
import { authApi, type AuthMe, type AuthRole } from "@/lib/api/me";
import {
  cachedIdentityToMe,
  clearCachedIdentity,
  readCachedIdentity,
  writeCachedIdentity,
} from "./identityCache";

export type AuthStatus =
  | "loading"
  | "unauthenticated"
  | "authenticated"
  | "no-guard-profile";

export interface SignInResult {
  ok: boolean;
  message?: string;
}

export interface AuthContextValue {
  status: AuthStatus;
  /** DB-verified role; only set when status === "authenticated". */
  role: AuthRole | null;
  /** Guard identity from /api/auth/me; only set when authenticated. */
  me: AuthMe | null;
  /**
   * False when `me` came from the identity cache or survived a failed
   * re-check — the guard is working offline on an unverified identity and the
   * UI must say so. True only after a successful /api/auth/me.
   */
  identityVerified: boolean;
  /** Whether Supabase password login is available in this build. */
  loginAvailable: boolean;
  /** Last login/resolution error message for display. */
  error: string | null;
  signIn(email: string, password: string): Promise<SignInResult>;
  signOut(): Promise<void>;
  /** Re-resolve the role from the server (e.g. after external token change). */
  refresh(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [role, setRole] = useState<AuthRole | null>(null);
  const [me, setMe] = useState<AuthMe | null>(null);
  const [identityVerified, setIdentityVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guards against setting state after unmount / out-of-order resolutions.
  const mountedRef = useRef(true);
  // Latest resolved identity + its Supabase user, readable without re-running
  // resolveRole when the identity outlives a failed re-check.
  const meRef = useRef<AuthMe | null>(null);
  const supabaseUserIdRef = useRef<string | null>(null);

  const applyMe = useCallback((next: AuthMe | null, verified: boolean) => {
    meRef.current = next;
    setMe(next);
    setRole(next?.role ?? null);
    setIdentityVerified(next ? verified : false);
  }, []);

  const resolveRole = useCallback(async () => {
    const res = await authApi.me();
    if (!mountedRef.current) return;

    if (res.ok) {
      applyMe(res.data, true);
      writeCachedIdentity(supabaseUserIdRef.current, res.data);
      setError(null);
      setStatus("authenticated");
      return;
    }

    // 403 → authenticated with Supabase but no linked guard profile. Never
    // restorable from cache: the answer is a definite "no console for you".
    if (res.status === 403) {
      applyMe(null, false);
      clearCachedIdentity();
      setStatus("no-guard-profile");
      return;
    }

    // Transport-level failure (status 0: offline, DNS, timeout). The server
    // said nothing, so it cannot revoke anything — keep an identity that was
    // already proven, or restore the last-known guard identity for this same
    // Supabase user, so the guard keeps logging into the offline queue.
    if (res.status === 0) {
      const cached = readCachedIdentity(supabaseUserIdRef.current);
      const survivor =
        meRef.current ?? (cached ? cachedIdentityToMe(cached) : null);

      if (survivor) {
        applyMe(survivor, false);
        setError(res.error.message);
        setStatus("authenticated");
        return;
      }

      // Nothing was ever proven on this device → stay fail-closed.
      applyMe(null, false);
      setError(res.error.message);
      setStatus("unauthenticated");
      return;
    }

    // 401 → no/invalid token → show login. Any other server-issued failure is
    // also a definite answer, so it clears the cache too, but surfaces a
    // message so the UI isn't silent.
    applyMe(null, false);
    clearCachedIdentity();
    if (res.status !== 401) {
      setError(res.error.message);
    }
    setStatus("unauthenticated");
  }, [applyMe]);

  const refresh = useCallback(async () => {
    setStatus("loading");
    await resolveRole();
  }, [resolveRole]);

  useEffect(() => {
    mountedRef.current = true;
    const supabase = getSupabaseClient();

    // Prime the token from any persisted Supabase session, then resolve role.
    void (async () => {
      if (supabase) {
        const { data } = await supabase.auth.getSession();
        setAuthToken(data.session?.access_token ?? null);
        supabaseUserIdRef.current = data.session?.user.id ?? null;
      }
      await resolveRole();
    })();

    // Keep the API token in sync with Supabase session changes (refresh,
    // sign-out from another tab, etc.) and re-resolve the role.
    const sub = supabase?.auth.onAuthStateChange((_event, session) => {
      setAuthToken(session?.access_token ?? null);
      supabaseUserIdRef.current = session?.user.id ?? supabaseUserIdRef.current;
      void resolveRole();
    });

    return () => {
      mountedRef.current = false;
      sub?.data.subscription.unsubscribe();
    };
  }, [resolveRole]);

  const signIn = useCallback(
    async (email: string, password: string): Promise<SignInResult> => {
      const supabase = getSupabaseClient();
      if (!supabase) {
        const message =
          "Login is not configured in this build (missing Supabase env vars).";
        setError(message);
        return { ok: false, message };
      }

      setError(null);
      const { data, error: signInError } = await supabase.auth.signInWithPassword(
        { email, password },
      );

      if (signInError) {
        setError(signInError.message);
        return { ok: false, message: signInError.message };
      }

      // Feed the freshly-issued token to the API client, then resolve the role
      // from the server (never from the Supabase session).
      supabaseUserIdRef.current = data.session?.user.id ?? data.user?.id ?? null;
      setAuthToken(data.session?.access_token ?? null);
      await resolveRole();
      return { ok: true };
    },
    [resolveRole],
  );

  const signOut = useCallback(async () => {
    const supabase = getSupabaseClient();
    await supabase?.auth.signOut();
    setAuthToken(null);
    clearCachedIdentity();
    meRef.current = null;
    supabaseUserIdRef.current = null;
    if (!mountedRef.current) return;
    setMe(null);
    setRole(null);
    setIdentityVerified(false);
    setError(null);
    setStatus("unauthenticated");
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      role,
      me,
      identityVerified,
      loginAvailable: isSupabaseConfigured(),
      error,
      signIn,
      signOut,
      refresh,
    }),
    [status, role, me, identityVerified, error, signIn, signOut, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
