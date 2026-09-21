import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { PublicFooter } from "./PublicFooter";

export const DRAFT_LEGAL_LABEL =
  "DRAFT — NOT A LEGAL DOCUMENT. Not yet reviewed by a lawyer or compliance professional.";

/**
 * Unmissable banner for legal/privacy scaffolding. Rendered at the top AND
 * bottom of any page whose text has not been through professional review, so
 * there is no scroll position from which the page reads as final.
 */
export function DraftLegalBanner({ position }: { position: "top" | "bottom" }) {
  return (
    <div
      role="note"
      aria-label="Draft legal document notice"
      data-testid={`draft-legal-banner-${position}`}
      className="flex items-start gap-3 border-2 border-amber-600 bg-amber-100 p-4 text-amber-950"
    >
      <AlertTriangle className="mt-0.5 h-6 w-6 shrink-0" aria-hidden="true" />
      <div className="text-sm">
        <p className="font-display text-base font-bold uppercase tracking-wide">
          {DRAFT_LEGAL_LABEL}
        </p>
        <p className="mt-1">
          This page is placeholder scaffolding written by the engineering team so the
          estate and its legal adviser have something concrete to review. It creates no
          rights or obligations, and nothing on it should be relied on as legal advice.
          The estate operator must replace it with reviewed text before commercial use.
        </p>
      </div>
    </div>
  );
}

export function PublicInfoLayout({
  title,
  lede,
  draft,
  testId,
  children,
}: {
  title: string;
  lede: string;
  /** true for legal/privacy scaffolding → draft banners top and bottom */
  draft: boolean;
  testId: string;
  children: ReactNode;
}) {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div
        className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8 md:py-12"
        data-testid={testId}
      >
        <Link
          to="/"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to GatePass
        </Link>

        {draft && <DraftLegalBanner position="top" />}

        <header>
          <h1 className="font-display text-3xl font-bold">{title}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{lede}</p>
        </header>

        <div className="flex flex-col gap-6 text-sm leading-relaxed [&_h2]:font-display [&_h2]:text-lg [&_h2]:font-bold [&_ul]:list-disc [&_ul]:pl-5 [&_li]:mt-1">
          {children}
        </div>

        {draft && <DraftLegalBanner position="bottom" />}

        <PublicFooter />
      </div>
    </main>
  );
}
