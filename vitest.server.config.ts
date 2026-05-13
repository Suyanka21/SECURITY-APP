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
    // No setup files — server tests don't need browser mocks
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
