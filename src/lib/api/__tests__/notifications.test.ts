/**
 * GatePass — Notifications API client tests.
 *
 * Source: src/docs/specs/notifications.md §7
 * Source: src/lib/api/__tests__/approvals.test.ts (fetch-mock pattern)
 *
 * Each test stubs global fetch and asserts:
 *   - The correct URL + method are issued.
 *   - The Authorization header is attached (guard endpoints).
 *   - The discriminated ApiResult is shaped correctly on success and on
 *     each contract-defined failure (PII rule: no rendered_body /
 *     idempotency_key in the response shape).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guardNotificationsApi } from "../notifications";
import { setAuthTokenGetter } from "../auth";
import type { NotificationView } from "../types";

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const APPROVAL_ID = "11111111-1111-4111-8111-111111111111";
const NOTIF_ID = "22222222-2222-4222-8222-222222222222";

function makeRow(over: Partial<NotificationView> = {}): NotificationView {
  return {
    id: NOTIF_ID,
    approvalId: APPROVAL_ID,
    channel: "whatsapp",
    status: "queued",
    attempts: 0,
    targetPhone: "+15551230001",
    templateKey: "approval.magic_link",
    lastErrorCode: null,
    lastProviderResponseCode: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deliveredAt: null,
    failedAt: null,
    ...over,
  };
}

let fetchMock: FetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  setAuthTokenGetter(() => "jwt-test-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  setAuthTokenGetter(null);
});

// ─── guardNotificationsApi.getNotifications ─────────────────────────

describe("guardNotificationsApi.getNotifications", () => {
  it("GETs /api/notifications?approvalId=:id with Authorization header", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        notifications: [makeRow({ status: "delivered" })],
        traceId: "trace-1",
      }),
    );

    const result = await guardNotificationsApi.getNotifications(APPROVAL_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.status).toBe(200);
    expect(result.data.notifications).toHaveLength(1);
    expect(result.data.notifications[0].status).toBe("delivered");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/notifications\?approvalId=/);
    expect(String(url)).toContain(APPROVAL_ID);
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer jwt-test-token",
    );
  });

  it("returns ok with an empty list when the approval has no phone (legacy flow)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { notifications: [], traceId: "trace-2" }),
    );

    const result = await guardNotificationsApi.getNotifications(APPROVAL_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.notifications).toEqual([]);
  });

  it("surfaces 403 NOTIFICATION_GUARD_MISMATCH as ok=false", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, {
        error: {
          code: "NOTIFICATION_GUARD_MISMATCH",
          message: "not owner",
          traceId: "trace-3",
        },
      }),
    );

    const result = await guardNotificationsApi.getNotifications(APPROVAL_ID);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.status).toBe(403);
    expect(result.error.code).toBe("NOTIFICATION_GUARD_MISMATCH");
  });

  it("surfaces 500 INTERNAL_ERROR so the controller can show a banner", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(500, {
        error: {
          code: "INTERNAL_ERROR",
          message: "boom",
          traceId: "trace-4",
        },
      }),
    );

    const result = await guardNotificationsApi.getNotifications(APPROVAL_ID);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.status).toBe(500);
    expect(result.error.code).toBe("INTERNAL_ERROR");
  });
});

// ─── guardNotificationsApi.retryNotification ────────────────────────

describe("guardNotificationsApi.retryNotification", () => {
  it("POSTs /api/notifications/:id/retry with an empty body and returns the requeued view", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(202, {
        notification: makeRow({ status: "queued", attempts: 1 }),
        traceId: "trace-5",
      }),
    );

    const result = await guardNotificationsApi.retryNotification(NOTIF_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.status).toBe(202);
    expect(result.data.notification.status).toBe("queued");
    expect(result.data.notification.attempts).toBe(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/notifications\/.+\/retry$/);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer jwt-test-token",
    );
    // Body is an empty object — retry takes nothing user-controllable.
    expect(init?.body).toBe("{}");
  });

  it("URL-encodes the notification id", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(202, { notification: makeRow(), traceId: "trace-x" }),
    );
    await guardNotificationsApi.retryNotification("foo bar");
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/foo%20bar/);
  });

  it("surfaces 429 RETRY_RATE_LIMITED as ok=false", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(429, {
        error: {
          code: "RETRY_RATE_LIMITED",
          message: "too soon",
          traceId: "trace-6",
        },
      }),
    );

    const result = await guardNotificationsApi.retryNotification(NOTIF_ID);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.status).toBe(429);
    expect(result.error.code).toBe("RETRY_RATE_LIMITED");
  });

  it("surfaces 409 NOTIFICATION_NOT_RETRYABLE so the UI can show current status", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: {
          code: "NOTIFICATION_NOT_RETRYABLE",
          message: "already delivered",
          traceId: "trace-7",
        },
      }),
    );

    const result = await guardNotificationsApi.retryNotification(NOTIF_ID);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("NOTIFICATION_NOT_RETRYABLE");
  });

  it("surfaces 410 APPROVAL_TERMINAL when the approval itself is closed", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(410, {
        error: {
          code: "APPROVAL_TERMINAL",
          message: "approval closed",
          traceId: "trace-8",
        },
      }),
    );

    const result = await guardNotificationsApi.retryNotification(NOTIF_ID);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("APPROVAL_TERMINAL");
  });
});
