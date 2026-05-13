/**
 * GatePass — Auth token resolver for the API client.
 *
 * Source: src/docs/gatepass-api-contract.md §2 — every protected route
 * requires `Authorization: Bearer <JWT>`. The backend extracts guardId
 * from the verified token (server/middleware/auth.ts), so the frontend
 * never sends guardId itself.
 *
 * Lookup order:
 * 1. Custom token getter set via `setAuthTokenGetter` (used by login flows
 *    or tests).
 * 2. `sessionStorage["gatepass.jwt"]` — populated after a real login.
 * 3. `import.meta.env.VITE_DEV_JWT` — convenience for local development.
 *
 * Returning `null` means no token is available; callers must handle the
 * resulting 401 from the backend rather than skipping the Authorization
 * header silently.
 */

const STORAGE_KEY = "gatepass.jwt";

type TokenGetter = () => string | null;

let overrideGetter: TokenGetter | null = null;

export function setAuthTokenGetter(getter: TokenGetter | null): void {
  overrideGetter = getter;
}

export function setAuthToken(token: string | null): void {
  if (typeof window === "undefined") return;
  if (token === null) {
    window.sessionStorage.removeItem(STORAGE_KEY);
    return;
  }
  window.sessionStorage.setItem(STORAGE_KEY, token);
}

export function getAuthToken(): string | null {
  if (overrideGetter) {
    return overrideGetter();
  }

  if (typeof window !== "undefined") {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    if (stored) return stored;
  }

  const envToken = (import.meta as ImportMeta & {
    env?: Record<string, string | undefined>;
  }).env?.VITE_DEV_JWT;
  if (envToken && envToken.length > 0) return envToken;

  return null;
}
