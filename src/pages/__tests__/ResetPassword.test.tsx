/**
 * ResetPassword — staff password reset page.
 *
 * Request step: the page shows one fixed message for every accepted email, so
 * the screen cannot reveal whether an account exists.
 * Set step: the recovery session arrives in the URL fragment; the page reads
 * it through the Supabase client and then removes it from the address bar.
 */
import { fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import type { SupabaseClient } from "@supabase/supabase-js";
import ResetPassword, { RESET_REQUESTED_MESSAGE } from "../ResetPassword";
import type { passwordResetApi } from "@/lib/api/password-reset";
import { PASSWORD_RESET_MESSAGE } from "@/server/routes/password-reset";

const RECOVERY_HASH =
  "#access_token=fake-access&expires_in=3600&refresh_token=fake-refresh&token_type=bearer&type=recovery";
const STRONG = "correct-horse-battery";

type ApiResultish =
  | { ok: true; status: number; data: { message: string; traceId: string } }
  | { ok: false; status: number; error: { code: string; message: string; traceId: string } };

function makeApi(result: ApiResultish) {
  return { request: vi.fn(async () => result) } as unknown as typeof passwordResetApi & {
    request: ReturnType<typeof vi.fn>;
  };
}

function makeClient(opts: {
  session?: object | null;
  updateError?: { code?: string; name?: string; message: string } | null;
} = {}) {
  const hashAtGetSession: string[] = [];
  const auth = {
    getSession: vi.fn(async () => {
      hashAtGetSession.push(window.location.hash);
      return {
        data: {
          session:
            opts.session === undefined ? { access_token: "fake-access", user: {} } : opts.session,
        },
      };
    }),
    updateUser: vi.fn(async () => ({ data: {}, error: opts.updateError ?? null })),
    signOut: vi.fn(async () => ({ error: null })),
  };
  return { client: { auth } as unknown as SupabaseClient, auth, hashAtGetSession };
}

function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter>{ui}</MemoryRouter>);
}

function at(url: string) {
  window.history.replaceState(null, "", url);
}

afterEach(() => at("/"));

describe("ResetPassword — request step", () => {
  it("shows the same fixed message for any accepted email, whatever the server body says", async () => {
    const api = makeApi({
      ok: true,
      status: 202,
      data: { message: "server text the page must not echo", traceId: "t" },
    });
    at("/reset-password");
    render(<ResetPassword api={api} getClient={() => null} />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "  nobody@example.test " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByText(RESET_REQUESTED_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText(/server text/)).toBeNull();
    expect(api.request).toHaveBeenCalledWith("nobody@example.test");
    expect(window.location.search).toBe("");
  });

  it("uses the same wording as the server's generic message", () => {
    expect(RESET_REQUESTED_MESSAGE).toBe(PASSWORD_RESET_MESSAGE);
  });

  it("429 tells the user to wait; no success message", async () => {
    const api = makeApi({
      ok: false,
      status: 429,
      error: { code: "RATE_LIMITED", message: "x", traceId: "t" },
    });
    at("/reset-password");
    render(<ResetPassword api={api} getClient={() => null} />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Wait 15 minutes/);
    expect(screen.queryByText(RESET_REQUESTED_MESSAGE)).toBeNull();
  });

  it("422 asks for a valid email", async () => {
    const api = makeApi({
      ok: false,
      status: 422,
      error: { code: "VALIDATION_ERROR", message: "x", traceId: "t" },
    });
    at("/reset-password");
    render(<ResetPassword api={api} getClient={() => null} />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a valid email address.");
  });

  it("without a recovery fragment the page never reads a Supabase session", () => {
    const { client, auth } = makeClient();
    at("/reset-password");
    render(<ResetPassword api={makeApi({ ok: true, status: 202, data: { message: "", traceId: "" } })} getClient={() => client} />);
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(auth.getSession).not.toHaveBeenCalled();
  });
});

describe("ResetPassword — set step (recovery link)", () => {
  it("reads the session before removing the fragment, then removes it from the URL", async () => {
    const { client, hashAtGetSession } = makeClient();
    at(`/reset-password${RECOVERY_HASH}`);
    render(<ResetPassword getClient={() => client} />);
    expect(await screen.findByLabelText("New password")).toBeInTheDocument();
    expect(hashAtGetSession[0]).toBe(RECOVERY_HASH);
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain("#");
    expect(window.location.href).not.toContain("access_token");
    expect(window.location.pathname).toBe("/reset-password");
  });

  it("rejects short and mismatched passwords without calling Supabase", async () => {
    const { client, auth } = makeClient();
    at(`/reset-password${RECOVERY_HASH}`);
    render(<ResetPassword getClient={() => client} />);
    fireEvent.change(await screen.findByLabelText("New password"), { target: { value: "short" } });
    fireEvent.change(screen.getByLabelText("Repeat new password"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("at least 12");

    fireEvent.change(screen.getByLabelText("New password"), { target: { value: STRONG } });
    fireEvent.change(screen.getByLabelText("Repeat new password"), { target: { value: `${STRONG}!` } });
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("do not match");
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it("saves the password, signs out every session, and shows the sign-in prompt", async () => {
    const { client, auth } = makeClient();
    at(`/reset-password${RECOVERY_HASH}`);
    render(<ResetPassword getClient={() => client} />);
    fireEvent.change(await screen.findByLabelText("New password"), { target: { value: STRONG } });
    fireEvent.change(screen.getByLabelText("Repeat new password"), { target: { value: STRONG } });
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
    expect(await screen.findByText(/Your password has been changed/)).toBeInTheDocument();
    expect(auth.updateUser).toHaveBeenCalledWith({ password: STRONG });
    expect(auth.signOut).toHaveBeenCalledWith();
    expect(screen.getByRole("link", { name: "Go to sign in" })).toHaveAttribute("href", "/");
  });

  it("weak_password keeps the form open with a plain message", async () => {
    const { client, auth } = makeClient({ updateError: { code: "weak_password", message: "raw" } });
    at(`/reset-password${RECOVERY_HASH}`);
    render(<ResetPassword getClient={() => client} />);
    fireEvent.change(await screen.findByLabelText("New password"), { target: { value: STRONG } });
    fireEvent.change(screen.getByLabelText("Repeat new password"), { target: { value: STRONG } });
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("too weak");
    expect(screen.queryByText("raw")).toBeNull();
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("an expired-session error drops the session and shows the expired panel", async () => {
    const { client, auth } = makeClient({ updateError: { code: "session_not_found", message: "raw" } });
    at(`/reset-password${RECOVERY_HASH}`);
    render(<ResetPassword getClient={() => client} />);
    fireEvent.change(await screen.findByLabelText("New password"), { target: { value: STRONG } });
    fireEvent.change(screen.getByLabelText("Repeat new password"), { target: { value: STRONG } });
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
    expect(await screen.findByText(/expired or has already been used/)).toBeInTheDocument();
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("a rejected link on a browser already signed in as someone else never opens the form", async () => {
    const { client, auth } = makeClient({
      session: { access_token: "alice-existing-session", user: { id: "alice" } },
    });
    at(`/reset-password${RECOVERY_HASH}`);
    render(<ResetPassword getClient={() => client} />);
    expect(await screen.findByText(/expired or has already been used/)).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).toBeNull();
    expect(auth.updateUser).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(window.location.href).not.toContain("#");
  });

  it("a network failure keeps the session and the form for a retry", async () => {
    const { client, auth } = makeClient({
      updateError: { name: "AuthRetryableFetchError", message: "Failed to fetch" },
    });
    at(`/reset-password${RECOVERY_HASH}`);
    render(<ResetPassword getClient={() => client} />);
    fireEvent.change(await screen.findByLabelText("New password"), { target: { value: STRONG } });
    fireEvent.change(screen.getByLabelText("Repeat new password"), { target: { value: STRONG } });
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("try again");
    expect(screen.getByLabelText("New password")).toBeInTheDocument();
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("a missing session (AuthSessionMissingError) shows the expired panel", async () => {
    const { client } = makeClient({
      updateError: { name: "AuthSessionMissingError", message: "Auth session missing!" },
    });
    at(`/reset-password${RECOVERY_HASH}`);
    render(<ResetPassword getClient={() => client} />);
    fireEvent.change(await screen.findByLabelText("New password"), { target: { value: STRONG } });
    fireEvent.change(screen.getByLabelText("Repeat new password"), { target: { value: STRONG } });
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
    expect(await screen.findByText(/expired or has already been used/)).toBeInTheDocument();
  });

  it("a recovery fragment with no resulting session shows the expired panel", async () => {
    const { client } = makeClient({ session: null });
    at(`/reset-password${RECOVERY_HASH}`);
    render(<ResetPassword getClient={() => client} />);
    expect(await screen.findByText(/expired or has already been used/)).toBeInTheDocument();
    expect(window.location.hash).toBe("");
  });

  it("an error fragment (expired link) is stripped and shows the expired panel", async () => {
    const { client, auth } = makeClient();
    at("/reset-password#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid");
    render(<ResetPassword getClient={() => client} />);
    expect(await screen.findByText(/expired or has already been used/)).toBeInTheDocument();
    expect(window.location.href).not.toContain("#");
    expect(auth.getSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Request a new link" }));
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
  });

  it("Cancel drops the recovery session on this device", async () => {
    const { client, auth } = makeClient();
    const assign = vi.fn();
    const original = window.location;
    at(`/reset-password${RECOVERY_HASH}`);
    render(<ResetPassword getClient={() => client} />);
    await screen.findByLabelText("New password");
    Object.defineProperty(window, "location", { configurable: true, value: { ...original, assign } });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
      expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: original });
    }
  });
});
