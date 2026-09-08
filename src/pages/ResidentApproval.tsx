/**
 * Resident magic-link approval page.
 * Source: src/docs/specs/resident-approval-flow.md §10 (resident UI).
 *
 * Mounted at /approve/:id. The single-use token comes in via the
 * `?token=` query string. The page previews the request once on mount
 * (so an already-decided link shows the outcome instead of a useless
 * form), then lets the resident approve or deny.
 *
 * Auth model (spec §11): the token in the URL IS the credential. No
 * JWT, no cookies. The resident does not need an account — which is
 * why both calls go through `residentApprovalApi`, never the guard's.
 *
 * This is a public surface: every failure is rendered in plain language.
 * Backend error codes and messages are mapped, never shown verbatim.
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
import { residentApprovalApi } from "@/lib/api/approvals";
import type { ApprovalRequestView } from "@/lib/api/types";

type Phase =
  | { kind: "loading" }
  | { kind: "missing-token" }
  | { kind: "ready"; approval: ApprovalRequestView }
  | { kind: "deciding"; approval: ApprovalRequestView; decision: "approve" | "deny" }
  | { kind: "decided"; approval: ApprovalRequestView }
  | { kind: "error"; code: string; traceId?: string };

interface PublicError {
  title: string;
  body: string;
}

/**
 * Maps every code the resident page can receive to words a resident can
 * act on. Unknown codes fall through to a generic retry message — the
 * code itself is never rendered.
 */
export function describeApprovalError(code: string): PublicError {
  switch (code) {
    case "APPROVAL_TOKEN_INVALID":
      return {
        title: "This link isn't valid",
        body: "The approval link is incomplete or has been altered. Open the link exactly as the guard sent it, or ask them to send a new one.",
      };
    case "APPROVAL_NOT_FOUND":
      return {
        title: "Request not found",
        body: "We couldn't find this approval request. It may have been removed, or the link may be incomplete. Ask the guard to send a new one.",
      };
    case "APPROVAL_ALREADY_DECIDED":
    case "TOKEN_ALREADY_USED":
      return {
        title: "Already handled",
        body: "A decision has already been recorded for this request, so this link can't be used again. If that wasn't you, contact the gate.",
      };
    case "APPROVAL_EXPIRED":
      return {
        title: "Request expired",
        body: "This approval link timed out before a decision was recorded. Ask the guard to send a new one.",
      };
    case "RATE_LIMITED":
    case "RATE_LIMIT_EXCEEDED":
      return {
        title: "Too many attempts",
        body: "Please wait a minute and open the link again.",
      };
    case "NETWORK_ERROR":
    case "REQUEST_TIMEOUT":
      return {
        title: "Couldn't reach the gate",
        body: "Check your connection and try again. The request is still waiting for you.",
      };
    default:
      return {
        title: "Something went wrong",
        body: "We couldn't load this request right now. Try again in a moment, or ask the guard for help.",
      };
  }
}

export interface ResidentApprovalProps {
  /** Test seam — overrides the resident preview/decide endpoints. */
  residentApi?: typeof residentApprovalApi;
}

export default function ResidentApproval({
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
  const [reasonMissing, setReasonMissing] = useState(false);

  // Preview the request once on mount so a stale or already-decided
  // link shows the outcome instead of pretending to be live.
  // We intentionally do NOT poll here — the resident's page is
  // user-driven, not background-driven. If the link expires while
  // the page sits open, the /decide call will fail explicitly and
  // we surface that.
  useEffect(() => {
    if (!id || token.length === 0) return;
    let cancelled = false;
    (async () => {
      const result = await residentApi.previewApproval(id, { token });
      if (cancelled) return;
      if (!result.ok) {
        setPhase({
          kind: "error",
          code: result.error.code,
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
  }, [id, token, residentApi]);

  const decide = useCallback(
    async (decision: "approve" | "deny") => {
      if (phase.kind !== "ready") return;
      if (!id) return;
      if (decision === "deny" && reason.trim().length === 0) {
        setReasonMissing(true);
        return;
      }
      setReasonMissing(false);
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
                onChange={(event) => {
                  setReason(event.target.value);
                  if (event.target.value.trim().length > 0) setReasonMissing(false);
                }}
                placeholder="e.g. Not expected today"
                maxLength={200}
                disabled={phase.kind === "deciding"}
                aria-invalid={reasonMissing || undefined}
                aria-describedby={reasonMissing ? "deny-reason-hint" : undefined}
              />
            </label>
            {reasonMissing && (
              <p
                id="deny-reason-hint"
                role="alert"
                className="mt-2 text-sm font-semibold text-destructive"
              >
                Please add a brief reason so the guard can explain the refusal.
              </p>
            )}

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
                  {describeApprovalError(phase.code).title}
                </h2>
                <p className="mt-1 text-sm">
                  {describeApprovalError(phase.code).body}
                </p>
                {phase.traceId && (
                  <p className="mt-2 text-xs opacity-80">
                    Support reference: <code>{phase.traceId}</code>
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
