import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { ResidentLogin } from "../ResidentLogin";
import { ClaimUnitScreen } from "../ClaimUnitScreen";

const { authMock, claimMock } = vi.hoisted(() => ({
  authMock: {
    sendPhoneOtp: vi.fn(),
    verifyPhoneOtp: vi.fn(),
    refresh: vi.fn(),
    signOut: vi.fn(),
    loginAvailable: true,
  },
  claimMock: vi.fn(),
}));
vi.mock("@/features/auth/AuthContext", () => ({ useAuth: () => authMock }));
vi.mock("@/lib/api/resident", () => ({
  residentApi: { claim: (...args: unknown[]) => claimMock(...args) },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  authMock.loginAvailable = true;
});

function renderLogin(onStaff = vi.fn()) {
  render(
    <MemoryRouter>
      <ResidentLogin onStaffSignIn={onStaff} />
    </MemoryRouter>,
  );
  return onStaff;
}

describe("ResidentLogin (phone OTP)", () => {
  it("normalizes a local number to E.164, sends the code, then verifies it", async () => {
    authMock.sendPhoneOtp.mockResolvedValue({ ok: true });
    authMock.verifyPhoneOtp.mockResolvedValue({ ok: true });
    renderLogin();

    fireEvent.change(screen.getByLabelText("Mobile number"), { target: { value: "0712 345 678" } });
    fireEvent.click(screen.getByTestId("resident-send-code"));
    await waitFor(() => expect(authMock.sendPhoneOtp).toHaveBeenCalledWith("+254712345678"));

    fireEvent.change(await screen.findByLabelText("Code"), { target: { value: "123 456" } });
    fireEvent.click(screen.getByTestId("resident-verify-code"));
    await waitFor(() => expect(authMock.verifyPhoneOtp).toHaveBeenCalledWith("+254712345678", "123456"));
  });

  it("an invalid number is refused locally and no SMS is requested", () => {
    renderLogin();
    fireEvent.change(screen.getByLabelText("Mobile number"), { target: { value: "12345" } });
    fireEvent.click(screen.getByTestId("resident-send-code"));
    expect(screen.getByRole("alert")).toHaveTextContent("valid mobile number");
    expect(authMock.sendPhoneOtp).not.toHaveBeenCalled();
  });

  it("a short code is refused locally; a rejected code shows the error", async () => {
    authMock.sendPhoneOtp.mockResolvedValue({ ok: true });
    authMock.verifyPhoneOtp.mockResolvedValue({ ok: false, message: "Token has expired or is invalid" });
    renderLogin();
    fireEvent.change(screen.getByLabelText("Mobile number"), { target: { value: "0712345678" } });
    fireEvent.click(screen.getByTestId("resident-send-code"));

    fireEvent.change(await screen.findByLabelText("Code"), { target: { value: "12" } });
    fireEvent.click(screen.getByTestId("resident-verify-code"));
    expect(screen.getByRole("alert")).toHaveTextContent("6-digit code");
    expect(authMock.verifyPhoneOtp).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "999999" } });
    fireEvent.click(screen.getByTestId("resident-verify-code"));
    expect(await screen.findByText("Token has expired or is invalid")).toBeInTheDocument();
  });

  it("without Supabase config it says so and offers no phone form", () => {
    authMock.loginAvailable = false;
    renderLogin();
    expect(screen.getByTestId("resident-login-unavailable")).toBeInTheDocument();
    expect(screen.queryByLabelText("Mobile number")).not.toBeInTheDocument();
  });

  it("'Staff sign in' exit is always present", () => {
    const onStaff = renderLogin();
    fireEvent.click(screen.getByTestId("resident-staff-sign-in"));
    expect(onStaff).toHaveBeenCalledTimes(1);
  });
});

describe("ClaimUnitScreen", () => {
  it("submits only code + name, then re-resolves identity", async () => {
    claimMock.mockResolvedValue({ ok: true, status: 201, data: { resident: { id: "r1" } } });
    render(<ClaimUnitScreen />);
    fireEvent.change(screen.getByLabelText("Unit code"), { target: { value: " ABCD-EFGH " } });
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Amina" } });
    fireEvent.click(screen.getByTestId("resident-claim-submit"));
    await waitFor(() => expect(claimMock).toHaveBeenCalledWith("ABCD-EFGH", "Amina"));
    await waitFor(() => expect(authMock.refresh).toHaveBeenCalledTimes(1));
  });

  it("a refused code shows the server's plain message and does not refresh", async () => {
    claimMock.mockResolvedValue({
      ok: false,
      status: 403,
      error: { code: "CLAIM_CODE_INVALID", message: "This code is invalid or has expired.", traceId: "t" },
    });
    render(<ClaimUnitScreen />);
    fireEvent.change(screen.getByLabelText("Unit code"), { target: { value: "ABCD-EFGH" } });
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Amina" } });
    fireEvent.click(screen.getByTestId("resident-claim-submit"));
    expect(await screen.findByRole("alert")).toHaveTextContent("This code is invalid or has expired.");
    expect(authMock.refresh).not.toHaveBeenCalled();
  });
});
