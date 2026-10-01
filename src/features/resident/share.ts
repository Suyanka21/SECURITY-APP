/**
 * GatePass — resident pass sharing helpers.
 *
 * Source: src/docs/specs/resident-portal.md §4.3. The resident forwards the
 * pass link themselves: native share sheet → WhatsApp (wa.me) → clipboard.
 * The PIN is deliberately NOT part of the shared text; it is sent separately.
 */

import type { VisitorInvitationIssuedView } from "@/lib/api/types";

/** Normalizes a Kenyan mobile number (07…, 7…, 254…, +254…) to E.164. */
export function normalizeKenyanPhone(input: string): string | null {
  const digits = input.replace(/[\s()-]/g, "");
  let e164: string;
  if (/^\+\d+$/.test(digits)) e164 = digits;
  else if (/^254\d{9}$/.test(digits)) e164 = `+${digits}`;
  else if (/^0[17]\d{8}$/.test(digits)) e164 = `+254${digits.slice(1)}`;
  else if (/^[17]\d{8}$/.test(digits)) e164 = `+254${digits}`;
  else return null;
  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : null;
}

export function formatPassExpiry(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function passShareText(
  pass: Pick<VisitorInvitationIssuedView, "visitorName" | "unit" | "expiresAt" | "passUrl">,
): string {
  return (
    `Hi ${pass.visitorName}, here is your gate pass for ${pass.unit}. ` +
    `Show the QR code at the gate. Valid until ${formatPassExpiry(pass.expiresAt)}, one entry only.\n` +
    pass.passUrl
  );
}

export function whatsappShareUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}
