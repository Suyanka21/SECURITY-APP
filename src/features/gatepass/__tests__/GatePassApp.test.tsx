import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatePassApp } from "../GatePassApp";
import type { GatePassApi } from "@/lib/api/gatepass";
import type { guardApprovalApi } from "@/lib/api/approvals";
import type { guardNotificationsApi } from "@/lib/api/notifications";
import type { NotificationView } from "@/lib/api/types";

function buildApi(overrides: Partial<GatePassApi> = {}): GatePassApi {
  const stub = vi.fn(async () => ({
    ok: false as const,
    status: 0,
    error: {
      code: "NETWORK_ERROR",
      message: "no api configured",
    },
  }));
  return {
    submitEntry: stub,
    validateQr: stub,
    syncEntries: stub,
    searchVisitors: stub,
    ...overrides,
  } as unknown as GatePassApi;
}

describe("GatePass UI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the guard entry screen as the default home", () => {
    render(<GatePassApp controller={{ api: buildApi() }} />);
    expect(screen.getByRole("heading", { name: "GatePass" })).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /Scan QR/i }).length
    ).toBeGreaterThan(0);
  });

  it("blocks an empty walk-in submission with the backend's validation contract", async () => {
    render(<GatePassApp controller={{ api: buildApi() }} />);
    fireEvent.click(screen.getAllByRole("button", { name: /Walk-in/i })[0]);
    fireEvent.click(screen.getByRole("button", { name: /Log entry/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        /VISITOR_NAME_REQUIRED|Visitor name is required/i
      );
    });
  });

  it("surfaces camera failure and provides fallback actions", () => {
    render(<GatePassApp controller={{ api: buildApi() }} />);
    fireEvent.click(screen.getAllByRole("button", { name: /Scan QR/i })[0]);
    fireEvent.click(screen.getByRole("button", { name: /Camera failed/i }));
    expect(screen.getByRole("alert")).toHaveTextContent("Camera failed");
    expect(
      screen.getByRole("button", { name: /Use walk-in/i })
    ).toBeInTheDocument();
  });

  it("surfaces a 500 from POST /entries as an explicit error, not a silent success", async () => {
    const api = buildApi({
      submitEntry: vi.fn(async () => ({
        ok: false as const,
        status: 500,
        error: {
          code: "INTERNAL_ERROR",
          message: "An unexpected error occurred",
          traceId: "trace-xyz",
        },
      })),
    });

    render(<GatePassApp controller={{ api }} />);
    fireEvent.click(screen.getAllByRole("button", { name: /Walk-in/i })[0]);
    fireEvent.change(
      screen.getByRole("textbox", { name: /Visitor name/i }),
      { target: { value: "Ada Lovelace" } }
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: /Resident \/ host/i }),
      { target: { value: "Bola" } }
    );
    fireEvent.change(screen.getByRole("textbox", { name: /^Unit$/i }), {
      target: { value: "4A" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Log entry/i }));

    await waitFor(() => {
      expect(api.submitEntry).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/INTERNAL_ERROR/i);
    });
  });

  // ─── Resident approval flow (Feature 1) ────────────────────────────
  // Source: src/docs/specs/resident-approval-flow.md §10

  function makeApprovalApi(): typeof guardApprovalApi {
    return {
      createApproval: vi.fn(async () => ({
        ok: true as const,
        status: 201,
        data: {
          approvalId: "11111111-1111-4111-8111-111111111111",
          magicLinkUrl:
            "http://localhost:5173/approve/11111111-1111-4111-8111-111111111111?token=" +
            "a".repeat(64),
          // 5 minutes ahead of a fixed "now" anchored in the controller.
          expiresAt: new Date("2024-01-01T00:05:00Z").toISOString(),
          traceId: "trace-create",
        },
      })),
      getApprovalStatus: vi.fn(async () => ({
        ok: true as const,
        status: 200,
        data: {
          approval: {
            id: "11111111-1111-4111-8111-111111111111",
            offlineId: "00000000-0000-4000-8000-000000000001",
            visitorName: "Ada Lovelace",
            host: "Bola",
            unit: "4A",
            plate: null,
            reason: "",
            method: "walk-in" as const,
            requestedByGuardId: "guard-west-04",
            status: "pending" as const,
            expiresAt: new Date("2024-01-01T00:05:00Z").toISOString(),
            decidedAt: null,
            deniedReason: null,
            entryId: null,
            traceId: "trace-status",
          },
          traceId: "trace-status",
        },
      })),
    } as unknown as typeof guardApprovalApi;
  }

  async function fillWalkInDraft() {
    fireEvent.click(screen.getAllByRole("button", { name: /Walk-in/i })[0]);
    fireEvent.change(
      screen.getByRole("textbox", { name: /Visitor name/i }),
      { target: { value: "Ada Lovelace" } }
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: /Resident \/ host/i }),
      { target: { value: "Bola" } }
    );
    fireEvent.change(screen.getByRole("textbox", { name: /^Unit$/i }), {
      target: { value: "4A" },
    });
  }

  it("renders the 'Request resident approval' button only on the walk-in form", () => {
    render(<GatePassApp controller={{ api: buildApi() }} />);
    fireEvent.click(screen.getAllByRole("button", { name: /Walk-in/i })[0]);
    expect(
      screen.getByRole("button", { name: /Request resident approval/i })
    ).toBeInTheDocument();
  });

  it("does NOT render the 'Request resident approval' button on the override form", () => {
    render(<GatePassApp controller={{ api: buildApi() }} />);
    // Override panel is on the top nav.
    fireEvent.click(
      screen.getAllByRole("button", { name: /^override$/i })[0]
    );
    expect(
      screen.queryByRole("button", { name: /Request resident approval/i })
    ).not.toBeInTheDocument();
  });

  it("disables the approval button while offline and explains why via title", () => {
    render(<GatePassApp controller={{ api: buildApi() }} />);
    fireEvent.click(
      screen.getByRole("button", { name: /Simulate offline/i })
    );
    fireEvent.click(screen.getAllByRole("button", { name: /Walk-in/i })[0]);
    const btn = screen.getByRole("button", {
      name: /Request resident approval/i,
    });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute(
      "title",
      expect.stringContaining("Resident approval requires a live connection")
    );
  });

  it("on click → POST /approvals → shows the awaiting-approval panel with the magic link and countdown", async () => {
    const approvalApi = makeApprovalApi();
    render(
      <GatePassApp
        controller={{
          api: buildApi(),
          approvalApi,
          now: () => new Date("2024-01-01T00:00:00Z"),
          // Long poll interval so the test never lands on a 2nd
          // status call that could race the assertion.
          approvalPollIntervalMs: 60_000,
        }}
      />
    );
    await fillWalkInDraft();

    fireEvent.click(
      screen.getByRole("button", { name: /Request resident approval/i })
    );

    await waitFor(() => {
      expect(approvalApi.createApproval).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(
        screen.getByText(/Awaiting resident approval/i)
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId("approval-magic-link")).toHaveTextContent(
      "/approve/11111111-1111-4111-8111-111111111111?token="
    );
    expect(screen.getByTestId("approval-countdown")).toBeInTheDocument();
  });

  it("'Cancel approval' returns the guard to the home flow", async () => {
    const approvalApi = makeApprovalApi();
    render(
      <GatePassApp
        controller={{
          api: buildApi(),
          approvalApi,
          now: () => new Date("2024-01-01T00:00:00Z"),
          approvalPollIntervalMs: 60_000,
        }}
      />
    );
    await fillWalkInDraft();
    fireEvent.click(
      screen.getByRole("button", { name: /Request resident approval/i })
    );

    await waitFor(() => {
      expect(
        screen.getByText(/Awaiting resident approval/i)
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Cancel approval/i }));

    // Returns to the guard home (the default RESET_FLOW destination).
    expect(
      screen.queryByText(/Awaiting resident approval/i)
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "GatePass" })
    ).toBeInTheDocument();
  });

  // ─── Notifications surface (Feature 2 slice 7) ─────────────────────
  // Source: src/docs/specs/notifications.md §5 (PII masking), §7
  // (HTTP surface), §10 (UI contract).

  function notificationView(
    overrides: Partial<NotificationView> = {},
  ): NotificationView {
    return {
      id: "nnnn-1",
      approvalId: "11111111-1111-4111-8111-111111111111",
      channel: "whatsapp",
      status: "queued",
      attempts: 0,
      targetPhone: "+15551230001",
      templateKey: "approval.magic_link",
      lastErrorCode: null,
      lastProviderResponseCode: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      deliveredAt: null,
      failedAt: null,
      ...overrides,
    };
  }

  function makeNotificationsApi(
    rows: NotificationView[] = [],
  ): typeof guardNotificationsApi {
    return {
      getNotifications: vi.fn(async () => ({
        ok: true as const,
        status: 200,
        data: { notifications: rows, traceId: "trace-n" },
      })),
      retryNotification: vi.fn(async (id: string) => ({
        ok: true as const,
        status: 202,
        data: {
          notification: notificationView({
            id,
            attempts: 2,
            status: "queued" as const,
          }),
          traceId: "trace-retry",
        },
      })),
    } as unknown as typeof guardNotificationsApi;
  }

  it("renders the host-phone field only on the walk-in panel", () => {
    render(<GatePassApp controller={{ api: buildApi() }} />);
    fireEvent.click(screen.getAllByRole("button", { name: /Walk-in/i })[0]);
    expect(screen.getByTestId("host-phone-input")).toBeInTheDocument();
    // Override panel should NOT have it.
    fireEvent.click(
      screen.getAllByRole("button", { name: /^override$/i })[0],
    );
    expect(screen.queryByTestId("host-phone-input")).not.toBeInTheDocument();
  });

  it("forwards the typed phone number to createApproval as hostPhoneE164", async () => {
    const approvalApi = makeApprovalApi();
    render(
      <GatePassApp
        controller={{
          api: buildApi(),
          approvalApi,
          notificationsApi: makeNotificationsApi(),
          now: () => new Date("2024-01-01T00:00:00Z"),
          approvalPollIntervalMs: 60_000,
          notificationsPollIntervalMs: 60_000,
        }}
      />,
    );
    await fillWalkInDraft();
    fireEvent.change(screen.getByTestId("host-phone-input"), {
      target: { value: "+15551230001" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Request resident approval/i }),
    );
    await waitFor(() => {
      expect(approvalApi.createApproval).toHaveBeenCalledTimes(1);
    });
    const payload = (approvalApi.createApproval as ReturnType<typeof vi.fn>)
      .mock.calls[0][0];
    expect(payload.hostPhoneE164).toBe("+15551230001");
  });

  it("rejects a non-E.164 phone with HOST_PHONE_INVALID and never calls createApproval", async () => {
    const approvalApi = makeApprovalApi();
    render(
      <GatePassApp
        controller={{
          api: buildApi(),
          approvalApi,
          notificationsApi: makeNotificationsApi(),
          now: () => new Date("2024-01-01T00:00:00Z"),
          approvalPollIntervalMs: 60_000,
          notificationsPollIntervalMs: 60_000,
        }}
      />,
    );
    await fillWalkInDraft();
    fireEvent.change(screen.getByTestId("host-phone-input"), {
      target: { value: "555-123-0001" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Request resident approval/i }),
    );
    await waitFor(() => {
      // The reducer flips to error mode on a client-side validation
      // failure (same contract as VISITOR_NAME_REQUIRED in Feature 1 —
      // no silent success, the guard sees the failure explicitly).
      expect(screen.getByRole("alert")).toHaveTextContent(
        /HOST_PHONE_INVALID/,
      );
    });
    expect(approvalApi.createApproval).not.toHaveBeenCalled();
  });

  it("renders the delivery-status block with a masked phone once notifications land", async () => {
    const approvalApi = makeApprovalApi();
    const notificationsApi = makeNotificationsApi([
      notificationView({ id: "n-1", status: "queued" }),
    ]);
    render(
      <GatePassApp
        controller={{
          api: buildApi(),
          approvalApi,
          notificationsApi,
          now: () => new Date("2024-01-01T00:00:00Z"),
          approvalPollIntervalMs: 60_000,
          notificationsPollIntervalMs: 10,
        }}
      />,
    );
    await fillWalkInDraft();
    fireEvent.change(screen.getByTestId("host-phone-input"), {
      target: { value: "+15551230001" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Request resident approval/i }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("delivery-status-block")).toBeInTheDocument();
    });
    expect(screen.getByTestId("delivery-row-n-1")).toHaveTextContent(
      /whatsapp/i,
    );
    // PII discipline: full phone is NEVER on screen, only the masked form.
    expect(screen.getByTestId("delivery-row-n-1")).not.toHaveTextContent(
      "+15551230001",
    );
    expect(screen.getByTestId("delivery-row-n-1")).toHaveTextContent(
      /••••/,
    );
  });

  it("Resend button only appears for failed rows and calls retryNotification", async () => {
    const approvalApi = makeApprovalApi();
    const notificationsApi = makeNotificationsApi([
      notificationView({
        id: "n-1",
        status: "failed",
        attempts: 1,
        lastErrorCode: "PROVIDER_5XX",
      }),
    ]);
    render(
      <GatePassApp
        controller={{
          api: buildApi(),
          approvalApi,
          notificationsApi,
          now: () => new Date("2024-01-01T00:00:00Z"),
          approvalPollIntervalMs: 60_000,
          notificationsPollIntervalMs: 10,
        }}
      />,
    );
    await fillWalkInDraft();
    fireEvent.change(screen.getByTestId("host-phone-input"), {
      target: { value: "+15551230001" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Request resident approval/i }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("delivery-retry-n-1")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("delivery-retry-n-1"));
    await waitFor(() => {
      expect(notificationsApi.retryNotification).toHaveBeenCalledWith("n-1");
    });
  });

  it("disables Resend during the 30s cooldown after a successful retry (slice 8)", async () => {
    // Inject a clock pinned to real wall-clock now so the controller's
    // cooldown stamp (now + 30s) lands in the AwaitingApprovalPanel's
    // future. The panel ticks its own clock off real Date.now(), so
    // anchoring the controller to the same wall-clock is what makes
    // the countdown visible.
    const wallNow = new Date();
    const approvalApi = makeApprovalApi();
    // Server returns a STILL-FAILED row from the retry so we can verify
    // the cooldown is the gate (not the row status). This isolates the
    // spec §6 contract: even when the next status is failed, the user
    // cannot mash Resend a second time inside 30s.
    const failedRetryRow = {
      id: "n-1",
      attempts: 2,
      status: "failed" as const,
      lastErrorCode: "PROVIDER_5XX" as const,
      approvalId: "11111111-1111-4111-8111-111111111111",
      channel: "whatsapp" as const,
      targetPhone: "+15559990001",
      attemptsMax: 3,
      providerMessageId: null,
      providerErrorRaw: null,
      lastErrorAt: "2024-01-01T00:00:00.000Z",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      enqueuedAt: "2024-01-01T00:00:00.000Z",
      attemptedAt: "2024-01-01T00:00:00.000Z",
      deliveredAt: null,
      failedAt: "2024-01-01T00:00:00.000Z",
    };
    const initialRow = { ...failedRetryRow, attempts: 1 };
    const notificationsApi = {
      getNotifications: vi.fn(async () => ({
        ok: true as const,
        status: 200,
        data: { notifications: [initialRow], traceId: "trace-n" },
      })),
      retryNotification: vi.fn(async () => ({
        ok: true as const,
        status: 202,
        data: { notification: failedRetryRow, traceId: "trace-retry" },
      })),
    } as unknown as typeof guardNotificationsApi;
    render(
      <GatePassApp
        controller={{
          api: buildApi(),
          approvalApi,
          notificationsApi,
          now: () => new Date(wallNow.getTime()),
          approvalPollIntervalMs: 60_000,
          notificationsPollIntervalMs: 60_000,
        }}
      />,
    );
    await fillWalkInDraft();
    fireEvent.change(screen.getByTestId("host-phone-input"), {
      target: { value: "+15551230001" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Request resident approval/i }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("delivery-retry-n-1")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("delivery-retry-n-1"));
    await waitFor(() => {
      expect(notificationsApi.retryNotification).toHaveBeenCalledTimes(1);
    });
    // Spec §6: after a successful retry, the Resend button vanishes and
    // a cooldown counter takes its place. Controller clock + 30s lands
    // ~30s ahead of the panel's wall-clock tick, so the UI shows
    // "Resend in 30s" (allow 29-30s for the 1s setInterval drift).
    await waitFor(() => {
      expect(screen.getByTestId("delivery-cooldown-n-1")).toBeInTheDocument();
    });
    expect(screen.getByTestId("delivery-cooldown-n-1")).toHaveTextContent(
      /Resend in (29|30)s/,
    );
    // The Resend button is gone — a second click cannot fire.
    expect(screen.queryByTestId("delivery-retry-n-1")).not.toBeInTheDocument();
  });

  it("accepts a human-formatted phone (slice 8 sanitization) and forwards the canonical E.164", async () => {
    const approvalApi = makeApprovalApi();
    render(
      <GatePassApp
        controller={{
          api: buildApi(),
          approvalApi,
          notificationsApi: makeNotificationsApi(),
          now: () => new Date("2024-01-01T00:00:00Z"),
          approvalPollIntervalMs: 60_000,
          notificationsPollIntervalMs: 60_000,
        }}
      />,
    );
    await fillWalkInDraft();
    fireEvent.change(screen.getByTestId("host-phone-input"), {
      target: { value: "+1 (555) 123-0001" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Request resident approval/i }),
    );
    await waitFor(() => {
      expect(approvalApi.createApproval).toHaveBeenCalledTimes(1);
    });
    const payload = (approvalApi.createApproval as ReturnType<typeof vi.fn>)
      .mock.calls[0][0];
    // Server never sees the formatted form — sanitizer normalizes to
    // E.164 client-side (spec §7.1 + slice 8).
    expect(payload.hostPhoneE164).toBe("+15551230001");
  });

  it("surfaces a notifications list failure WITHOUT collapsing the approval panel (two-stream isolation)", async () => {
    const approvalApi = makeApprovalApi();
    const notificationsApi = {
      getNotifications: vi.fn(async () => ({
        ok: false as const,
        status: 500,
        error: { code: "INTERNAL_ERROR", message: "Database unavailable" },
      })),
      retryNotification: vi.fn(),
    } as unknown as typeof guardNotificationsApi;
    render(
      <GatePassApp
        controller={{
          api: buildApi(),
          approvalApi,
          notificationsApi,
          now: () => new Date("2024-01-01T00:00:00Z"),
          approvalPollIntervalMs: 60_000,
          notificationsPollIntervalMs: 10,
        }}
      />,
    );
    await fillWalkInDraft();
    fireEvent.change(screen.getByTestId("host-phone-input"), {
      target: { value: "+15551230001" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Request resident approval/i }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("delivery-list-error")).toHaveTextContent(
        /INTERNAL_ERROR/,
      );
    });
    // The approval panel itself is still up — magic link still visible,
    // countdown still ticking. A notifications transport failure must
    // never collapse the approval surface (spec §5).
    expect(screen.getByTestId("approval-magic-link")).toBeInTheDocument();
    expect(screen.getByTestId("approval-countdown")).toBeInTheDocument();
  });
});
