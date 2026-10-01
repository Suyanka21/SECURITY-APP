/**
 * GatePass — Resident authentication middleware (Resident Portal, PR R1).
 *
 * Source: src/docs/specs/resident-portal.md §2.4, §3.1.
 *
 * Residents are a SEPARATE actor model from staff:
 * - The token is verified exactly like staff tokens (Supabase JWKS, or the
 *   legacy HS256 secret when SUPABASE_URL is unset), but `sub` is resolved
 *   against residents.supabase_user_id — never guards.
 * - A resident is never a row in `guards`, so requireRole can never be
 *   satisfied by a resident token, and a guard token never resolves here.
 * - Everything is fail-closed: unknown user, inactive resident, inactive
 *   unit → 403. Identity + unit are injected from the DB, never the client.
 *
 * Two middlewares:
 * - requireSupabaseUser: verified login only (used by POST /api/resident/claim,
 *   where the user is not yet a resident).
 * - requireResidentAuth: verified login + active resident + active unit.
 */

import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import * as jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@/db/schema";
import { residents, units } from "@/db/schema";
import {
  isSupabaseAuthConfigured,
  normalizePhoneClaim,
  verifySupabaseToken,
} from "../auth/supabase-jwt";
import { getJWTSecret } from "./auth";

export interface SupabaseUserRequest extends Request {
  /** Verified Supabase auth.users UUID (token `sub`) — never client-supplied */
  supabaseUserId: string;
  /** E.164 phone from the verified token, when the user signed in by phone */
  supabasePhone?: string;
}

export interface ResidentIdentity {
  residentId: string;
  supabaseUserId: string;
  displayName: string;
  phoneE164: string;
  unitId: string;
  /** Canonical text label written into authorization_decisions.unit etc. */
  unitLabel: string;
}

export interface ResidentRequest extends Request {
  /** Resident identity resolved from the DB — never client-supplied */
  resident: ResidentIdentity;
}

type ResidentDbHandle = Pick<NodePgDatabase<typeof schema>, "select">;

interface LegacyPayload {
  sub?: unknown;
  phone?: unknown;
}

type VerifiedLogin = { supabaseUserId: string; phone?: string };

function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  traceId: string,
): void {
  res.status(status).json({ error: { code, message, traceId } });
}

/**
 * Extracts and verifies the Bearer token. Returns null after writing the
 * error response, so callers just `return` on null.
 */
async function verifyLogin(
  req: Request,
  res: Response,
  traceId: string,
): Promise<VerifiedLogin | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    sendError(res, 401, "AUTH_TOKEN_MISSING", "Authentication required. Provide Bearer token in Authorization header.", traceId);
    return null;
  }
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    sendError(res, 401, "AUTH_TOKEN_MALFORMED", "Authorization header must be: Bearer <token>", traceId);
    return null;
  }
  const token = parts[1];

  if (isSupabaseAuthConfigured()) {
    try {
      const verified = await verifySupabaseToken(token);
      return { supabaseUserId: verified.sub, phone: verified.phone };
    } catch (err) {
      const expired =
        err && typeof err === "object" && (err as { code?: string }).code === "ERR_JWT_EXPIRED";
      if (expired) {
        sendError(res, 401, "AUTH_TOKEN_EXPIRED", "Authentication token has expired. Please re-authenticate.", traceId);
      } else {
        sendError(res, 401, "AUTH_TOKEN_INVALID", "Authentication token is invalid or corrupted.", traceId);
      }
      return null;
    }
  }

  // Legacy self-issued mode (development / tests): `sub` plays the role of
  // the Supabase user UUID; an optional `phone` claim mirrors Supabase's.
  let secret: string;
  try {
    secret = getJWTSecret();
  } catch {
    sendError(res, 503, "AUTH_MISCONFIGURED", "Authentication is not configured on this server (no Supabase URL and no legacy secret).", traceId);
    return null;
  }
  try {
    const payload = jwt.verify(token, secret, { algorithms: ["HS256"] }) as LegacyPayload;
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      sendError(res, 403, "AUTH_TOKEN_INVALID", "Token payload missing identity (sub)", traceId);
      return null;
    }
    return {
      supabaseUserId: payload.sub,
      phone: normalizePhoneClaim(payload.phone),
    };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      sendError(res, 401, "AUTH_TOKEN_EXPIRED", "Authentication token has expired. Please re-authenticate.", traceId);
    } else {
      sendError(res, 401, "AUTH_TOKEN_INVALID", "Authentication token is invalid or corrupted.", traceId);
    }
    return null;
  }
}

/**
 * Verified Supabase login, no resident row required. Injects
 * req.supabaseUserId (+ req.supabasePhone). Used only by the claim route.
 */
export async function requireSupabaseUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const traceId = `trace-${randomUUID()}`;
  const login = await verifyLogin(req, res, traceId);
  if (!login) return;
  const r = req as SupabaseUserRequest;
  r.supabaseUserId = login.supabaseUserId;
  r.supabasePhone = login.phone;
  next();
}

/**
 * Verified login that resolves to an ACTIVE resident of an ACTIVE unit.
 * Injects req.resident. Anything else is 403 — including staff tokens.
 */
export async function requireResidentAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const traceId = `trace-${randomUUID()}`;
  const login = await verifyLogin(req, res, traceId);
  if (!login) return;

  const db = (req as Request & { db?: ResidentDbHandle }).db;
  if (!db) {
    sendError(res, 500, "INTERNAL_ERROR", "Database handle missing on request", traceId);
    return;
  }

  try {
    const rows = await db
      .select({
        residentId: residents.id,
        supabaseUserId: residents.supabaseUserId,
        displayName: residents.displayName,
        phoneE164: residents.phoneE164,
        residentActive: residents.isActive,
        unitId: units.id,
        unitLabel: units.label,
        unitActive: units.isActive,
      })
      .from(residents)
      .innerJoin(units, eq(units.id, residents.unitId))
      .where(eq(residents.supabaseUserId, login.supabaseUserId));

    // A user who moved units has one inactive row per past unit and at most
    // one active row (partial unique index); the active row wins.
    const row = rows.find((r) => r.residentActive) ?? rows[0];
    if (!row) {
      sendError(res, 403, "AUTH_NO_RESIDENT_LINK", "This account is not linked to a resident unit.", traceId);
      return;
    }
    if (!row.residentActive) {
      sendError(res, 403, "RESIDENT_INACTIVE", "This resident account has been deactivated.", traceId);
      return;
    }
    if (!row.unitActive) {
      sendError(res, 403, "UNIT_INACTIVE", "This unit is no longer active.", traceId);
      return;
    }

    (req as ResidentRequest).resident = {
      residentId: row.residentId,
      supabaseUserId: row.supabaseUserId,
      displayName: row.displayName,
      phoneE164: row.phoneE164,
      unitId: row.unitId,
      unitLabel: row.unitLabel,
    };
    next();
  } catch {
    sendError(res, 500, "INTERNAL_ERROR", "Authentication lookup failed", traceId);
  }
}
