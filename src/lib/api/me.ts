/**
 * GatePass — auth identity API client (GET /api/auth/me).
 *
 * Source: src/server/routes/auth.ts + src/docs/specs/auth-and-role-routing.md §7.
 *
 * The client's auth-role is learned ONLY from this endpoint, which reads it
 * from guards.role — the same source requireRole trusts. Never derive the role
 * from the Supabase session, JWT claims, or localStorage.
 */

import { apiClient } from "./client";
import type { ApiResult } from "./types";

/** DB-backed roles (guards.role). Distinct from onboarding StakeholderRole. */
export type AuthRole = "guard" | "senior-guard" | "admin";

export interface AuthMe {
  guardId: string;
  role: AuthRole;
  name: string;
  badgeNumber: string;
  isActive: boolean;
  traceId: string;
}

export const authApi = {
  me(signal?: AbortSignal): Promise<ApiResult<AuthMe>> {
    return apiClient.get<AuthMe>("/api/auth/me", { signal });
  },
};
