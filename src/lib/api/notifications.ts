/**
 * GatePass — Notifications API client.
 *
 * Source: src/docs/specs/notifications.md §7
 * Source: src/lib/api/approvals.ts (pattern: typed `ApiResult<T>` per method)
 *
 * One surface — `guardNotificationsApi` — used by the guard's controller
 * to poll delivery status and (rarely) trigger a manual retry. Residents
 * never call these endpoints; they only see the approval page.
 *
 * `getNotifications(approvalId)` runs alongside the existing approval
 * polling loop in useGatePassController (slice 6). The two responses
 * dispatch INDEPENDENTLY so a transient notification failure can never
 * mask the approval's status (and vice-versa).
 */

import { apiClient } from "./client";
import type {
  ApiResult,
  NotificationsListResponse,
  NotificationRetryResponse,
} from "./types";

export const guardNotificationsApi = {
  /**
   * spec §7.2 — GET /api/notifications?approvalId=:id
   *
   * Polled every 2s by useGatePassController while a magic-link approval
   * is pending. The server applies a 30-second 'sending' stale sweep on
   * read, so the response is authoritative.
   *
   * Failure modes the caller must explicitly handle (no silent success):
   *   - 422 APPROVAL_ID_INVALID  → reducer NOTIFICATIONS_FAILED
   *   - 403 NOTIFICATION_GUARD_MISMATCH → reducer NOTIFICATIONS_FAILED
   *   - 404 NOTIFICATION_NOT_FOUND → treat as "no rows" (legacy hand-copy)
   *   - 500 INTERNAL_ERROR → reducer NOTIFICATIONS_FAILED
   *   - network error → reducer NOTIFICATIONS_FAILED (transient, retried
   *     by the polling loop)
   */
  getNotifications(
    approvalId: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<NotificationsListResponse>> {
    const qs = new URLSearchParams({ approvalId }).toString();
    return apiClient.get<NotificationsListResponse>(
      `/api/notifications?${qs}`,
      { signal },
    );
  },

  /**
   * spec §7.3 — POST /api/notifications/:id/retry
   *
   * Manual resend triggered by the guard's Resend button. The server
   * throttles to one retry per 30s per row and refuses to retry
   * already-delivered or permanently-failed rows.
   *
   * Failure modes the caller must explicitly handle:
   *   - 429 RETRY_RATE_LIMITED        → UI shows "Wait a moment"
   *   - 409 NOTIFICATION_NOT_RETRYABLE → UI shows current status
   *   - 410 APPROVAL_TERMINAL          → UI shows approval is closed
   *   - 403 NOTIFICATION_GUARD_MISMATCH → UI shows session expired
   *   - 422 VALIDATION_ERROR           → developer bug; should never
   *                                       happen if the id came from a
   *                                       previous list response.
   */
  retryNotification(
    notificationId: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<NotificationRetryResponse>> {
    return apiClient.post<NotificationRetryResponse>(
      `/api/notifications/${encodeURIComponent(notificationId)}/retry`,
      // The retry endpoint takes no body — anything that could differ
      // between attempts is pinned on the row (spec §7.3).
      {},
      { signal },
    );
  },
};

export type GuardNotificationsApi = typeof guardNotificationsApi;
