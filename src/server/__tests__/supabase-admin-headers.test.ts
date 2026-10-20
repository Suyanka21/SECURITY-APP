/**
 * GatePass — Supabase Admin API headers.
 *
 * Source: Supabase — API keys https://supabase.com/docs/guides/api/api-keys
 *   "Send publishable and secret keys on the apikey header, not on
 *   Authorization: Bearer."
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  adminHeaders,
  createSupabaseAuthUser,
  isSupabaseAdminConfigured,
} from "../auth/supabase-admin";

describe("Supabase admin API headers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("sends the secret key on apikey only, never as a Bearer token", () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test_value");
    const headers = adminHeaders();
    expect(headers.apikey).toBe("sb_secret_test_value");
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("authorization");
  });

  it("reads SUPABASE_SECRET_KEY, not the legacy SUPABASE_SERVICE_ROLE_KEY", () => {
    vi.stubEnv("SUPABASE_URL", "https://ref.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "legacy-service-role-jwt");
    expect(isSupabaseAdminConfigured()).toBe(false);
    expect(() => adminHeaders()).toThrow("SUPABASE_SECRET_KEY is not configured");
  });

  it("creates users with the apikey header and no Authorization header", async () => {
    vi.stubEnv("SUPABASE_URL", "https://ref.supabase.co/");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test_value");
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "u1", email: "a@b.co" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createSupabaseAuthUser("a@b.co", "pw-123456789");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ref.supabase.co/auth/v1/admin/users");
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe("sb_secret_test_value");
    expect(headers.Authorization).toBeUndefined();
  });
});
