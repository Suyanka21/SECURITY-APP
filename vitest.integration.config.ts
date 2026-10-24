import { defineConfig } from "vitest/config";
import path from "path";
import dotenv from "dotenv";
import { assertLocalDatabaseUrl } from "./src/server/__tests__/integration/hosted-db-guard";

// Load .env.local for database credentials
dotenv.config({ path: ".env.local" });

// The .env.local stores the URL as SUPABASE_DATABASE_URL=DATABASE_URL="<url>"
// Extract the actual connection string
if (!process.env.DATABASE_URL && process.env.SUPABASE_DATABASE_URL) {
  const match = process.env.SUPABASE_DATABASE_URL.match(
    /DATABASE_URL="?([^"]+)"?/
  );
  if (match) {
    process.env.DATABASE_URL = match[1];
  }
}
assertLocalDatabaseUrl(process.env.DATABASE_URL);

/**
 * Vitest configuration for integration tests (real PostgreSQL).
 *
 * Separate from unit tests to avoid accidentally running DB tests
 * in the standard test suite.
 *
 * RUN: npx vitest run --config vitest.integration.config.ts
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/server/**/*.integration.{test,spec}.{ts,tsx}"],
    // All files share one database and some clean up table-wide (e.g.
    // resident_claim_attempts), so files run one at a time.
    fileParallelism: false,
    // Longer timeout — real DB operations take more time
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
