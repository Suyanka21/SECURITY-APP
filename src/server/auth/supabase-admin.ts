/**
 * GatePass — Supabase Admin Auth (server-side ONLY).
 *
 * Source: Supabase — Admin API: create/delete users via the service-role key.
 *   https://supabase.com/docs/reference/api/admin-create-user
 *   POST   {SUPABASE_URL}/auth/v1/admin/users
 *   DELETE {SUPABASE_URL}/auth/v1/admin/users/{id}
 *   GET    {SUPABASE_URL}/auth/v1/admin/users?...   (list; used to find dupes)
 * Source: src/docs/adr/0001-...md — accounts are provisioned server-side; the
 *   service-role key never reaches the browser and is never logged.
 * Source: Security-and-Hardening — secrets are sacred; never log tokens/keys.
 *
 * SECURITY INVARIANTS (enforced here, verified by review):
 *   - Reads SUPABASE_SERVICE_ROLE_KEY from the server env ONLY. This module is
 *     imported exclusively by server code; it must NEVER be bundled into the
 *     browser (no VITE_ prefix, no import from src/lib or src/features).
 *   - Never console.logs the key, the Authorization header, or any password.
 *   - Errors returned to callers carry a status + safe message, never the key.
 */

export interface SupabaseAdminUser {
  id: string;
  email?: string;
}

/**
 * Whether server-side account provisioning is configured. Requires BOTH the
 * Supabase project URL and the service-role key. When false, the provisioning
 * endpoint returns 503 rather than attempting a doomed call.
 */
export function isSupabaseAdminConfigured(): boolean {
  return Boolean(
    process.env.SUPABASE_URL &&
      process.env.SUPABASE_URL.length > 0 &&
      process.env.SUPABASE_SERVICE_ROLE_KEY &&
      process.env.SUPABASE_SERVICE_ROLE_KEY.length > 0,
  );
}

function baseUrl(): string {
  const raw = process.env.SUPABASE_URL;
  if (!raw) {
    throw new Error("SUPABASE_URL is not configured");
  }
  // Tolerate a trailing slash or an accidental /rest/v1 suffix.
  return raw.replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
}

function serviceRoleKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  }
  return key;
}

function adminHeaders(): Record<string, string> {
  const key = serviceRoleKey();
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

/**
 * Structured error for admin-API failures. Carries a coarse category the
 * service layer maps to an HTTP status. The raw provider body is intentionally
 * NOT surfaced beyond a short, non-sensitive message.
 */
export class SupabaseAdminError extends Error {
  constructor(
    public readonly kind: "duplicate" | "unavailable" | "transient",
    message: string,
  ) {
    super(message);
    this.name = "SupabaseAdminError";
  }
}

/**
 * Create a pre-confirmed Supabase Auth user. `email_confirm: true` so the new
 * operator can sign in immediately with the credentials the admin relays
 * (GatePass does not run an email-delivery flow for the internal console).
 *
 * @returns the created auth user's id (auth.users.id → guards.supabase_user_id).
 * @throws SupabaseAdminError("duplicate") when the email already has an auth user.
 */
export async function createSupabaseAuthUser(
  email: string,
  password: string,
): Promise<SupabaseAdminUser> {
  const res = await fetch(`${baseUrl()}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ email, password, email_confirm: true }),
  });

  if (res.status === 200 || res.status === 201) {
    const body = (await res.json()) as SupabaseAdminUser;
    return { id: body.id, email: body.email };
  }

  // Supabase returns 422 for an already-registered email.
  if (res.status === 422) {
    throw new SupabaseAdminError(
      "duplicate",
      "An account with this email already exists",
    );
  }

  // Do NOT include the raw provider body — it can echo request context.
  throw new SupabaseAdminError(
    "transient",
    `Supabase admin user creation failed (status ${res.status})`,
  );
}

/**
 * Delete a Supabase Auth user. Used as the compensating action when the guards
 * row insert fails after the auth user was created, so we never leave an
 * orphaned auth user with no linked guard profile.
 *
 * Best-effort: a failure here is logged by the caller as a reconciliation TODO,
 * never surfaced as the primary error.
 */
export async function deleteSupabaseAuthUser(id: string): Promise<void> {
  const res = await fetch(`${baseUrl()}/auth/v1/admin/users/${id}`, {
    method: "DELETE",
    headers: adminHeaders(),
  });
  if (!(res.status === 200 || res.status === 204)) {
    throw new SupabaseAdminError(
      "transient",
      `Supabase admin user deletion failed (status ${res.status})`,
    );
  }
}

export interface SupabaseAdminDeps {
  isConfigured: () => boolean;
  createUser: (email: string, password: string) => Promise<SupabaseAdminUser>;
  deleteUser: (id: string) => Promise<void>;
}

/** The real, network-backed dependency bundle used in production. */
export const realSupabaseAdminDeps: SupabaseAdminDeps = {
  isConfigured: isSupabaseAdminConfigured,
  createUser: createSupabaseAuthUser,
  deleteUser: deleteSupabaseAuthUser,
};
