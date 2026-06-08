/**
 * GatePass — Visitor invitation API client (Feature 6 / Guest QR Ticket).
 *
 * Source: src/docs/specs/guest-qr-ticket.md §6 (Backend — Endpoints).
 * Source: src/lib/api/visitor-profiles.ts (pattern: typed ApiResult<T>).
 *
 * Two methods:
 *
 *   issueInvitation: admin/senior-guard mints a single-use QR pass.
 *                    Raw token is returned EXACTLY ONCE in the response.
 *                    Caller is responsible for delivering pass URL to the
 *                    guest (clipboard, WhatsApp/SMS via Feature 2, etc.).
 *
 *   previewInvitation: public — the token IN the URL is the auth. Returns
 *                      ONLY safe display fields (no id, no hash, no
 *                      is_used). Used by the /pass/:token landing page.
 */

import { apiClient } from "./client";
import type {
  ApiResult,
  IssueVisitorInvitationRequest,
  IssueVisitorInvitationResponse,
  PreviewVisitorInvitationResponse,
} from "./types";

export const visitorInvitationsApi = {
  /**
   * spec §6 — POST /api/visitor-invitations.
   * Requires an authenticated admin or senior-guard token. Guard tokens
   * receive 403 AUTH_FORBIDDEN from the requireRole middleware.
   */
  issueInvitation(
    input: IssueVisitorInvitationRequest,
    signal?: AbortSignal,
  ): Promise<ApiResult<IssueVisitorInvitationResponse>> {
    return apiClient.post<IssueVisitorInvitationResponse>(
      "/api/visitor-invitations",
      input,
      { signal },
    );
  },

  /**
   * spec §6 — GET /api/visitor-invitations/:token/preview.
   * Public endpoint. Returns 404 INVITATION_NOT_FOUND for unknown OR
   * malformed tokens (single shape — no enumeration leak).
   * Returns 410 INVITATION_EXPIRED / INVITATION_CONSUMED for stale tokens.
   */
  previewInvitation(
    rawToken: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<PreviewVisitorInvitationResponse>> {
    return apiClient.get<PreviewVisitorInvitationResponse>(
      `/api/visitor-invitations/${encodeURIComponent(rawToken)}/preview`,
      { signal },
    );
  },
};

export type VisitorInvitationsApi = typeof visitorInvitationsApi;
