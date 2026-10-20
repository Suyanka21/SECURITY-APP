/**
 * TLS settings for the standalone scripts' Postgres connections.
 *
 * Source: node-postgres SSL docs — https://node-postgres.com/features/ssl
 * Source: Supabase — SSL enforcement https://supabase.com/docs/guides/platform/ssl-enforcement
 *
 * Mirrors src/db/index.ts: a hosted database is verified by default.
 *   DATABASE_SSL_ROOT_CERT            path to the project's CA certificate
 *                                     (Dashboard → Database → SSL → Download)
 *   DATABASE_SSL_REJECT_UNAUTHORIZED  "false" is an explicit, logged opt-out,
 *                                     refused when NODE_ENV=production
 * A localhost database uses no TLS.
 */

import { readFileSync } from "fs";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function isLocalHost(hostname) {
  return LOCAL_HOSTS.has(hostname);
}

export function scriptPgSsl(databaseUrl, log = console.warn) {
  if (isLocalHost(new URL(databaseUrl).hostname)) return false;

  const caPath = process.env.DATABASE_SSL_ROOT_CERT;
  if (caPath) return { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true };

  if (process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === "false") {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "DATABASE_SSL_REJECT_UNAUTHORIZED=false is refused when NODE_ENV=production; " +
          "set DATABASE_SSL_ROOT_CERT to the project's CA certificate instead",
      );
    }
    log("[pg-ssl] WARNING: DATABASE_SSL_REJECT_UNAUTHORIZED=false — TLS is on but the server certificate is NOT verified.");
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true };
}
