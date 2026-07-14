/**
 * GatePass — Supabase browser client (auth only).
 *
 * Source: Supabase JS — createClient / auth.signInWithPassword / getSession.
 *   https://supabase.com/docs/reference/javascript/initializing
 *   https://supabase.com/docs/reference/javascript/auth-signinwithpassword
 *
 * We use Supabase ONLY for authentication (password sign-in issues the JWT the
 * backend verifies against the project JWKS). We deliberately do NOT read the
 * database directly through this client — all data goes through our own API,
 * where requireRole enforces authorization. The user's role is NEVER read from
 * the Supabase session/metadata; it comes from GET /api/auth/me (guards.role).
 *
 * Returns null when the Supabase env vars are absent so the app still builds
 * and runs in the legacy dev-token mode (VITE_DEV_JWT) without crashing.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function readEnv(key: string): string | undefined {
  return (
    import.meta as ImportMeta & { env?: Record<string, string | undefined> }
  ).env?.[key];
}

let cached: SupabaseClient | null | undefined;

export function getSupabaseClient(): SupabaseClient | null {
  if (cached !== undefined) return cached;

  const rawUrl = readEnv("VITE_SUPABASE_URL");
  const anonKey = readEnv("VITE_SUPABASE_ANON_KEY");

  if (!rawUrl || !anonKey) {
    cached = null;
    return cached;
  }

  // Tolerate a trailing slash or an accidental /rest/v1 suffix in the env var.
  const url = rawUrl.replace(/\/+$/, "").replace(/\/rest\/v1$/, "");

  cached = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  return cached;
}

export function isSupabaseConfigured(): boolean {
  return getSupabaseClient() !== null;
}
