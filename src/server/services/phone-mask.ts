/**
 * GatePass — phone masking for every staff-facing response.
 *
 * A resident's full number never leaves the server except in that
 * resident's own responses (claim, /api/resident/me).
 */

/**
 * Masks an E.164 number so at least half its digits are hidden:
 * 12+ digits keep the first 3 and last 3, shorter numbers the first 1 and
 * last 2 (`+254712345678` -> `+254••••••678`).
 */
export function maskPhoneE164(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  const [head, tail] = digits.length >= 12 ? [3, 3] : digits.length >= 6 ? [1, 2] : [0, 0];
  const hidden = digits.length - head - tail;
  return `+${digits.slice(0, head)}${"•".repeat(hidden)}${tail > 0 ? digits.slice(-tail) : ""}`;
}
