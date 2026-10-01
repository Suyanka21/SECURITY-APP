/**
 * GatePass — resident capability 1: send a pass to an expected visitor.
 *
 * Source: src/docs/specs/resident-portal.md §4. Wraps the existing
 * invitation → /pass/:token → gate-scan flow. The body carries visitor
 * fields only; host and unit are set by the server from the resident row.
 * The link and PIN are shown once, in this component's state only — they
 * are never written to storage.
 */

import { useState, type FormEvent } from "react";
import { Copy, Loader2, MessageCircle, Send, Share2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { residentApi } from "@/lib/api/resident";
import type { VisitorInvitationIssuedView } from "@/lib/api/types";
import { formatPassExpiry, passShareText, whatsappShareUrl } from "./share";

const DURATIONS = [
  { hours: 4, label: "4 hours" },
  { hours: 12, label: "12 hours" },
  { hours: 24, label: "1 day" },
  { hours: 48, label: "2 days" },
] as const;

function describeIssueError(status: number, code: string, message: string): string {
  if (status === 0) return "No connection. Check your internet and try again.";
  if (code === "RESIDENT_PASS_LIMIT_REACHED") return message;
  if (status === 403) return "Your resident access is no longer active. Contact estate management.";
  if (status === 422) return message;
  if (status === 429) return "Too many passes sent. Please wait a while and try again.";
  return "Something went wrong creating the pass. Try again.";
}

export function SendPassCard() {
  const [visitorName, setVisitorName] = useState("");
  const [plate, setPlate] = useState("");
  const [ttlHours, setTtlHours] = useState<number>(24);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pass, setPass] = useState<VisitorInvitationIssuedView | null>(null);
  const [copied, setCopied] = useState<"link" | "pin" | null>(null);

  const canNativeShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!visitorName.trim()) {
      setError("Enter your visitor's name.");
      return;
    }
    setSubmitting(true);
    const result = await residentApi.issuePass({
      visitorName: visitorName.trim(),
      plate: plate.trim() ? plate.trim() : null,
      ttlHours,
    });
    setSubmitting(false);
    if (!result.ok) {
      setError(describeIssueError(result.status, result.error.code, result.error.message));
      return;
    }
    setPass(result.data.invitation);
  }

  async function copy(text: string, what: "link" | "pin") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
    } catch {
      setError("Couldn't copy. Select and copy it manually.");
    }
  }

  async function nativeShare(p: VisitorInvitationIssuedView) {
    try {
      await navigator.share({ title: "Gate pass", text: passShareText(p) });
    } catch {
      // Dismissing the share sheet is not an error.
    }
  }

  function reset() {
    setPass(null);
    setVisitorName("");
    setPlate("");
    setTtlHours(24);
    setCopied(null);
    setError(null);
  }

  return (
    <section
      className="rounded-lg border border-border bg-card p-5 shadow-sm"
      aria-labelledby="send-pass-title"
      data-testid="send-pass-card"
    >
      <div className="mb-4 flex items-center gap-2">
        <Send className="h-5 w-5 text-primary" aria-hidden="true" />
        <h2 id="send-pass-title" className="text-base font-semibold text-foreground">
          Send a pass to a visitor
        </h2>
      </div>

      {pass ? (
        <div className="space-y-4" data-testid="send-pass-result">
          <p className="text-sm text-muted-foreground">
            Pass for <span className="font-medium text-foreground">{pass.visitorName}</span>, valid
            until {formatPassExpiry(pass.expiresAt)}. One entry only.
          </p>
          <div className="flex justify-center rounded-md bg-white p-2">
            <QRCodeSVG value={pass.passUrl} size={180} level="M" includeMargin />
          </div>
          <div className="flex flex-wrap gap-2">
            {canNativeShare && (
              <Button onClick={() => void nativeShare(pass)} data-testid="send-pass-share">
                <Share2 className="mr-2 h-4 w-4" aria-hidden="true" />
                Share
              </Button>
            )}
            <Button asChild variant={canNativeShare ? "outline" : "default"}>
              <a
                href={whatsappShareUrl(passShareText(pass))}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="send-pass-whatsapp"
              >
                <MessageCircle className="mr-2 h-4 w-4" aria-hidden="true" />
                WhatsApp
              </a>
            </Button>
            <Button
              variant="outline"
              onClick={() => void copy(pass.passUrl, "link")}
              data-testid="send-pass-copy"
            >
              <Copy className="mr-2 h-4 w-4" aria-hidden="true" />
              {copied === "link" ? "Link copied" : "Copy link"}
            </Button>
          </div>
          <div className="rounded-md border border-border p-3 text-sm" data-testid="send-pass-pin">
            <p className="text-muted-foreground">
              Backup code if the QR won't scan. Send it in a <strong>separate</strong> message:
            </p>
            <p className="mt-1 font-mono text-base text-foreground">
              Pass {pass.passRef} · PIN {pass.pin}
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="mt-1 px-0"
              onClick={() => void copy(`Pass ${pass.passRef} PIN ${pass.pin}`, "pin")}
            >
              {copied === "pin" ? "Copied" : "Copy code"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            This link and PIN are shown only now. If you lose them, send a new pass.
          </p>
          <Button variant="secondary" className="w-full" onClick={reset} data-testid="send-pass-another">
            Send another pass
          </Button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="pass-visitor">Visitor's name</Label>
            <Input
              id="pass-visitor"
              maxLength={120}
              value={visitorName}
              onChange={(e) => setVisitorName(e.target.value)}
              disabled={submitting}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pass-plate">Car plate (optional)</Label>
            <Input
              id="pass-plate"
              maxLength={12}
              autoCapitalize="characters"
              placeholder="KCA 123A"
              value={plate}
              onChange={(e) => setPlate(e.target.value)}
              disabled={submitting}
            />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-foreground">Valid for</legend>
            <div className="flex flex-wrap gap-2">
              {DURATIONS.map((d) => (
                <Button
                  key={d.hours}
                  type="button"
                  size="sm"
                  variant={ttlHours === d.hours ? "default" : "outline"}
                  aria-pressed={ttlHours === d.hours}
                  onClick={() => setTtlHours(d.hours)}
                  disabled={submitting}
                >
                  {d.label}
                </Button>
              ))}
            </div>
          </fieldset>
          <Button type="submit" className="w-full" disabled={submitting} data-testid="send-pass-submit">
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            Create pass
          </Button>
        </form>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
