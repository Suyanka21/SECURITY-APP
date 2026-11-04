/**
 * GatePass — Server Entry Point
 *
 * Starts the Express server on port 3001.
 * Runs alongside Vite dev server (port 5173).
 *
 * Source: Security-and-Hardening skill — "Use environment variables for secrets"
 */

import "dotenv/config";
// Side-effect import, evaluated before ./app and @/db: a misconfigured
// production deploy fails here, before the DB pool or auth middleware exist.
import "./config/assert-startup";
import { createApp } from "./app";
import { db, pool } from "@/db";
import { setAuditDB } from "./services/audit-logger";
import {
  buildNotificationProvidersFromEnv,
  getNotificationProviders,
  setNotificationProviders,
} from "./services/notifications/registry";
import { startQueuedNotificationSweep } from "./services/notifications/queued-sweep";

const PORT = process.env.PORT || 3001;

// Real message providers from NOTIFICATIONS_*_PROVIDER / TWILIO_* (unset
// keeps the default-deny provider). No call to Twilio happens here.
setNotificationProviders(buildNotificationProvidersFromEnv(process.env));

const app = createApp(db);

// [S3 FIX] Connect audit logger to database BEFORE accepting requests.
// HARD RULE: Every audit event MUST be persisted to DB.
// Without this call, auditDB remains null and events are memory-only.
// Placed after createApp() so DB is ready, before listen() so no request
// can be processed without audit persistence active.
setAuditDB(db as any);

// Sends notification rows left queued by a stop between commit and dispatch.
const stopQueuedSweep = startQueuedNotificationSweep(
  db as unknown as Parameters<typeof startQueuedNotificationSweep>[0],
  getNotificationProviders,
);

const server = app.listen(PORT, () => {
  console.log(`[GatePass] Server running on http://localhost:${PORT}`);
  console.log(`[GatePass] POST /api/entries ready`);
  console.log(`[GatePass] Audit DB persistence: ACTIVE`);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("[GatePass] SIGTERM received, shutting down...");
  stopQueuedSweep();
  server.close();
  await pool.end();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("[GatePass] SIGINT received, shutting down...");
  stopQueuedSweep();
  server.close();
  await pool.end();
  process.exit(0);
});
