/**
 * GatePass — Delivery management API client.
 *
 * Source: src/docs/specs/delivery-management.md §4
 *
 * Two methods:
 *   submitDelivery(input)   → POST /api/entries/deliveries
 *   listDeliveries()        → GET  /api/entries/deliveries (admin only)
 *
 * Returns the discriminated `ApiResult<T>` — callers must handle both
 * branches. RBAC is enforced server-side; the client sends the JWT and
 * lets the server decide.
 */

import { apiClient } from "./client";
import type {
  ApiResult,
  CreateDeliveryEntryRequest,
  CreateDeliveryEntryResponse,
  ListDeliveriesResponse,
} from "./types";

export const deliveryApi = {
  /** spec §4.1 — POST /api/entries/deliveries (any guard). */
  submitDelivery(
    input: CreateDeliveryEntryRequest,
    signal?: AbortSignal,
  ): Promise<ApiResult<CreateDeliveryEntryResponse>> {
    return apiClient.post<CreateDeliveryEntryResponse>(
      "/api/entries/deliveries",
      input,
      { signal },
    );
  },

  /** spec §4.3 — GET /api/entries/deliveries (admin / senior-guard only). */
  listDeliveries(
    signal?: AbortSignal,
  ): Promise<ApiResult<ListDeliveriesResponse>> {
    return apiClient.get<ListDeliveriesResponse>("/api/entries/deliveries", {
      signal,
    });
  },
};
