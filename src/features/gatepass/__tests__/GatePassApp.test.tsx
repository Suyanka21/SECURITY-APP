import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatePassApp } from "../GatePassApp";
import type { GatePassApi } from "@/lib/api/gatepass";
import type { guardApprovalApi } from "@/lib/api/approvals";

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
});
