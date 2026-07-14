/**
 * GatePass — Auth identity route.
 *
 * Source: src/docs/specs/auth-and-role-routing.md §7 (source of truth) and
 *         src/docs/adr/0001-...md — the client learns its own role ONLY from
 *         the server, which reads it from guards.role (the same DB source
 *         requireRole checks). The client never derives its auth-role from a
 *         token, localStorage, or Supabase metadata.
 *
 * One handler:
 *   GET /api/auth/me   requireAuth (any authenticated guard role)
 *
 * Returns the caller's guard identity + DB role. Post-login routing selects the
 * guard/admin/resident interface from this response — never from the token.
 */

import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";

import { guards } from "@/db/schema";
import type { AuthenticatedRequest, GuardRole } from "../middleware/auth";

export interface AuthMeResponse {
  guardId: string;
  role: GuardRole;
  name: string;
  badgeNumber: string;
  isActive: boolean;
  traceId: string;
}

export async function handleGetMe(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const traceId = `trace-${randomUUID()}`;
  try {
    const guardId = (req as AuthenticatedRequest).guardId;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (req as any).db;
    const rows = (await db
      .select()
      .from(guards)
      .where(eq(guards.id, guardId))) as {
      id: string;
      role: GuardRole;
      name: string;
      badgeNumber: string;
      isActive: boolean;
    }[];

    const guard = rows?.[0];
    if (!guard) {
      // requireAuth resolved a guardId, but the row is gone — fail closed.
      res.status(401).json({
        error: { code: "AUTH_FAILED", message: "Guard not found", traceId },
      });
      return;
    }

    const body: AuthMeResponse = {
      guardId: guard.id,
      role: guard.role,
      name: guard.name,
      badgeNumber: guard.badgeNumber,
      isActive: guard.isActive,
      traceId,
    };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}
