/**
 * GatePass — post-onboarding router (Phase 2).
 *
 * Source: src/docs/specs/auth-and-role-routing.md §6.
 *
 * Routing keys off the DB-verified auth-role ONLY. The cosmetic onboarding-role
 * participates in exactly one decision: with NO staff session, a `resident`
 * onboarding-role sees the resident phone sign-in instead of the staff login
 * (resident-portal.md §4). A real session always wins over that
 * stored value — it is a tap on a tile, not a credential — and the info screen
 * resident sign-in carries a "Staff sign in" exit so a wrong tap is recoverable without wiping
 * browser storage. There is NO silent fallback to the guard console — an
 * unhandled role gets an explicit not-available state.
 */

import { Loader2 } from "lucide-react";

import { GatePassApp } from "@/features/gatepass/GatePassApp";
import { AdminDashboard } from "@/features/admin/AdminDashboard";
import { useAuth } from "@/features/auth/AuthContext";
import { LoginScreen } from "@/features/auth/LoginScreen";
import {
  RoleInterfaceNotAvailable,
  NoGuardProfileNotice,
} from "@/features/auth/NotAvailable";
import { ResidentLogin } from "@/features/resident/ResidentLogin";
import { ClaimUnitScreen, ResidentAccessEnded } from "@/features/resident/ClaimUnitScreen";
import { ResidentPortal } from "@/features/resident/ResidentPortal";
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
  const { state, skipOnboarding } = useOnboarding();
  const auth = useAuth();

  if (auth.status === "loading") return <FullScreenLoader />;

  if (auth.status === "unauthenticated") {
    // onboarding-role `resident` → resident phone sign-in. Staff who tapped
    // the wrong tile leave via its "Staff sign in" button, which clears the
    // stored role and marks onboarding done so the gate does not re-open the
    // picker.
    if (state.role === "resident") {
      return <ResidentLogin onStaffSignIn={skipOnboarding} />;
    }
    return <LoginScreen />;
  }

  if (auth.status === "resident" && auth.resident) {
    return <ResidentPortal resident={auth.resident} onSignOut={() => void auth.signOut()} />;
  }
  if (auth.status === "resident-unclaimed") return <ClaimUnitScreen />;
  if (auth.status === "resident-inactive") {
    return <ResidentAccessEnded onSignOut={() => void auth.signOut()} />;
  }

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
