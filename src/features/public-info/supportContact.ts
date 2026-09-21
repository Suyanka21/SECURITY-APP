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

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return v.length > 0 ? v : null;
}

export function readSupportContact(
  env: Record<string, unknown> = import.meta.env as unknown as Record<string, unknown>
): SupportContact {
  const email = clean(env.VITE_SUPPORT_EMAIL);
  const phone = clean(env.VITE_SUPPORT_PHONE);
  return { email, phone, configured: email !== null || phone !== null };
}
