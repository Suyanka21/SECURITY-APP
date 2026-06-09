/**
 * GatePass — Shift log aggregation API client.
 *
 * Source: src/docs/specs/shift-log-aggregation.md §4
 * Source: src/lib/api/visitor-profiles.ts (pattern: typed `ApiResult<T>`).
 *
 * One method, one endpoint. Returns the discriminated `ApiResult<T>` —
 * callers must handle both branches. The backend enforces RBAC
 * (admin / senior-guard) at the requireRole middleware layer.
 */

import { apiClient } from "./client";
import type {
  ApiResult,
  ListShiftsQuery,
  ListShiftsResponse,
} from "./types";

function buildListQuery(
  q: ListShiftsQuery
): Record<string, string | undefined> {
  return {
    fromIso: q.fromIso,
    toIso: q.toIso,
    guardId: q.guardId,
  };
}

export const shiftsApi = {
  /** spec §4 — GET /api/admin/shifts (admin / senior-guard only). */
  listShifts(
    query: ListShiftsQuery = {},
    signal?: AbortSignal
  ): Promise<ApiResult<ListShiftsResponse>> {
    return apiClient.get<ListShiftsResponse>("/api/admin/shifts", {
      query: buildListQuery(query),
      signal,
    });
  },
};
