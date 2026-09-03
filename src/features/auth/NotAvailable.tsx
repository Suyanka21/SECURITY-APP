/**
 * GatePass — explicit "not available" states.
 *
 * Source: src/docs/specs/auth-and-role-routing.md §5.3, §6.
 *
 * The single most important behavioural rule of Phase 2: no role ever silently
 * falls back to the guard console. When there is no interface to render for a
 * given (onboarding- or auth-) role, we render one of these explicit states.
 */

import { Info, ShieldAlert, LinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AuthRole } from "@/lib/api/me";

function Shell({
  icon,
  title,
  children,
  testId,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <div
      className="flex min-h-screen items-center justify-center bg-background p-4"
      data-testid={testId}
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted text-foreground">
          {icon}
        </div>
        <h1 className="text-lg font-semibold text-foreground">{title}</h1>
        <div className="mt-2 space-y-3 text-sm text-muted-foreground">
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * §5.3 — onboarding-role `resident`. Residents do not sign in to a console;
 * they approve/deny each visitor from a one-off link sent to their phone.
 * This screen must NOT render the guard console. It must, however, offer a
 * way out: the role is a stored tile tap, and a staff member who chose it by
 * mistake needs to reach the login without clearing browser storage.
 */
export function ResidentMagicLinkInfo({
  onStaffSignIn,
}: {
  onStaffSignIn: () => void;
}) {
  return (
    <Shell
      icon={<LinkIcon className="h-6 w-6" aria-hidden="true" />}
      title="Residents don't sign in here"
      testId="resident-not-available"
    >
      <p>
        As a resident/host, you don't need an account. Each time a visitor
        arrives, you'll get an approval link on your phone (SMS/WhatsApp).
      </p>
      <p>
        Open that link to approve or deny that specific visitor. The decision
        applies only to that arrival — there's nothing to log into and no
        standing dashboard.
      </p>
      <div className="border-t border-border pt-3">
        <p className="mb-2">Not a resident? Guards and administrators sign in here.</p>
        <Button
          variant="outline"
          onClick={onStaffSignIn}
          data-testid="resident-staff-sign-in"
        >
          Staff sign in
        </Button>
      </div>
    </Shell>
  );
}

/**
 * §6 — a DB-verified auth-role that has no interface built yet. Never falls
 * back to the guard console.
 */
export function RoleInterfaceNotAvailable({ role }: { role: string }) {
  return (
    <Shell
      icon={<ShieldAlert className="h-6 w-6" aria-hidden="true" />}
      title="Interface not available"
      testId="role-not-available"
    >
      <p>
        Your account role (<span className="font-medium">{role}</span>) doesn't
        have an interface in this build yet.
      </p>
      <p>
        This is intentional — GatePass never shows you a console that isn't
        meant for your role. Contact your administrator if you believe this is
        a mistake.
      </p>
    </Shell>
  );
}

/**
 * A valid Supabase session with no linked guard profile (403 AUTH_NO_GUARD_LINK).
 * Authenticated, but not authorized as any guard/admin — no console.
 */
export function NoGuardProfileNotice({
  onSignOut,
}: {
  onSignOut: () => void;
}) {
  return (
    <Shell
      icon={<Info className="h-6 w-6" aria-hidden="true" />}
      title="Account not linked"
      testId="no-guard-profile"
    >
      <p>
        You're signed in, but this account isn't linked to a guard or
        administrator profile, so there's nothing to show.
      </p>
      <p>Ask your administrator to link your account, then sign in again.</p>
      <Button variant="outline" className="mt-1" onClick={onSignOut}>
        Sign out
      </Button>
    </Shell>
  );
}

/** Convenience: pick the not-available screen for an unhandled auth-role. */
export function notAvailableForRole(role: AuthRole | string) {
  return <RoleInterfaceNotAvailable role={String(role)} />;
}
