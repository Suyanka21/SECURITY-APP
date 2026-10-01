/**
 * GatePass — resident portal shell.
 *
 * Source: src/docs/specs/resident-portal.md §1, §4. Capabilities in priority
 * order; R2 ships capability 1 (send a pass). Household members/workers and
 * vehicles arrive in R3. No dashboard, inbox or notification centre.
 */

import { LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PublicFooter } from "@/features/public-info/PublicFooter";
import type { ResidentMe } from "@/lib/api/resident";
import { SendPassCard } from "./SendPassCard";

export function ResidentPortal({
  resident,
  onSignOut,
}: {
  resident: ResidentMe;
  onSignOut: () => void;
}) {
  return (
    <div className="min-h-screen bg-background" data-testid="resident-portal">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-md items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <p className="truncate font-semibold text-foreground" data-testid="resident-name">
              {resident.displayName}
            </p>
            <p className="text-sm text-muted-foreground" data-testid="resident-unit">
              Unit {resident.unitLabel}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onSignOut} data-testid="resident-sign-out">
            <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />
            Sign out
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-md space-y-4 p-4">
        <SendPassCard />
      </main>
      <div className="mx-auto max-w-md px-4 pb-6">
        <PublicFooter />
      </div>
    </div>
  );
}
