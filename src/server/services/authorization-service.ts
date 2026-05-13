/**
 * GatePass — Authorization Service (Decision Engine)
 *
 * Source: GATEPASS DEFINITION §3 — "Authorization Layer"
 * Source: gatepass-api-contract.md §3.1, §3.2, §3.4
 *
 * Central decision engine that resolves authorization for all entry methods.
 * Every decision path produces an explicit, traceable record.
 *
 * Decision paths:
 * - QR (pre-approved): authorization_decisions record updated
 * - Walk-in: entry_records with guard_id = decision record
 * - Override: override_events record = decision record
 * - Recognized: entry_records with guard_id = decision record
 *
 * Hard rules:
 * - No implicit approvals
 * - Every decision produces a stored record
 * - Entry cannot be approved without decision record
 */

import { randomUUID } from "crypto";

// ─── Decision Types ──────────────────────────────────────────────────────────

export type EntryMethod = "qr" | "walk-in" | "override" | "recognized";

export type DecisionOutcome = "approved" | "denied";

export interface AuthorizationDecisionResult {
  outcome: DecisionOutcome;
  decisionType: EntryMethod;
  reason: string;
  traceId: string;
  /** For QR: the pre-approval ID. For others: null */
  preApprovalId: string | null;
  /** Guard who made/confirmed this decision */
  guardId: string;
  /** When the decision was made */
  decidedAt: string;
}

// ─── Input Types ─────────────────────────────────────────────────────────────

export interface AuthorizationInput {
  method: EntryMethod;
  guardId: string;
  /** Required for QR — links to validated pre-approval */
  preApprovalId?: string;
  /** Required for override — justification reason */
  reason?: string;
  /** Required for recognized — ID of the recognized visitor */
  recognizedVisitorId?: string;
}

// ─── Decision Engine ─────────────────────────────────────────────────────────

/**
 * Resolves an authorization decision for a given entry method.
 *
 * This is a pure decision function — it does NOT perform DB writes.
 * The caller (entry service) handles persistence.
 *
 * Source: DEFINITION §3 — "Authorization Layer"
 * - Pre-approved rules
 * - Auto-approval engine
 * - Real-time resident approval (if needed)
 * - Guard override (always available but logged)
 *
 * Hard rule: No implicit approvals — every path explicitly returns
 * a decision with outcome, type, reason, and traceId.
 */
export function resolveAuthorization(
  input: AuthorizationInput
): AuthorizationDecisionResult {
  const traceId = `trace-${randomUUID()}`;
  const decidedAt = new Date().toISOString();

  switch (input.method) {
    // ── QR Pre-Approved ──────────────────────────────────────────────────
    // Source: DEFINITION §2A — "Scan QR → System validates → Entry logged"
    // Decision: Pre-approval exists and was validated (by QR service)
    case "qr": {
      if (!input.preApprovalId) {
        return {
          outcome: "denied",
          decisionType: "qr",
          reason: "Pre-approval ID is required for QR entries",
          traceId,
          preApprovalId: null,
          guardId: input.guardId,
          decidedAt,
        };
      }

      return {
        outcome: "approved",
        decisionType: "qr",
        reason: "Pre-approved via validated QR code",
        traceId,
        preApprovalId: input.preApprovalId,
        guardId: input.guardId,
        decidedAt,
      };
    }

    // ── Walk-In ──────────────────────────────────────────────────────────
    // Source: DEFINITION §2B — "Tap 'New Entry' → Input details → System decides"
    // Decision: Guard explicitly creates entry = guard-decided approval
    case "walk-in": {
      return {
        outcome: "approved",
        decisionType: "walk-in",
        reason: "Guard-authorized walk-in entry",
        traceId,
        preApprovalId: null,
        guardId: input.guardId,
        decidedAt,
      };
    }

    // ── Override ─────────────────────────────────────────────────────────
    // Source: DEFINITION §2D — "Guard selects Allow → Chooses reason → Entry logged"
    // Source: DEFINITION §3 — "Guard override (always available but logged)"
    // Decision: Guard explicitly overrides with mandatory reason
    case "override": {
      const reason = input.reason?.trim() || "";

      if (reason.length < 8) {
        return {
          outcome: "denied",
          decisionType: "override",
          reason: "Override reason too short (minimum 8 characters required)",
          traceId,
          preApprovalId: null,
          guardId: input.guardId,
          decidedAt,
        };
      }

      return {
        outcome: "approved",
        decisionType: "override",
        reason,
        traceId,
        preApprovalId: null,
        guardId: input.guardId,
        decidedAt,
      };
    }

    // ── Recognized Visitor ───────────────────────────────────────────────
    // Source: DEFINITION §2C — "System suggests frequent visitor → One-tap selection"
    // Decision: Guard confirms recognized visitor = guard-decided approval
    case "recognized": {
      return {
        outcome: "approved",
        decisionType: "recognized",
        reason: "Guard-confirmed recognized visitor entry",
        traceId,
        preApprovalId: null,
        guardId: input.guardId,
        decidedAt,
      };
    }

    // ── Unknown Method — defensive guard ─────────────────────────────────
    default: {
      const exhaustiveCheck: never = input.method;
      return {
        outcome: "denied",
        decisionType: exhaustiveCheck,
        reason: `Unknown entry method: ${input.method}`,
        traceId,
        preApprovalId: null,
        guardId: input.guardId,
        decidedAt,
      };
    }
  }
}
