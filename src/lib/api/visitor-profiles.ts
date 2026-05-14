/**
 * GatePass — Visitor profile API client.
 *
 * Source: src/docs/specs/visitor-profiles.md §4
 * Source: src/lib/api/approvals.ts (pattern: typed `ApiResult<T>` per method)
 *
 * Single surface used by the admin/senior-guard "Visitors" subview.
 * Every call returns a discriminated `ApiResult<T>` — callers must handle
 * both branches. The backend enforces RBAC via requireRole; reading the
 * list/get endpoints is allowed for any authenticated role, but mutations
 * (POST/PATCH/DELETE/restore) return 403 AUTH_FORBIDDEN when called with
 * a guard token.
 */

import { apiClient } from "./client";
import type {
  ApiResult,
  CreateVisitorProfileRequest,
  ListVisitorProfilesQuery,
  ListVisitorProfilesResponse,
  UpdateVisitorProfileRequest,
  VisitorProfileResponse,
} from "./types";

function buildListQuery(
  q: ListVisitorProfilesQuery
): Record<string, string | number | undefined> {
  return {
    host: q.host,
    unit: q.unit,
    q: q.q,
    page: q.page,
    pageSize: q.pageSize,
    // Zod boolean coercion on the server accepts "true"/"false" strings.
    includeDeleted: q.includeDeleted === undefined
      ? undefined
      : q.includeDeleted
        ? "true"
        : "false",
  };
}

export const visitorProfilesApi = {
  /** spec §4 — POST /api/visitor-profiles (admin / senior-guard only). */
  createProfile(
    input: CreateVisitorProfileRequest,
    signal?: AbortSignal
  ): Promise<ApiResult<VisitorProfileResponse>> {
    return apiClient.post<VisitorProfileResponse>(
      "/api/visitor-profiles",
      input,
      { signal }
    );
  },

  /** spec §4 — GET /api/visitor-profiles (any authenticated role). */
  listProfiles(
    query: ListVisitorProfilesQuery = {},
    signal?: AbortSignal
  ): Promise<ApiResult<ListVisitorProfilesResponse>> {
    return apiClient.get<ListVisitorProfilesResponse>(
      "/api/visitor-profiles",
      { query: buildListQuery(query), signal }
    );
  },

  /** spec §4 — GET /api/visitor-profiles/:id (any authenticated role). */
  getProfile(
    id: string,
    signal?: AbortSignal
  ): Promise<ApiResult<VisitorProfileResponse>> {
    return apiClient.get<VisitorProfileResponse>(
      `/api/visitor-profiles/${encodeURIComponent(id)}`,
      { signal }
    );
  },

  /** spec §4 — PATCH /api/visitor-profiles/:id (admin / senior-guard only). */
  updateProfile(
    id: string,
    patch: UpdateVisitorProfileRequest,
    signal?: AbortSignal
  ): Promise<ApiResult<VisitorProfileResponse>> {
    return apiClient.patch<VisitorProfileResponse>(
      `/api/visitor-profiles/${encodeURIComponent(id)}`,
      patch,
      { signal }
    );
  },

  /** spec §4 — DELETE /api/visitor-profiles/:id (soft-delete; admin/senior). */
  softDeleteProfile(
    id: string,
    signal?: AbortSignal
  ): Promise<ApiResult<VisitorProfileResponse>> {
    return apiClient.del<VisitorProfileResponse>(
      `/api/visitor-profiles/${encodeURIComponent(id)}`,
      { signal }
    );
  },

  /** spec §4 — POST /api/visitor-profiles/:id/restore (admin / senior-guard). */
  restoreProfile(
    id: string,
    signal?: AbortSignal
  ): Promise<ApiResult<VisitorProfileResponse>> {
    return apiClient.post<VisitorProfileResponse>(
      `/api/visitor-profiles/${encodeURIComponent(id)}/restore`,
      {},
      { signal }
    );
  },
};

export type VisitorProfilesApi = typeof visitorProfilesApi;
