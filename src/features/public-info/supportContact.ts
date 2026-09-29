/**
 * Support / incident contact shown on the public pages.
 *
 * Read from build-time env so an estate can set its own desk without a code
 * change. When nothing is configured the pages say so plainly instead of
 * inventing a contact — a visitor must never be sent to a made-up address.
 */
export interface SupportContact {
  email: string | null;
  phone: string | null;
  configured: boolean;
}

// Deliberately strict: a value that is not plainly an address or a dialable
// number is dropped (and the page says "not configured") rather than rendered
// into a mailto:/tel: link.
const EMAIL_RE = /^[^\s@<>"'()/\\]+@[^\s@<>"'()/\\]+\.[A-Za-z]{2,}$/;
const PHONE_RE = /^\+?[0-9][0-9 ()-]{5,19}$/;

function clean(value: unknown, re: RegExp): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return v.length > 0 && re.test(v) ? v : null;
}

export function readSupportContact(
  env: Record<string, unknown> = import.meta.env as unknown as Record<string, unknown>
): SupportContact {
  const email = clean(env.VITE_SUPPORT_EMAIL, EMAIL_RE);
  const phone = clean(env.VITE_SUPPORT_PHONE, PHONE_RE);
  return { email, phone, configured: email !== null || phone !== null };
}
