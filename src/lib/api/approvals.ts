/**
 * GatePass — Resident approval API client.
 *
 * Source: src/docs/specs/resident-approval-flow.md §7
 * Source: src/lib/api/gatepass.ts (pattern: typed `ApiResult<T>` per method)
 *
 * Two surfaces:
 *
 *   guardApprovalApi  → JWT-authenticated calls used by the guard's UI
 *                       (createApproval, getApprovalStatus).
 *   residentApprovalApi → unauthenticated call used by the resident's
 *                         magic-link page (decideApproval).
 *
 * The split exists because /decide does not require — and must not send —
 * an Authorization header. Keeping the surfaces separate makes it obvious
 * at the call site which authentication context a request runs in.
 */

import { apiClient } from "./client";
import type {
  ApiResult,
  ApprovalStatusResponse,
  CreateApprovalRequest,
  CreateApprovalResponse,
  DecideApprovalRequest,
  DecideApprovalResponse,
} from "./types";

export const guardApprovalApi = {
  /**
   * spec §7.1 — POST /api/approvals
   *
   * Used by the guard's UI after submitting a walk-in entry that requires
   * resident approval. The response contains the magic-link URL the guard
   * shows to the visitor.
   */
  createApproval(
    input: CreateApprovalRequest,
    signal?: AbortSignal
  ): Promise<ApiResult<CreateApprovalResponse>> {
    return apiClient.post<CreateApprovalResponse>(
      "/api/approvals",
      input,
      { signal }
    );
  },

  /**
   * spec §7.2 — GET /api/approvals/:id/status
   *
   * Polled every 2s by the guard's UI while the entry is pending. The
   * server applies lazy expiry on read, so the response is the
   * authoritative current state.
   */
  getApprovalStatus(
    approvalId: string,
    signal?: AbortSignal
  ): Promise<ApiResult<ApprovalStatusResponse>> {
    return apiClient.get<ApprovalStatusResponse>(
      `/api/approvals/${encodeURIComponent(approvalId)}/status`,
      { signal }
    );
  },
};

export const residentApprovalApi = {
  /**
   * spec §7.3 — POST /api/approvals/:id/decide
   *
   * Used by the resident's magic-link page (/approve/:id). NO JWT is
   * required — the token in the body IS the auth. The apiClient still
   * attaches Authorization if a token happens to be present in the page's
   * session storage, but the backend ignores it on this route.
   */
  decideApproval(
    approvalId: string,
    input: DecideApprovalRequest,
    signal?: AbortSignal
  ): Promise<ApiResult<DecideApprovalResponse>> {
    return apiClient.post<DecideApprovalResponse>(
      `/api/approvals/${encodeURIComponent(approvalId)}/decide`,
      input,
      { signal }
    );
  },
};

export type GuardApprovalApi = typeof guardApprovalApi;
export type ResidentApprovalApi = typeof residentApprovalApi;
