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
 *   error    → plain-language panel (code + backend text never shown);
 *              QR MUST NOT be rendered on error
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
    expect(screen.queryByTestId("visitor-pass-error-code")).toBeNull();
    expect(screen.queryByText(/QR_EXPIRED/)).toBeNull();
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

  it("default-denies a 423 INVITATION_LOCKED: says 'Locked', never 'Valid until'", async () => {
    const api = makeApi({
      ok: false,
      status: 423,
      error: {
        code: "INVITATION_LOCKED",
        message: "This pass is locked after too many incorrect PIN attempts",
      },
    });
    renderAt(api);

    await waitFor(() => {
      expect(screen.getByTestId("visitor-pass-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("visitor-pass-error-title")).toHaveTextContent(
      "Locked",
    );
    expect(screen.queryByText(/INVITATION_LOCKED/)).toBeNull();
    expect(screen.getByTestId("visitor-pass-error-body")).toHaveTextContent(
      /locked after too many incorrect PIN attempts/i,
    );
    // The visitor must never see a locked pass presented as valid.
    expect(screen.queryByText(/valid until/i)).toBeNull();
    expect(screen.queryByTestId("visitor-pass-expires")).toBeNull();
    expect(screen.queryByTestId("visitor-pass-qr")).toBeNull();
  });

  it("also maps the legacy QR_LOCKED spelling to the Locked panel", async () => {
    const api = makeApi({
      ok: false,
      status: 423,
      error: { code: "QR_LOCKED", message: "This pass is locked" },
    });
    renderAt(api);

    await waitFor(() => {
      expect(screen.getByTestId("visitor-pass-error-title")).toHaveTextContent(
        "Locked",
      );
    });
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

  it("default-denies a generic 5xx: shows the 'could not load' panel, no code, no backend text", async () => {
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
      "Couldn't load your pass",
    );
    expect(screen.queryByText(/INTERNAL_ERROR/)).toBeNull();
    expect(screen.queryByText(/Server error\./)).toBeNull();
    expect(screen.queryByTestId("visitor-pass-qr")).toBeNull();
  });
  it("network failure (status 0): plain 'couldn't load' with a retry that re-calls preview", async () => {
    const api = makeApi({
      ok: false,
      status: 0,
      error: { code: "NETWORK_ERROR", message: "fetch failed: ECONNREFUSED" },
    });
    renderAt(api);

    await waitFor(() => {
      expect(screen.getByTestId("visitor-pass-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("visitor-pass-error-title")).toHaveTextContent(
      "Couldn't load your pass",
    );
    expect(screen.getByText(/check your connection/i)).toBeInTheDocument();
    expect(screen.queryByText(/NETWORK_ERROR/)).toBeNull();
    expect(screen.queryByText(/ECONNREFUSED/)).toBeNull();
    expect(screen.queryByTestId("visitor-pass-qr")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => {
      expect(api.previewInvitation).toHaveBeenCalledTimes(2);
    });
  });

  it("terminal states (locked/expired/used/not found) offer no retry — only 'ask your host'", async () => {
    const api = makeApi({
      ok: false,
      status: 410,
      error: { code: "INVITATION_EXPIRED", message: "expired" },
    });
    renderAt(api);
    await waitFor(() => {
      expect(screen.getByTestId("visitor-pass-error")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
    expect(screen.getByText(/ask your host to issue a new pass/i)).toBeInTheDocument();
  });

  it("shows the traceId only as a labelled support reference, never the code", async () => {
    const api = makeApi({
      ok: false,
      status: 404,
      error: {
        code: "INVITATION_NOT_FOUND",
        message: "invitation row missing for token hash",
        traceId: "trace-abc-123",
      },
    });
    renderAt(api);
    await waitFor(() => {
      expect(screen.getByTestId("visitor-pass-error")).toBeInTheDocument();
    });
    expect(screen.getByText(/Support reference/)).toBeInTheDocument();
    expect(screen.getByText("trace-abc-123")).toBeInTheDocument();
    expect(screen.queryByText(/INVITATION_NOT_FOUND/)).toBeNull();
    expect(screen.queryByText(/token hash/)).toBeNull();
  });

  it("missing token in URL → 'Pass not found' panel with no fetch", async () => {
    const api = makeApi({ ok: false, status: 404, error: { code: "x", message: "y" } });
    render(
      <MemoryRouter initialEntries={["/pass/"]}>
        <Routes>
          <Route path="/pass/:token?" element={<VisitorPass api={api} />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("visitor-pass-error-title")).toHaveTextContent("Pass not found");
    });
    expect(api.previewInvitation).not.toHaveBeenCalled();
  });
});
