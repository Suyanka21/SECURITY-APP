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

type PageState =
  | { kind: "loading" }
  | { kind: "loaded"; invitation: VisitorInvitationPreviewView }
  | { kind: "error"; code: string; message: string };

// The server speaks INVITATION_*; earlier drafts of this page keyed off QR_*
// codes, so both spellings are accepted rather than silently falling through
// to the generic "Could not load pass" panel.
function titleForCode(code: string): string {
  if (code === "INVITATION_LOCKED" || code === "QR_LOCKED") return "Locked";
  if (code === "INVITATION_EXPIRED" || code === "QR_EXPIRED")
    return "Pass expired";
  if (code === "INVITATION_CONSUMED" || code === "QR_CONSUMED")
    return "Pass already used";
  if (code === "INVITATION_NOT_FOUND" || code === "QR_NOT_FOUND")
    return "Pass not found";
  return "Could not load pass";
}

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
      setState({
        kind: "error",
        code: "INVITATION_NOT_FOUND",
        message: "Missing token in URL.",
      });
      return;
    }
    setState({ kind: "loading" });
    const result = await api.previewInvitation(token);
    if (!result.ok) {
      // No silent success: surface the server's exact error code.
      setState({
        kind: "error",
        code: result.error.code,
        message: result.error.message,
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

        {state.kind === "error" && (
          <section
            role="alert"
            className="border border-destructive bg-destructive/10 p-5"
            data-testid="visitor-pass-error"
          >
            <div className="flex items-start gap-3">
              {state.code === "INVITATION_LOCKED" ||
              state.code === "QR_LOCKED" ? (
                <Lock className="mt-0.5 h-6 w-6 text-destructive" />
              ) : state.code === "INVITATION_EXPIRED" ||
                state.code === "QR_EXPIRED" ? (
                <Clock3 className="mt-0.5 h-6 w-6 text-destructive" />
              ) : state.code === "INVITATION_CONSUMED" ||
                state.code === "QR_CONSUMED" ? (
                <ShieldAlert className="mt-0.5 h-6 w-6 text-destructive" />
              ) : (
                <AlertTriangle className="mt-0.5 h-6 w-6 text-destructive" />
              )}
              <div>
                <p
                  className="font-display text-xl font-bold text-destructive"
                  data-testid="visitor-pass-error-title"
                >
                  {titleForCode(state.code)}
                </p>
                <p
                  className="mt-1 text-sm font-semibold text-destructive"
                  data-testid="visitor-pass-error-code"
                >
                  {state.code}
                </p>
                <p className="mt-2 text-sm text-foreground">{state.message}</p>
                <p className="mt-3 text-sm text-muted-foreground">
                  Ask your host to issue a new pass.
                </p>
                {(state.code === "INVITATION_LOCKED" ||
                  state.code === "QR_LOCKED") && (
                  <p
                    className="mt-1 text-sm text-muted-foreground"
                    data-testid="visitor-pass-locked-note"
                  >
                    This pass was locked after too many incorrect PIN attempts.
                    The guard cannot let you in with it.
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
