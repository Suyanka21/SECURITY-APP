/**
 * GatePass — staff password reset request.
 *
 *   POST /api/auth/password-reset   public, passwordResetLimiter (app.ts)
 *
 * - Never reveals whether an email has an account: every well-formed request
 *   gets the same 202 body, and the Supabase call runs after the response is
 *   sent, so the response time does not depend on it either.
 * - Rate limited per IP (app.ts) and, silently, per email address.
 * - The email address is never logged; failures log a short hash only.
 * - The reset link is built by Supabase from APP_PUBLIC_ORIGIN; its tokens
 *   sit in the URL fragment, which is not sent to servers or logged.
 */

import type { Request, Response } from "express";
import { createHash, randomUUID } from "crypto";
import { z } from "zod";

import { isSupabaseAdminConfigured, requestPasswordRecovery } from "../auth/supabase-admin";

export const PASSWORD_RESET_EMAIL_COOLDOWN_MS = 60_000;
export const PASSWORD_RESET_MESSAGE =
  "If that email belongs to a GatePass staff account, a reset link is on its way. Check your inbox.";

export const PasswordResetRequestSchema = z
  .object({
    email: z
      .string({ required_error: "Email is required" })
      .trim()
      .toLowerCase()
      .max(254, "Enter a valid email address")
      .email("Enter a valid email address"),
  })
  .strict();

const lastRequestAt = new Map<string, number>();
// Expired entries are swept once the map reaches this size, so it cannot grow
// without bound.
const COOLDOWN_SWEEP_AT = 1_000;

/** Test hook: forget the per-email cooldowns. */
export function passwordResetCooldownSize(): number {
  return lastRequestAt.size;
}

export function resetPasswordResetCooldowns(): void {
  lastRequestAt.clear();
}

function emailTag(email: string): string {
  return createHash("sha256").update(email).digest("hex").slice(0, 12);
}

function resolveRedirect(): string {
  const origin = (process.env.APP_PUBLIC_ORIGIN ?? "http://localhost:5173").replace(/\/+$/, "");
  return `${origin}/reset-password`;
}

export type RecoverySender = (email: string, redirectTo: string) => Promise<void>;

export function makePasswordResetHandler(
  send: RecoverySender = requestPasswordRecovery,
  now: () => number = () => Date.now(),
) {
  return function handlePasswordReset(req: Request, res: Response): void {
    const traceId = `trace-${randomUUID()}`;
    const parsed = PasswordResetRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(422).json({
        error: {
          code: "VALIDATION_ERROR",
          message: parsed.error.issues[0]?.message ?? "Enter a valid email address",
          field: "email",
          traceId,
        },
      });
      return;
    }

    const { email } = parsed.data;
    res.status(202).json({ message: PASSWORD_RESET_MESSAGE, traceId });

    const at = now();
    if (lastRequestAt.size >= COOLDOWN_SWEEP_AT) {
      for (const [key, t] of lastRequestAt) {
        if (at - t >= PASSWORD_RESET_EMAIL_COOLDOWN_MS) lastRequestAt.delete(key);
      }
    }
    const previous = lastRequestAt.get(email);
    if (previous !== undefined && at - previous < PASSWORD_RESET_EMAIL_COOLDOWN_MS) return;
    lastRequestAt.set(email, at);

    if (!isSupabaseAdminConfigured()) {
      console.warn(`[password-reset] Supabase Auth is not configured; no email sent (email#${emailTag(email)})`);
      return;
    }
    void send(email, resolveRedirect()).catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : "unknown error";
      console.error(`[password-reset] recovery request failed for email#${emailTag(email)}: ${reason}`);
    });
  };
}

export const handlePasswordReset = makePasswordResetHandler();
