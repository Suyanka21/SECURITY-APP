/**
 * GatePass — resident sign-in (Supabase phone OTP, no password).
 *
 * Source: src/docs/specs/resident-portal.md §2.4, §4. Residents self-serve:
 * the first sign-in creates the Supabase user; the unit link is made
 * afterwards with an admin-issued claim code (ClaimUnitScreen).
 */

import { useState, type FormEvent } from "react";
import { Home, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/features/auth/AuthContext";
import { PublicFooter } from "@/features/public-info/PublicFooter";
import { normalizeKenyanPhone } from "./share";

export function ResidentLogin({ onStaffSignIn }: { onStaffSignIn: () => void }) {
  const { sendPhoneOtp, verifyPhoneOtp, loginAvailable } = useAuth();
  const [phone, setPhone] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSend(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const e164 = normalizeKenyanPhone(phone);
    if (!e164) {
      setError("Enter a valid mobile number, for example 0712 345 678.");
      return;
    }
    setSubmitting(true);
    const result = await sendPhoneOtp(e164);
    setSubmitting(false);
    if (!result.ok) {
      setError(result.message ?? "Could not send the code. Try again.");
      return;
    }
    setSentTo(e164);
  }

  async function handleVerify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!sentTo) return;
    const otp = code.replace(/\s/g, "");
    if (!/^\d{6}$/.test(otp)) {
      setError("Enter the 6-digit code from the SMS.");
      return;
    }
    setSubmitting(true);
    const result = await verifyPhoneOtp(sentTo, otp);
    setSubmitting(false);
    if (!result.ok) {
      setError(result.message ?? "That code didn't work. Check it and try again.");
    }
  }

  return (
    <div
      className="flex min-h-screen items-center justify-center bg-background p-4"
      data-testid="resident-login"
    >
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Home className="h-6 w-6" aria-hidden="true" />
          </div>
          <h1 className="text-xl font-semibold text-foreground">Resident sign in</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in with your mobile number to send gate passes to your visitors.
          </p>
        </div>

        {!loginAvailable ? (
          <p className="text-sm text-muted-foreground" data-testid="resident-login-unavailable">
            Resident sign-in is not available in this build yet.
          </p>
        ) : sentTo === null ? (
          <form onSubmit={handleSend} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="resident-phone">Mobile number</Label>
              <Input
                id="resident-phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="0712 345 678"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={submitting}
              />
            </div>
            <Button type="submit" className="w-full" disabled={submitting} data-testid="resident-send-code">
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              Send code
            </Button>
          </form>
        ) : (
          <form onSubmit={handleVerify} className="space-y-4" noValidate>
            <p className="text-sm text-muted-foreground">
              We sent a 6-digit code to <span className="font-medium text-foreground">{sentTo}</span>.
            </p>
            <div className="space-y-2">
              <Label htmlFor="resident-otp">Code</Label>
              <Input
                id="resident-otp"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={submitting}
              />
            </div>
            <Button type="submit" className="w-full" disabled={submitting} data-testid="resident-verify-code">
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              Sign in
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              disabled={submitting}
              onClick={() => {
                setSentTo(null);
                setCode("");
                setError(null);
              }}
            >
              Use a different number
            </Button>
          </form>
        )}

        {error && (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="mt-6 border-t border-border pt-4 text-center text-sm text-muted-foreground">
          <p className="mb-2">Not a resident? Guards and administrators sign in here.</p>
          <Button variant="outline" onClick={onStaffSignIn} data-testid="resident-staff-sign-in">
            Staff sign in
          </Button>
        </div>
        <PublicFooter />
      </div>
    </div>
  );
}
