/**
 * TLS settings for the standalone scripts' Postgres connections.
 *
 * Source: node-postgres SSL docs — https://node-postgres.com/features/ssl
 * Source: Supabase — SSL enforcement https://supabase.com/docs/guides/platform/ssl-enforcement
 *
 * Mirrors src/db/ssl.ts: a hosted database is verified by default.
 *   DATABASE_SSL_CA                   the project's CA certificate as PEM text ("\n" escapes allowed)
 *   DATABASE_SSL_ROOT_CERT            path to that certificate (Dashboard → Database → SSL → Download)
 *   DATABASE_SSL_REJECT_UNAUTHORIZED  "false" is an explicit, logged opt-out, honoured only for
 *                                     callers passing allowUnverified (the dev seed) and never
 *                                     when NODE_ENV=production
 * A localhost database uses no TLS.
 */

import { readFileSync } from "fs";

// URL.hostname keeps the brackets on IPv6 literals.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLocalHost(hostname) {
  return LOCAL_HOSTS.has(hostname);
}

// node-postgres lets TLS query params in the connection string override the
// `ssl` object, so they are removed and TLS comes only from scriptPgSsl().
const TLS_PARAMS = ["ssl", "sslmode", "sslrootcert", "sslcert", "sslkey", "sslpassword", "uselibpqcompat"];

export function stripTlsParams(databaseUrl) {
  const url = new URL(databaseUrl);
  for (const p of TLS_PARAMS) url.searchParams.delete(p);
  return url.toString();
}

const PEM_MARKER = "-----BEGIN CERTIFICATE-----";

function readCa(env) {
  const inline = env.DATABASE_SSL_CA?.trim();
  const path = env.DATABASE_SSL_ROOT_CERT?.trim();
  if (inline && path) throw new Error("Set only one of DATABASE_SSL_CA and DATABASE_SSL_ROOT_CERT");
  const pem = inline ? inline.replace(/\\n/g, "\n") : path ? readFileSync(path, "utf8") : undefined;
  if (pem !== undefined && !pem.includes(PEM_MARKER)) {
    throw new Error(`${inline ? "DATABASE_SSL_CA" : "DATABASE_SSL_ROOT_CERT"} does not contain a PEM certificate`);
  }
  return pem;
}

export function scriptPgSsl(databaseUrl, { allowUnverified = false, log = console.warn, env = process.env } = {}) {
  if (isLocalHost(new URL(databaseUrl).hostname)) return false;

  const optOut = env.DATABASE_SSL_REJECT_UNAUTHORIZED?.trim() === "false";
  const ca = readCa(env);
  if (ca) {
    if (optOut) {
      throw new Error("DATABASE_SSL_REJECT_UNAUTHORIZED=false contradicts a configured CA certificate; unset it");
    }
    return { ca, rejectUnauthorized: true };
  }

  if (optOut) {
    if (!allowUnverified) {
      throw new Error(
        "DATABASE_SSL_REJECT_UNAUTHORIZED=false is refused by this script; " +
          "set DATABASE_SSL_CA or DATABASE_SSL_ROOT_CERT to the project's CA certificate instead",
      );
    }
    if (env.NODE_ENV === "production") {
      throw new Error(
        "DATABASE_SSL_REJECT_UNAUTHORIZED=false is refused when NODE_ENV=production; " +
          "set DATABASE_SSL_CA or DATABASE_SSL_ROOT_CERT to the project's CA certificate instead",
      );
    }
    log("[pg-ssl] WARNING: DATABASE_SSL_REJECT_UNAUTHORIZED=false — TLS is on but the server certificate is NOT verified.");
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true };
}
