/**
 * Task 7.4 — public info pages.
 *
 * Proves, through the real App router:
 *   - /legal/privacy, /legal/terms, /support, /support/incident render without
 *     any auth, onboarding state or role
 *   - both legal pages carry the NEEDS LEGAL REVIEW banner top AND bottom, and
 *     every section lists what the legal adviser must decide
 *   - the operational pages (support, incident) do not claim to be legal text
 *   - no page hard-codes a fake contact; unconfigured → honest notice
 *   - the pages never render raw error codes, trace ids, tokens or PII
 *   - the footer is on every public surface and, while LEGAL_TEXT_APPROVED is
 *     false, no screen links to the legal placeholders
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/features/gatepass/GatePassApp", () => ({ GatePassApp: () => <div>console</div> }));
vi.mock("@/features/admin/AdminDashboard", () => ({ AdminDashboard: () => <div>admin</div> }));
vi.mock("@/features/auth/AuthContext", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({ status: "unauthenticated", me: null, signIn: vi.fn(), signOut: vi.fn() }),
}));

import App from "@/App";
import { PublicFooter } from "../PublicFooter";
import { PUBLIC_INFO_LINKS } from "../publicInfoLinks";
import { LEGAL_TEXT_APPROVED } from "../legalStatus";
import { DRAFT_LEGAL_LABEL } from "../PublicInfoLayout";
import { readSupportContact } from "../supportContact";

// App owns its own BrowserRouter; drive it through the real history API.
function renderAt(path: string) {
  window.history.pushState({}, "", path);
  return render(<App />);
}

const FORBIDDEN_ON_PUBLIC_PAGES = [
  /AUTH_[A-Z_]+/,
  /APPROVAL_[A-Z_]+/,
  /INVITATION_[A-Z_]+/,
  /QR_[A-Z_]+/,
  /trace-[0-9a-f]{8}-/i,
  /Bearer/,
  /service.role/i,
  /supabase/i,
  /postgres/i,
  /@example\.com/,
  /\+254\s?7\d{8}/, // no hard-coded phone numbers
];

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  window.history.pushState({}, "", "/");
});

describe("public info routes render without auth", () => {
  const cases: Array<[string, string, boolean]> = [
    ["/legal/privacy", "privacy-notice-page", true],
    ["/legal/terms", "terms-page", true],
    ["/support", "support-page", false],
    ["/support/incident", "incident-page", false],
  ];

  for (const [path, testId, isDraft] of cases) {
    it(`${path} renders, ${isDraft ? "with" : "without"} the DRAFT legal banners`, () => {
      renderAt(path);
      const page = screen.getByTestId(testId);
      expect(page).toBeInTheDocument();

      const top = screen.queryByTestId("draft-legal-banner-top");
      const bottom = screen.queryByTestId("draft-legal-banner-bottom");
      if (isDraft) {
        expect(top).toBeInTheDocument();
        expect(bottom).toBeInTheDocument();
        expect(top).toHaveTextContent(DRAFT_LEGAL_LABEL);
        expect(bottom).toHaveTextContent(DRAFT_LEGAL_LABEL);
        expect(top).toHaveTextContent(/needs legal review/i);
        expect(top).toHaveTextContent(/not a legal document/i);
        expect(top).toHaveTextContent(/not linked from any screen/i);
        // every section lists what the adviser must decide
        const reviewBoxes = within(page).getAllByTestId("needs-legal-review");
        expect(reviewBoxes.length).toBeGreaterThanOrEqual(6);
      } else {
        expect(top).not.toBeInTheDocument();
        expect(bottom).not.toBeInTheDocument();
      }

      // footer with all four links reachable from every info page
      const footer = within(page).getByTestId("public-footer");
      for (const l of PUBLIC_INFO_LINKS) {
        expect(within(footer).getByRole("link", { name: l.label })).toHaveAttribute("href", l.to);
      }

      // nothing internal on a public page
      const text = page.textContent ?? "";
      for (const re of FORBIDDEN_ON_PUBLIC_PAGES) expect(text, String(re)).not.toMatch(re);
    });
  }

  it("legal pages never assert a retention period, law or guarantee the system does not implement", () => {
    renderAt("/legal/privacy");
    const text = screen.getByTestId("privacy-notice-page").textContent ?? "";
    expect(text).toMatch(/To be set by the operator after review/);
    expect(text).not.toMatch(/\b(GDPR|Data Protection Act|Section \d+|guarantee)\b/i);

    cleanup();
    renderAt("/legal/terms");
    const terms = screen.getByTestId("terms-page").textContent ?? "";
    expect(terms).toMatch(/To be drafted by the legal reviewer/);
    expect(terms).not.toMatch(/governing law of|shall be liable for|warrant(s|y) that/i);
  });

  it("an unknown path still shows the footer (404 page is a public surface)", () => {
    renderAt("/definitely/not/a/route");
    expect(screen.getByText("404")).toBeInTheDocument();
    expect(screen.getByTestId("public-footer")).toBeInTheDocument();
  });
});

describe("support contact", () => {
  it("is honest when nothing is configured (no invented address)", () => {
    const c = readSupportContact({});
    expect(c).toEqual({ email: null, phone: null, configured: false });
    renderAt("/support");
    expect(screen.getByTestId("support-contact-unconfigured")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /@/ })).not.toBeInTheDocument();
  });

  it("reads and trims VITE_SUPPORT_EMAIL / VITE_SUPPORT_PHONE", () => {
    expect(
      readSupportContact({ VITE_SUPPORT_EMAIL: "  gate@estate.test ", VITE_SUPPORT_PHONE: "" })
    ).toEqual({ email: "gate@estate.test", phone: null, configured: true });
    expect(readSupportContact({ VITE_SUPPORT_PHONE: "0700000000" }).configured).toBe(true);
    expect(readSupportContact({ VITE_SUPPORT_PHONE: "+254 700 000 000" }).configured).toBe(true);
  });

  it("drops values that are not plainly an email or a dialable number", () => {
    const bad = [
      { VITE_SUPPORT_EMAIL: "javascript:alert(1)" },
      { VITE_SUPPORT_EMAIL: "gate@estate.test?subject=x&body=<b>" },
      { VITE_SUPPORT_EMAIL: "not-an-email" },
      { VITE_SUPPORT_EMAIL: "a b@estate.test" },
      { VITE_SUPPORT_PHONE: "call me" },
      { VITE_SUPPORT_PHONE: "+254700000000;phone-context=evil" },
      { VITE_SUPPORT_PHONE: "javascript:alert(1)" },
      { VITE_SUPPORT_PHONE: "12" },
    ];
    for (const env of bad) {
      expect(readSupportContact(env), JSON.stringify(env)).toEqual({
        email: null,
        phone: null,
        configured: false,
      });
    }
  });
});

describe("PublicFooter", () => {
  it("links only to the support pages while the legal text is unapproved", () => {
    expect(LEGAL_TEXT_APPROVED).toBe(false);
    render(
      <MemoryRouter>
        <PublicFooter />
      </MemoryRouter>
    );
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/support", "/support/incident"]);
    expect(screen.getByText(/will be linked here once reviewed/i)).toBeInTheDocument();
  });
});

describe("no screen links to a legal placeholder", () => {
  for (const path of ["/", "/support", "/support/incident", "/legal/privacy", "/legal/terms", "/nope"]) {
    it(`${path} has no link to /legal/*`, () => {
      const { container } = renderAt(path);
      const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
      expect(hrefs.filter((h) => h.startsWith("/legal"))).toEqual([]);
    });
  }
});
