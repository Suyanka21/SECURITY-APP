/**
 * GatePass — Resident Portal API client.
 *
 * Source: src/docs/specs/resident-portal.md §3–§4.
 *
 * Identity, unit and host are never sent: the server derives them from the
 * verified Supabase session and the residents row.
 */

import { apiClient } from "./client";
import type { ApiResult, IssueVisitorInvitationResponse } from "./types";

export interface ResidentMe {
  id: string;
  displayName: string;
  phoneE164: string;
  unitId: string;
  unitLabel: string;
}

export interface ResidentIssuePassRequest {
  visitorName: string;
  plate?: string | null;
  ttlHours?: number;
}

export const residentApi = {
  me(signal?: AbortSignal): Promise<ApiResult<{ resident: ResidentMe }>> {
    return apiClient.get<{ resident: ResidentMe }>("/api/resident/me", { signal });
  },

  claim(code: string, displayName: string): Promise<ApiResult<{ resident: { id: string } }>> {
    return apiClient.post<{ resident: { id: string } }>("/api/resident/claim", {
      code,
      displayName,
    });
  },

  issuePass(
    input: ResidentIssuePassRequest,
  ): Promise<ApiResult<IssueVisitorInvitationResponse>> {
    return apiClient.post<IssueVisitorInvitationResponse>("/api/resident/passes", input);
  },
};
