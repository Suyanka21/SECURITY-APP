/**
 * ResidentApproval — magic-link page tests.
 * Source: src/docs/specs/resident-approval-flow.md §10, §11
 *
 * The page exists so a resident can approve or deny a walk-in without
 * installing the app. The token in the URL is the credential — the page
 * must never depend on a guard session. These tests verify each branch:
 *   - missing token   → no fetch, alert with recovery hint
 *   - preview uses the PUBLIC endpoint with the link token, never the
 *                       guard-only status route
 *   - already decided → outcome shown, no decide form
 *   - approve happy   → decideApproval called with token + decision
 *   - deny requires reason (form stays usable)
 *   - deny happy      → decideApproval called with reason
 *   - every failure   → plain language; raw codes / backend text never shown
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import ResidentApproval from "../ResidentApproval";
import { describeApprovalError } from "../resident-approval-errors";
import type { residentApprovalApi } from "@/lib/api/approvals";
import type {
  ApprovalRequestView,
  ApprovalStatusResponse,
  DecideApprovalResponse,
} from "@/lib/api/types";

const APPROVAL_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "b".repeat(64);

type ApiFailure = {
  ok: false;
  status: number;
  error: { code: string; message: string; traceId?: string };
};

function makeApproval(
  overrides: Partial<ApprovalRequestView> = {}
): ApprovalRequestView {
  return {
    id: APPROVAL_ID,
    offlineId: "00000000-0000-4000-8000-000000000001",
    visitorName: "Maya Angelou",
    host: "Ada",
    unit: "1A",
    plate: null,
    reason: "Late visit",
    method: "walk-in",
    requestedByGuardId: "guard-west-04",
    status: "pending",
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    decidedAt: null,
    deniedReason: null,
    entryId: null,
    traceId: "trace-status",
    ...overrides,
  };
}

function makeResidentApi({
  preview,
  decide,
}: {
  preview?: ApprovalStatusResponse | ApiFailure;
  decide?: { ok: true; data: DecideApprovalResponse } | ApiFailure;
} = {}): typeof residentApprovalApi {
  const previewResponse = preview ?? { approval: makeApproval(), traceId: "t" };
  return {
    previewApproval: vi.fn(async () =>
      "ok" in previewResponse && previewResponse.ok === false
        ? previewResponse
        : { ok: true as const, status: 200, data: previewResponse as ApprovalStatusResponse }
    ),
    decideApproval: vi.fn(async () => {
      if (!decide) throw new Error("decideApproval not expected in this test");
      return decide.ok
        ? { ok: true as const, status: 200, data: decide.data }
        : { ok: false as const, status: decide.status, error: decide.error };
    }),
  } as unknown as typeof residentApprovalApi;
}

function renderAt(
  path: string,
  props: Parameters<typeof ResidentApproval>[0] = {}
) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/approve/:id"
          element={<ResidentApproval {...props} />}
        />
        <Route path="/" element={<div>Home</div>} />
      </Routes>
    </MemoryRouter>
  );
}

/** A public page must never show these to a resident. */
function expectNoTechnicalLeak(...raw: string[]) {
  for (const s of raw) {
    expect(screen.queryByText(new RegExp(s))).not.toBeInTheDocument();
  }
}

describe("ResidentApproval page", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("missing token → renders 'Missing token' alert without fetching", () => {
    const residentApi = makeResidentApi();
    renderAt(`/approve/${APPROVAL_ID}`, { residentApi });
    expect(screen.getByText(/Missing token/i)).toBeInTheDocument();
    expect(residentApi.previewApproval).not.toHaveBeenCalled();
  });

  it("loads the request through the public preview endpoint using only the link token (no guard session)", async () => {
    const residentApi = makeResidentApi({
      preview: { approval: makeApproval({ reason: "Late delivery" }), traceId: "t" },
    });
    renderAt(`/approve/${APPROVAL_ID}?token=${TOKEN}`, { residentApi });
    await waitFor(() => {
      expect(screen.getByText(/Maya Angelou/)).toBeInTheDocument();
    });
    expect(residentApi.previewApproval).toHaveBeenCalledWith(APPROVAL_ID, {
      token: TOKEN,
    });
    expect(screen.getByText(/Late delivery/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approve/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Deny/i })).toBeEnabled();
  });

  it("approve happy path → calls decideApproval with token+decision and shows the success state", async () => {
    const residentApi = makeResidentApi({
      decide: {
        ok: true,
        data: {
          approval: makeApproval({
            status: "approved",
            decidedAt: new Date().toISOString(),
            entryId: "entry-new",
          }),
          entry: null,
          traceId: "t",
        },
      },
    });

    renderAt(`/approve/${APPROVAL_ID}?token=${TOKEN}`, { residentApi });
    await waitFor(() => {
      expect(screen.getByText(/Maya Angelou/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /Approve/i }));
    await waitFor(() => {
      expect(residentApi.decideApproval).toHaveBeenCalledTimes(1);
    });
    expect(residentApi.decideApproval).toHaveBeenCalledWith(APPROVAL_ID, {
      token: TOKEN,
      decision: "approve",
      reason: undefined,
    });
    await waitFor(() => {
      expect(screen.getByText(/^Approved$/)).toBeInTheDocument();
    });
  });

  it("deny without reason → plain-language inline hint, form stays usable, no API call", async () => {
    const residentApi = makeResidentApi({
      decide: {
        ok: true,
        data: {
          approval: makeApproval({ status: "denied", deniedReason: "Not today" }),
          entry: null,
          traceId: "t",
        },
      },
    });

    renderAt(`/approve/${APPROVAL_ID}?token=${TOKEN}`, { residentApi });
    await waitFor(() => {
      expect(screen.getByText(/Maya Angelou/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /Deny/i }));
    expect(
      screen.getByRole("alert")
    ).toHaveTextContent(/Please add a brief reason/i);
    expectNoTechnicalLeak("REASON_REQUIRED");
    expect(residentApi.decideApproval).not.toHaveBeenCalled();

    // The resident is not thrown out of the form: fixing the omission works.
    const box = screen.getByRole("textbox", { name: /please tell the guard why/i });
    expect(box).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(box, { target: { value: "Not today" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Deny/i }));
    await waitFor(() => {
      expect(residentApi.decideApproval).toHaveBeenCalledWith(APPROVAL_ID, {
        token: TOKEN,
        decision: "deny",
        reason: "Not today",
      });
    });
  });

  it("deny with reason → calls decideApproval and shows the denied outcome", async () => {
    const residentApi = makeResidentApi({
      decide: {
        ok: true,
        data: {
          approval: makeApproval({
            status: "denied",
            decidedAt: new Date().toISOString(),
            deniedReason: "Not expected today",
          }),
          entry: null,
          traceId: "t",
        },
      },
    });

    renderAt(`/approve/${APPROVAL_ID}?token=${TOKEN}`, { residentApi });
    await waitFor(() => {
      expect(screen.getByText(/Maya Angelou/)).toBeInTheDocument();
    });
    fireEvent.change(
      screen.getByRole("textbox", { name: /please tell the guard why/i }),
      { target: { value: "Not expected today" } }
    );
    fireEvent.click(screen.getByRole("button", { name: /Deny/i }));
    await waitFor(() => {
      expect(residentApi.decideApproval).toHaveBeenCalledWith(APPROVAL_ID, {
        token: TOKEN,
        decision: "deny",
        reason: "Not expected today",
      });
    });
    await waitFor(() => {
      expect(screen.getByText(/^Denied$/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Reason recorded: Not expected today/)).toBeInTheDocument();
  });

  it("already-decided link (preview returns approved) → skips the form and shows the outcome", async () => {
    const residentApi = makeResidentApi({
      preview: {
        approval: makeApproval({
          status: "approved",
          decidedAt: new Date().toISOString(),
          entryId: "entry-prev",
        }),
        traceId: "t",
      },
    });
    renderAt(`/approve/${APPROVAL_ID}?token=${TOKEN}`, { residentApi });
    await waitFor(() => {
      expect(screen.getByText(/^Approved$/)).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: /^Approve$/i })
    ).not.toBeInTheDocument();
  });

  it("expired link (preview returns expired) → shows the expired outcome, not the form", async () => {
    const residentApi = makeResidentApi({
      preview: { approval: makeApproval({ status: "expired" }), traceId: "t" },
    });
    renderAt(`/approve/${APPROVAL_ID}?token=${TOKEN}`, { residentApi });
    await waitFor(() => {
      expect(screen.getByText(/^Expired$/)).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /Approve/i })).not.toBeInTheDocument();
  });

  describe("preview failures are rendered in plain language, never as codes", () => {
    const cases: Array<{
      code: string;
      status: number;
      message: string;
      title: RegExp;
    }> = [
      {
        code: "APPROVAL_NOT_FOUND",
        status: 404,
        message: "Approval request not found",
        title: /Request not found/i,
      },
      {
        code: "APPROVAL_TOKEN_INVALID",
        status: 401,
        message: "Approval token is invalid",
        title: /This link isn't valid/i,
      },
      {
        code: "APPROVAL_ALREADY_DECIDED",
        status: 409,
        message: "Approval already approved",
        title: /Already handled/i,
      },
      {
        code: "APPROVAL_EXPIRED",
        status: 410,
        message: "Approval has expired",
        title: /Request expired/i,
      },
      {
        code: "RATE_LIMIT_EXCEEDED",
        status: 429,
        message: "Too many requests from this IP",
        title: /Too many attempts/i,
      },
      {
        code: "NETWORK_ERROR",
        status: 0,
        message: "fetch failed: ECONNREFUSED 127.0.0.1:3001",
        title: /Couldn't reach the gate/i,
      },
      {
        code: "INTERNAL_ERROR",
        status: 500,
        message: "relation approval_requests does not exist",
        title: /Something went wrong/i,
      },
      {
        code: "AUTH_TOKEN_MISSING",
        status: 401,
        message: "Provide Bearer token in Authorization header",
        title: /Something went wrong/i,
      },
    ];

    for (const c of cases) {
      it(`${c.code} → "${c.title.source}" with a support reference, no raw code or backend text`, async () => {
        const residentApi = makeResidentApi({
          preview: {
            ok: false,
            status: c.status,
            error: { code: c.code, message: c.message, traceId: `trace-${c.status}` },
          },
        });
        renderAt(`/approve/${APPROVAL_ID}?token=${TOKEN}`, { residentApi });
        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent(c.title);
        expect(alert).toHaveTextContent(/Support reference/);
        expect(alert).toHaveTextContent(`trace-${c.status}`);
        expectNoTechnicalLeak(c.code, c.message.slice(0, 20));
        expect(residentApi.decideApproval).not.toHaveBeenCalled();
        expect(screen.queryByRole("button", { name: /^Approve$/i })).not.toBeInTheDocument();
      });
    }
  });

  it("decide failure (link already used) → plain-language 'Already handled', no silent success, no raw code", async () => {
    const residentApi = makeResidentApi({
      decide: {
        ok: false,
        status: 409,
        error: {
          code: "APPROVAL_ALREADY_DECIDED",
          message: "Approval already denied",
          traceId: "trace-409",
        },
      },
    });
    renderAt(`/approve/${APPROVAL_ID}?token=${TOKEN}`, { residentApi });
    await waitFor(() => {
      expect(screen.getByText(/Maya Angelou/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /Approve/i }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Already handled/i);
    expect(alert).toHaveTextContent(/trace-409/);
    expectNoTechnicalLeak("APPROVAL_ALREADY_DECIDED", "Approval already denied");
    expect(screen.queryByText(/^Approved$/)).not.toBeInTheDocument();
  });

  it("describeApprovalError never echoes the code back for unknown inputs", () => {
    const weird = "SOME_NEW_CODE_NOBODY_MAPPED";
    const { title, body } = describeApprovalError(weird);
    expect(title).not.toContain(weird);
    expect(body).not.toContain(weird);
    expect(title.length).toBeGreaterThan(0);
  });
});
