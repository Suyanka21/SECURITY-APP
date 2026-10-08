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
import { pinRouter } from "./routes/pin";
import { watchlistRouter } from "./routes/watchlist";
import { syncRouter } from "./routes/sync";
import { visitorsRouter } from "./routes/visitors";
import { auditRouter } from "./routes/audit";
import {
  handleCreateApproval,
  handleGetApprovalStatus,
  handleDecideApproval,
  handlePreviewApproval,
} from "./routes/approvals";
import {
  handleListNotifications,
  handleRetryNotification,
} from "./routes/notifications";
import {
  handleSeedAutoApprovalRule,
  handleListAutoApprovalRules,
  handleDeactivateAutoApprovalRule,
  handleClearAutoApprovalRuleBlock,
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
  handleAddEntryNote,
  handleAddExitNote,
  handleListEntryNotes,
} from "./routes/guard-notes";
import {
  handleCreateDeliveryEntry,
  handleListDeliveries,
} from "./routes/deliveries";
import { handleGetMe } from "./routes/auth";
import { handleProvisionAccount } from "./routes/accounts";
import {
  adminResidentsRouter,
  adminUnitsRouter,
  handleClaimUnit,
  handleCreateRegistration,
  handleIssueResidentPass,
  handleListRegistrations,
  handleRemoveRegistration,
  handleRenewRegistration,
  handleResidentMe,
} from "./routes/residents";
import { errorHandler } from "./middleware/error-handler";
import { requireAuth, requireRole } from "./middleware/auth";
import {
  requireResidentAuth,
  requireSupabaseUser,
  type ResidentRequest,
} from "./middleware/resident-auth";

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

const RESIDENT_PASS_RATE_LIMIT = {
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: "RATE_LIMIT_EXCEEDED",
      message: "Too many passes issued. Please wait before trying again.",
      traceId: "rate-limited",
    },
  },
};

const RESIDENT_REGISTRATION_RATE_LIMIT = {
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: "RATE_LIMIT_EXCEEDED",
      message: "Too many changes. Please wait before trying again.",
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
  // Feature 11 (Stage 4) — One-Time PIN Backup. Same middleware stack as QR
  // validate; strictLimiter caps guessing at the transport layer while the
  // per-pass limiter in the service enforces the "lock the pass" contract.
  // Registered before "/api/entries" so it is not shadowed by the :entryId
  // param routes.
  app.use("/api/entries/pin/validate", requireAuth, strictLimiter, pinRouter);
  app.use("/api/entries/sync", requireAuth, strictLimiter, syncRouter);
  app.use("/api/entries", requireAuth, strictLimiter, entriesRouter);
  app.use("/api/visitors", requireAuth, visitorsRouter);
  // Audit log is a supervisor/admin review surface: never public, and not
  // readable by a plain guard (it spans every guard's activity). The guard
  // console keeps its own local, in-session trail and never calls this.
  app.use("/api/audit", requireAuth, requireRole("admin", "senior-guard"), auditRouter);

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
  app.post("/api/approvals/:id/preview", strictLimiter, handlePreviewApproval);

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
  app.post(
    "/api/auto-approval-rules/:id/clear-block",
    requireAuth,
    strictLimiter,
    requireRole("admin"),
    handleClearAutoApprovalRuleBlock
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

  // Stage 1 (A1) — Admin Account Provisioning.
  // Source: src/docs/adr/0001-...md — accounts are created ONLY by an
  // authenticated admin; the role is server-controlled and persisted in
  // guards.role. There is NO public signup route (dormant or otherwise).
  // Strict-limited because each call mints an auth credential.
  app.post(
    "/api/admin/accounts",
    requireAuth,
    strictLimiter,
    requireRole("admin"),
    handleProvisionAccount
  );

  // Resident Portal R1 (spec §2–3) — units, residents, claim codes.
  // Admin-only management (decision §10.6: claim codes are provisioning, same
  // level as staff accounts). Resident routes use the SEPARATE resident
  // middleware: a guard token has no residents row → AUTH_NO_RESIDENT_LINK,
  // and a resident token has no guards row → requireAuth AUTH_NO_GUARD_LINK,
  // so neither side can ever satisfy the other's routes.
  app.use(
    "/api/admin/units",
    requireAuth,
    strictLimiter,
    requireRole("admin"),
    adminUnitsRouter
  );
  app.use(
    "/api/admin/residents",
    requireAuth,
    strictLimiter,
    requireRole("admin"),
    adminResidentsRouter
  );
  app.post("/api/resident/claim", strictLimiter, requireSupabaseUser, handleClaimUnit);
  app.get("/api/resident/me", requireResidentAuth, handleResidentMe);
  // R2 capability 1. Rate-limited per resident (after auth), not per IP:
  // residents share carrier NAT, and the 10-open-pass cap bounds the rest.
  const residentPassLimiter = rateLimit({
    ...RESIDENT_PASS_RATE_LIMIT,
    keyGenerator: (req) => (req as ResidentRequest).resident.residentId,
  });
  app.post(
    "/api/resident/passes",
    requireResidentAuth,
    residentPassLimiter,
    handleIssueResidentPass
  );
  // R3 capabilities 2 + 3. Writes share one per-resident limiter; the
  // per-unit registration cap bounds the rest.
  const residentRegistrationLimiter = rateLimit({
    ...RESIDENT_REGISTRATION_RATE_LIMIT,
    keyGenerator: (req) => (req as ResidentRequest).resident.residentId,
  });
  app.get("/api/resident/registrations", requireResidentAuth, handleListRegistrations);
  app.post(
    "/api/resident/registrations",
    requireResidentAuth,
    residentRegistrationLimiter,
    handleCreateRegistration
  );
  app.delete(
    "/api/resident/registrations/:id",
    requireResidentAuth,
    residentRegistrationLimiter,
    handleRemoveRegistration
  );
  app.post(
    "/api/resident/registrations/:id/renew",
    requireResidentAuth,
    residentRegistrationLimiter,
    handleRenewRegistration
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

  // Feature 9 — Guard Notes (spec §4).
  // Any authenticated guard can attach a standardised note to an entry/exit.
  // Reads are auth-gated. guardId comes from the verified token, not the body.
  // Strict-limited on writes to bound abuse of the free-text 'other' field.
  app.get(
    "/api/entries/:entryId/notes",
    requireAuth,
    handleListEntryNotes
  );
  app.post(
    "/api/entries/:entryId/notes",
    requireAuth,
    strictLimiter,
    handleAddEntryNote
  );
  app.post(
    "/api/exits/:exitId/notes",
    requireAuth,
    strictLimiter,
    handleAddExitNote
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

  // Feature 12 (Stage 5) — Watchlist (spec §3).
  // Management is admin + senior-guard only, reusing the EXISTING requireRole
  // middleware — no new role logic. Guard tokens get 403 AUTH_FORBIDDEN.
  // Strict-limited for the whole router (same as /api/entries) — the admin
  // list is low-frequency, so a single cap on all methods is fine.
  // The match warning itself is not an endpoint: it
  // rides on the existing entry/QR/PIN responses, so a guard never needs
  // watchlist read access to be warned.
  app.use(
    "/api/watchlist",
    requireAuth,
    strictLimiter,
    requireRole("admin", "senior-guard"),
    watchlistRouter
  );

  // ─── Error Handler ─────────────────────────────────────────────────
  // Must be LAST — catches all unhandled errors
  app.use(errorHandler);

  return app;
}
