/**
 * GatePass — DB Connection
 *
 * Source: Drizzle ORM node-postgres docs
 * https://orm.drizzle.team/docs/get-started/postgresql-new#node-postgres
 *
 * Uses a connection pool for efficient connection management.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { resolveSSL, stripTlsParams } from "./ssl";

// Connection pool — configured via DATABASE_URL environment variable
// Source: Security-and-Hardening skill — "Use environment variables for secrets"
const pool = new Pool({
  connectionString: stripTlsParams(process.env.DATABASE_URL),
  max: 20, // Maximum pool size
  ssl: resolveSSL(),
});

// Drizzle instance with schema for relational queries
// Source: https://orm.drizzle.team/docs/relations
export const db = drizzle(pool, { schema });

// Export pool for graceful shutdown
export { pool };
