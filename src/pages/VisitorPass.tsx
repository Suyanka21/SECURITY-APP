/**
 * Visitor-facing pass page.
 * Source: src/docs/specs/guest-qr-ticket.md §7 (visitor UI), §A6/A8
 * (security model — pass page is read-only, QR rendered client-side).
 *
 * Mounted at /pass/:token. The token in the URL IS the credential
 * (same magic-link pattern as Feature 1). The page does NOT consume
 * the QR — consumption happens server-side only when the guard scans
 * at the gate (qr-service.validateQrToken). This page only renders.
 *
 * Error contract (no-silent-success):
 *   404 INVITATION_NOT_FOUND → "Pass not found" panel
 *   410 INVITATION_EXPIRED   → "Pass expired" panel
 *   410 INVITATION_CONSUMED  → "Pass already used" panel
 *   423 INVITATION_LOCKED    → "Locked" panel (Feature 11 PIN limiter)
 *   Network / other 5xx      → "Could not load pass" panel + retry
 *
 * A locked pass must never render as a valid pass: the guard's gate check
 * will refuse it, so the visitor is told here instead of at the barrier.
 *
 * Default-deny: the QR is rendered ONLY when status is "loaded" and
 * the server returned a 200 with a valid preview payload. Any non-OK
 * response keeps the page in an explicit error state — no fallback
 * QR is ever rendered.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { AlertTriangle, Clock3, Loader2, Lock, ShieldAlert } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { visitorInvitationsApi } from "@/lib/api/visitor-invitations";
import type {
  PreviewVisitorInvitationResponse,
  VisitorInvitationPreviewView,
} from "@/lib/api/types";
import { describePassError } from "./visitor-pass-errors";

type PageState =
  | { kind: "loading" }
  | { kind: "loaded"; invitation: VisitorInvitationPreviewView }
  | { kind: "error"; code: string; traceId?: string };

interface VisitorPassProps {
  // Optional injection for tests; defaults to the real API client.
  api?: typeof visitorInvitationsApi;
}

export default function VisitorPass({ api = visitorInvitationsApi }: VisitorPassProps = {}) {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<PageState>({ kind: "loading" });

  const passUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    return `${window.location.origin}/pass/${encodeURIComponent(token ?? "")}`;
  }, [token]);

  const load = useCallback(async () => {
    if (!token) {
      setState({ kind: "error", code: "INVITATION_NOT_FOUND" });
      return;
    }
    setState({ kind: "loading" });
    const result = await api.previewInvitation(token);
    if (!result.ok) {
      // No silent success: keep the exact code for the panel to classify,
      // but it is described in plain language, never shown.
      setState({
        kind: "error",
        code: result.error.code,
        traceId: result.error.traceId,
      });
      return;
    }
    const data = result.data as PreviewVisitorInvitationResponse;
    setState({ kind: "loaded", invitation: data.invitation });
  }, [api, token]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div
        className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 py-8 md:py-12"
        data-testid="visitor-pass-page"
      >
        <header>
          <h1 className="font-display text-3xl font-bold">Visitor pass</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Show this QR to the guard at the gate.
          </p>
        </header>

        {state.kind === "loading" && (
          <section
            className="flex items-center gap-3 border border-border bg-card p-5"
            data-testid="visitor-pass-loading"
          >
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <p className="text-sm font-semibold text-muted-foreground">
              Loading your pass…
            </p>
          </section>
        )}

        {state.kind === "loaded" && (
          <section
            className="border border-primary bg-card p-5 shadow-panel"
            data-testid="visitor-pass-loaded"
          >
            <div className="flex flex-col items-center gap-4">
              <div className="bg-white p-4" data-testid="visitor-pass-qr">
                <QRCodeSVG
                  value={passUrl}
                  size={220}
                  level="M"
                  includeMargin
                />
              </div>
              <div className="w-full">
                <p className="font-display text-2xl font-bold">
                  {state.invitation.visitorName}
                </p>
                <dl className="mt-3 grid gap-2 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="font-semibold text-muted-foreground">
                      Host
                    </dt>
                    <dd
                      className="text-right"
                      data-testid="visitor-pass-host"
                    >
                      {state.invitation.host}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="font-semibold text-muted-foreground">
                      Unit
                    </dt>
                    <dd
                      className="text-right"
                      data-testid="visitor-pass-unit"
                    >
                      {state.invitation.unit}
                    </dd>
                  </div>
                  {state.invitation.plate && (
                    <div className="flex justify-between gap-3">
                      <dt className="font-semibold text-muted-foreground">
                        Plate
                      </dt>
                      <dd
                        className="text-right"
                        data-testid="visitor-pass-plate"
                      >
                        {state.invitation.plate}
                      </dd>
                    </div>
                  )}
                  <div className="flex justify-between gap-3">
                    <dt className="font-semibold text-muted-foreground">
                      Valid until
                    </dt>
                    <dd
                      className="text-right"
                      data-testid="visitor-pass-expires"
                    >
                      <time dateTime={state.invitation.expiresAt}>
                        {new Date(state.invitation.expiresAt).toLocaleString()}
                      </time>
                    </dd>
                  </div>
                </dl>
              </div>
              <p
                className="border-t border-border pt-3 text-center text-xs italic text-muted-foreground"
                data-testid="visitor-pass-single-use-note"
              >
                This pass is single-use. After the guard scans it,
                it cannot be reused.
              </p>
            </div>
          </section>
        )}

        {state.kind === "error" && (() => {
          const err = describePassError(state.code);
          return (
            <section
              role="alert"
              className="border border-destructive bg-destructive/10 p-5"
              data-testid="visitor-pass-error"
              data-error-kind={err.kind}
            >
              <div className="flex items-start gap-3">
                {err.kind === "locked" ? (
                  <Lock className="mt-0.5 h-6 w-6 text-destructive" />
                ) : err.kind === "expired" ? (
                  <Clock3 className="mt-0.5 h-6 w-6 text-destructive" />
                ) : err.kind === "consumed" ? (
                  <ShieldAlert className="mt-0.5 h-6 w-6 text-destructive" />
                ) : (
                  <AlertTriangle className="mt-0.5 h-6 w-6 text-destructive" />
                )}
                <div>
                  <p
                    className="font-display text-xl font-bold text-destructive"
                    data-testid="visitor-pass-error-title"
                  >
                    {err.title}
                  </p>
                  <p
                    className="mt-2 text-sm text-foreground"
                    data-testid="visitor-pass-error-body"
                  >
                    {err.body}
                  </p>
                  <p className="mt-3 text-sm text-muted-foreground">{err.hint}</p>
                  {err.kind === "unavailable" && (
                    <button
                      type="button"
                      className="focus-ring mt-4 border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground"
                      onClick={() => void load()}
                    >
                      Try again
                    </button>
                  )}
                  {state.traceId && (
                    <p className="mt-3 text-xs text-muted-foreground">
                      Support reference: <code>{state.traceId}</code>
                    </p>
                  )}
                </div>
              </div>
            </section>
          );
        })()}
      </div>
    </main>
  );
}
