/**
 * GatePass — auto-approval rules API client (admin dashboard, read-only use).
 *
 * Source: src/server/routes/auto-approval.ts — GET /api/auto-approval-rules is
 *         gated to requireRole(admin, senior-guard); deactivate and
 *         clear-block are admin only. Both take a reason: the server refuses
 *         to switch off a resident's rule (REASON_REQUIRED) or clear a block
 *         without one.
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
  /** POST /api/auto-approval-rules/:id/deactivate (admin only). */
  deactivateRule(
    ruleId: string,
    reason: string,
  ): Promise<ApiResult<{ rule: AutoApprovalRuleView; traceId: string }>> {
    return apiClient.post(`/api/auto-approval-rules/${encodeURIComponent(ruleId)}/deactivate`, { reason });
  },
  /** POST /api/auto-approval-rules/:id/clear-block (admin only). */
  clearBlock(
    ruleId: string,
    reason: string,
  ): Promise<ApiResult<{ block: { ruleId: string; registrationId: string; blockClearedAt: string }; traceId: string }>> {
    return apiClient.post(`/api/auto-approval-rules/${encodeURIComponent(ruleId)}/clear-block`, { reason });
  },
};
