/**
 * GatePass — Login screen (Supabase password auth for guard / admin).
 *
 * Source: src/docs/specs/auth-and-role-routing.md §6 (login precedes the
 *         role switch) and §5.4 (residents do NOT log in here — they use
 *         one-off magic links).
 *
 * This screen only authenticates. The resulting role is resolved server-side
 * (GET /api/auth/me) by the AuthProvider — never from the Supabase session.
 */

import { useState, type FormEvent } from "react";
import { ShieldCheck, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "./AuthContext";

export function LoginScreen() {
  const { signIn, loginAvailable, error } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLocalError(null);
    if (!email || !password) {
      setLocalError("Enter your email and password.");
      return;
    }
    setSubmitting(true);
    const result = await signIn(email.trim(), password);
    setSubmitting(false);
    if (!result.ok) {
      setLocalError(result.message ?? "Sign in failed. Check your credentials.");
    }
  }

  const shownError = localError ?? error;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <ShieldCheck className="h-6 w-6" aria-hidden="true" />
          </div>
          <h1 className="text-xl font-semibold text-foreground">
            Sign in to GatePass
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            For guards and administrators. Residents approve visitors from the
            link sent to their phone — no sign-in needed.
          </p>
        </div>

        {!loginAvailable && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
          >
            Login is not configured in this build. Set VITE_SUPABASE_URL and
            VITE_SUPABASE_ANON_KEY to enable sign-in.
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="login-email">Email</Label>
            <Input
              id="login-email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting || !loginAvailable}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="login-password">Password</Label>
            <Input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting || !loginAvailable}
              required
            />
          </div>

          {shownError && (
            <p role="alert" className="text-sm text-destructive">
              {shownError}
            </p>
          )}

          <Button
            type="submit"
            className="w-full"
            disabled={submitting || !loginAvailable}
          >
            {submitting && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            )}
            {submitting ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </div>
    </div>
  );
}
