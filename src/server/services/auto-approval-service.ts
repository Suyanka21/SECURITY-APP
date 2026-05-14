/**
 * GatePass — Auto-Approval Service
 *
 * Source: src/docs/specs/auto-approval.md §§4–9 (match algorithm,
 *         state-machine extension, error codes, boundaries, security).
 * Source: Security-and-Hardening — default-deny, kill switch, TTL.
 * Source: Trustless-System-Auditor — every non-match has a recorded reason.
 *
 * Responsibilities:
 *   1. evaluate()          — read-only rule lookup, returns a Decision.
 *                            ANY failure resolves to { match: false }.
 *   2. seedAutoApprovalRule() — admin-only INSERT with validation +
 *                            audit row.
 *   3. listAutoApprovalRules() — admin/senior-guard read.
 *   4. deactivateAutoApprovalRule() — admin kill switch + audit row.
 *
 * Hard rules:
 *   - evaluate() NEVER throws. Any exception is caught and reported as
 *     reason="EVALUATOR_ERROR" so the caller can fall through to the
 *     manual flow without seeing a 500 (spec §4).
 *   - A successful match returns the FULL rule row so the caller can
 *     bind it to the audit event written alongside entry_created.
 *   - last_matched_at / match_count are bumped inside the evaluate()
 *     path so admins can find stale rules. The bump is best-effort;
 *     its failure NEVER blocks the auto-approval.
 */

import { and, eq, sql } from "drizzle-orm";

import { autoApprovalRules, guards } from "@/db/schema";
import { emitAuditEvent } from "./audit-logger";
import { ServiceError } from "./errors";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum TTL accepted on rule seed. Spec §13 idea-refine note 4. */
export const MAX_RULE_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** Minimum TTL accepted on rule seed (5 minutes — guard's typo grace). */
export const MIN_RULE_TTL_MS = 5 * 60 * 1000;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DrizzleDB {
  select: (...args: unknown[]) => unknown;
  insert: (...args: unknown[]) => unknown;
  update: (...args: unknown[]) => unknown;
  transaction: (...args: unknown[]) => unknown;
  query: Record<string, unknown>;
  [key: string]: unknown;
}

/** Closed set of reasons a rule did NOT fire. Spec §4 table. */
export type AutoApprovalNonMatchReason =
  | "INPUT_INCOMPLETE"
  | "NO_RULE"
  | "RULE_EXPIRED"
  | "RULE_INACTIVE"
  | "PLATE_MISMATCH"
  | "EVALUATOR_ERROR";

export interface AutoApprovalRuleRow {
  id: string;
  visitorName: string;
  host: string;
  unit: string;
  plateRequired: string | null;
  createdByGuardId: string;
  active: boolean;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  lastMatchedAt: Date | null;
  matchCount: number;
}

export interface AutoApprovalInput {
  visitorName: string;
  host: string;
  unit: string;
  plate?: string | null;
}

export type AutoApprovalDecision =
  | {
      match: true;
      rule: AutoApprovalRuleRow;
      reason: null;
    }
  | {
      match: false;
      rule: null;
      reason: AutoApprovalNonMatchReason;
    };

export interface SeedAutoApprovalRuleInput {
  visitorName: string;
  host: string;
  unit: string;
  plateRequired?: string | null;
  expiresAt: Date;
}

export interface AutoApprovalRuleView {
  id: string;
  visitorName: string;
  host: string;
  unit: string;
  plateRequired: string | null;
  active: boolean;
  expiresAt: string; // ISO string for wire format
  createdAt: string;
  updatedAt: string;
  lastMatchedAt: string | null;
  matchCount: number;
}

// ─── Mapping ────────────────────────────────────────────────────────────────

/**
 * Strips internal fields and ISO-serializes timestamps for the wire.
 * Guard-id is intentionally omitted from the view — admin endpoints
 * join to `guards.display_name` separately so the raw uuid never leaks
 * to the guard UI.
 */
export function toAutoApprovalRuleView(
  row: AutoApprovalRuleRow,
): AutoApprovalRuleView {
  return {
    id: row.id,
    visitorName: row.visitorName,
    host: row.host,
    unit: row.unit,
    plateRequired: row.plateRequired,
    active: row.active,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastMatchedAt: row.lastMatchedAt
      ? row.lastMatchedAt.toISOString()
      : null,
    matchCount: row.matchCount,
  };
}

// ─── Normalization ───────────────────────────────────────────────────────────

/** Lowercases + trims — matches the partial UNIQUE index. */
function normalize(s: string): string {
  return s.trim().toLowerCase();
}

// ─── evaluate() ──────────────────────────────────────────────────────────────

/**
 * Default-deny rule evaluator. Returns a Decision; NEVER throws.
 *
 * Source: spec §4.
 *
 * The contract: if ANY check fails (input incomplete, no rule, expired,
 * inactive, plate mismatch, exception), the result is match=false and
 * the caller MUST fall through to the manual approval flow.
 *
 * @param input — visitor identity + optional plate.
 * @param db — drizzle handle (mockable in tests).
 * @param now — clock for tests; defaults to Date.now() wall clock.
 */
export async function evaluate(
  input: AutoApprovalInput,
  db: DrizzleDB,
  now: () => Date = () => new Date(),
): Promise<AutoApprovalDecision> {
  try {
    const visitorName = (input.visitorName ?? "").trim();
    const host = (input.host ?? "").trim();
    const unit = (input.unit ?? "").trim();

    if (!visitorName || !host || !unit) {
      return { match: false, rule: null, reason: "INPUT_INCOMPLETE" };
    }

    // Lookup all rows that COULD match. We filter case-insensitively in
    // memory because the partial UNIQUE index already enforces "at most
    // one active rule per lower(triple)" so the candidate set is small.
    // The btree index on (visitor_name, host, unit) makes the seek
    // cheap; case-insensitive matching avoids needing a generated col.
    const rows = (await (db as any)
      .select()
      .from(autoApprovalRules)
      .where(
        and(
          sql`lower(${autoApprovalRules.visitorName}) = ${normalize(visitorName)}`,
          sql`lower(${autoApprovalRules.host}) = ${normalize(host)}`,
          sql`lower(${autoApprovalRules.unit}) = ${normalize(unit)}`,
        ),
      )) as AutoApprovalRuleRow[];

    if (!rows || rows.length === 0) {
      return { match: false, rule: null, reason: "NO_RULE" };
    }

    // Pick the most-recently-updated active candidate. The partial
    // UNIQUE index normally guarantees at most one, but in case a
    // race during deactivation left two, we deterministically pick
    // the freshest. Inactive rows also count for status reporting.
    const sorted = [...rows].sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    const active = sorted.find((r) => r.active);
    const top = active ?? sorted[0];

    if (!top.active) {
      return { match: false, rule: null, reason: "RULE_INACTIVE" };
    }

    const nowDate = now();
    if (new Date(top.expiresAt).getTime() <= nowDate.getTime()) {
      // Lazy expiry. Audit so admins can find expired rules later.
      // Best-effort: a failure here MUST NOT crash the evaluator.
      try {
        await emitAuditEvent(
          "auto_approval_rule_expired",
          top.createdByGuardId,
          `auto-approval-${top.id}`,
          {
            ruleId: top.id,
            visitorName: top.visitorName,
            host: top.host,
            unit: top.unit,
            expiresAt: new Date(top.expiresAt).toISOString(),
          },
        );
      } catch {
        /* swallow — see method docstring */
      }
      return { match: false, rule: null, reason: "RULE_EXPIRED" };
    }

    if (top.plateRequired) {
      const inputPlate = (input.plate ?? "").trim();
      if (normalize(top.plateRequired) !== normalize(inputPlate)) {
        return { match: false, rule: null, reason: "PLATE_MISMATCH" };
      }
    }

    // Match. Bump match_count / last_matched_at; best-effort.
    try {
      await (db as any)
        .update(autoApprovalRules)
        .set({
          lastMatchedAt: nowDate,
          matchCount: top.matchCount + 1,
          updatedAt: nowDate,
        })
        .where(eq(autoApprovalRules.id, top.id));
    } catch {
      /* swallow — match is still valid even if bump fails */
    }

    return { match: true, rule: top, reason: null };
  } catch {
    return { match: false, rule: null, reason: "EVALUATOR_ERROR" };
  }
}

// ─── seedAutoApprovalRule() ──────────────────────────────────────────────────

/**
 * Admin-only INSERT. Validates the TTL bounds, then writes the row +
 * an audit event. Returns the rule view.
 *
 * @throws ServiceError(VALIDATION_ERROR, 422) if input is malformed.
 * @throws ServiceError(RULE_DUPLICATE, 409) if an active rule already
 *         exists for the same lower(triple).
 */
export async function seedAutoApprovalRule(
  guardId: string,
  input: SeedAutoApprovalRuleInput,
  db: DrizzleDB,
  now: () => Date = () => new Date(),
): Promise<AutoApprovalRuleView> {
  const visitorName = (input.visitorName ?? "").trim();
  const host = (input.host ?? "").trim();
  const unit = (input.unit ?? "").trim();
  const plate = input.plateRequired ? input.plateRequired.trim() : null;

  if (!visitorName || visitorName.length > 120) {
    throw new ServiceError(
      "RULE_INVALID_INPUT",
      "visitor_name must be 1..120 characters",
      422,
      "visitor_name",
    );
  }
  if (!host || host.length > 120) {
    throw new ServiceError(
      "RULE_INVALID_INPUT",
      "host must be 1..120 characters",
      422,
      "host",
    );
  }
  if (!unit || unit.length > 32) {
    throw new ServiceError(
      "RULE_INVALID_INPUT",
      "unit must be 1..32 characters",
      422,
      "unit",
    );
  }
  if (plate !== null && (plate.length < 1 || plate.length > 32)) {
    throw new ServiceError(
      "RULE_INVALID_INPUT",
      "plate_required must be 1..32 characters when set",
      422,
      "plate_required",
    );
  }

  const nowDate = now();
  const expiresAt = new Date(input.expiresAt);
  const ttlMs = expiresAt.getTime() - nowDate.getTime();
  if (ttlMs < MIN_RULE_TTL_MS) {
    throw new ServiceError(
      "RULE_INVALID_INPUT",
      `expires_at must be at least ${MIN_RULE_TTL_MS / 60000} minutes from now`,
      422,
      "expires_at",
    );
  }
  if (ttlMs > MAX_RULE_TTL_MS) {
    throw new ServiceError(
      "RULE_INVALID_INPUT",
      `expires_at must be at most ${MAX_RULE_TTL_MS / 86400000} days from now`,
      422,
      "expires_at",
    );
  }

  // Check for an existing active rule on the same lower(triple).
  // The partial UNIQUE index will also raise on insert, but the explicit
  // pre-check returns a clean 409 rather than a generic DB error.
  const existing = (await (db as any)
    .select()
    .from(autoApprovalRules)
    .where(
      and(
        sql`lower(${autoApprovalRules.visitorName}) = ${normalize(visitorName)}`,
        sql`lower(${autoApprovalRules.host}) = ${normalize(host)}`,
        sql`lower(${autoApprovalRules.unit}) = ${normalize(unit)}`,
        eq(autoApprovalRules.active, true),
      ),
    )) as AutoApprovalRuleRow[];

  if (existing && existing.length > 0) {
    throw new ServiceError(
      "RULE_DUPLICATE",
      "An active auto-approval rule already exists for this visitor/host/unit",
      409,
    );
  }

  const inserted = (await (db as any)
    .insert(autoApprovalRules)
    .values({
      visitorName,
      host,
      unit,
      plateRequired: plate,
      createdByGuardId: guardId,
      active: true,
      expiresAt,
      createdAt: nowDate,
      updatedAt: nowDate,
      matchCount: 0,
    })
    .returning()) as AutoApprovalRuleRow[];

  if (!inserted || inserted.length === 0) {
    throw new ServiceError(
      "INTERNAL_ERROR",
      "Failed to insert auto-approval rule",
      500,
    );
  }

  const row = inserted[0];

  await emitAuditEvent(
    "auto_approval_rule_created",
    guardId,
    `auto-approval-${row.id}`,
    {
      ruleId: row.id,
      visitorName: row.visitorName,
      host: row.host,
      unit: row.unit,
      plateRequired: row.plateRequired,
      expiresAt: row.expiresAt.toISOString(),
    },
  );

  return toAutoApprovalRuleView(row);
}

// ─── listAutoApprovalRules() ─────────────────────────────────────────────────

export interface ListAutoApprovalRulesFilter {
  host?: string;
  unit?: string;
  includeInactive?: boolean;
}

/**
 * Admin/senior-guard read. Returns rules ordered by most recent activity.
 * Authorization is enforced upstream by the route's role middleware.
 */
export async function listAutoApprovalRules(
  filter: ListAutoApprovalRulesFilter,
  db: DrizzleDB,
): Promise<AutoApprovalRuleView[]> {
  // Push the cheapest predicates to the DB so a large table doesn't
  // dump every row over the wire. host/unit filters use the btree index
  // by exact-match path; case-insensitivity is preserved by the JS
  // post-filter below.
  const dbClauses = [] as unknown[];
  if (filter.host) {
    dbClauses.push(
      sql`lower(${autoApprovalRules.host}) = ${normalize(filter.host)}`,
    );
  }
  if (filter.unit) {
    dbClauses.push(
      sql`lower(${autoApprovalRules.unit}) = ${normalize(filter.unit)}`,
    );
  }

  let query = (db as any).select().from(autoApprovalRules);
  if (dbClauses.length > 0) {
    query = query.where(and(...(dbClauses as Parameters<typeof and>)));
  }

  const rows = (await query) as AutoApprovalRuleRow[];

  // JS-side post-filter: the active/inactive filter is applied here so
  // the same predicate can be verified deterministically in unit tests
  // without needing a real DB. The list endpoint is admin-only and the
  // table is bounded (one active rule per identity triple), so the cost
  // is negligible.
  const filtered = filter.includeInactive
    ? rows
    : rows.filter((r) => r.active);

  return filtered
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )
    .map(toAutoApprovalRuleView);
}

// ─── deactivateAutoApprovalRule() ────────────────────────────────────────────

/**
 * Admin kill switch. Sets active=false on the rule (idempotent — calling
 * twice is a no-op) and writes an audit event.
 *
 * @throws ServiceError("NOT_FOUND", 404) if no rule with that id exists.
 */
export async function deactivateAutoApprovalRule(
  guardId: string,
  ruleId: string,
  db: DrizzleDB,
  now: () => Date = () => new Date(),
): Promise<AutoApprovalRuleView> {
  const existing = (await (db as any)
    .select()
    .from(autoApprovalRules)
    .where(eq(autoApprovalRules.id, ruleId))) as AutoApprovalRuleRow[];

  if (!existing || existing.length === 0) {
    throw new ServiceError(
      "NOT_FOUND",
      "Auto-approval rule not found",
      404,
    );
  }

  const row = existing[0];
  if (!row.active) {
    // Idempotent — already deactivated. Return the existing view.
    return toAutoApprovalRuleView(row);
  }

  const nowDate = now();
  const updated = (await (db as any)
    .update(autoApprovalRules)
    .set({ active: false, updatedAt: nowDate })
    .where(eq(autoApprovalRules.id, ruleId))
    .returning()) as AutoApprovalRuleRow[];

  const next = updated && updated[0] ? updated[0] : { ...row, active: false };

  await emitAuditEvent(
    "auto_approval_rule_deactivated",
    guardId,
    `auto-approval-${ruleId}`,
    {
      ruleId,
      visitorName: row.visitorName,
      host: row.host,
      unit: row.unit,
    },
  );

  return toAutoApprovalRuleView(next);
}

// Re-export so callers don't double-import.
export { ServiceError };
// Suppress unused-warning for `guards`; the table is imported so the schema
// graph stays linked for relations even though we don't query it here.
void guards;
