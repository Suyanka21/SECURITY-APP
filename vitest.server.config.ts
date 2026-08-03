import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Vitest configuration for server-side (Node) tests.
 * Separate from the main vitest.config.ts which uses jsdom for React tests.
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/server/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["src/server/**/*.integration.{test,spec}.{ts,tsx}"],
    // No setup files — server tests don't need browser mocks.
    // Feature 11 (Stage 4): the PIN service requires a server-side pepper.
    // A fixed test value keeps HMAC derivation deterministic across the suite
    // (it is NOT a production secret — that comes from env / the blueprint).
    env: {
      PIN_PEPPER: "test-pin-pepper-0123456789abcdef",
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
