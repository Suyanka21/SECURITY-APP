/**
 * GatePass — Typed API surface used by the React layer.
 *
 * Each method maps 1:1 to a backend route in src/server/routes/*. The
 * frontend never inserts guardId — the backend extracts it from the
 * verified JWT (server/middleware/auth.ts).
 *
 * Contract: src/docs/gatepass-api-contract.md
 */

import { apiClient } from "./client";
import type {
  ApiResult,
  CreateEntryRequest,
  CreateEntryResponse,
  QrValidateRequest,
  QrValidateResponse,
  PinValidateRequest,
  PinValidateResponse,
  RecognizedVisitorsRequest,
  RecognizedVisitorsResponse,
  SyncBatchRequest,
  SyncBatchResponse,
} from "./types";

export const gatePassApi = {
  /** Contract §3.2 — POST /api/entries */
  submitEntry(
    input: CreateEntryRequest,
    signal?: AbortSignal
  ): Promise<ApiResult<CreateEntryResponse>> {
    return apiClient.post<CreateEntryResponse>("/api/entries", input, { signal });
  },

  /** Contract §3.1 — POST /api/entries/qr/validate */
  validateQr(
    input: QrValidateRequest,
    signal?: AbortSignal
  ): Promise<ApiResult<QrValidateResponse>> {
    return apiClient.post<QrValidateResponse>(
      "/api/entries/qr/validate",
      input,
      { signal }
    );
  },

  /** Feature 11 — POST /api/entries/pin/validate (pass reference + PIN). */
  validatePin(
    input: PinValidateRequest,
    signal?: AbortSignal
  ): Promise<ApiResult<PinValidateResponse>> {
    return apiClient.post<PinValidateResponse>(
      "/api/entries/pin/validate",
      input,
      { signal }
    );
  },

  /** Contract §3.3 — POST /api/entries/sync (200 full, 207 partial). */
  syncEntries(
    input: SyncBatchRequest,
    signal?: AbortSignal
  ): Promise<ApiResult<SyncBatchResponse>> {
    return apiClient.post<SyncBatchResponse>(
      "/api/entries/sync",
      input,
      { signal }
    );
  },

  /** Contract §3.4 — GET /api/visitors/recognized */
  searchVisitors(
    input: RecognizedVisitorsRequest = {},
    signal?: AbortSignal
  ): Promise<ApiResult<RecognizedVisitorsResponse>> {
    return apiClient.get<RecognizedVisitorsResponse>(
      "/api/visitors/recognized",
      {
        query: {
          q: input.q,
          page: input.page,
          pageSize: input.pageSize,
        },
        signal,
      }
    );
  },
};

export type GatePassApi = typeof gatePassApi;
