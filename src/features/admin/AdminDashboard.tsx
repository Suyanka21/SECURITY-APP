/**
 * GatePass — Admin dashboard (Interface 2).
 *
 * Source: src/docs/specs/auth-and-role-routing.md §4.
 *
 * A read-oriented operations dashboard over endpoints that ALREADY exist and
 * are ALREADY role-gated to admin/senior-guard in app.ts. This adds NO backend
 * authorization surface. Every call below targets an endpoint whose real
 * requireRole allowlist permits `admin` (Phase 4 allowlist discipline):
 *   - GET /api/admin/shifts            → admin, senior-guard
 *   - GET /api/entries/on-premise      → admin, senior-guard
 *   - GET /api/entries/deliveries      → admin, senior-guard
 *   - GET /api/auto-approval-rules     → admin, senior-guard
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { LogOut, RefreshCw, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ApiResult } from "@/lib/api/types";
import { shiftsApi } from "@/lib/api/shifts";
import { exitTrackingApi } from "@/lib/api/exit-tracking";
import { deliveryApi } from "@/lib/api/deliveries";
import { autoApprovalApi } from "@/lib/api/auto-approval";
import { useAuth } from "@/features/auth/AuthContext";
import { AccountProvisioningPanel } from "./AccountProvisioningPanel";
import { WatchlistPanel } from "./WatchlistPanel";

type PanelState<T> =
  | { status: "loading" }
  | { status: "error"; code: string; message: string }
  | { status: "ready"; data: T };

function usePanel<T>(fetcher: (signal?: AbortSignal) => Promise<ApiResult<T>>) {
  const [state, setState] = useState<PanelState<T>>({ status: "loading" });
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    void fetcher(controller.signal).then((res) => {
      if (controller.signal.aborted) return;
      if (res.ok) {
        setState({ status: "ready", data: res.data });
      } else {
        setState({
          status: "error",
          code: res.error.code,
          message: res.error.message,
        });
      }
    });
    return () => controller.abort();
  }, [fetcher, nonce]);

  return { state, reload };
}

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <header className="mb-3">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {subtitle && (
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        )}
      </header>
      {children}
    </section>
  );
}

function PanelBody<T>({
  state,
  empty,
  render,
}: {
  state: PanelState<T>;
  empty: string;
  render: (data: T) => ReactNode;
}): ReactNode {
  if (state.status === "loading") {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading…
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div
        role="alert"
        className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
      >
        <span className="font-medium">{state.code}</span> — {state.message}
      </div>
    );
  }
  return render(state.data) ?? <p className="py-4 text-sm text-muted-foreground">{empty}</p>;
}

export function AdminDashboard() {
  const { me, signOut } = useAuth();

  const fetchShifts = useMemo(
    () => (signal?: AbortSignal) => shiftsApi.listShifts({}, signal),
    [],
  );
  const fetchOnPremise = useMemo(
    () => (signal?: AbortSignal) => exitTrackingApi.listOnPremise(signal),
    [],
  );
  const fetchDeliveries = useMemo(
    () => (signal?: AbortSignal) => deliveryApi.listDeliveries(signal),
    [],
  );
  const fetchRules = useMemo(
    () => (signal?: AbortSignal) => autoApprovalApi.listRules(signal),
    [],
  );

  const shifts = usePanel(fetchShifts);
  const onPremise = usePanel(fetchOnPremise);
  const deliveries = usePanel(fetchDeliveries);
  const rules = usePanel(fetchRules);

  const reloadAll = () => {
    shifts.reload();
    onPremise.reload();
    deliveries.reload();
    rules.reload();
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <div>
            <h1 className="text-lg font-semibold text-foreground">
              GatePass — Admin
            </h1>
            <p className="text-xs text-muted-foreground">
              {me ? `${me.name} · ${me.role}` : "Administrator"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={reloadAll}>
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
              Refresh
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void signOut()}>
              <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-5xl grid-cols-1 gap-4 p-4 md:grid-cols-2">
        <AccountProvisioningPanel />

        <WatchlistPanel />

        <Panel
          title="Currently on premise"
          subtitle="Visitors who entered but have not exited"
        >
          <PanelBody
            state={onPremise.state}
            empty="No one is currently on premise."
            render={(data) =>
              data.entries.length === 0 ? null : (
                <ul className="divide-y divide-border text-sm">
                  {data.entries.map((e) => (
                    <li key={e.id} className="flex justify-between py-2">
                      <span className="font-medium text-foreground">
                        {e.visitorName}
                      </span>
                      <span className="text-muted-foreground">
                        {e.host} · {e.unit}
                      </span>
                    </li>
                  ))}
                </ul>
              )
            }
          />
        </Panel>

        <Panel title="Deliveries" subtitle="Logged delivery entries">
          <PanelBody
            state={deliveries.state}
            empty="No deliveries logged."
            render={(data) =>
              data.entries.length === 0 ? null : (
                <ul className="divide-y divide-border text-sm">
                  {data.entries.map((e) => (
                    <li key={e.id} className="flex justify-between py-2">
                      <span className="font-medium text-foreground">
                        {e.visitorName}
                      </span>
                      <span className="text-muted-foreground">
                        {e.deliveryCategory} · {e.unit}
                      </span>
                    </li>
                  ))}
                </ul>
              )
            }
          />
        </Panel>

        <Panel
          title="Shift log"
          subtitle="Per-guard activity for the current window"
        >
          <PanelBody
            state={shifts.state}
            empty="No shift activity in this window."
            render={(data) =>
              data.shifts.length === 0 ? null : (
                <ul className="divide-y divide-border text-sm">
                  {data.shifts.map((s) => (
                    <li key={s.guardId} className="flex justify-between py-2">
                      <span className="font-medium text-foreground">
                        {s.guardName}{" "}
                        <span className="text-muted-foreground">
                          #{s.badgeNumber}
                        </span>
                      </span>
                      <span className="text-muted-foreground">
                        {s.totals.entries} entries · {s.totals.approvalsDenied}{" "}
                        denied
                      </span>
                    </li>
                  ))}
                </ul>
              )
            }
          />
        </Panel>

        <Panel
          title="Auto-approval rules"
          subtitle="Active pre-authorizations"
        >
          <PanelBody
            state={rules.state}
            empty="No auto-approval rules."
            render={(data) =>
              data.rules.length === 0 ? null : (
                <ul className="divide-y divide-border text-sm">
                  {data.rules.map((r) => (
                    <li key={r.id} className="flex justify-between py-2">
                      <span className="font-medium text-foreground">
                        {r.visitorName}
                      </span>
                      <span className="text-muted-foreground">
                        {r.host} · {r.unit} · {r.active ? "active" : "inactive"}
                      </span>
                    </li>
                  ))}
                </ul>
              )
            }
          />
        </Panel>
      </main>
    </div>
  );
}
