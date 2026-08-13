/**
 * GatePass — Watchlist API client (Feature 12 / Stage 5).
 *
 * Source: src/docs/specs/watchlist.md §3
 * Source: src/lib/api/guard-notes.ts (pattern: typed `ApiResult<T>`).
 *
 *   list(query)          → GET    /api/watchlist
 *   create(body)         → POST   /api/watchlist
 *   review(id, body)     → PATCH  /api/watchlist/:id
 *   remove(id, body)     → DELETE /api/watchlist/:id
 *
 * All four are admin/senior-guard only server-side. guardId is never sent —
 * the server derives it from the JWT.
 */

import { apiClient } from "./client";
import type {
  ApiResult,
  CreateWatchlistEntryRequest,
  ListWatchlistQuery,
  ListWatchlistResponse,
  RemoveWatchlistEntryRequest,
  ReviewWatchlistEntryRequest,
  WatchlistEntryResponse,
} from "./types";

export const watchlistApi = {
  list(
    query: ListWatchlistQuery = {},
    signal?: AbortSignal,
  ): Promise<ApiResult<ListWatchlistResponse>> {
    return apiClient.get<ListWatchlistResponse>("/api/watchlist", {
      query: {
        status: query.status,
        // Only send the filter when it is on — an absent param means "no filter".
        needsReview: query.needsReview ? "true" : undefined,
      },
      signal,
    });
  },

  create(
    body: CreateWatchlistEntryRequest,
    signal?: AbortSignal,
  ): Promise<ApiResult<WatchlistEntryResponse>> {
    return apiClient.post<WatchlistEntryResponse>("/api/watchlist", body, {
      signal,
    });
  },

  review(
    id: string,
    body: ReviewWatchlistEntryRequest = {},
    signal?: AbortSignal,
  ): Promise<ApiResult<WatchlistEntryResponse>> {
    return apiClient.patch<WatchlistEntryResponse>(
      `/api/watchlist/${encodeURIComponent(id)}`,
      body,
      { signal },
    );
  },

  remove(
    id: string,
    body: RemoveWatchlistEntryRequest,
    signal?: AbortSignal,
  ): Promise<ApiResult<WatchlistEntryResponse>> {
    return apiClient.del<WatchlistEntryResponse>(
      `/api/watchlist/${encodeURIComponent(id)}`,
      { body, signal },
    );
  },
};

export type WatchlistApi = typeof watchlistApi;
