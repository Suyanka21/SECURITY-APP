/**
 * GatePass — admin account-provisioning API client (Decision A1).
 *
 * Source: src/server/routes/accounts.ts — POST /api/admin/accounts is gated to
 *         requireAuth + requireRole("admin"). The role is server-controlled;
 *         the client sends a role only as a REQUEST for one of the allowed
 *         values — the server re-validates it against the closed enum.
 */

import { apiClient } from "./client";
import type { ApiResult } from "./types";

/** The closed set of roles an admin may provision. Mirrors the server enum. */
export const PROVISIONABLE_ROLES = ["guard", "senior-guard", "admin"] as const;
export type ProvisionableRole = (typeof PROVISIONABLE_ROLES)[number];

export interface ProvisionAccountInput {
  email: string;
  name: string;
  badgeNumber: string;
  role: ProvisionableRole;
  /** Optional admin-chosen password; when omitted the server generates one. */
  password?: string;
}

export interface ProvisionedAccountView {
  guardId: string;
  email: string;
  name: string;
  badgeNumber: string;
  role: ProvisionableRole;
  isActive: boolean;
}

export interface ProvisionAccountResponse {
  account: ProvisionedAccountView;
  /** Present only when the server generated the password (shown once). */
  temporaryPassword?: string;
  traceId: string;
}

export const accountsApi = {
  /** POST /api/admin/accounts (admin only). */
  createAccount(
    input: ProvisionAccountInput,
    signal?: AbortSignal,
  ): Promise<ApiResult<ProvisionAccountResponse>> {
    return apiClient.post<ProvisionAccountResponse>(
      "/api/admin/accounts",
      input,
      { signal },
    );
  },
};
