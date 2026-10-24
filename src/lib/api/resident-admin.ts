/**
 * GatePass — admin API client for units, claim codes, residents and a unit's
 * registrations (R4a).
 *
 * Source: src/docs/specs/resident-admin-panels.md; src/server/routes/residents.ts.
 * Every route is requireAuth + requireRole("admin") on the server. Residents
 * come back with `phoneMasked` only: the server never sends an admin the
 * full number, so this client has nothing to mask.
 */

import { apiClient } from "./client";
import type { ApiResult } from "./types";

export const UNIT_LABEL_MAX = 32;

export interface UnitView {
  id: string;
  label: string;
  isActive: boolean;
  createdAt: string;
  deactivatedAt: string | null;
  activeResidentCount: number;
}

export interface UnitDeactivatedResponse {
  unit: UnitView;
  expiredPassCount: number;
  deactivatedResidentCount: number;
  disabledRuleCount: number;
}

export interface ClaimCodeIssued {
  claimCodeId: string;
  unitId: string;
  unitLabel: string;
  /** XXXX-XXXX, returned once. Never store, log or put it in a URL. */
  code: string;
  expiresAt: string;
}

export interface AdminResidentView {
  id: string;
  displayName: string;
  phoneMasked: string;
  isActive: boolean;
  unitId: string;
  unitLabel: string;
  claimedAt: string;
  deactivatedAt: string | null;
}

export type AdminRegistrationStatus = "active" | "renew_due" | "expired" | "disabled" | "removed";

export interface AdminRegistrationView {
  id: string;
  kind: "person" | "vehicle";
  label: string;
  plate: string | null;
  residentId: string;
  residentDisplayName: string;
  status: AdminRegistrationStatus;
  ruleId: string;
  ruleActive: boolean;
  expiresAt: string;
  createdAt: string;
  removedAt: string | null;
  block: null | {
    blockedAt: string;
    blockedBy: string;
    reason: string | null;
    clearedAt: string | null;
    clearedBy: string | null;
    clearReason: string | null;
  };
}

export const residentAdminApi = {
  listUnits(includeInactive: boolean, signal?: AbortSignal): Promise<ApiResult<{ units: UnitView[]; count: number }>> {
    return apiClient.get("/api/admin/units", {
      query: { includeInactive: includeInactive ? "true" : undefined },
      signal,
    });
  },
  createUnit(label: string): Promise<ApiResult<{ unit: UnitView }>> {
    return apiClient.post("/api/admin/units", { label });
  },
  deactivateUnit(unitId: string): Promise<ApiResult<UnitDeactivatedResponse>> {
    return apiClient.post(`/api/admin/units/${encodeURIComponent(unitId)}/deactivate`, {});
  },
  /** Uses the server's default lifetime (72 hours). */
  issueClaimCode(unitId: string): Promise<ApiResult<{ claimCode: ClaimCodeIssued }>> {
    return apiClient.post(`/api/admin/units/${encodeURIComponent(unitId)}/claim-codes`, {});
  },
  listResidents(
    unitId: string,
    includeInactive: boolean,
    signal?: AbortSignal,
  ): Promise<ApiResult<{ residents: AdminResidentView[]; count: number }>> {
    return apiClient.get("/api/admin/residents", {
      query: { unitId, includeInactive: includeInactive ? "true" : undefined },
      signal,
    });
  },
  deactivateResident(residentId: string): Promise<ApiResult<{ resident: AdminResidentView }>> {
    return apiClient.post(`/api/admin/residents/${encodeURIComponent(residentId)}/deactivate`, {});
  },
  listRegistrations(
    unitId: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<{ registrations: AdminRegistrationView[]; count: number }>> {
    return apiClient.get(`/api/admin/units/${encodeURIComponent(unitId)}/registrations`, { signal });
  },
};
