/**
 * GatePass — link a signed-in phone to a unit with an admin-issued claim code.
 *
 * Source: src/docs/specs/resident-portal.md §2.4. The code proves which unit;
 * the phone comes from the verified session, never from this form.
 */

import { useState, type FormEvent } from "react";
import { KeyRound, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/features/auth/AuthContext";
import { residentApi } from "@/lib/api/resident";

export function ClaimUnitScreen() {
  const { refresh, signOut } = useAuth();
  const [code, setCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!code.trim() || !displayName.trim()) {
      setError("Enter the code from estate management and your name.");
      return;
    }
    setSubmitting(true);
    const result = await residentApi.claim(code.trim(), displayName.trim());
    setSubmitting(false);
    if (!result.ok) {
      setError(
        result.status === 0
          ? "No connection. Check your internet and try again."
          : result.error.message,
      );
      return;
    }
    await refresh();
  }

  return (
    <div
      className="flex min-h-screen items-center justify-center bg-background p-4"
      data-testid="resident-claim"
    >
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <KeyRound className="h-6 w-6" aria-hidden="true" />
          </div>
          <h1 className="text-xl font-semibold text-foreground">Link your home</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Enter the one-time code estate management gave you for your unit.
          </p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="claim-code">Unit code</Label>
            <Input
              id="claim-code"
              autoCapitalize="characters"
              autoComplete="off"
              placeholder="XXXX-XXXX"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={submitting}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="claim-name">Your name</Label>
            <Input
              id="claim-name"
              autoComplete="name"
              maxLength={120}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              disabled={submitting}
            />
            <p className="text-xs text-muted-foreground">
              Guards and your visitors see this name on passes.
            </p>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={submitting} data-testid="resident-claim-submit">
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            Link unit
          </Button>
          <Button type="button" variant="ghost" className="w-full" onClick={() => void signOut()}>
            Sign out
          </Button>
        </form>
      </div>
    </div>
  );
}

export function ResidentAccessEnded({ onSignOut }: { onSignOut: () => void }) {
  return (
    <div
      className="flex min-h-screen items-center justify-center bg-background p-4"
      data-testid="resident-access-ended"
    >
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 text-center shadow-sm">
        <h1 className="text-lg font-semibold text-foreground">Resident access ended</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This number is no longer linked to an active unit. If you have moved or
          think this is a mistake, ask estate management for a new unit code.
        </p>
        <Button variant="outline" className="mt-4" onClick={onSignOut}>
          Sign out
        </Button>
      </div>
    </div>
  );
}
