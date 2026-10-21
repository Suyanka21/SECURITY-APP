/**
 * GatePass — Postgres TLS settings for the API server.
 *
 * Source: node-postgres SSL docs — https://node-postgres.com/features/ssl
 * Source: Supabase — SSL enforcement https://supabase.com/docs/guides/platform/ssl-enforcement
 *
 * Mirrors scripts/lib/pg-ssl.mjs. With TLS on (production, or DATABASE_SSL=require):
 *   DATABASE_SSL_CA                   the CA certificate itself (PEM text; "\n" escapes allowed)
 *   DATABASE_SSL_ROOT_CERT            path to the CA certificate file
 *   DATABASE_SSL_REJECT_UNAUTHORIZED  "false" relaxes verification when no CA is set
 * Supabase's pooler chains to its own root (Dashboard → Database → SSL), so one
 * of the CA settings is what makes verification succeed there.
 */

import { readFileSync } from "fs";
import type { PoolConfig } from "pg";

type Env = Record<string, string | undefined>;

const PEM_MARKER = "-----BEGIN CERTIFICATE-----";

// node-postgres lets TLS query params in the connection string override the
// `ssl` object, so they are removed and TLS comes only from resolveSSL().
const TLS_PARAMS = ["ssl", "sslmode", "sslrootcert", "sslcert", "sslkey", "sslpassword", "uselibpqcompat"];

export function stripTlsParams(databaseUrl: string | undefined): string | undefined {
  if (!databaseUrl) return databaseUrl;
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    // Fail closed: an unparsed string could still carry TLS overrides.
    throw new Error("DATABASE_URL is not a valid postgresql:// URL");
  }
  for (const p of TLS_PARAMS) url.searchParams.delete(p);
  return url.toString();
}

function readCa(env: Env, readFile: (path: string) => string): string | undefined {
  const inline = env.DATABASE_SSL_CA?.trim();
  const path = env.DATABASE_SSL_ROOT_CERT?.trim();
  if (inline && path) {
    throw new Error("Set only one of DATABASE_SSL_CA and DATABASE_SSL_ROOT_CERT");
  }
  const pem = inline ? inline.replace(/\\n/g, "\n") : path ? readFile(path) : undefined;
  if (pem !== undefined && !pem.includes(PEM_MARKER)) {
    throw new Error(
      `${inline ? "DATABASE_SSL_CA" : "DATABASE_SSL_ROOT_CERT"} does not contain a PEM certificate`,
    );
  }
  return pem;
}

export function resolveSSL(
  env: Env = process.env,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): PoolConfig["ssl"] {
  const mode = env.DATABASE_SSL;
  const isProduction = env.NODE_ENV === "production";

  if (mode === "disable" && !isProduction) return false;
  if (!isProduction && mode !== "require") return false;

  const ca = readCa(env, readFile);
  if (ca) {
    if (env.DATABASE_SSL_REJECT_UNAUTHORIZED === "false") {
      throw new Error(
        "DATABASE_SSL_REJECT_UNAUTHORIZED=false contradicts a configured CA certificate; unset it",
      );
    }
    return { ca, rejectUnauthorized: true };
  }
  return { rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" };
}
