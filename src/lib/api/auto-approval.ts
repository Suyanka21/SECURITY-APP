/**
 * GatePass — auto-approval rules API client (admin dashboard, read-only use).
 *
 * Source: src/server/routes/auto-approval.ts — GET /api/auto-approval-rules is
 *         gated to requireRole(admin, senior-guard). The admin dashboard only
 *         READS rules; create/deactivate stay out of scope here.
 */

import { apiClient } from "./client";
import type { ApiResult } from "./types";

export interface AutoApprovalRuleView {
  id: string;
  visitorName: string;
  host: string;
  unit: string;
  plateRequired: string | null;
  active: boolean;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  lastMatchedAt: string | null;
  matchCount: number;
}

export interface ListAutoApprovalRulesResponse {
  rules: AutoApprovalRuleView[];
  traceId: string;
}

export const autoApprovalApi = {
  /** GET /api/auto-approval-rules (admin / senior-guard only). */
  listRules(
    signal?: AbortSignal,
  ): Promise<ApiResult<ListAutoApprovalRulesResponse>> {
    return apiClient.get<ListAutoApprovalRulesResponse>(
      "/api/auto-approval-rules",
      { signal },
    );
  },
};
