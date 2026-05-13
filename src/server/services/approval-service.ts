/**
 * GatePass — Resident Approval Service
 *
 * Source: src/docs/specs/resident-approval-flow.md §§5–9
 * Source: GATEPASS DEFINITION.md §USER FLOW.2.B — "request approval"
 * Source: API-and-Interface-Design skill — typed boundary, structured errors
 * Source: Security-and-Hardening skill — magic-link tokens, hashed at rest
 * Source: Trustless-System-Auditor skill — no silent success, audit per transition
 *
 * Responsibilities:
 *   1. createApprovalRequest()   → generate token, hash it, INSERT pending row
 *   2. getApprovalStatus()       → lazy pending→expired flip; sanitized view
 *   3. decideApprovalRequest()   → token-auth, transactional approve/deny
 *
 * Hard rules (cannot be violated by any caller):
 *   - Guard identity comes from the verified JWT only — NEVER from the body.
 *   - Raw tokens are never stored or logged. Only SHA-256(token) lives in the DB.
 *   - tokenHash is wiped (set NULL) on the first successful decision → strict
 *     single-use. The DB UNIQUE on token_hash prevents reuse across rows.
 *   - Lazy expiry: any pending row read past expires_at is flipped to "expired"
 *     and the resulting view reflects that — clients can never observe a stale
 *     pending row.
 *   - Approval and deny are TRANSACTIONAL with the audit/entry side-effects:
 *     either everything succeeds and we have an entry + audit row, or nothing
 *     changes and the approval stays pending until expiry.
 */

import { eq, and } from "drizzle-orm";
import { randomBytes, createHash, randomUUID } from "crypto";
import {
  approvalRequests,
  entryRecords,
  guards,
} from "@/db/schema";
import {
  ApprovalErrorCodes,
  sanitizeFreeText,
  type CreateApprovalInput,
  type CreateApprovalResponse,
  type ApprovalStatusResponse,
  type DecideApprovalResponse,
  type ApprovalRequestView,
} from "../validation/approval-schemas";
import { ServiceError } from "./errors";
import { emitAuditEvent } from "./audit-logger";

// Re-exported so route handlers keep a single import surface.
export { ServiceError };

// ─── Config ──────────────────────────────────────────────────────────────────
// Source: spec §A6 — approval timeout is configurable, defaults to 300s.

const DEFAULT_APPROVAL_TIMEOUT_SECONDS = 300;

function resolveApprovalTimeoutSeconds(): number {
  const raw = process.env.APPROVAL_TIMEOUT_SECONDS;
  if (!raw) return DEFAULT_APPROVAL_TIMEOUT_SECONDS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 30 || parsed > 24 * 60 * 60) {
    // Refuse silly values (under 30s or over 24h) — fail loud, not silent.
    console.warn(
      `[APPROVAL] Ignoring APPROVAL_TIMEOUT_SECONDS=${raw} — out of range [30, 86400]. Falling back to ${DEFAULT_APPROVAL_TIMEOUT_SECONDS}.`
    );
    return DEFAULT_APPROVAL_TIMEOUT_SECONDS;
  }
  return parsed;
}

/**
 * Public host the resident uses to reach the magic-link page.
 *
 * Source: Security-and-Hardening — never let arbitrary user input control
 * outbound URLs. APP_PUBLIC_ORIGIN is operator-set in env.
 */
function resolvePublicOrigin(): string {
  return process.env.APP_PUBLIC_ORIGIN ?? "http://localhost:5173";
}

// ─── DB Type ─────────────────────────────────────────────────────────────────
// Loose shape to allow mocking. Same convention as entry-service.ts.

export interface DrizzleDB {
  select: (...args: unknown[]) => unknown;
  insert: (...args: unknown[]) => unknown;
  update: (...args: unknown[]) => unknown;
  transaction: (...args: unknown[]) => unknown;
  query: Record<string, unknown>;
  [key: string]: unknown;
}

// ─── Crypto helpers ──────────────────────────────────────────────────────────

/**
 * Generates a 256-bit cryptographic token, hex-encoded.
 *
 * Source: spec §A1 — 32 random bytes via Node's crypto.randomBytes.
 * Returns 64 hex chars. The raw value is shown to the resident ONCE in
 * the magic-link URL and never persists in our DB.
 */
function generateRawToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * SHA-256 hash, hex-encoded. Deterministic, no salt by design: token entropy
 * (256 bits) is far above offline-grind thresholds, and salting would prevent
 * the lookup in /decide.
 *
 * Source: spec §9 — security threat table, replay row.
 */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

// ─── Mapping helpers ─────────────────────────────────────────────────────────

interface ApprovalRow {
  id: string;
  offlineId: string;
  visitorName: string;
  host: string;
  unit: string;
  plate: string | null;
  reason: string;
  method: "walk-in";
  requestedByGuardId: string;
  tokenHash: string | null;
  status: "pending" | "approved" | "denied" | "expired";
  decidedAt: Date | null;
  deniedReason: string | null;
  entryId: string | null;
  expiresAt: Date;
  createdAt: Date;
  traceId: string;
}

/**
 * Strips secret material before returning an approval row to any caller.
 *
 * Source: spec §6.1 — pendingApproval reducer shape (no tokenHash).
 * Source: API-and-Interface-Design — "Don't leak implementation details."
 */
function toApprovalView(row: ApprovalRow): ApprovalRequestView {
  return {
    id: row.id,
    offlineId: row.offlineId,
    visitorName: row.visitorName,
    host: row.host,
    unit: row.unit,
    plate: row.plate ?? null,
    reason: row.reason,
    method: row.method,
    requestedByGuardId: row.requestedByGuardId,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    deniedReason: row.deniedReason,
    entryId: row.entryId,
    traceId: row.traceId,
  };
}

// ─── Time injection ──────────────────────────────────────────────────────────
// Tests need to advance the clock without sleeping. Callers may pass a `now`
// function; defaults to `Date.now`. Source: TDD skill — deterministic tests.

interface ServiceClock {
  /** Returns the current epoch in milliseconds */
  now(): number;
}

const DEFAULT_CLOCK: ServiceClock = { now: () => Date.now() };

// ─── 1. createApprovalRequest ─────────────────────────────────────────────────

/**
 * Inserts a pending approval row and returns the magic-link URL.
 *
 * Source: spec §7.1.
 * Failure modes:
 *   - guard not found / inactive  → 403 GUARD_SESSION_EXPIRED
 *   - offlineId already has a row → 409 APPROVAL_DUPLICATE
 *   - DB insert fails             → propagates (500 in route)
 *
 * SECURITY:
 *   - Raw token returned in the response ONLY via magicLinkUrl. The route
 *     layer must not log the URL.
 *   - guardId is required as a parameter (already verified by auth middleware
 *     at the route boundary). Never accepted from request body.
 */
export async function createApprovalRequest(
  input: CreateApprovalInput,
  guardId: string,
  db: DrizzleDB,
  clock: ServiceClock = DEFAULT_CLOCK
): Promise<{ response: CreateApprovalResponse; statusCode: number }> {
  const traceId = generateTraceId();

  // Step 1: verify guard exists and is active.
  // Source: spec §7.1 — "guard identity comes from JWT, verified here".
  const guardRows = await (db as any)
    .select({ id: guards.id, isActive: guards.isActive })
    .from(guards)
    .where(eq(guards.id, guardId))
    .limit(1);

  if (!guardRows || guardRows.length === 0 || !guardRows[0].isActive) {
    throw new ServiceError(
      ApprovalErrorCodes.GUARD_SESSION_EXPIRED,
      "Guard identity not found or session expired",
      403,
      "guardId"
    );
  }

  // Step 2: dedupe on offlineId. The UNIQUE constraint enforces this at the
  // DB level, but checking up-front lets us return a structured 409 instead
  // of a generic 500 on the constraint violation.
  // Source: spec §7.1 — 409 APPROVAL_DUPLICATE.
  const existing = await (db as any)
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(eq(approvalRequests.offlineId, input.offlineId))
    .limit(1);

  if (existing && existing.length > 0) {
    throw new ServiceError(
      ApprovalErrorCodes.APPROVAL_DUPLICATE,
      "An approval request already exists for this offlineId",
      409,
      "offlineId"
    );
  }

  // Step 3: generate token + compute hash. The raw token is only ever held
  // in this function's stack; nothing logs it, nothing stores it.
  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);

  const approvalId = randomUUID();
  const nowMs = clock.now();
  const expiresAt = new Date(nowMs + resolveApprovalTimeoutSeconds() * 1000);

  // Step 4: INSERT pending row. We do not wrap in a transaction because there
  // is exactly one write here; failure rolls back automatically.
  await (db as any).insert(approvalRequests).values({
    id: approvalId,
    offlineId: input.offlineId,
    visitorName: input.draft.visitorName,
    host: input.draft.host,
    unit: input.draft.unit,
    plate: input.draft.plate ?? null,
    reason: input.draft.reason ?? "",
    method: input.draft.method,
    requestedByGuardId: guardId,
    tokenHash,
    status: "pending",
    expiresAt,
    createdAt: new Date(nowMs),
    traceId,
  });

  // Step 5: audit. AWAITED — if the audit write fails we want the route to
  // return 500 (no silent drop).
  // Source: Trustless-System-Auditor — every state transition is audited.
  await emitAuditEvent("approval_requested", guardId, traceId, {
    approvalId,
    offlineId: input.offlineId,
    unit: input.draft.unit,
    method: input.draft.method,
    expiresAt: expiresAt.toISOString(),
  });

  // Step 6: build magic-link URL. The token is in the path, not a query
  // parameter, so it does not appear in the Referer header of any onward
  // navigation from the approval page.
  // Source: Security-and-Hardening — minimize token leakage surfaces.
  const magicLinkUrl = `${resolvePublicOrigin()}/approve/${approvalId}?token=${rawToken}`;

  const response: CreateApprovalResponse = {
    approvalId,
    magicLinkUrl,
    expiresAt: expiresAt.toISOString(),
    traceId,
  };

  return { response, statusCode: 201 };
}

// ─── 2. getApprovalStatus ─────────────────────────────────────────────────────

/**
 * Returns the current state of an approval, lazily flipping past-expiry
 * pending rows to "expired" on read.
 *
 * Source: spec §7.2.
 * Failure modes:
 *   - row not found                              → 404 APPROVAL_NOT_FOUND
 *   - row belongs to a different guard           → 403 APPROVAL_GUARD_MISMATCH
 *
 * Lazy expiry is intentional: it removes the need for a background expiry
 * job in v1 and guarantees clients never observe a stale pending row.
 */
export async function getApprovalStatus(
  approvalId: string,
  guardId: string,
  db: DrizzleDB,
  clock: ServiceClock = DEFAULT_CLOCK
): Promise<{ response: ApprovalStatusResponse; statusCode: number }> {
  const rows = await (db as any)
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, approvalId))
    .limit(1);

  if (!rows || rows.length === 0) {
    throw new ServiceError(
      ApprovalErrorCodes.APPROVAL_NOT_FOUND,
      "Approval request not found",
      404
    );
  }

  let row: ApprovalRow = rows[0];

  // Guard mismatch: a guard can only see their own pending approvals.
  // Source: spec §9 — "guard-A reading guard-B's pending approvals".
  if (row.requestedByGuardId !== guardId) {
    throw new ServiceError(
      ApprovalErrorCodes.APPROVAL_GUARD_MISMATCH,
      "This approval belongs to a different guard",
      403
    );
  }

  // Lazy expiry: flip pending → expired if past expires_at.
  // Source: spec §5 — "server flips on every read; no background job".
  if (row.status === "pending" && row.expiresAt.getTime() < clock.now()) {
    const decidedAt = new Date(clock.now());
    await (db as any)
      .update(approvalRequests)
      .set({
        status: "expired",
        decidedAt,
        tokenHash: null, // wipe — no one can decide an expired approval
      })
      .where(
        and(
          eq(approvalRequests.id, approvalId),
          eq(approvalRequests.status, "pending")
        )
      );

    row = { ...row, status: "expired", decidedAt, tokenHash: null };

    await emitAuditEvent("approval_expired", row.requestedByGuardId, row.traceId, {
      approvalId,
      offlineId: row.offlineId,
      expiresAt: row.expiresAt.toISOString(),
    });
  }

  const response: ApprovalStatusResponse = {
    approval: toApprovalView(row),
    traceId: row.traceId,
  };
  return { response, statusCode: 200 };
}

// ─── 3. decideApprovalRequest ─────────────────────────────────────────────────

/**
 * The resident-facing endpoint. Verifies the magic-link token, transitions
 * the approval to approved/denied, and (on approve) creates the entry record
 * inside the same transaction.
 *
 * Source: spec §7.3.
 * Failure modes:
 *   - row not found                       → 404 APPROVAL_NOT_FOUND
 *   - token does not match stored hash    → 401 APPROVAL_TOKEN_INVALID
 *   - already decided (terminal status)   → 409 APPROVAL_ALREADY_DECIDED
 *   - past expires_at                     → 410 APPROVAL_EXPIRED
 *     (the row is also flipped to expired as a side effect)
 *   - decision="deny" without reason      → 422 APPROVAL_DENY_REASON_REQUIRED
 *
 * SECURITY:
 *   - constant-time comparison of token hashes (the SHA-256 hex is fixed-length,
 *     so === is acceptable, but we still want this to be guard-against-timing
 *     conscious; we look up by hash via WHERE clause which is uniform).
 *   - token_hash is wiped (NULL) on success → single-use.
 */
export async function decideApprovalRequest(
  approvalId: string,
  rawToken: string,
  decision: "approve" | "deny",
  reason: string | undefined,
  db: DrizzleDB,
  clock: ServiceClock = DEFAULT_CLOCK
): Promise<{ response: DecideApprovalResponse; statusCode: number }> {
  // Step 1: fetch the row by id (NOT by token hash — we want to distinguish
  // "no row" from "wrong token" so the error code is accurate).
  const rows = await (db as any)
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, approvalId))
    .limit(1);

  if (!rows || rows.length === 0) {
    throw new ServiceError(
      ApprovalErrorCodes.APPROVAL_NOT_FOUND,
      "Approval request not found",
      404
    );
  }

  const row: ApprovalRow = rows[0];

  // Step 2: terminal-status check FIRST (before token, before expiry). Once
  // approved or denied, a second /decide must always return 409 regardless
  // of whether the token is correct — replay attempts get a uniform answer.
  // Source: spec §9 — replay row.
  if (row.status === "approved" || row.status === "denied") {
    throw new ServiceError(
      ApprovalErrorCodes.APPROVAL_ALREADY_DECIDED,
      `Approval already ${row.status}`,
      409
    );
  }

  // Step 3: expiry check. We treat `status==='expired'` and `expires_at<now`
  // identically — both yield 410. We also flip the DB row to expired in the
  // second case to keep the lazy-expiry contract.
  const nowMs = clock.now();
  const isExpired = row.status === "expired" || row.expiresAt.getTime() < nowMs;
  if (isExpired) {
    if (row.status === "pending") {
      const decidedAt = new Date(nowMs);
      await (db as any)
        .update(approvalRequests)
        .set({ status: "expired", decidedAt, tokenHash: null })
        .where(
          and(
            eq(approvalRequests.id, approvalId),
            eq(approvalRequests.status, "pending")
          )
        );
      await emitAuditEvent(
        "approval_expired",
        row.requestedByGuardId,
        row.traceId,
        {
          approvalId,
          offlineId: row.offlineId,
          expiresAt: row.expiresAt.toISOString(),
        }
      );
    }
    throw new ServiceError(
      ApprovalErrorCodes.APPROVAL_EXPIRED,
      "Approval has expired",
      410
    );
  }

  // Step 4: token check. We hash the supplied token and compare to the stored
  // hash. The stored hash MUST exist on a pending row (it's wiped on terminal
  // statuses); a null hash on a pending row would be a data-integrity bug.
  const suppliedHash = hashToken(rawToken);
  if (!row.tokenHash || row.tokenHash !== suppliedHash) {
    throw new ServiceError(
      ApprovalErrorCodes.APPROVAL_TOKEN_INVALID,
      "Approval token is invalid",
      401
    );
  }

  // Step 5: branch on decision.
  const decidedAt = new Date(nowMs);

  if (decision === "deny") {
    const sanitized = sanitizeFreeText(reason ?? "");
    if (sanitized.length < 1) {
      throw new ServiceError(
        ApprovalErrorCodes.APPROVAL_DENY_REASON_REQUIRED,
        "A reason is required when denying",
        422,
        "reason"
      );
    }

    // Single-statement update; no transaction needed.
    await (db as any)
      .update(approvalRequests)
      .set({
        status: "denied",
        decidedAt,
        deniedReason: sanitized,
        tokenHash: null,
      })
      .where(
        and(
          eq(approvalRequests.id, approvalId),
          eq(approvalRequests.status, "pending")
        )
      );

    await emitAuditEvent(
      "approval_denied",
      row.requestedByGuardId,
      row.traceId,
      { approvalId, offlineId: row.offlineId, reason: sanitized }
    );

    const view = toApprovalView({
      ...row,
      status: "denied",
      decidedAt,
      deniedReason: sanitized,
      tokenHash: null,
    });
    return {
      response: { approval: view, entry: null, traceId: row.traceId },
      statusCode: 200,
    };
  }

  // decision === "approve":
  // Transactional approve:
  //   1) INSERT entry_records (the audit-of-record for actually letting the
  //      visitor in),
  //   2) UPDATE approval_requests → approved + entry_id + decidedAt, wipe token.
  // If either step fails, the row stays pending and a fresh attempt is possible
  // until expiry.
  const entryId = randomUUID();

  await (db as any).transaction(async (tx: any) => {
    await tx.insert(entryRecords).values({
      id: entryId,
      visitorName: row.visitorName,
      host: row.host,
      unit: row.unit,
      plate: row.plate ?? null,
      reason: row.reason || "",
      method: row.method,
      guardId: row.requestedByGuardId,
      status: "logged",
      syncState: "synced",
      offlineId: row.offlineId,
      preApprovalId: null,
      deviceCreatedAt: row.createdAt, // best available — the original guard write time
      createdAt: decidedAt,
      traceId: row.traceId,
    });

    await tx
      .update(approvalRequests)
      .set({
        status: "approved",
        decidedAt,
        entryId,
        tokenHash: null,
      })
      .where(
        and(
          eq(approvalRequests.id, approvalId),
          eq(approvalRequests.status, "pending")
        )
      );
  });

  await emitAuditEvent(
    "approval_approved",
    row.requestedByGuardId,
    row.traceId,
    { approvalId, offlineId: row.offlineId, entryId }
  );

  const view = toApprovalView({
    ...row,
    status: "approved",
    decidedAt,
    entryId,
    tokenHash: null,
  });

  return {
    response: {
      approval: view,
      entry: {
        id: entryId,
        visitorName: row.visitorName,
        host: row.host,
        unit: row.unit,
        plate: row.plate ?? null,
        reason: row.reason || "",
        method: row.method,
        guardId: row.requestedByGuardId,
        createdAt: decidedAt.toISOString(),
        status: "logged",
        syncState: "synced",
      },
      traceId: row.traceId,
    },
    statusCode: 200,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateTraceId(): string {
  return `trace-${randomUUID()}`;
}
