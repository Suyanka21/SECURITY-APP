/**
 * GatePass — staff password reset (/reset-password).
 *
 * Two steps on one page:
 *  1. Request: the staff member types their email. The server answers every
 *     well-formed email with the same 202 (no account enumeration) and asks
 *     Supabase Auth to email a recovery link.
 *  2. Set: the recovery link lands back here. Supabase uses the implicit flow,
 *     so the one-time session arrives in the URL fragment (#access_token=…),
 *     which browsers never send to a server or in a Referer header. Once the
 *     Supabase client has read it, the fragment is removed from the address
 *     bar and history. After the new password is saved, every session of the
 *     account is signed out and the user signs in again.
 *
 * This route sits outside AuthProvider, so a recovery session never resolves
 * a staff role or opens a dashboard here.
 */

import { useEffect, useState, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Loader2, KeyRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PublicFooter } from "@/features/public-info/PublicFooter";
import { getSupabaseClient } from "@/lib/supabase";
import { passwordResetApi } from "@/lib/api/password-reset";

export const RESET_REQUESTED_MESSAGE =
  "If that email belongs to a GatePass staff account, a reset link is on its way. Check your inbox.";

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

type Fragment = "recovery" | "error" | null;
type Mode = "checking" | "request" | "requested" | "set" | "done" | "expired";

function readFragment(): Fragment {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  if (params.has("error") || params.has("error_code") || params.has("error_description")) {
    return "error";
  }
  if (params.get("type") === "recovery" && params.has("access_token")) return "recovery";
  return null;
}

function stripFragment(): void {
  const { pathname, search, href } = window.location;
  if (window.location.hash || href.endsWith("#")) {
    window.history.replaceState(window.history.state, "", `${pathname}${search}`);
  }
}

function updateErrorMessage(code: string | undefined): string | null {
  if (code === "weak_password") {
    return "That password is too weak. Choose a longer one that is hard to guess.";
  }
  if (code === "same_password") {
    return "Choose a password that is different from your old one.";
  }
  return null;
}

interface ResetPasswordProps {
  api?: typeof passwordResetApi;
  getClient?: () => SupabaseClient | null;
}

export default function ResetPassword({
  api = passwordResetApi,
  getClient = getSupabaseClient,
}: ResetPasswordProps = {}) {
  // Captured at first render, before the Supabase client clears the hash.
  const [fragment] = useState<Fragment>(readFragment);
  const [mode, setMode] = useState<Mode>(fragment ? "checking" : "request");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!fragment) return;
    let active = true;
    void (async () => {
      const supabase = fragment === "recovery" ? getClient() : null;
      // getSession waits for the client to read the session from the hash.
      const session = supabase
        ? (await supabase.auth.getSession()).data.session
        : null;
      stripFragment();
      if (active) setMode(session ? "set" : "expired");
    })();
    return () => {
      active = false;
    };
  }, [fragment, getClient]);

  async function handleRequest(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.request(email.trim());
      if (res.ok) {
        setMode("requested");
      } else if (res.status === 429) {
        setError("Too many reset requests from this network. Wait 15 minutes and try again.");
      } else if (res.status === 422) {
        setError("Enter a valid email address.");
      } else {
        setError("Could not send the request right now. Try again in a few minutes.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSet(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (password.length < PASSWORD_MIN) {
      setError(`Use at least ${PASSWORD_MIN} characters.`);
      return;
    }
    if (password.length > PASSWORD_MAX) {
      setError(`Use at most ${PASSWORD_MAX} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    const supabase = getClient();
    if (!supabase) {
      setMode("expired");
      return;
    }
    setSubmitting(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        const message = updateErrorMessage(updateError.code);
        if (message) {
          setError(message);
        } else {
          await supabase.auth.signOut({ scope: "local" });
          setMode("expired");
        }
        return;
      }
      // Global scope: every device signed in to this account must sign in again.
      await supabase.auth.signOut();
      setPassword("");
      setConfirm("");
      setMode("done");
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelSet() {
    await getClient()?.auth.signOut({ scope: "local" });
    window.location.assign("/");
  }

  function backToRequest() {
    setError(null);
    setMode("request");
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <KeyRound className="mx-auto h-10 w-10 text-primary" aria-hidden="true" />
          <h1 className="text-2xl font-semibold">Reset staff password</h1>
        </div>

        {mode === "checking" && (
          <p className="flex items-center justify-center text-sm text-muted-foreground" role="status">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            Checking your reset link…
          </p>
        )}

        {mode === "request" && (
          <form onSubmit={handleRequest} className="space-y-4" noValidate>
            <p className="text-sm text-muted-foreground">
              Enter the email you sign in with. If it belongs to a staff account, we will
              email you a link to choose a new password.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="reset-email">Email</Label>
              <Input
                id="reset-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
                required
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={submitting || !email.trim()}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              {submitting ? "Sending…" : "Send reset link"}
            </Button>
            <p className="text-center text-sm">
              <a href="/" className="underline">
                Back to sign in
              </a>
            </p>
          </form>
        )}

        {mode === "requested" && (
          <div className="space-y-4 text-center">
            <p role="status" className="text-sm">
              {RESET_REQUESTED_MESSAGE}
            </p>
            <p className="text-sm text-muted-foreground">
              The link works once. If nothing arrives, check spam or ask your admin.
            </p>
            <a href="/" className="text-sm underline">
              Back to sign in
            </a>
          </div>
        )}

        {mode === "set" && (
          <form onSubmit={handleSet} className="space-y-4" noValidate>
            <p className="text-sm text-muted-foreground">
              Choose a new password ({PASSWORD_MIN}–{PASSWORD_MAX} characters).
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="reset-new-password">New password</Label>
              <Input
                id="reset-new-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reset-confirm-password">Repeat new password</Label>
              <Input
                id="reset-confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                disabled={submitting}
                required
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              {submitting ? "Saving…" : "Save new password"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              disabled={submitting}
              onClick={() => void cancelSet()}
            >
              Cancel
            </Button>
          </form>
        )}

        {mode === "done" && (
          <div className="space-y-4 text-center">
            <p role="status" className="text-sm">
              Your password has been changed and every device signed in to this account
              has been signed out. Sign in with your new password.
            </p>
            <a href="/" className="text-sm underline">
              Go to sign in
            </a>
          </div>
        )}

        {mode === "expired" && (
          <div className="space-y-4 text-center">
            <p role="alert" className="text-sm">
              This reset link has expired or has already been used. Request a new one.
            </p>
            <Button type="button" className="w-full" onClick={backToRequest}>
              Request a new link
            </Button>
          </div>
        )}

        <PublicFooter />
      </div>
    </div>
  );
}
