/**
 * GatePass — DB Connection
 *
 * Source: Drizzle ORM node-postgres docs
 * https://orm.drizzle.team/docs/get-started/postgresql-new#node-postgres
 *
 * Uses a connection pool for efficient connection management.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import * as schema from "./schema";

/**
 * Resolve the SSL setting for the Postgres pool.
 *
 * Source: node-postgres SSL docs — https://node-postgres.com/features/ssl
 * Source: Supabase — "Connections to the database require SSL"
 *   https://supabase.com/docs/guides/database/connecting-to-postgres
 * Source: Security-and-Hardening skill — "Use HTTPS/TLS for all external
 *   communication"; do not silently disable transport encryption.
 *
 * Behavior (explicit, no implicit defaults):
 * - Managed Postgres (Supabase et al.) requires TLS, so SSL is ON by default
 *   in production. `DATABASE_SSL_REJECT_UNAUTHORIZED=false` relaxes chain
 *   verification for providers that terminate TLS with a non-system CA
 *   (Supabase's pooler is one) — the connection is still encrypted.
 * - Local development against a plain Postgres has no TLS, so SSL is OFF
 *   unless explicitly requested via `DATABASE_SSL=require`.
 */
function resolveSSL(): PoolConfig["ssl"] {
  const mode = process.env.DATABASE_SSL;
  const isProduction = process.env.NODE_ENV === "production";

  // Explicit opt-out (only honored outside production).
  if (mode === "disable" && !isProduction) return false;

  // SSL on by default in production, or when explicitly required anywhere.
  if (isProduction || mode === "require") {
    const rejectUnauthorized =
      process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false";
    return { rejectUnauthorized };
  }

  // Local development default: no TLS.
  return false;
}

// Connection pool — configured via DATABASE_URL environment variable
// Source: Security-and-Hardening skill — "Use environment variables for secrets"
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20, // Maximum pool size
  ssl: resolveSSL(),
});

// Drizzle instance with schema for relational queries
// Source: https://orm.drizzle.team/docs/relations
export const db = drizzle(pool, { schema });

// Export pool for graceful shutdown
export { pool };
