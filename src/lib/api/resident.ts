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

export type ResidentRegistrationKind = "person" | "vehicle";

/** renew_due: fewer than renewPromptDays left. disabled: switched off by staff. */
export type ResidentRegistrationStatus = "active" | "renew_due" | "expired" | "disabled";

export interface ResidentRegistration {
  id: string;
  kind: ResidentRegistrationKind;
  label: string;
  plate: string | null;
  status: ResidentRegistrationStatus;
  expiresAt: string;
  createdAt: string;
}

export interface ResidentRegistrationList {
  registrations: ResidentRegistration[];
  count: number;
  renewPromptDays: number;
}

export type CreateResidentRegistrationRequest =
  | { kind: "person"; label: string }
  | { kind: "vehicle"; label: string; plate: string };

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

  listRegistrations(signal?: AbortSignal): Promise<ApiResult<ResidentRegistrationList>> {
    return apiClient.get<ResidentRegistrationList>("/api/resident/registrations", { signal });
  },

  createRegistration(
    input: CreateResidentRegistrationRequest,
  ): Promise<ApiResult<{ registration: ResidentRegistration }>> {
    return apiClient.post<{ registration: ResidentRegistration }>("/api/resident/registrations", input);
  },

  removeRegistration(id: string): Promise<ApiResult<{ registration: { id: string } }>> {
    return apiClient.del<{ registration: { id: string } }>(
      `/api/resident/registrations/${encodeURIComponent(id)}`,
    );
  },

  renewRegistration(id: string): Promise<ApiResult<{ registration: ResidentRegistration }>> {
    return apiClient.post<{ registration: ResidentRegistration }>(
      `/api/resident/registrations/${encodeURIComponent(id)}/renew`,
      {},
    );
  },
};
