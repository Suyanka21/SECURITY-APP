import { defineConfig } from "drizzle-kit";

// Drizzle Kit configuration for GatePass
// Source: https://orm.drizzle.team/docs/drizzle-config-file
export default defineConfig({
  // Schema location
  schema: "./src/db/schema.ts",

  // Output directory for generated migrations
  out: "./drizzle",

  // PostgreSQL dialect
  dialect: "postgresql",

  // Database connection — reads from environment variable
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },

  // Verbose logging during migrations
  verbose: true,

  // Strict mode — warns about potentially destructive changes
  strict: true,
});
