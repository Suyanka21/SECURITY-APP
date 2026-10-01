/**
 * AuthContext resident resolution (Resident Portal R2).
 *
 * A phone-OTP session with no guard row resolves through /api/resident/me;
 * an email session with no guard row stays "no-guard-profile" and never asks
 * the resident endpoint. Resident identity is never restored from cache.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AuthProvider, useAuth } from "../AuthContext";
import type { ApiResult } from "@/lib/api/types";

const { meMock, residentMeMock, session, verifyOtpMock, signInWithOtpMock } = vi.hoisted(() => ({
  meMock: vi.fn(),
  residentMeMock: vi.fn(),
  session: { current: null as null | { access_token: string; user: { id: string; phone?: string } } },
  verifyOtpMock: vi.fn(),
  signInWithOtpMock: vi.fn(),
}));

vi.mock("@/lib/api/me", () => ({ authApi: { me: () => meMock() } }));
vi.mock("@/lib/api/resident", () => ({ residentApi: { me: () => residentMeMock() } }));
vi.mock("@/lib/api/auth", () => ({ setAuthToken: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  isSupabaseConfigured: () => true,
  getSupabaseClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: session.current } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
      signOut: async () => ({ error: null }),
      signInWithOtp: (...args: unknown[]) => signInWithOtpMock(...args),
      verifyOtp: (...args: unknown[]) => verifyOtpMock(...args),
    },
  }),
}));

const RESIDENT = {
  id: "r-1",
  displayName: "Amina",
  phoneE164: "+254712345678",
  unitId: "u-1",
  unitLabel: "B12",
};

function fail<T>(status: number, code: string): ApiResult<T> {
  return { ok: false, status, error: { code, message: code, traceId: "t" } };
}

function Probe() {
  const { status, resident, sendPhoneOtp, verifyPhoneOtp } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="unit">{resident?.unitLabel ?? "-"}</span>
      <button onClick={() => void sendPhoneOtp("+254712345678")}>send</button>
      <button onClick={() => void verifyPhoneOtp("+254712345678", "123456")}>verify</button>
    </div>
  );
}

async function settled(status: string) {
  await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent(new RegExp(`^${status}$`)));
}

describe("AuthContext resident resolution", () => {
  beforeEach(() => {
    window.localStorage.clear();
    meMock.mockReset().mockResolvedValue(fail(403, "AUTH_NO_GUARD_LINK"));
    residentMeMock.mockReset();
    session.current = { access_token: "tok", user: { id: "sb-1", phone: "254712345678" } };
  });
  afterEach(() => cleanup());

  it("phone session + no guard row + active resident → resident", async () => {
    residentMeMock.mockResolvedValue({ ok: true, status: 200, data: { resident: RESIDENT } });
    render(<AuthProvider><Probe /></AuthProvider>);
    await settled("resident");
    expect(screen.getByTestId("unit")).toHaveTextContent("B12");
  });

  it("AUTH_NO_RESIDENT_LINK → resident-unclaimed", async () => {
    residentMeMock.mockResolvedValue(fail(403, "AUTH_NO_RESIDENT_LINK"));
    render(<AuthProvider><Probe /></AuthProvider>);
    await settled("resident-unclaimed");
  });

  it.each(["RESIDENT_INACTIVE", "UNIT_INACTIVE"])("%s → resident-inactive", async (code) => {
    residentMeMock.mockResolvedValue(fail(403, code));
    render(<AuthProvider><Probe /></AuthProvider>);
    await settled("resident-inactive");
    expect(screen.getByTestId("unit")).toHaveTextContent("-");
  });

  it("transport failure while resolving a resident fails closed", async () => {
    residentMeMock.mockResolvedValue(fail(0, "NETWORK_ERROR"));
    render(<AuthProvider><Probe /></AuthProvider>);
    await settled("unauthenticated");
  });

  it("an email session with no guard row stays no-guard-profile and never asks /api/resident/me", async () => {
    session.current = { access_token: "tok", user: { id: "sb-2" } };
    render(<AuthProvider><Probe /></AuthProvider>);
    await settled("no-guard-profile");
    expect(residentMeMock).not.toHaveBeenCalled();
  });

  it("a guard row always wins: resident endpoint is not consulted", async () => {
    meMock.mockResolvedValue({
      ok: true,
      status: 200,
      data: { guardId: "g", role: "guard", name: "G", badgeNumber: "B", isActive: true, traceId: "t" },
    });
    render(<AuthProvider><Probe /></AuthProvider>);
    await settled("authenticated");
    expect(residentMeMock).not.toHaveBeenCalled();
  });

  it("sendPhoneOtp / verifyPhoneOtp call Supabase phone OTP (type sms) and then resolve", async () => {
    session.current = null;
    meMock.mockResolvedValueOnce(fail(401, "AUTH_REQUIRED"));
    signInWithOtpMock.mockResolvedValue({ error: null });
    verifyOtpMock.mockResolvedValue({
      data: { session: { access_token: "new", user: { id: "sb-3", phone: "254712345678" } } },
      error: null,
    });
    residentMeMock.mockResolvedValue(fail(403, "AUTH_NO_RESIDENT_LINK"));
    render(<AuthProvider><Probe /></AuthProvider>);
    await settled("unauthenticated");

    fireEvent.click(screen.getByText("send"));
    await waitFor(() => expect(signInWithOtpMock).toHaveBeenCalledWith({ phone: "+254712345678" }));

    fireEvent.click(screen.getByText("verify"));
    await waitFor(() =>
      expect(verifyOtpMock).toHaveBeenCalledWith({ phone: "+254712345678", token: "123456", type: "sms" }),
    );
    await settled("resident-unclaimed");
  });
});
