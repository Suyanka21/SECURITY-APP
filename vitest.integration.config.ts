import { defineConfig } from "vitest/config";
import path from "path";
import dotenv from "dotenv";

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
    // Longer timeout — real DB operations take more time
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
