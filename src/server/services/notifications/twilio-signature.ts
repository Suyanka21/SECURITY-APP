/**
 * GatePass — Twilio webhook signature check (X-Twilio-Signature).
 *
 * Source: https://www.twilio.com/docs/usage/webhooks/webhooks-security
 * The signature is base64(HMAC-SHA1(authToken, url + each POST param name
 * and value, params sorted by name)). `url` must be the exact public URL
 * Twilio called, so it is built from APP_PUBLIC_ORIGIN, never from the
 * request's Host header.
 */

import { createHmac, timingSafeEqual } from "crypto";

export function computeTwilioSignature(
  url: string,
  params: Record<string, string>,
  authToken: string,
): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export function isValidTwilioSignature(
  signature: string | undefined,
  url: string,
  params: Record<string, string>,
  authToken: string,
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(computeTwilioSignature(url, params, authToken));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
