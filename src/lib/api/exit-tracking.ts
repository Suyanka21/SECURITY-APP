/**
 * GatePass — Exit tracking API client.
 *
 * Source: src/docs/specs/exit-tracking.md §6
 * Source: src/lib/api/shifts.ts (pattern: typed `ApiResult<T>`).
 *
 * Two methods, two endpoints:
 *   recordExit(entryId)  →  POST /api/entries/:entryId/exit
 *   listOnPremise()      →  GET  /api/entries/on-premise
 *
 * Returns the discriminated `ApiResult<T>` — callers must handle both
 * branches. RBAC is enforced server-side; the client sends the JWT and
 * lets the server decide.
 */

import { apiClient } from "./client";
import type {
  ApiResult,
  RecordExitResponse,
  ListOnPremiseResponse,
} from "./types";

export const exitTrackingApi = {
  /** spec §6 — POST /api/entries/:entryId/exit (any guard). */
  recordExit(
    entryId: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<RecordExitResponse>> {
    return apiClient.post<RecordExitResponse>(
      `/api/entries/${encodeURIComponent(entryId)}/exit`,
      {},
      { signal },
    );
  },

  /** spec §6 — GET /api/entries/on-premise (admin / senior-guard only). */
  listOnPremise(
    signal?: AbortSignal,
  ): Promise<ApiResult<ListOnPremiseResponse>> {
    return apiClient.get<ListOnPremiseResponse>("/api/entries/on-premise", {
      signal,
    });
  },
};
