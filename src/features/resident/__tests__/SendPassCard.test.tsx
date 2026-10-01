import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { SendPassCard } from "../SendPassCard";
import type { ApiResult, IssueVisitorInvitationResponse } from "@/lib/api/types";

const { issuePassMock } = vi.hoisted(() => ({ issuePassMock: vi.fn() }));
vi.mock("@/lib/api/resident", () => ({
  residentApi: { issuePass: (...args: unknown[]) => issuePassMock(...args) },
}));

const ISSUED: ApiResult<IssueVisitorInvitationResponse> = {
  ok: true,
  status: 201,
  data: {
    traceId: "trace-1",
    invitation: {
      id: "inv-1",
      qrToken: "RAWTOKEN_abc-123",
      passUrl: "https://gate.example/pass/RAWTOKEN_abc-123",
      passRef: "PR7K2M9Q",
      pin: "482913",
      visitorName: "John Kamau",
      host: "Amina Wanjiru",
      unit: "B12",
      plate: "KCA 123A",
      expiresAt: "2026-05-14T18:00:00.000Z",
      issuedAt: "2026-05-13T18:00:00.000Z",
    },
  },
};

function fail(status: number, code: string, message: string): ApiResult<IssueVisitorInvitationResponse> {
  return { ok: false, status, error: { code, message, traceId: "t" } };
}

function fillAndSubmit(name = "John Kamau", plate = "") {
  fireEvent.change(screen.getByLabelText("Visitor's name"), { target: { value: name } });
  if (plate) fireEvent.change(screen.getByLabelText(/Car plate/), { target: { value: plate } });
  fireEvent.click(screen.getByTestId("send-pass-submit"));
}

describe("SendPassCard", () => {
  const originalShare = navigator.share;

  beforeEach(() => {
    issuePassMock.mockReset();
  });
  afterEach(() => {
    cleanup();
    Object.defineProperty(navigator, "share", { value: originalShare, configurable: true });
  });

  it("sends only visitor fields — never host, unit or identity", async () => {
    issuePassMock.mockResolvedValue(ISSUED);
    render(<SendPassCard />);
    fireEvent.click(screen.getByRole("button", { name: "2 days" }));
    fillAndSubmit("John Kamau", "KCA 123A");
    await screen.findByTestId("send-pass-result");
    expect(issuePassMock).toHaveBeenCalledTimes(1);
    expect(issuePassMock.mock.calls[0][0]).toEqual({
      visitorName: "John Kamau",
      plate: "KCA 123A",
      ttlHours: 48,
    });
  });

  it("an empty visitor name is refused locally", () => {
    render(<SendPassCard />);
    fillAndSubmit("   ");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your visitor's name.");
    expect(issuePassMock).not.toHaveBeenCalled();
  });

  it("shows QR, WhatsApp link with the pass URL, and the PIN separately (not in the shared text)", async () => {
    issuePassMock.mockResolvedValue(ISSUED);
    render(<SendPassCard />);
    fillAndSubmit();
    await screen.findByTestId("send-pass-result");

    const wa = screen.getByTestId("send-pass-whatsapp") as HTMLAnchorElement;
    const shared = decodeURIComponent(wa.href.split("?text=")[1]);
    expect(wa.href.startsWith("https://wa.me/?text=")).toBe(true);
    expect(shared).toContain("https://gate.example/pass/RAWTOKEN_abc-123");
    expect(shared).not.toContain("482913");
    expect(wa.rel).toContain("noopener");

    expect(screen.getByTestId("send-pass-pin")).toHaveTextContent("PR7K2M9Q");
    expect(screen.getByTestId("send-pass-pin")).toHaveTextContent("482913");
    expect(document.querySelector("svg")).not.toBeNull();
  });

  it("uses the native share sheet when available, without the PIN", async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { value: shareMock, configurable: true });
    issuePassMock.mockResolvedValue(ISSUED);
    render(<SendPassCard />);
    fillAndSubmit();
    fireEvent.click(await screen.findByTestId("send-pass-share"));
    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));
    const arg = shareMock.mock.calls[0][0] as { text: string };
    expect(arg.text).toContain("https://gate.example/pass/RAWTOKEN_abc-123");
    expect(arg.text).not.toContain("482913");
  });

  it("copy link writes the pass URL to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    issuePassMock.mockResolvedValue(ISSUED);
    render(<SendPassCard />);
    fillAndSubmit();
    fireEvent.click(await screen.findByTestId("send-pass-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://gate.example/pass/RAWTOKEN_abc-123"));
    expect(await screen.findByText("Link copied")).toBeInTheDocument();
  });

  it("'Send another pass' clears the one-time link and PIN from the screen", async () => {
    issuePassMock.mockResolvedValue(ISSUED);
    render(<SendPassCard />);
    fillAndSubmit();
    fireEvent.click(await screen.findByTestId("send-pass-another"));
    expect(screen.queryByTestId("send-pass-result")).not.toBeInTheDocument();
    expect(screen.queryByText(/482913/)).not.toBeInTheDocument();
  });

  it.each([
    [409, "RESIDENT_PASS_LIMIT_REACHED", "Your unit already has 10 open passes. Wait for one to be used or expire.", "Your unit already has 10 open passes"],
    [403, "RESIDENT_INACTIVE", "x", "no longer active"],
    [0, "NETWORK_ERROR", "x", "No connection"],
    [429, "RATE_LIMIT_EXCEEDED", "x", "Too many passes"],
    [500, "INTERNAL_ERROR", "Failed query: insert into ...", "Something went wrong"],
  ])("status %i %s → plain-language error", async (status, code, message, expected) => {
    issuePassMock.mockResolvedValue(fail(status, code, message));
    render(<SendPassCard />);
    fillAndSubmit();
    expect(await screen.findByRole("alert")).toHaveTextContent(expected);
    expect(screen.getByRole("alert")).not.toHaveTextContent("Failed query");
    expect(screen.queryByTestId("send-pass-result")).not.toBeInTheDocument();
  });
});
