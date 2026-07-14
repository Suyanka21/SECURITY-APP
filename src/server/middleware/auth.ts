/**
 * GatePass — Authentication Middleware
 *
 * Source: TRUSTLESS-AUDIT-REPORT [C1] — "No authentication middleware exists"
 * Source: TRUSTLESS-AUDIT-REPORT [C3] — "Guard bypass via direct guardId injection"
 * Source: GATEPASS DEFINITION §Critical Actions — "Every override, approval, or bypass must be logged with guard ID"
 *
 * HARD RULES:
 * - guardId MUST come from verified JWT token, NEVER from request body/query
 * - All protected routes require valid Bearer token
 * - Invalid/missing tokens return structured error (contract §2 APIError)
 *
 * Token format: Bearer <JWT>
 * JWT payload: { sub: string (guardId), iat: number, exp: number }
 */

import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import * as jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { guards } from "@/db/schema";
import {
  isSupabaseAuthConfigured,
  verifySupabaseToken,
} from "../auth/supabase-jwt";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AuthenticatedRequest extends Request {
  /** Guard identity extracted from verified JWT — NEVER client-supplied */
  guardId: string;
}

/** Closed set of guard roles. Mirrors the DB CHECK on guards.role. */
export type GuardRole = "guard" | "senior-guard" | "admin";

export interface JWTPayload {
  /** Guard UUID — the verified identity */
  sub: string;
  /** Issued at timestamp */
  iat: number;
  /** Expiration timestamp */
  exp: number;
}

// ─── Config ──────────────────────────────────────────────────────────────────

const DEV_FALLBACK_SECRET = "gatepass-dev-secret-change-in-production";
const JWT_ALGORITHM = "HS256" as const;

// [M2 FIX] Production fail-fast guard for JWT_SECRET
// Source: Security-and-Hardening — "No fallback secrets in production"
// Source: Code-Review-and-Quality — "Fail loudly on misconfiguration"
//
// In production: missing JWT_SECRET is a FATAL error → process refuses to start.
// In development: a warning is logged, dev fallback is used for convenience.
function resolveJWTSecret(): string {
  const envSecret = process.env.JWT_SECRET;
  const isProduction = process.env.NODE_ENV === "production";

  if (isProduction && (!envSecret || envSecret === DEV_FALLBACK_SECRET)) {
    // FATAL: Production must NEVER use a fallback/hardcoded secret.
    // This prevents the server from starting in an insecure state.
    const message =
      "[FATAL] JWT_SECRET is missing or set to the dev fallback in production. " +
      "Set a strong, unique JWT_SECRET environment variable before deploying. " +
      "The server will NOT start without it.";
    console.error(message);
    throw new Error(message);
  }

  if (!envSecret) {
    console.warn(
      "[AUTH] WARNING: JWT_SECRET not set. Using dev fallback. " +
        "This is acceptable for development but MUST be changed for production."
    );
    return DEV_FALLBACK_SECRET;
  }

  return envSecret;
}

const JWT_SECRET = resolveJWTSecret();

/**
 * Returns the JWT secret. Exported for token generation in tests.
 */
export function getJWTSecret(): string {
  return JWT_SECRET;
}

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * Authentication middleware.
 *
 * Verifies JWT Bearer token and injects `req.guardId` from the verified payload.
 * This is the ONLY source of guard identity in the system.
 *
 * SECURITY:
 * - guardId is extracted from `token.sub`, not from request body
 * - Expired tokens are rejected
 * - Malformed tokens are rejected
 * - Missing tokens are rejected
 *
 * @returns void — attaches guardId to req, or sends 401/403 error
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const traceId = `trace-${randomUUID()}`;

  // Extract Bearer token from Authorization header
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(401).json({
      error: {
        code: "AUTH_TOKEN_MISSING",
        message: "Authentication required. Provide Bearer token in Authorization header.",
        traceId,
      },
    });
    return;
  }

  // Validate Bearer format
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    res.status(401).json({
      error: {
        code: "AUTH_TOKEN_MALFORMED",
        message: "Authorization header must be: Bearer <token>",
        traceId,
      },
    });
    return;
  }

  const token = parts[1];

  // ─── Supabase mode ─────────────────────────────────────────────────────────
  // When SUPABASE_URL is configured, tokens are Supabase-issued (asymmetric,
  // verified against the project JWKS). The token's `sub` is the Supabase user
  // UUID — we resolve it to a guard row via guards.supabase_user_id and inject
  // that guard's canonical id, so requireRole (which reads guards.role by id)
  // stays structurally unchanged. Role is NEVER taken from the token.
  if (isSupabaseAuthConfigured()) {
    await requireAuthSupabase(req, res, next, token, traceId);
    return;
  }

  // ─── Legacy self-issued mode (development / tests) ───────────────────────────
  try {
    // Verify JWT signature and expiration
    const payload = jwt.verify(token, JWT_SECRET, {
      algorithms: [JWT_ALGORITHM],
    }) as JWTPayload;

    // Validate payload has required sub (guardId)
    if (!payload.sub || typeof payload.sub !== "string") {
      res.status(403).json({
        error: {
          code: "AUTH_TOKEN_INVALID",
          message: "Token payload missing guard identity (sub)",
          traceId,
        },
      });
      return;
    }

    // CRITICAL: Inject guardId from VERIFIED token, never from request body
    // This is the fix for [C3] — guard identity is now trustworthy
    (req as AuthenticatedRequest).guardId = payload.sub;

    next();
  } catch (err) {
    // Handle specific JWT errors
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({
        error: {
          code: "AUTH_TOKEN_EXPIRED",
          message: "Authentication token has expired. Please re-authenticate.",
          traceId,
        },
      });
      return;
    }

    if (err instanceof jwt.JsonWebTokenError) {
      res.status(401).json({
        error: {
          code: "AUTH_TOKEN_INVALID",
          message: "Authentication token is invalid or corrupted.",
          traceId,
        },
      });
      return;
    }

    // Unknown error — reject
    res.status(401).json({
      error: {
        code: "AUTH_FAILED",
        message: "Authentication failed.",
        traceId,
      },
    });
  }
}

/**
 * Supabase-issued token path for requireAuth.
 *
 * Verifies the token against the Supabase JWKS, then maps the Supabase user
 * UUID (`sub`) to a guard row via guards.supabase_user_id. A verified Supabase
 * user with no linked guard row is authenticated-but-not-a-guard → 403.
 */
async function requireAuthSupabase(
  req: Request,
  res: Response,
  next: NextFunction,
  token: string,
  traceId: string,
): Promise<void> {
  let supabaseUserId: string;
  try {
    const verified = await verifySupabaseToken(token);
    supabaseUserId = verified.sub;
  } catch (err) {
    const code =
      err && typeof err === "object" && (err as { code?: string }).code === "ERR_JWT_EXPIRED"
        ? { status: 401, code: "AUTH_TOKEN_EXPIRED", message: "Authentication token has expired. Please re-authenticate." }
        : { status: 401, code: "AUTH_TOKEN_INVALID", message: "Authentication token is invalid or corrupted." };
    res.status(code.status).json({ error: { code: code.code, message: code.message, traceId } });
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (req as any).db as DrizzleDBHandle | undefined;
  if (!db) {
    res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Database handle missing on request", traceId },
    });
    return;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (await (db as any)
      .select()
      .from(guards)
      .where(eq(guards.supabaseUserId, supabaseUserId))) as { id: string }[];

    const guard = rows?.[0];
    if (!guard) {
      // Authenticated with Supabase but no guard profile is linked. This is an
      // authorization failure, not an authentication one — default-deny.
      res.status(403).json({
        error: {
          code: "AUTH_NO_GUARD_LINK",
          message: "This account is not linked to a guard profile.",
          traceId,
        },
      });
      return;
    }

    (req as AuthenticatedRequest).guardId = guard.id;
    next();
  } catch {
    res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Authentication lookup failed", traceId },
    });
  }
}

// ─── Token Generation (for development/testing) ─────────────────────────────

/**
 * Generates a JWT token for a guard.
 * Used in development and testing only.
 * In production, tokens would be issued by a dedicated auth service.
 */
export function generateGuardToken(
  guardId: string,
  expiresIn: string = "8h"
): string {
  return jwt.sign(
    { sub: guardId },
    JWT_SECRET,
    { algorithm: JWT_ALGORITHM, expiresIn }
  );
}

// ─── requireRole middleware ─────────────────────────────────────────────────
//
// Source: src/docs/specs/auto-approval.md §8 (security).
// Source: Security-and-Hardening skill — "authorization checked on every
//         protected endpoint".
//
// Reads the guard's role from the DB (the JWT carries only the sub/guardId,
// never the role — a stale-role JWT cannot retain admin privileges after
// demotion). The lookup uses the request-scoped Drizzle handle injected
// in app.ts.
//
// The middleware MUST run AFTER requireAuth so req.guardId is set.
// (eq + guards are imported at the top of this file.)

interface DrizzleDBHandle {
  select: (...args: unknown[]) => unknown;
  query?: Record<string, unknown>;
}

export function requireRole(...allowed: GuardRole[]) {
  return async function requireRoleMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const traceId = `trace-${randomUUID()}`;
    const guardId = (req as AuthenticatedRequest).guardId;

    if (!guardId) {
      // requireAuth was not run upstream — fail closed.
      res.status(401).json({
        error: {
          code: "AUTH_REQUIRED",
          message: "Authentication required",
          traceId,
        },
      });
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (req as any).db as DrizzleDBHandle | undefined;
    if (!db) {
      res.status(500).json({
        error: {
          code: "INTERNAL_ERROR",
          message: "Database handle missing on request",
          traceId,
        },
      });
      return;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = (await (db as any)
        .select()
        .from(guards)
        .where(eq(guards.id, guardId))) as {
        id: string;
        role: GuardRole;
        isActive: boolean;
      }[];

      if (!rows || rows.length === 0) {
        res.status(401).json({
          error: {
            code: "AUTH_FAILED",
            message: "Guard not found",
            traceId,
          },
        });
        return;
      }

      const guard = rows[0];
      if (!guard.isActive) {
        res.status(403).json({
          error: {
            code: "AUTH_FORBIDDEN",
            message: "Guard is not active",
            traceId,
          },
        });
        return;
      }

      if (!allowed.includes(guard.role)) {
        res.status(403).json({
          error: {
            code: "AUTH_FORBIDDEN",
            message: `Role '${guard.role}' is not permitted for this endpoint`,
            traceId,
          },
        });
        return;
      }

      next();
    } catch {
      res.status(500).json({
        error: {
          code: "INTERNAL_ERROR",
          message: "Role check failed",
          traceId,
        },
      });
    }
  };
}
