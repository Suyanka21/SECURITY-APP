/**
 * VisitorPass — public pass-page tests.
 *
 * Source: src/docs/specs/guest-qr-ticket.md §7 (UI), §A6/A8 (security).
 *
 * The page renders /pass/:token. The token in the URL IS the
 * credential — no other auth. The page calls previewInvitation ONCE
 * on mount and renders one of three terminal states:
 *
 *   loading  → spinner
 *   loaded   → QR + visitor name + host + unit + expiresAt + single-use note
 *   error    → explicit code panel; QR MUST NOT be rendered on error
 *
 * Default-deny is the linchpin contract: any non-OK preview response
 * lands in the error panel. The QR <svg> is only mounted under the
 * "loaded" branch.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import VisitorPass from "../VisitorPass";
import type { visitorInvitationsApi } from "@/lib/api/visitor-invitations";
import type {
  PreviewVisitorInvitationResponse,
  VisitorInvitationPreviewView,
} from "@/lib/api/types";

const TOKEN = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefg";

const PREVIEW: VisitorInvitationPreviewView = {
  visitorName: "Maya Chen",
  host: "A. Okafor",
  unit: "18B",
  plate: "LND-482",
  expiresAt: "2024-02-02T00:00:00.000Z",
};

function makeApi(
  previewResolved:
    | { ok: true; status: number; data: PreviewVisitorInvitationResponse }
    | { ok: false; status: number; error: { code: string; message: string; traceId?: string } },
): typeof visitorInvitationsApi {
  return {
    previewInvitation: vi.fn(async () => previewResolved),
    issueInvitation: vi.fn(),
  } as unknown as typeof visitorInvitationsApi;
}

function renderAt(api: typeof visitorInvitationsApi, token = TOKEN) {
  return render(
    <MemoryRouter initialEntries={[`/pass/${token}`]}>
      <Routes>
        <Route path="/pass/:token" element={<VisitorPass api={api} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("VisitorPass (Feature 6)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the QR + visitor details when preview returns 200", async () => {
    const api = makeApi({
      ok: true,
      status: 200,
      data: { invitation: PREVIEW },
    });
    renderAt(api);

    await waitFor(() => {
      expect(screen.getByTestId("visitor-pass-loaded")).toBeInTheDocument();
    });
    expect(api.previewInvitation).toHaveBeenCalledTimes(1);
    expect(api.previewInvitation).toHaveBeenCalledWith(TOKEN);

    // QR PNG rendered client-side from the URL token — verified by <svg>.
    const qrWrapper = screen.getByTestId("visitor-pass-qr");
    expect(qrWrapper.querySelector("svg")).not.toBeNull();

    expect(screen.getByTestId("visitor-pass-host")).toHaveTextContent(
      "A. Okafor",
    );
    expect(screen.getByTestId("visitor-pass-unit")).toHaveTextContent("18B");
    expect(screen.getByTestId("visitor-pass-plate")).toHaveTextContent(
      "LND-482",
    );
    expect(screen.getByTestId("visitor-pass-single-use-note")).toBeInTheDocument();
  });

  it("default-denies a 410 QR_EXPIRED: shows the explicit error panel and NO QR", async () => {
    const api = makeApi({
      ok: false,
      status: 410,
      error: { code: "QR_EXPIRED", message: "Pass has expired.", traceId: "trace-exp" },
    });
    renderAt(api);

    await waitFor(() => {
      expect(screen.getByTestId("visitor-pass-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("visitor-pass-error-title")).toHaveTextContent(
      "Pass expired",
    );
    expect(screen.getByTestId("visitor-pass-error-code")).toHaveTextContent(
      "QR_EXPIRED",
    );
    // Critical default-deny: the QR <svg> must not be rendered on error.
    expect(screen.queryByTestId("visitor-pass-qr")).toBeNull();
    expect(screen.queryByTestId("visitor-pass-loaded")).toBeNull();
  });

  it("default-denies a 410 QR_CONSUMED: shows the 'already used' panel", async () => {
    const api = makeApi({
      ok: false,
      status: 410,
      error: {
        code: "QR_CONSUMED",
        message: "Pass has already been used.",
      },
    });
    renderAt(api);

    await waitFor(() => {
      expect(screen.getByTestId("visitor-pass-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("visitor-pass-error-title")).toHaveTextContent(
      "Pass already used",
    );
    expect(screen.queryByTestId("visitor-pass-qr")).toBeNull();
  });

  it("default-denies a 404 QR_NOT_FOUND: shows the 'not found' panel", async () => {
    const api = makeApi({
      ok: false,
      status: 404,
      error: { code: "QR_NOT_FOUND", message: "No such pass." },
    });
    renderAt(api);

    await waitFor(() => {
      expect(screen.getByTestId("visitor-pass-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("visitor-pass-error-title")).toHaveTextContent(
      "Pass not found",
    );
    expect(screen.queryByTestId("visitor-pass-qr")).toBeNull();
  });

  it("default-denies a generic 5xx: shows the 'could not load' panel + exact code", async () => {
    const api = makeApi({
      ok: false,
      status: 500,
      error: { code: "INTERNAL_ERROR", message: "Server error." },
    });
    renderAt(api);

    await waitFor(() => {
      expect(screen.getByTestId("visitor-pass-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("visitor-pass-error-title")).toHaveTextContent(
      "Could not load pass",
    );
    expect(screen.getByTestId("visitor-pass-error-code")).toHaveTextContent(
      "INTERNAL_ERROR",
    );
    expect(screen.queryByTestId("visitor-pass-qr")).toBeNull();
  });
});
