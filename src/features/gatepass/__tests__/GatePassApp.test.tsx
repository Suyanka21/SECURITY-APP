import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatePassApp } from "../GatePassApp";
import type { GatePassApi } from "@/lib/api/gatepass";

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
});
