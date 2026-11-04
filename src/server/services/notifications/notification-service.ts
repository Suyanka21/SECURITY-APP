/**
 * GatePass — Notification Service
 *
 * Source: src/docs/specs/notifications.md §5 (architecture), §6 (provider),
 *         §7 (endpoints), §9 (state machine), §11 (audit).
 * Source: Security-and-Hardening — idempotency keys, scrubbed responses,
 *         default-deny on unknown env.
 * Source: Trustless-System-Auditor — every failure path is provable.
 *
 * Responsibilities:
 *   1. enqueueNotification()      — INSERT a 'queued' row (called inside
 *                                   the approval txn so a failed approval
 *                                   never leaves an orphan delivery).
 *   2. dispatchNotification()     — fetch + mark 'sending' + call provider
 *                                   + mark 'delivered' | 'failed';
 *                                   on WA failure, enqueue SMS fallback.
 *   3. listNotificationsForApproval() — guard auth-gated read.
 *   4. retryNotification()        — guard-triggered manual retry.
 *   5. lazyFlipStaleSending()     — read-time sweep for sending > N s.
 *
 * Hard rules:
 *   - Provider failures NEVER throw out of dispatch — they always
 *     resolve into a recorded row state. The HTTP response to the
 *     guard MUST NOT depend on delivery outcome (B2 in spec §2).
 *   - Idempotency keys are computed deterministically. The dispatcher
 *     can be called twice for the same logical attempt; the second
 *     call collapses to no-op via the DB UNIQUE constraint.
 *   - Every state transition emits exactly one audit event.
 */

import { createHash, randomUUID } from "crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import {
  notifications,
  notificationCallbacks,
  approvalRequests,
} from "@/db/schema";
import { emitAuditEvent, publishAuditEvent, type AuditEvent } from "../audit-logger";
import { ServiceError } from "../errors";
import { maskPhoneE164 } from "../phone-mask";
import { NotificationErrorCodes } from "../../validation/notification-schemas";
import {
  NotificationError,
  truncateResponseExcerpt,
  type NotificationProvider,
  type NotificationChannel,
  type NotificationSendResult,
} from "./provider";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default max attempts before flipping to permanently_failed (spec B5). */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * If a row has been 'sending' for longer than this, it's considered
 * lost (crashed dispatcher) and is flipped to 'failed' on the next
 * read. Spec §9.
 */
export const SENDING_STALE_THRESHOLD_MS = 30_000;

/** Retry rate limit per approval — spec §7.3. */
export const RETRY_RATE_LIMIT_MS = 30_000;

/** Allowed status values surfaced to the API view. */
type NotificationStatus =
  | "queued"
  | "sending"
  | "sent"
  | "delivered"
  | "failed"
  | "permanently_failed";

// ─── DB type ─────────────────────────────────────────────────────────────────
// Loose shape matching the convention used in approval-service.ts so
// tests can inject a mock without coupling to Drizzle internals.

export interface DrizzleDB {
  select: (...args: unknown[]) => unknown;
  insert: (...args: unknown[]) => unknown;
  update: (...args: unknown[]) => unknown;
  transaction: (...args: unknown[]) => unknown;
  query: Record<string, unknown>;
  [key: string]: unknown;
}

// ─── Idempotency key ─────────────────────────────────────────────────────────
// sha256(approval_id || ':' || channel || ':' || attempt_no) → hex.
// UNIQUE in DB so two enqueues collapse into one row.

export function computeIdempotencyKey(
  approvalId: string,
  channel: NotificationChannel,
  attemptNo: number,
): string {
  return createHash("sha256")
    .update(`${approvalId}:${channel}:${attemptNo}`)
    .digest("hex");
}

// ─── Templates ───────────────────────────────────────────────────────────────
// Source: spec §8 — template-only bodies, no free-form. The visitor
// name is included but the phone number is NEVER part of the body.
// The magic-link URL itself is opaque (token + id).

export interface ApprovalTemplateInput {
  visitorName: string;
  host: string;
  unit: string;
  magicLinkUrl: string;
}

export const TEMPLATE_KEYS = {
  approvalMagicLink: "approval.magic_link",
} as const;

/**
 * Inverse of renderApprovalMagicLinkBody, for providers that need the
 * template variables (WhatsApp Content Templates) rather than the body.
 * Returns null for a body this renderer did not produce.
 */
export function parseApprovalMagicLinkBody(body: string): ApprovalTemplateInput | null {
  const m = /^GatePass: (.+) is at the gate for (.+) \(Unit (.+)\)\.\nApprove or deny: (\S+)$/s.exec(body);
  if (!m) return null;
  return { visitorName: m[1], host: m[2], unit: m[3], magicLinkUrl: m[4] };
}

export function renderApprovalMagicLinkBody(input: ApprovalTemplateInput): string {
  // Plain text body. WhatsApp + SMS both accept this shape. The link is
  // last so SMS character truncation doesn't lose it.
  return [
    `GatePass: ${input.visitorName} is at the gate for ${input.host} (Unit ${input.unit}).`,
    `Approve or deny: ${input.magicLinkUrl}`,
  ].join("\n");
}

// ─── Provider registry ───────────────────────────────────────────────────────
// One provider per channel, injected. The dispatcher always tries the
// WA provider first; on failure it enqueues an SMS row.

export interface NotificationProviderRegistry {
  whatsapp: NotificationProvider;
  sms: NotificationProvider;
}

// ─── Internal row shape ──────────────────────────────────────────────────────
// What we read back from the DB. Mirrors the table columns.

interface NotificationRow {
  id: string;
  approvalId: string;
  channel: NotificationChannel;
  targetPhone: string;
  templateKey: string;
  renderedBody: string;
  status: NotificationStatus;
  attempts: number;
  idempotencyKey: string;
  lastProviderResponseCode: number | null;
  lastProviderResponseExcerpt: string | null;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
  deliveredAt: Date | null;
  failedAt: Date | null;
  providerMessageId?: string | null;
}

// ─── Public API view mapper ──────────────────────────────────────────────────

function toView(row: NotificationRow) {
  return {
    id: row.id,
    approvalId: row.approvalId,
    channel: row.channel,
    // Staff see only the masked target; the full number stays on the server.
    targetPhoneMasked: maskPhoneE164(row.targetPhone),
    templateKey: row.templateKey,
    status: row.status,
    attempts: row.attempts,
    lastErrorCode: row.lastErrorCode,
    lastProviderResponseCode: row.lastProviderResponseCode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
    failedAt: row.failedAt ? row.failedAt.toISOString() : null,
  };
}

// ─── enqueueNotification ─────────────────────────────────────────────────────
// Called INSIDE the approval transaction. If the approval write rolls
// back, the notification write rolls back too — no orphans.

export interface EnqueueNotificationInput {
  approvalId: string;
  channel: NotificationChannel;
  targetPhone: string;
  templateKey: string;
  renderedBody: string;
  attemptNo: number;
}

export async function enqueueNotification(
  tx: DrizzleDB,
  input: EnqueueNotificationInput,
): Promise<{ id: string; idempotencyKey: string }> {
  const id = randomUUID();
  const idempotencyKey = computeIdempotencyKey(
    input.approvalId,
    input.channel,
    input.attemptNo,
  );
  await (tx.insert as (table: unknown) => { values: (row: unknown) => Promise<void> })(
    notifications,
  ).values({
    id,
    approvalId: input.approvalId,
    channel: input.channel,
    targetPhone: input.targetPhone,
    templateKey: input.templateKey,
    renderedBody: input.renderedBody,
    status: "queued",
    attempts: input.attemptNo,
    idempotencyKey,
  });
  return { id, idempotencyKey };
}

// ─── dispatchNotification ────────────────────────────────────────────────────
// Drives one row from queued → sending → delivered | failed. On WA
// failure, enqueues an SMS fallback row (which will be picked up on
// the next dispatcher tick). NEVER throws — all outcomes are persisted
// state.

export interface DispatchOptions {
  providers: NotificationProviderRegistry;
  /** Audit guard ID — required for emitAuditEvent. */
  systemGuardId: string;
  /** Override for testing — defaults to module constant. */
  maxAttempts?: number;
  /** Override for testing — defaults to module constant. */
  stalenessThresholdMs?: number;
}

export interface DispatchOutcome {
  notificationId: string;
  finalStatus: NotificationStatus;
  fallbackEnqueued: boolean;
}

export async function dispatchNotification(
  db: DrizzleDB,
  notificationId: string,
  opts: DispatchOptions,
): Promise<DispatchOutcome> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const stalenessMs = opts.stalenessThresholdMs ?? SENDING_STALE_THRESHOLD_MS;

  const row = await loadNotificationRow(db, notificationId);
  if (!row) {
    throw new ServiceError(
      NotificationErrorCodes.NOTIFICATION_NOT_FOUND,
      "Notification not found",
      404,
    );
  }

  // Lazy flip of stale 'sending' rows (crashed dispatcher recovery).
  if (
    row.status === "sending" &&
    Date.now() - row.updatedAt.getTime() > stalenessMs
  ) {
    await markFailed(db, row, {
      providerResponseCode: null,
      providerResponseExcerpt: null,
      errorCode: "DISPATCHER_STALE",
    });
    row.status = "failed";
  }

  // Terminal rows, and rows Twilio already accepted ('sent', waiting for
  // its status callback), are a no-op (idempotent at the API).
  if (
    row.status === "delivered" ||
    row.status === "sent" ||
    row.status === "permanently_failed"
  ) {
    return {
      notificationId: row.id,
      finalStatus: row.status,
      fallbackEnqueued: false,
    };
  }

  // Flip to 'sending' before the outbound call so a crash leaves an
  // observable state for the lazy sweep above.
  await markSending(db, row);
  row.status = "sending";

  const provider = opts.providers[row.channel];
  let accepted: NotificationSendResult | null = null;
  try {
    const templateVars = parseApprovalMagicLinkBody(row.renderedBody);
    const result = await provider.send({
      target: row.targetPhone,
      body: row.renderedBody,
      // One key per attempt: a concurrent replay of this attempt dedups, a
      // Resend (next attempt) sends a new message.
      idempotencyKey: `${row.idempotencyKey}:${row.attempts}`,
      ...(templateVars
        ? { template: { key: row.templateKey, variables: { ...templateVars } } }
        : {}),
    });
    if (result.acceptedOnly) {
      accepted = result;
    } else {
    await markDelivered(db, row, {
      providerResponseCode: result.responseCode,
      providerResponseExcerpt: truncateResponseExcerpt(result.responseExcerpt),
      providerMessageId: result.providerMessageId,
    });
    await emitAuditEvent(
      "notification_sent",
      opts.systemGuardId,
      row.id,
      {
        notificationId: row.id,
        approvalId: row.approvalId,
        channel: row.channel,
        providerMessageId: result.providerMessageId,
      },
    );
    return {
      notificationId: row.id,
      finalStatus: "delivered",
      fallbackEnqueued: false,
    };
    }
  } catch (err) {
    const isNotificationError = err instanceof NotificationError;
    const errorCode = isNotificationError ? err.code : "UNEXPECTED_ERROR";
    const responseCode = isNotificationError ? err.responseCode : null;
    const responseExcerpt = isNotificationError
      ? truncateResponseExcerpt(err.responseExcerpt)
      : truncateResponseExcerpt(String((err as Error).message ?? "unknown"));

    const newAttempts = row.attempts + 1;
    const exhausted = newAttempts >= maxAttempts;
    const nextStatus: NotificationStatus = exhausted
      ? "permanently_failed"
      : "failed";

    await markFailedTerminal(db, row, {
      providerResponseCode: responseCode,
      providerResponseExcerpt: responseExcerpt,
      errorCode,
      nextStatus,
      attempts: newAttempts,
    });

    await emitAuditEvent(
      nextStatus === "permanently_failed"
        ? "notification_permanently_failed"
        : "notification_failed",
      opts.systemGuardId,
      row.id,
      {
        notificationId: row.id,
        approvalId: row.approvalId,
        channel: row.channel,
        errorCode,
        attempts: newAttempts,
      },
    );

    // WA → SMS fallback (spec §5). Only fires when:
    //   - The failed channel was WA AND
    //   - We have an SMS provider configured AND
    //   - The row that just failed is not already SMS
    const fallbackEnqueued =
      row.channel === "whatsapp" &&
      !exhausted &&
      (await enqueueAndDispatchSmsFallback(db, row, opts));

    return {
      notificationId: row.id,
      finalStatus: nextStatus,
      fallbackEnqueued,
    };
  }
  // Twilio has the message: from here a failed local write is not a send failure.
  if (!accepted) throw new Error("unreachable: provider send neither returned nor threw");
  return acceptAndApplyStoredCallbacks(db, row, accepted, opts, maxAttempts);
}

/**
 * Queues the SMS fallback row and dispatches it straight away (spec
 * twilio-provider.md G2: nothing else ever picks a queued row up).
 */
async function enqueueAndDispatchSmsFallback(
  db: DrizzleDB,
  failedRow: NotificationRow,
  opts: DispatchOptions,
): Promise<boolean> {
  const fallbackId = await maybeEnqueueSmsFallback(db, failedRow);
  if (!fallbackId) return false;
  await dispatchNotification(db, fallbackId, opts);
  return true;
}

async function maybeEnqueueSmsFallback(
  db: DrizzleDB,
  failedRow: NotificationRow,
): Promise<string | null> {
  // Has an SMS attempt already been queued for this approval? If yes,
  // do not duplicate — the dispatcher already has it.
  const existing = await loadNotificationsForApproval(db, failedRow.approvalId);
  const smsAlreadyExists = existing.some((n) => n.channel === "sms");
  if (smsAlreadyExists) return null;

  // The SMS attempt is its own row with attempt_no=0.
  const { id } = await enqueueNotification(db, {
    approvalId: failedRow.approvalId,
    channel: "sms",
    targetPhone: failedRow.targetPhone,
    templateKey: failedRow.templateKey,
    renderedBody: failedRow.renderedBody,
    attemptNo: 0,
  });
  return id;
}

// ─── Twilio delivery status (twilio-provider.md §3, option B) ───────────────
// The dispatcher (saves the SID, applies stored callbacks) and the webhook
// (stores the callback, applies it if the SID is known) each run in one
// transaction holding pg_advisory_xact_lock on the SID, so whichever runs
// second sees the other's committed write and no callback is missed.

export type TwilioCallbackStatus = "delivered" | "read" | "failed" | "undelivered";

interface StoredCallback {
  status: string;
  errorCode: string | null;
}

interface CallbackOutcome {
  events: AuditEvent[];
  /** SMS fallback row queued in the same transaction, dispatched after commit. */
  fallbackId: string | null;
  finalStatus: NotificationStatus;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

async function lockMessageSid(tx: Tx, sid: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${sid}, 0))`);
}

async function applyCallbacks(
  tx: Tx,
  row: NotificationRow,
  callbacks: StoredCallback[],
  guardId: string,
  maxAttempts: number,
): Promise<CallbackOutcome> {
  const events: AuditEvent[] = [];
  let status = row.status;
  let fallbackId: string | null = null;
  for (const cb of callbacks) {
    // Only a row still waiting on the provider can move; a late or replayed
    // callback cannot change a finished row.
    if (status !== "sending" && status !== "sent") break;
    const now = new Date();
    if (cb.status === "delivered" || cb.status === "read") {
      await tx
        .update(notifications)
        .set({ status: "delivered", deliveredAt: now, updatedAt: now, lastErrorCode: null })
        .where(eq(notifications.id, row.id));
      status = "delivered";
      events.push(
        await emitAuditEvent(
          "notification_delivered",
          guardId,
          row.id,
          { notificationId: row.id, approvalId: row.approvalId, channel: row.channel },
          { tx },
        ),
      );
    } else if (cb.status === "failed" || cb.status === "undelivered") {
      const exhausted = row.attempts >= maxAttempts;
      const nextStatus = exhausted ? "permanently_failed" : "failed";
      const errorCode = `DELIVERY_${cb.status.toUpperCase()}`;
      await tx
        .update(notifications)
        .set({
          status: nextStatus,
          failedAt: now,
          updatedAt: now,
          lastErrorCode: errorCode,
          lastProviderResponseExcerpt: truncateResponseExcerpt(
            `callback status=${cb.status}${cb.errorCode ? ` code=${cb.errorCode}` : ""}`,
          ),
        })
        .where(eq(notifications.id, row.id));
      status = nextStatus;
      events.push(
        await emitAuditEvent(
          nextStatus === "permanently_failed" ? "notification_permanently_failed" : "notification_failed",
          guardId,
          row.id,
          {
            notificationId: row.id,
            approvalId: row.approvalId,
            channel: row.channel,
            errorCode,
            providerErrorCode: cb.errorCode,
            attempts: row.attempts,
          },
          { tx },
        ),
      );
      if (row.channel === "whatsapp" && !exhausted) {
        fallbackId = await maybeEnqueueSmsFallback(tx, row);
      }
    }
  }
  return { events, fallbackId, finalStatus: status };
}

async function acceptAndApplyStoredCallbacks(
  db: DrizzleDB,
  row: NotificationRow,
  result: { providerMessageId: string; responseCode: number; responseExcerpt: string },
  opts: DispatchOptions,
  maxAttempts: number,
): Promise<DispatchOutcome> {
  const sid = result.providerMessageId;
  const run = (withSentEvent: boolean) =>
    (db.transaction as (fn: (tx: Tx) => Promise<CallbackOutcome>) => Promise<CallbackOutcome>)(async (tx) => {
      await lockMessageSid(tx, sid);
      const now = new Date();
      const attempts = row.attempts + 1;
      await tx
        .update(notifications)
        .set({
          status: "sent",
          updatedAt: now,
          attempts,
          providerMessageId: sid,
          lastProviderResponseCode: result.responseCode,
          lastProviderResponseExcerpt: truncateResponseExcerpt(result.responseExcerpt),
          lastErrorCode: null,
        })
        .where(eq(notifications.id, row.id));
      const events: AuditEvent[] = [];
      if (withSentEvent) {
        events.push(
          await emitAuditEvent(
            "notification_sent",
            opts.systemGuardId,
            row.id,
            { notificationId: row.id, approvalId: row.approvalId, channel: row.channel, providerMessageId: sid },
            { tx },
          ),
        );
      }
      const stored: StoredCallback[] = await tx
        .select({ status: notificationCallbacks.status, errorCode: notificationCallbacks.errorCode })
        .from(notificationCallbacks)
        .where(eq(notificationCallbacks.messageSid, sid))
        .orderBy(asc(notificationCallbacks.receivedAt));
      const applied = await applyCallbacks(
        tx,
        { ...row, status: "sent", attempts },
        stored,
        opts.systemGuardId,
        maxAttempts,
      );
      return { ...applied, events: [...events, ...applied.events] };
    });

  let outcome: CallbackOutcome;
  try {
    outcome = await run(true);
  } catch (err) {
    // Twilio has the message, so a failed local write is never a refused send.
    // Retry once without the 'sent' audit row (still under the SID lock, still
    // replaying callbacks that arrived early); if that fails too, at least keep
    // the SID so Twilio's next callback can find the row.
    try {
      outcome = await run(false);
      // The audit table is missing this one 'sent' row; leave a trace in the
      // server log (ids only, no number or body) so it can be reconciled.
      console.error(
        `[NOTIFY] notification_sent audit row not written | notification=${row.id} | sid=${sid} | pg=${pgErrorCode(err)}`,
      );
    } catch {
      const saved = await saveAcceptedSidBestEffort(db, row, result);
      if (!saved) throw err;
      return { notificationId: row.id, finalStatus: "sent", fallbackEnqueued: false };
    }
  }
  outcome.events.forEach(publishAuditEvent);
  const fallbackEnqueued = await dispatchQueuedFallback(db, outcome.fallbackId, opts);
  return { notificationId: row.id, finalStatus: outcome.finalStatus, fallbackEnqueued };
}

function pgErrorCode(err: unknown): string {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === "string" ? code : "?";
}

async function saveAcceptedSidBestEffort(
  db: DrizzleDB,
  row: NotificationRow,
  result: { providerMessageId: string; responseCode: number },
): Promise<boolean> {
  try {
    const now = new Date();
    await (db.update as (t: unknown) => Tx)(notifications)
      .set({
        status: "sent",
        updatedAt: now,
        attempts: row.attempts + 1,
        providerMessageId: result.providerMessageId,
        lastProviderResponseCode: result.responseCode,
        lastErrorCode: null,
      })
      .where(and(eq(notifications.id, row.id), eq(notifications.status, "sending")));
    return true;
  } catch {
    return false;
  }
}

async function dispatchQueuedFallback(
  db: DrizzleDB,
  fallbackId: string | null,
  opts: DispatchOptions,
): Promise<boolean> {
  if (!fallbackId) return false;
  await dispatchNotification(db, fallbackId, opts);
  return true;
}

export interface TwilioCallbackInput {
  messageSid: string;
  status: TwilioCallbackStatus;
  errorCode: string | null;
}

export interface TwilioCallbackResult {
  stored: boolean;
  notificationId: string | null;
  finalStatus: NotificationStatus | null;
  fallbackEnqueued: boolean;
}

/**
 * Stores a signature-verified Twilio status callback, then applies it if the
 * message SID is already saved on a row. A repeat (same SID + status) hits
 * the unique index and changes nothing.
 */
export async function recordTwilioStatusCallback(
  db: DrizzleDB,
  input: TwilioCallbackInput,
  opts: { providers: NotificationProviderRegistry; maxAttempts?: number },
): Promise<TwilioCallbackResult> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  type Out = { stored: boolean; row: NotificationRow | null; guardId: string | null; outcome: CallbackOutcome | null };
  const out: Out = await (db.transaction as (fn: (tx: Tx) => Promise<Out>) => Promise<Out>)(async (tx) => {
    await lockMessageSid(tx, input.messageSid);
    const inserted = await tx
      .insert(notificationCallbacks)
      .values({ messageSid: input.messageSid, status: input.status, errorCode: input.errorCode })
      .onConflictDoNothing()
      .returning({ id: notificationCallbacks.id });
    const rows: NotificationRow[] = await tx
      .select()
      .from(notifications)
      .where(eq(notifications.providerMessageId, input.messageSid))
      .limit(1);
    const row = rows[0] ?? null;
    if (inserted.length === 0 || !row) {
      return { stored: inserted.length > 0, row, guardId: null, outcome: null };
    }
    const approval = await loadApprovalGuardId(tx, row.approvalId);
    const guardId = approval?.requestedByGuardId ?? "";
    const outcome = await applyCallbacks(tx, row, [input], guardId, maxAttempts);
    return { stored: true, row, guardId, outcome };
  });
  if (!out.outcome || !out.row) {
    return { stored: out.stored, notificationId: out.row?.id ?? null, finalStatus: out.row?.status ?? null, fallbackEnqueued: false };
  }
  out.outcome.events.forEach(publishAuditEvent);
  const fallbackEnqueued = await dispatchQueuedFallback(db, out.outcome.fallbackId, {
    providers: opts.providers,
    systemGuardId: out.guardId ?? "",
    maxAttempts,
  });
  return { stored: true, notificationId: out.row.id, finalStatus: out.outcome.finalStatus, fallbackEnqueued };
}

// ─── listNotificationsForApproval (route handler use) ────────────────────────
// Guard-auth-gated: returns the per-approval delivery rows after
// verifying the calling guard owns the approval.

export async function listNotificationsForApproval(
  db: DrizzleDB,
  approvalId: string,
  guardId: string,
): Promise<NotificationRow[]> {
  const approval = await loadApprovalGuardId(db, approvalId);
  if (!approval) {
    throw new ServiceError(
      NotificationErrorCodes.NOTIFICATION_NOT_FOUND,
      "Approval not found",
      404,
    );
  }
  if (approval.requestedByGuardId !== guardId) {
    throw new ServiceError(
      NotificationErrorCodes.NOTIFICATION_GUARD_MISMATCH,
      "Notification does not belong to this guard",
      403,
    );
  }
  return loadNotificationsForApproval(db, approvalId);
}

// ─── retryNotification (route handler use) ───────────────────────────────────
// Guard-triggered manual retry. Spec §7.3 constraints.

export interface RetryOptions {
  /** Audit guard ID (the JWT-authenticated guard). */
  guardId: string;
  /** Defaults to module constant. */
  rateLimitMs?: number;
  /** Defaults to module constant. */
  maxAttempts?: number;
}

export async function retryNotification(
  db: DrizzleDB,
  notificationId: string,
  opts: RetryOptions,
): Promise<NotificationRow> {
  const rateMs = opts.rateLimitMs ?? RETRY_RATE_LIMIT_MS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const row = await loadNotificationRow(db, notificationId);
  if (!row) {
    throw new ServiceError(
      NotificationErrorCodes.NOTIFICATION_NOT_FOUND,
      "Notification not found",
      404,
    );
  }

  const approval = await loadApprovalGuardId(db, row.approvalId);
  if (!approval) {
    // Shouldn't happen given FK + CASCADE, but be defensive.
    throw new ServiceError(
      NotificationErrorCodes.NOTIFICATION_NOT_FOUND,
      "Approval not found",
      404,
    );
  }
  if (approval.requestedByGuardId !== opts.guardId) {
    throw new ServiceError(
      NotificationErrorCodes.NOTIFICATION_GUARD_MISMATCH,
      "Notification does not belong to this guard",
      403,
    );
  }
  if (approval.status !== "pending") {
    throw new ServiceError(
      NotificationErrorCodes.APPROVAL_TERMINAL,
      "Approval is no longer pending",
      410,
    );
  }
  if (row.status !== "failed" || row.attempts >= maxAttempts) {
    throw new ServiceError(
      NotificationErrorCodes.NOTIFICATION_NOT_RETRYABLE,
      "Notification cannot be retried",
      409,
    );
  }
  // Throttle by failedAt — most recent failure must be older than rateMs.
  const lastFailedMs = row.failedAt ? row.failedAt.getTime() : 0;
  if (Date.now() - lastFailedMs < rateMs) {
    throw new ServiceError(
      NotificationErrorCodes.RETRY_RATE_LIMITED,
      "Retry is rate-limited",
      429,
    );
  }

  // Flip back to 'queued' and clear last_error so the dispatcher
  // picks it up on the next tick.
  await (db.update as (table: unknown) => {
    set: (patch: Partial<NotificationRow>) => {
      where: (...args: unknown[]) => Promise<void>;
    };
  })(notifications)
    .set({
      status: "queued",
      lastErrorCode: null,
      lastProviderResponseCode: null,
      lastProviderResponseExcerpt: null,
      failedAt: null,
      // A late callback for the previous attempt must not touch the new one.
      providerMessageId: null,
      updatedAt: new Date(),
    })
    .where(eq(notifications.id, row.id));

  const reloaded = await loadNotificationRow(db, row.id);
  if (!reloaded) {
    // Defensive — the row exists; this is unreachable in practice.
    throw new ServiceError(
      NotificationErrorCodes.NOTIFICATION_NOT_FOUND,
      "Notification disappeared after retry",
      404,
    );
  }
  return reloaded;
}

// ─── DB helpers (kept private) ───────────────────────────────────────────────

async function loadNotificationRow(
  db: DrizzleDB,
  id: string,
): Promise<NotificationRow | null> {
  const rows = await (db.select as () => {
    from: (table: unknown) => {
      where: (...args: unknown[]) => { limit: (n: number) => Promise<NotificationRow[]> };
    };
  })()
    .from(notifications)
    .where(eq(notifications.id, id))
    .limit(1);
  return rows[0] ?? null;
}

async function loadNotificationsForApproval(
  db: DrizzleDB,
  approvalId: string,
): Promise<NotificationRow[]> {
  return (db.select as () => {
    from: (table: unknown) => {
      where: (...args: unknown[]) => Promise<NotificationRow[]>;
    };
  })()
    .from(notifications)
    .where(eq(notifications.approvalId, approvalId));
}

async function loadApprovalGuardId(
  db: DrizzleDB,
  approvalId: string,
): Promise<{ requestedByGuardId: string; status: string } | null> {
  const rows = await (db.select as () => {
    from: (table: unknown) => {
      where: (...args: unknown[]) => { limit: (n: number) => Promise<{ requestedByGuardId: string; status: string }[]> };
    };
  })()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, approvalId))
    .limit(1);
  return rows[0] ?? null;
}

async function markSending(db: DrizzleDB, row: NotificationRow): Promise<void> {
  await (db.update as (table: unknown) => {
    set: (patch: Partial<NotificationRow>) => {
      where: (...args: unknown[]) => Promise<void>;
    };
  })(notifications)
    .set({ status: "sending", updatedAt: new Date() })
    .where(eq(notifications.id, row.id));
}

async function markDelivered(
  db: DrizzleDB,
  row: NotificationRow,
  opts: {
    providerResponseCode: number | null;
    providerResponseExcerpt: string | null;
    providerMessageId?: string | null;
  },
): Promise<void> {
  const now = new Date();
  await (db.update as (table: unknown) => {
    set: (patch: Partial<NotificationRow>) => {
      where: (...args: unknown[]) => Promise<void>;
    };
  })(notifications)
    .set({
      status: "delivered",
      deliveredAt: now,
      updatedAt: now,
      attempts: row.attempts + 1,
      lastProviderResponseCode: opts.providerResponseCode,
      lastProviderResponseExcerpt: opts.providerResponseExcerpt,
      lastErrorCode: null,
    })
    .where(eq(notifications.id, row.id));
}

async function markFailedTerminal(
  db: DrizzleDB,
  row: NotificationRow,
  opts: {
    providerResponseCode: number | null;
    providerResponseExcerpt: string | null;
    errorCode: string;
    nextStatus: "failed" | "permanently_failed";
    attempts: number;
  },
): Promise<void> {
  const now = new Date();
  await (db.update as (table: unknown) => {
    set: (patch: Partial<NotificationRow>) => {
      where: (...args: unknown[]) => Promise<void>;
    };
  })(notifications)
    .set({
      status: opts.nextStatus,
      failedAt: now,
      updatedAt: now,
      attempts: opts.attempts,
      lastProviderResponseCode: opts.providerResponseCode,
      lastProviderResponseExcerpt: opts.providerResponseExcerpt,
      lastErrorCode: opts.errorCode,
    })
    .where(eq(notifications.id, row.id));
}

async function markFailed(
  db: DrizzleDB,
  row: NotificationRow,
  opts: {
    providerResponseCode: number | null;
    providerResponseExcerpt: string | null;
    errorCode: string;
  },
): Promise<void> {
  await markFailedTerminal(db, row, {
    providerResponseCode: opts.providerResponseCode,
    providerResponseExcerpt: opts.providerResponseExcerpt,
    errorCode: opts.errorCode,
    nextStatus: "failed",
    attempts: row.attempts + 1,
  });
}

// ─── Re-export view mapper for route handlers ────────────────────────────────
export { toView };

// ─── Inline-use export for future query helpers ──────────────────────────────
// `inArray` is re-exported so route handlers (e.g. bulk fetch) can
// import from this module without pulling drizzle-orm directly.
export { inArray, and };
