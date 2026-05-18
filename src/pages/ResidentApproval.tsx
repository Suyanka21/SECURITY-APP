/**
 * Resident magic-link approval page.
 * Source: src/docs/specs/resident-approval-flow.md §10 (resident UI).
 *
 * Mounted at /approve/:id. The single-use token comes in via the
 * `?token=` query string. The page fetches the current approval status
 * once on mount (so an already-decided link shows the outcome instead
 * of a useless form), then lets the resident approve or deny.
 *
 * Auth model (spec §11): the token in the URL IS the credential. No
 * JWT, no cookies. The resident does not need an account.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Loader2,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import {
  guardApprovalApi,
  residentApprovalApi,
} from "@/lib/api/approvals";
import type { ApprovalRequestView } from "@/lib/api/types";

type Phase =
  | { kind: "loading" }
  | { kind: "missing-token" }
  | { kind: "ready"; approval: ApprovalRequestView }
  | { kind: "deciding"; approval: ApprovalRequestView; decision: "approve" | "deny" }
  | { kind: "decided"; approval: ApprovalRequestView }
  | { kind: "error"; code: string; message: string; traceId?: string };

export interface ResidentApprovalProps {
  /** Test seam — overrides the guard status fetcher. */
  guardApi?: typeof guardApprovalApi;
  /** Test seam — overrides the resident decide endpoint. */
  residentApi?: typeof residentApprovalApi;
}

export default function ResidentApproval({
  guardApi = guardApprovalApi,
  residentApi = residentApprovalApi,
}: ResidentApprovalProps = {}) {
  const { id } = useParams<{ id: string }>();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const token = search.get("token") ?? "";

  const [phase, setPhase] = useState<Phase>(() =>
    token.length === 0 ? { kind: "missing-token" } : { kind: "loading" }
  );
  const [reason, setReason] = useState("");

  // Fetch the current status once on mount so a stale or already-
  // decided link shows the outcome instead of pretending to be live.
  // We intentionally do NOT poll here — the resident's page is
  // user-driven, not background-driven. If the link expires while
  // the page sits open, the /decide call will fail explicitly and
  // we surface that.
  useEffect(() => {
    if (!id || token.length === 0) return;
    let cancelled = false;
    (async () => {
      const result = await guardApi.getApprovalStatus(id);
      if (cancelled) return;
      if (!result.ok) {
        setPhase({
          kind: "error",
          code: result.error.code,
          message: result.error.message,
          traceId: result.error.traceId,
        });
        return;
      }
      const approval = result.data.approval;
      if (approval.status !== "pending") {
        setPhase({ kind: "decided", approval });
      } else {
        setPhase({ kind: "ready", approval });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, token, guardApi]);

  const decide = useCallback(
    async (decision: "approve" | "deny") => {
      if (phase.kind !== "ready") return;
      if (!id) return;
      if (decision === "deny" && reason.trim().length === 0) {
        setPhase({
          kind: "error",
          code: "REASON_REQUIRED",
          message: "Please provide a brief reason so the guard can explain.",
        });
        return;
      }
      setPhase({ kind: "deciding", approval: phase.approval, decision });
      const result = await residentApi.decideApproval(id, {
        token,
        decision,
        reason: decision === "deny" ? reason.trim() : undefined,
      });
      if (!result.ok) {
        setPhase({
          kind: "error",
          code: result.error.code,
          message: result.error.message,
          traceId: result.error.traceId,
        });
        return;
      }
      setPhase({ kind: "decided", approval: result.data.approval });
    },
    [phase, id, token, reason, residentApi]
  );

  const visitorLine = useMemo(() => {
    if (phase.kind === "ready" || phase.kind === "deciding" || phase.kind === "decided") {
      const a = phase.approval;
      return `${a.visitorName} → ${a.host} (Unit ${a.unit})`;
    }
    return null;
  }, [phase]);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-5 px-4 py-8 md:px-6 md:py-12">
        <header className="flex items-center gap-3">
          <ShieldCheck
            className="h-8 w-8 text-primary"
            aria-hidden="true"
          />
          <div>
            <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
              GatePass
            </p>
            <h1 className="font-display text-2xl font-bold">
              Resident approval
            </h1>
          </div>
        </header>

        {phase.kind === "missing-token" && (
          <section
            role="alert"
            className="border border-destructive bg-destructive/10 p-5 text-destructive"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle
                className="mt-0.5 h-5 w-5 shrink-0"
                aria-hidden="true"
              />
              <div>
                <h2 className="font-display text-lg font-bold">
                  Missing token
                </h2>
                <p className="mt-1 text-sm">
                  This approval link is incomplete. Ask the guard to resend it.
                </p>
              </div>
            </div>
          </section>
        )}

        {phase.kind === "loading" && (
          <section className="flex items-center gap-3 border border-border bg-card p-5 shadow-panel">
            <Loader2
              className="h-5 w-5 animate-spin text-info-foreground"
              aria-hidden="true"
            />
            <p className="text-sm font-semibold text-muted-foreground">
              Checking the request…
            </p>
          </section>
        )}

        {(phase.kind === "ready" || phase.kind === "deciding") && visitorLine && (
          <section className="border border-info bg-info/5 p-5 shadow-panel">
            <p className="text-xs font-bold uppercase tracking-widest text-info-foreground">
              You're being asked to approve a walk-in
            </p>
            <h2 className="mt-2 font-display text-3xl font-bold text-foreground">
              {visitorLine}
            </h2>
            {phase.approval.reason && (
              <p className="mt-3 text-sm text-muted-foreground">
                <span className="font-semibold">Reason from guard:</span>{" "}
                {phase.approval.reason}
              </p>
            )}
            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <Clock3 className="h-4 w-4" aria-hidden="true" />
              Expires{" "}
              {new Date(phase.approval.expiresAt).toLocaleString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </div>

            <label
              htmlFor="deny-reason"
              className="mt-5 grid gap-2 text-sm font-semibold text-foreground"
            >
              If denying, please tell the guard why (required to deny)
              <textarea
                id="deny-reason"
                className="focus-ring min-h-20 border border-input bg-background px-3 py-3 text-base font-medium"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="e.g. Not expected today"
                maxLength={200}
                disabled={phase.kind === "deciding"}
              />
            </label>

            <div className="mt-5 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                className="focus-ring flex-1 bg-success px-5 py-4 font-display text-lg font-bold text-success-foreground shadow-panel transition-transform hover:-translate-y-0.5 disabled:opacity-60"
                disabled={phase.kind === "deciding"}
                onClick={() => void decide("approve")}
              >
                {phase.kind === "deciding" && phase.decision === "approve"
                  ? "Approving…"
                  : "Approve"}
              </button>
              <button
                type="button"
                className="focus-ring flex-1 border border-destructive bg-card px-5 py-4 font-display text-lg font-bold text-destructive shadow-panel transition-transform hover:-translate-y-0.5 disabled:opacity-60"
                disabled={phase.kind === "deciding"}
                onClick={() => void decide("deny")}
              >
                {phase.kind === "deciding" && phase.decision === "deny"
                  ? "Denying…"
                  : "Deny"}
              </button>
            </div>
          </section>
        )}

        {phase.kind === "decided" && (
          <section
            role="status"
            aria-live="polite"
            className={`border p-5 shadow-panel ${
              phase.approval.status === "approved"
                ? "border-success bg-success/10"
                : phase.approval.status === "denied"
                  ? "border-destructive bg-destructive/10"
                  : "border-warning bg-warning/10"
            }`}
          >
            <div className="flex items-start gap-3">
              {phase.approval.status === "approved" ? (
                <CheckCircle2
                  className="mt-0.5 h-7 w-7 text-success"
                  aria-hidden="true"
                />
              ) : phase.approval.status === "denied" ? (
                <XCircle
                  className="mt-0.5 h-7 w-7 text-destructive"
                  aria-hidden="true"
                />
              ) : (
                <AlertTriangle
                  className="mt-0.5 h-7 w-7 text-warning"
                  aria-hidden="true"
                />
              )}
              <div>
                <h2 className="font-display text-2xl font-bold">
                  {phase.approval.status === "approved"
                    ? "Approved"
                    : phase.approval.status === "denied"
                      ? "Denied"
                      : "Expired"}
                </h2>
                <p className="mt-1 text-sm">
                  {phase.approval.status === "approved"
                    ? "The guard has been notified. The visitor can enter."
                    : phase.approval.status === "denied"
                      ? "The guard has been notified. The visitor will be turned away."
                      : "This approval link timed out before a decision was recorded. Ask the guard to send a new one."}
                </p>
                {phase.approval.deniedReason && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Reason recorded: {phase.approval.deniedReason}
                  </p>
                )}
              </div>
            </div>
            <button
              type="button"
              className="focus-ring mt-5 border border-border px-5 py-3 font-semibold"
              onClick={() => navigate("/")}
            >
              Close
            </button>
          </section>
        )}

        {phase.kind === "error" && (
          <section
            role="alert"
            className="border border-destructive bg-destructive/10 p-5 text-destructive"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle
                className="mt-0.5 h-5 w-5 shrink-0"
                aria-hidden="true"
              />
              <div>
                <h2 className="font-display text-lg font-bold">
                  {phase.code}
                </h2>
                <p className="mt-1 text-sm">{phase.message}</p>
                {phase.traceId && (
                  <p className="mt-2 text-xs opacity-80">
                    Trace: <code>{phase.traceId}</code>
                  </p>
                )}
              </div>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
