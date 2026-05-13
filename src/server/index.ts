/**
 * GatePass — Server Entry Point
 *
 * Starts the Express server on port 3001.
 * Runs alongside Vite dev server (port 8080).
 *
 * Source: Security-and-Hardening skill — "Use environment variables for secrets"
 */

import "dotenv/config";
import { createApp } from "./app";
import { db, pool } from "@/db";
import { setAuditDB } from "./services/audit-logger";

const PORT = process.env.PORT || 3001;

const app = createApp(db);

// [S3 FIX] Connect audit logger to database BEFORE accepting requests.
// HARD RULE: Every audit event MUST be persisted to DB.
// Without this call, auditDB remains null and events are memory-only.
// Placed after createApp() so DB is ready, before listen() so no request
// can be processed without audit persistence active.
setAuditDB(db as any);

const server = app.listen(PORT, () => {
  console.log(`[GatePass] Server running on http://localhost:${PORT}`);
  console.log(`[GatePass] POST /api/entries ready`);
  console.log(`[GatePass] Audit DB persistence: ACTIVE`);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("[GatePass] SIGTERM received, shutting down...");
  server.close();
  await pool.end();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("[GatePass] SIGINT received, shutting down...");
  server.close();
  await pool.end();
  process.exit(0);
});
