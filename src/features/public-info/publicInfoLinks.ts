import { LEGAL_TEXT_APPROVED } from "./legalStatus";

const LEGAL_LINKS = [
  { to: "/legal/privacy", label: "Privacy notice" },
  { to: "/legal/terms", label: "Terms of use" },
] as const;

const SUPPORT_LINKS = [
  { to: "/support", label: "Support" },
  { to: "/support/incident", label: "Report a problem" },
] as const;

/** Legal pages are omitted until their text is approved (see legalStatus.ts). */
export const PUBLIC_INFO_LINKS: ReadonlyArray<{ to: string; label: string }> =
  LEGAL_TEXT_APPROVED ? [...LEGAL_LINKS, ...SUPPORT_LINKS] : [...SUPPORT_LINKS];
