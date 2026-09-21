import { Link } from "react-router-dom";

export const PUBLIC_INFO_LINKS = [
  { to: "/legal/privacy", label: "Privacy notice" },
  { to: "/legal/terms", label: "Terms of use" },
  { to: "/support", label: "Support" },
  { to: "/support/incident", label: "Report a problem" },
] as const;

/**
 * Role-neutral footer. Mounted on every public surface (visitor pass, resident
 * approval, login, 404, and the info pages themselves) so the people whose data
 * GatePass holds can always reach the privacy notice and a way to report a
 * problem — without needing an account.
 */
export function PublicFooter() {
  return (
    <footer
      data-testid="public-footer"
      className="mt-6 border-t border-border pt-4 text-xs text-muted-foreground"
    >
      <nav aria-label="Legal and support">
        <ul className="flex flex-wrap gap-x-4 gap-y-1">
          {PUBLIC_INFO_LINKS.map((l) => (
            <li key={l.to}>
              <Link to={l.to} className="underline-offset-4 hover:underline">
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <p className="mt-2">
        Legal and privacy pages are drafts pending professional review.
      </p>
    </footer>
  );
}
