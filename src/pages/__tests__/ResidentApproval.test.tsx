/**
 * ResidentApproval — magic-link page tests.
 * Source: src/docs/specs/resident-approval-flow.md §10, §11
 *
 * The page exists so a resident can approve or deny a walk-in without
 * installing the app. The token in the URL is the credential. These
 * tests verify each branch of the spec:
 *   - missing token   → no fetch, alert with recovery hint
 *   - already decided → outcome shown, no decide form
 *   - approve happy   → decideApproval called with token + decision
 *   - deny requires reason
 *   - deny happy      → decideApproval called with reason
 *   - status fetch failure surfaces backend code + message
 *   - decide failure  → error surfaced (no silent success)
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import ResidentApproval from "../ResidentApproval";
import type {
  guardApprovalApi,
  residentApprovalApi,
} from "@/lib/api/approvals";
import type {
  ApprovalRequestView,
  ApprovalStatusResponse,
  DecideApprovalResponse,
} from "@/lib/api/types";

const APPROVAL_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "b".repeat(64);

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

function makeGuardApi(
  statusResponse: ApprovalStatusResponse | {
    ok: false;
    status: number;
    error: { code: string; message: string; traceId?: string };
  }
): typeof guardApprovalApi {
  const isOk = !("ok" in statusResponse) || statusResponse.ok !== false;
  return {
    createApproval: vi.fn(),
    getApprovalStatus: vi.fn(async () =>
      isOk
        ? {
            ok: true as const,
            status: 200,
            data: statusResponse as ApprovalStatusResponse,
          }
        : (statusResponse as { ok: false; status: number; error: { code: string; message: string; traceId?: string } })
    ),
  } as unknown as typeof guardApprovalApi;
}

function makeResidentApi(
  decideResponse:
    | { ok: true; data: DecideApprovalResponse }
    | { ok: false; status: number; error: { code: string; message: string; traceId?: string } }
): typeof residentApprovalApi {
  return {
    decideApproval: vi.fn(async () =>
      decideResponse.ok
        ? {
            ok: true as const,
            status: 200,
            data: decideResponse.data,
          }
        : {
            ok: false as const,
            status: decideResponse.status,
            error: decideResponse.error,
          }
    ),
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

describe("ResidentApproval page", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("missing token → renders 'Missing token' alert without fetching status", () => {
    const guardApi = makeGuardApi({
      approval: makeApproval(),
      traceId: "t",
    });
    renderAt(`/approve/${APPROVAL_ID}`, { guardApi });
    expect(screen.getByText(/Missing token/i)).toBeInTheDocument();
    expect(guardApi.getApprovalStatus).not.toHaveBeenCalled();
  });

  it("pending approval → shows visitor + reason from guard, Approve/Deny buttons enabled", async () => {
    const guardApi = makeGuardApi({
      approval: makeApproval({ reason: "Late delivery" }),
      traceId: "t",
    });
    renderAt(`/approve/${APPROVAL_ID}?token=${TOKEN}`, { guardApi });
    await waitFor(() => {
      expect(screen.getByText(/Maya Angelou/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Late delivery/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approve/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Deny/i })).toBeEnabled();
  });

  it("approve happy path → calls decideApproval with token+decision and shows the success state", async () => {
    const guardApi = makeGuardApi({
      approval: makeApproval(),
      traceId: "t",
    });
    const residentApi = makeResidentApi({
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
    });

    renderAt(`/approve/${APPROVAL_ID}?token=${TOKEN}`, {
      guardApi,
      residentApi,
    });
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

  it("deny without reason → surfaces REASON_REQUIRED inline without calling the API", async () => {
    const guardApi = makeGuardApi({
      approval: makeApproval(),
      traceId: "t",
    });
    const residentApi = makeResidentApi({
      ok: true,
      data: {
        approval: makeApproval({ status: "denied" }),
        entry: null,
        traceId: "t",
      },
    });

    renderAt(`/approve/${APPROVAL_ID}?token=${TOKEN}`, {
      guardApi,
      residentApi,
    });
    await waitFor(() => {
      expect(screen.getByText(/Maya Angelou/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /Deny/i }));
    await waitFor(() => {
      expect(screen.getByText(/REASON_REQUIRED/)).toBeInTheDocument();
    });
    expect(residentApi.decideApproval).not.toHaveBeenCalled();
  });

  it("deny with reason → calls decideApproval and shows the denied outcome", async () => {
    const guardApi = makeGuardApi({
      approval: makeApproval(),
      traceId: "t",
    });
    const residentApi = makeResidentApi({
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
    });

    renderAt(`/approve/${APPROVAL_ID}?token=${TOKEN}`, {
      guardApi,
      residentApi,
    });
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

  it("already-decided link → skips the form and shows the existing outcome", async () => {
    const guardApi = makeGuardApi({
      approval: makeApproval({
        status: "approved",
        decidedAt: new Date().toISOString(),
        entryId: "entry-prev",
      }),
      traceId: "t",
    });
    renderAt(`/approve/${APPROVAL_ID}?token=${TOKEN}`, { guardApi });
    await waitFor(() => {
      expect(screen.getByText(/^Approved$/)).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: /^Approve$/i })
    ).not.toBeInTheDocument();
  });

  it("expired link from status → shows the expired outcome, not the form", async () => {
    const guardApi = makeGuardApi({
      approval: makeApproval({ status: "expired" }),
      traceId: "t",
    });
    renderAt(`/approve/${APPROVAL_ID}?token=${TOKEN}`, { guardApi });
    await waitFor(() => {
      expect(screen.getByText(/^Expired$/)).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /Approve/i })).not.toBeInTheDocument();
  });

  it("status fetch failure → surfaces the backend code + traceId, no decide attempted", async () => {
    const guardApi = makeGuardApi({
      ok: false,
      status: 404,
      error: {
        code: "APPROVAL_NOT_FOUND",
        message: "No approval matches that id",
        traceId: "trace-404",
      },
    });
    const residentApi = makeResidentApi({
      ok: true,
      data: {
        approval: makeApproval(),
        entry: null,
        traceId: "t",
      },
    });
    renderAt(`/approve/${APPROVAL_ID}?token=${TOKEN}`, {
      guardApi,
      residentApi,
    });
    await waitFor(() => {
      expect(screen.getByText(/APPROVAL_NOT_FOUND/)).toBeInTheDocument();
    });
    expect(screen.getByText(/trace-404/)).toBeInTheDocument();
    expect(residentApi.decideApproval).not.toHaveBeenCalled();
  });

  it("decide failure (token already used) → surfaces backend code, no silent success", async () => {
    const guardApi = makeGuardApi({
      approval: makeApproval(),
      traceId: "t",
    });
    const residentApi = makeResidentApi({
      ok: false,
      status: 409,
      error: {
        code: "TOKEN_ALREADY_USED",
        message: "This approval link has already been used",
        traceId: "trace-409",
      },
    });
    renderAt(`/approve/${APPROVAL_ID}?token=${TOKEN}`, {
      guardApi,
      residentApi,
    });
    await waitFor(() => {
      expect(screen.getByText(/Maya Angelou/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /Approve/i }));
    await waitFor(() => {
      expect(screen.getByText(/TOKEN_ALREADY_USED/)).toBeInTheDocument();
    });
    expect(screen.getByText(/trace-409/)).toBeInTheDocument();
  });
});
