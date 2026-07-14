/**
 * GatePass — Supabase JWT verification (server-side).
 *
 * Source: Supabase — "Verifying a JWT" / signing keys are asymmetric (JWKS).
 *   https://supabase.com/docs/guides/auth/jwts
 *   https://supabase.com/docs/guides/auth/signing-keys
 * Source: jose — createRemoteJWKSet + jwtVerify.
 *   https://github.com/panva/jose/blob/main/docs/functions/jwks_remote.createRemoteJWKSet.md
 * Source: src/docs/adr/0001-...md — the token authenticates a Supabase user;
 *   the guard ROLE is read from our DB (guards.role), never from the token.
 *
 * This project's Supabase instance signs access tokens with an asymmetric key
 * (ES256, verified against the project's public JWKS endpoint), so the server
 * needs no shared secret to verify them. We pin the allowed algorithms to
 * asymmetric ones here — HS256 (the legacy self-issued path) is verified
 * separately in the auth middleware and must never be accepted against the
 * JWKS, which prevents algorithm-confusion.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";

/** Whether Supabase-issued JWT verification is configured for this process. */
export function isSupabaseAuthConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_URL.length > 0);
}

function baseUrl(): string {
  const raw = process.env.SUPABASE_URL;
  if (!raw) {
    throw new Error("SUPABASE_URL is not configured");
  }
  // Tolerate a trailing slash or an accidental /rest/v1 suffix.
  return raw.replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
}

// Cache the remote JWKS resolver per URL (jose caches/refreshes keys internally).
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedForUrl: string | null = null;

function jwks(): ReturnType<typeof createRemoteJWKSet> {
  const url = `${baseUrl()}/auth/v1/.well-known/jwks.json`;
  if (!cachedJwks || cachedForUrl !== url) {
    cachedJwks = createRemoteJWKSet(new URL(url));
    cachedForUrl = url;
  }
  return cachedJwks;
}

export interface SupabaseVerifiedToken {
  /** Supabase auth.users UUID — maps to guards.supabase_user_id. */
  sub: string;
  email?: string;
}

/**
 * Verify a Supabase-issued access token against the project JWKS.
 * Throws on any invalid/expired/tampered token — callers must default-deny.
 */
export async function verifySupabaseToken(
  token: string,
): Promise<SupabaseVerifiedToken> {
  const base = baseUrl();
  const { payload } = await jwtVerify(token, jwks(), {
    issuer: `${base}/auth/v1`,
    audience: "authenticated",
    // Asymmetric only. Never HS256 here — that path uses the shared secret.
    algorithms: ["ES256", "RS256"],
  });

  if (!payload.sub || typeof payload.sub !== "string") {
    throw new Error("Supabase token payload missing sub");
  }

  return {
    sub: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
  };
}
