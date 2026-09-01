/**
 * Offline identity continuity in AuthContext.
 *
 * Before this, ANY non-403 failure of /api/auth/me resolved to
 * `unauthenticated` — so a guard whose tab woke up offline mid-shift was shown
 * a login screen that cannot work without the network, and the console (with
 * its unsynced offline queue) was unmounted. These tests pin the split between
 * "the server refused" (401/403 → clear) and "the server never answered"
 * (transport → keep identity, unverified), and that a device which never
 * proved an identity stays fail-closed.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthProvider, useAuth } from "../AuthContext";
import { writeCachedIdentity } from "../identityCache";
import type { AuthMe } from "@/lib/api/me";
import type { ApiResult } from "@/lib/api/types";

const USER = "9f2c1f8e-0000-4000-8000-000000000001";
const OTHER_USER = "9f2c1f8e-0000-4000-8000-000000000002";

const { meMock, sessionUserId, setAuthTokenMock } = vi.hoisted(() => ({
  meMock: vi.fn(),
  sessionUserId: { current: null as string | null },
  setAuthTokenMock: vi.fn(),
}));

vi.mock("@/lib/api/me", () => ({
  authApi: { me: () => meMock() },
}));

vi.mock("@/lib/api/auth", () => ({
  setAuthToken: setAuthTokenMock,
}));

vi.mock("@/lib/supabase", () => ({
  isSupabaseConfigured: () => true,
  getSupabaseClient: () => ({
    auth: {
      getSession: async () => ({
        data: {
          session: sessionUserId.current
            ? { access_token: "token", user: { id: sessionUserId.current } }
            : null,
        },
      }),
      onAuthStateChange: () => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      }),
      signOut: async () => ({ error: null }),
    },
  }),
}));

const GUARD: AuthMe = {
  guardId: "11111111-1111-4111-8111-111111111111",
  role: "guard",
  name: "N. Adeyemi",
  badgeNumber: "G-001",
  isActive: true,
  traceId: "trace-me",
};

const ADMIN: AuthMe = { ...GUARD, role: "admin", name: "A. Okoro" };

function ok(data: AuthMe): ApiResult<AuthMe> {
  return { ok: true, status: 200, data };
}

function fail(status: number, code: string): ApiResult<AuthMe> {
  return { ok: false, status, error: { code, message: code } };
}

const offline = () => fail(0, "NETWORK_ERROR");

function Probe() {
  const { status, role, me, identityVerified, refresh, signOut } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="role">{role ?? "-"}</span>
      <span data-testid="name">{me?.name ?? "-"}</span>
      <span data-testid="verified">{String(identityVerified)}</span>
      <button onClick={() => void refresh()}>refresh</button>
      <button onClick={() => void signOut()}>sign out</button>
    </div>
  );
}

function renderAuth() {
  return render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
}

async function settled(status: string) {
  await waitFor(() =>
    expect(screen.getByTestId("status")).toHaveTextContent(status),
  );
}

describe("AuthContext offline identity continuity", () => {
  beforeEach(() => {
    window.localStorage.clear();
    meMock.mockReset();
    sessionUserId.current = USER;
  });

  it("marks a freshly resolved identity verified", async () => {
    meMock.mockResolvedValue(ok(GUARD));
    renderAuth();

    await settled("authenticated");
    expect(screen.getByTestId("verified")).toHaveTextContent("true");
    expect(screen.getByTestId("name")).toHaveTextContent("N. Adeyemi");
  });

  it("keeps a guard signed in — unverified — when the tab wakes offline", async () => {
    meMock.mockResolvedValueOnce(ok(GUARD)).mockResolvedValue(offline());
    const { rerender } = renderAuth();
    await settled("authenticated");

    // Simulates the wake/refresh re-resolution against a dead network.
    rerender(
      <AuthProvider key="remount">
        <Probe />
      </AuthProvider>,
    );

    await settled("authenticated");
    expect(screen.getByTestId("role")).toHaveTextContent("guard");
    expect(screen.getByTestId("name")).toHaveTextContent("N. Adeyemi");
    expect(screen.getByTestId("verified")).toHaveTextContent("false");
  });

  it("keeps an in-memory identity when a re-check fails with no cache to fall back on", async () => {
    meMock.mockResolvedValueOnce(ok(GUARD)).mockResolvedValue(offline());
    renderAuth();
    await settled("authenticated");

    // No cache at all: the identity survives purely because it was already
    // proven in this session and the server never said otherwise.
    window.localStorage.clear();
    screen.getByRole("button", { name: "refresh" }).click();

    await waitFor(() =>
      expect(screen.getByTestId("verified")).toHaveTextContent("false"),
    );
    expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
    expect(screen.getByTestId("name")).toHaveTextContent("N. Adeyemi");
  });

  it("keeps an admin's own live session on a transport failure without caching it", async () => {
    meMock.mockResolvedValueOnce(ok(ADMIN)).mockResolvedValue(offline());
    renderAuth();
    await settled("authenticated");
    expect(window.localStorage.getItem("gatepass.identity.v1")).toBeNull();

    screen.getByRole("button", { name: "refresh" }).click();

    await waitFor(() =>
      expect(screen.getByTestId("verified")).toHaveTextContent("false"),
    );
    expect(screen.getByTestId("role")).toHaveTextContent("admin");
  });

  it("restores the cached guard identity on an offline reload of the same session", async () => {
    writeCachedIdentity(USER, GUARD);
    meMock.mockResolvedValue(offline());
    renderAuth();

    await settled("authenticated");
    expect(screen.getByTestId("role")).toHaveTextContent("guard");
    expect(screen.getByTestId("verified")).toHaveTextContent("false");
  });

  it("stays fail-closed offline when nothing was ever cached", async () => {
    meMock.mockResolvedValue(offline());
    renderAuth();

    await settled("unauthenticated");
    expect(screen.getByTestId("name")).toHaveTextContent("-");
    expect(screen.getByTestId("verified")).toHaveTextContent("false");
  });

  it("does not restore a cache belonging to a different Supabase user", async () => {
    writeCachedIdentity(OTHER_USER, GUARD);
    meMock.mockResolvedValue(offline());
    renderAuth();

    await settled("unauthenticated");
  });

  it("does not restore anything when there is no Supabase session", async () => {
    writeCachedIdentity(USER, GUARD);
    sessionUserId.current = null;
    meMock.mockResolvedValue(offline());
    renderAuth();

    await settled("unauthenticated");
  });

  it("never restores an admin from cache", async () => {
    meMock.mockResolvedValueOnce(ok(ADMIN)).mockResolvedValue(offline());
    renderAuth();
    await settled("authenticated");

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    // Second provider has no in-memory identity to keep, and admin was never
    // written to the cache, so it must land on the login screen.
    await waitFor(() =>
      expect(screen.getAllByTestId("status")[1]).toHaveTextContent(
        "unauthenticated",
      ),
    );
  });

  it("still clears identity and cache on 401", async () => {
    meMock.mockResolvedValueOnce(ok(GUARD)).mockResolvedValue(fail(401, "AUTH_REQUIRED"));
    renderAuth();
    await settled("authenticated");

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("status")[1]).toHaveTextContent(
        "unauthenticated",
      ),
    );
    expect(window.localStorage.getItem("gatepass.identity.v1")).toBeNull();
  });

  it("still resolves 403 to no-guard-profile and clears the cache", async () => {
    writeCachedIdentity(USER, GUARD);
    meMock.mockResolvedValue(fail(403, "AUTH_NO_GUARD_LINK"));
    renderAuth();

    await settled("no-guard-profile");
    expect(window.localStorage.getItem("gatepass.identity.v1")).toBeNull();
  });

  it("clears the cached identity on sign-out", async () => {
    meMock.mockResolvedValue(ok(GUARD));
    renderAuth();
    await settled("authenticated");
    expect(window.localStorage.getItem("gatepass.identity.v1")).not.toBeNull();

    screen.getByRole("button", { name: "sign out" }).click();

    await settled("unauthenticated");
    expect(window.localStorage.getItem("gatepass.identity.v1")).toBeNull();
  });
});
