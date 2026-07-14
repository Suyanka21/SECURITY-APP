/**
 * GatePass — post-onboarding router (Phase 2).
 *
 * Source: src/docs/specs/auth-and-role-routing.md §6.
 *
 * Routing keys off the DB-verified auth-role ONLY. The cosmetic onboarding-role
 * participates in exactly one decision: a `resident` onboarding-role sees the
 * §5.3 magic-link info state (residents never sign in to a console). Everything
 * else gates on login, then renders by auth-role. There is NO silent fallback
 * to the guard console — an unhandled role gets an explicit not-available state.
 */

import { Loader2 } from "lucide-react";

import { GatePassApp } from "@/features/gatepass/GatePassApp";
import { AdminDashboard } from "@/features/admin/AdminDashboard";
import { useAuth } from "@/features/auth/AuthContext";
import { LoginScreen } from "@/features/auth/LoginScreen";
import {
  ResidentMagicLinkInfo,
  RoleInterfaceNotAvailable,
  NoGuardProfileNotice,
} from "@/features/auth/NotAvailable";
import { useOnboarding } from "@/features/onboarding/useOnboarding";

function FullScreenLoader() {
  return (
    <div
      className="flex min-h-screen items-center justify-center bg-background"
      data-testid="auth-loading"
    >
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
    </div>
  );
}

const Index = () => {
  const { state } = useOnboarding();
  const auth = useAuth();

  // onboarding-role `resident` → informational state (§5.3). Never a console,
  // never a login prompt — residents act through one-off links.
  if (state.role === "resident") {
    return <ResidentMagicLinkInfo />;
  }

  if (auth.status === "loading") return <FullScreenLoader />;
  if (auth.status === "unauthenticated") return <LoginScreen />;
  if (auth.status === "no-guard-profile") {
    return <NoGuardProfileNotice onSignOut={() => void auth.signOut()} />;
  }

  // Authenticated: render by DB-verified auth-role only.
  switch (auth.role) {
    case "guard":
    case "senior-guard":
      return <GatePassApp />;
    case "admin":
      return <AdminDashboard />;
    default:
      // No interface for this role — explicit, never GatePassApp.
      return <RoleInterfaceNotAvailable role={auth.role ?? "unknown"} />;
  }
};

export default Index;
