/**
 * GatePass — Express Application
 *
 * Source: TRUSTLESS-AUDIT-REPORT [C2] — CORS, helmet, rate limiting
 * Source: TRUSTLESS-AUDIT-REPORT [C1] — authentication middleware
 * Source: Security-and-Hardening skill — OWASP protections
 *
 * Middleware execution order (defense-in-depth):
 * 1. Security headers (helmet)
 * 2. CORS (origin allowlist)
 * 3. Body size limit (JSON)
 * 4. Rate limiting (global + endpoint-specific)
 * 5. DB attachment
 * 6. Authentication (JWT)
 * 7. Routes
 * 8. Error handler
 */

import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { entriesRouter } from "./routes/entries";
import { qrRouter } from "./routes/qr";
import { syncRouter } from "./routes/sync";
import { visitorsRouter } from "./routes/visitors";
import { auditRouter } from "./routes/audit";
import {
  handleCreateApproval,
  handleGetApprovalStatus,
  handleDecideApproval,
} from "./routes/approvals";
import {
  handleListNotifications,
  handleRetryNotification,
} from "./routes/notifications";
import {
  handleSeedAutoApprovalRule,
  handleListAutoApprovalRules,
  handleDeactivateAutoApprovalRule,
} from "./routes/auto-approval";
import {
  handleCreateVisitorProfile,
  handleListVisitorProfiles,
  handleGetVisitorProfile,
  handleUpdateVisitorProfile,
  handleSoftDeleteVisitorProfile,
  handleRestoreVisitorProfile,
} from "./routes/visitor-profiles";
import { handleListShifts } from "./routes/shifts";
import {
  handleIssueVisitorInvitation,
  handlePreviewVisitorInvitation,
} from "./routes/visitor-invitations";
import {
  handleRecordExit,
  handleListOnPremise,
} from "./routes/exit-tracking";
import {
  handleCreateDeliveryEntry,
  handleListDeliveries,
} from "./routes/deliveries";
import { handleGetMe } from "./routes/auth";
import { errorHandler } from "./middleware/error-handler";
import { requireAuth, requireRole } from "./middleware/auth";

// ─── Configuration ───────────────────────────────────────────────────────────

/**
 * Allowed origins for CORS.
 * Source: Security-and-Hardening — "No wildcard origins"
 *
 * In production, set ALLOWED_ORIGINS env var (comma-separated).
 * Falls back to localhost for development.
 */
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : ["http://localhost:8080", "http://localhost:3000", "http://localhost:5173"];

/**
 * Rate limit configuration.
 * Source: TRUSTLESS-AUDIT-REPORT [C2] — "Without rate limiting: an attacker
 * can brute-force QR tokens or flood the entry endpoint"
 */
const GLOBAL_RATE_LIMIT = {
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,                  // 300 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: "RATE_LIMIT_EXCEEDED",
      message: "Too many requests. Please wait before retrying.",
      traceId: "rate-limited",
    },
  },
};

const STRICT_RATE_LIMIT = {
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60,                   // 60 requests per window per IP (stricter)
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: "RATE_LIMIT_EXCEEDED",
      message: "Too many entry submissions. Please wait before retrying.",
      traceId: "rate-limited",
    },
  },
};

// ─── App Factory ─────────────────────────────────────────────────────────────

export function createApp(db: unknown) {
  const app = express();

  // ─── Layer 1: Security Headers ───────────────────────────────────────
  // [C2 FIX] Helmet sets 15+ security headers (CSP, HSTS, X-Frame-Options, etc.)
  // Source: OWASP — "Set security headers on all responses"
  app.use(helmet());

  // ─── Layer 2: CORS ───────────────────────────────────────────────────
  // [C2 FIX] Explicit origin allowlist — no wildcard
  // Source: TRUSTLESS-AUDIT-REPORT [C2] — "Without CORS: any website can make API calls"
  app.use(cors({
    origin: ALLOWED_ORIGINS,
    // PATCH + DELETE added for Feature 4 (visitor profile CRUD); spec §4.
    methods: ["GET", "POST", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
    maxAge: 600, // Cache preflight for 10 minutes
  }));

  // ─── Layer 3: Body Size Limit ────────────────────────────────────────
  // Source: TRUSTLESS-AUDIT-REPORT Gate 1 — "No input size limit on request body"
  app.use(express.json({ limit: "100kb" }));

  // ─── Layer 4: Global Rate Limiter ────────────────────────────────────
  // [C2 FIX] Prevents flood attacks across all endpoints
  app.use(rateLimit(GLOBAL_RATE_LIMIT));

  // ─── Layer 5: DB Attachment ──────────────────────────────────────────
  app.use((req, _res, next) => {
    (req as any).db = db;
    next();
  });

  // ─── Public Routes (no auth required) ──────────────────────────────

  // Health check — must be accessible without authentication
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // ─── Layer 6: Stricter Rate Limiters (endpoint-specific) ───────────
  // Source: TRUSTLESS-AUDIT-REPORT [C2] — "brute-force QR tokens or flood the entry endpoint"
  const strictLimiter = rateLimit(STRICT_RATE_LIMIT);

  // ─── Auth identity ─────────────────────────────────────────────────
  // Returns the caller's DB-verified role so the client can route to the
  // correct interface. Any authenticated guard role may call it; the role is
  // read from guards.role (auth-and-role-routing.md §7), never from the token.
  app.get("/api/auth/me", requireAuth, handleGetMe);

  // ─── Protected Routes ──────────────────────────────────────────────
  // Auth + stricter rate limits on mutation endpoints
  app.use("/api/entries/qr/validate", requireAuth, strictLimiter, qrRouter);
  app.use("/api/entries/sync", requireAuth, strictLimiter, syncRouter);
  app.use("/api/entries", requireAuth, strictLimiter, entriesRouter);
  app.use("/api/visitors", requireAuth, visitorsRouter);
  app.use("/api/audit", requireAuth, auditRouter);

  // ─── Resident Approval Routes ──────────────────────────────────────
  // Source: src/docs/specs/resident-approval-flow.md §7.
  //
  // Three routes, three middleware stacks. Registered as discrete handlers
  // (not via a sub-router) so each route gets exactly the middleware it
  // needs — the /decide endpoint must NOT see requireAuth because the
  // resident has no JWT; the 256-bit token in the body IS the auth.
  app.post("/api/approvals", requireAuth, strictLimiter, handleCreateApproval);
  app.get("/api/approvals/:id/status", requireAuth, handleGetApprovalStatus);
  app.post("/api/approvals/:id/decide", strictLimiter, handleDecideApproval);

  // Feature 2 — Notifications (spec §7)
  app.get("/api/notifications", requireAuth, handleListNotifications);
  app.post(
    "/api/notifications/:id/retry",
    requireAuth,
    strictLimiter,
    handleRetryNotification
  );

  // Feature 3 — Auto-approval rules (spec §7).
  // Admin-only seeding + deactivation; senior-guards can also list.
  // The role check runs AFTER requireAuth so guardId is available.
  app.post(
    "/api/auto-approval-rules",
    requireAuth,
    strictLimiter,
    requireRole("admin"),
    handleSeedAutoApprovalRule
  );
  app.get(
    "/api/auto-approval-rules",
    requireAuth,
    requireRole("admin", "senior-guard"),
    handleListAutoApprovalRules
  );
  app.post(
    "/api/auto-approval-rules/:id/deactivate",
    requireAuth,
    strictLimiter,
    requireRole("admin"),
    handleDeactivateAutoApprovalRule
  );

  // Feature 4 — Visitor Profile CRUD (spec §4, §6).
  // Reads: any authenticated role (guard / senior-guard / admin).
  // Mutations: admin + senior-guard. The guard role is intentionally
  // excluded; requireRole rejects guard tokens with AUTH_FORBIDDEN.
  // PATCH is exposed via app.patch so the verb is explicit on the wire.
  app.post(
    "/api/visitor-profiles",
    requireAuth,
    strictLimiter,
    requireRole("admin", "senior-guard"),
    handleCreateVisitorProfile
  );
  app.get(
    "/api/visitor-profiles",
    requireAuth,
    handleListVisitorProfiles
  );
  app.get(
    "/api/visitor-profiles/:id",
    requireAuth,
    handleGetVisitorProfile
  );
  app.patch(
    "/api/visitor-profiles/:id",
    requireAuth,
    strictLimiter,
    requireRole("admin", "senior-guard"),
    handleUpdateVisitorProfile
  );
  app.delete(
    "/api/visitor-profiles/:id",
    requireAuth,
    strictLimiter,
    requireRole("admin", "senior-guard"),
    handleSoftDeleteVisitorProfile
  );
  app.post(
    "/api/visitor-profiles/:id/restore",
    requireAuth,
    strictLimiter,
    requireRole("admin", "senior-guard"),
    handleRestoreVisitorProfile
  );

  // Feature 5 — Shift Log Aggregation (spec §4, §9).
  // Read-only aggregation over entry_records + audit_events. Admin or
  // senior-guard only; guard tokens get 403 AUTH_FORBIDDEN. No mutations,
  // no audit rows written by the endpoint itself.
  app.get(
    "/api/admin/shifts",
    requireAuth,
    requireRole("admin", "senior-guard"),
    handleListShifts
  );

  // Feature 7 — Exit Tracking (spec §6).
  // Record exit: any authenticated guard can record an exit.
  // On-premise list: admin + senior-guard only; guard tokens get 403.
  // Route order matters: /on-premise MUST be registered before /:entryId/exit
  // so Express doesn't treat "on-premise" as an entryId param.
  app.get(
    "/api/entries/on-premise",
    requireAuth,
    requireRole("admin", "senior-guard"),
    handleListOnPremise
  );
  app.post(
    "/api/entries/:entryId/exit",
    requireAuth,
    strictLimiter,
    handleRecordExit
  );

  // Feature 8 — Delivery Management (spec §4).
  // Create delivery entry: any authenticated guard. Separate endpoint from
  // POST /api/entries so delivery-specific validation runs without altering
  // the existing visitor entry path.
  // List deliveries: admin + senior-guard only; guard tokens get 403.
  // Route order: GET must be registered before POST to avoid param conflicts.
  app.get(
    "/api/entries/deliveries",
    requireAuth,
    requireRole("admin", "senior-guard"),
    handleListDeliveries
  );
  app.post(
    "/api/entries/deliveries",
    requireAuth,
    strictLimiter,
    handleCreateDeliveryEntry
  );

  // Feature 6 — Guest QR Ticket (spec §6).
  // Issue: admin + senior-guard only; guard tokens get 403 AUTH_FORBIDDEN.
  //        Strict-limited because each call mints a single-use credential.
  // Preview: PUBLIC. The token IN the URL is the auth (256-bit entropy).
  //          Read-only. Does NOT mark is_used. Strict-limited to deter
  //          enumeration attempts.
  app.post(
    "/api/visitor-invitations",
    requireAuth,
    strictLimiter,
    requireRole("admin", "senior-guard"),
    handleIssueVisitorInvitation
  );
  app.get(
    "/api/visitor-invitations/:token/preview",
    strictLimiter,
    handlePreviewVisitorInvitation
  );

  // ─── Error Handler ─────────────────────────────────────────────────
  // Must be LAST — catches all unhandled errors
  app.use(errorHandler);

  return app;
}
