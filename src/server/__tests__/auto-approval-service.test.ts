// @vitest-environment node
/**
 * GatePass — Auto-Approval Service Tests (TDD)
 *
 * Source: src/docs/specs/auto-approval.md §§3–10
 * Source: Test-Driven-Development skill — "failing test first; behavior, not impl"
 * Source: Trustless-System-Auditor skill — every non-match path is provable
 *
 * Each test names a state transition, not an implementation detail.
 * DAMP over DRY: shared mock factory but each test reads as a spec line.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  evaluate,
  seedAutoApprovalRule,
  listAutoApprovalRules,
  deactivateAutoApprovalRule,
  MAX_RULE_TTL_MS,
  MIN_RULE_TTL_MS,
  ServiceError,
  type AutoApprovalRuleRow,
} from "../services/auto-approval-service";
import {
  clearAuditLog,
  getAuditEventsByType,
} from "../services/audit-logger";

// ─── Mock DB factory ─────────────────────────────────────────────────────────

interface MockDBOpts {
  rules?: AutoApprovalRuleRow[];
  failSelect?: boolean;
  failInsert?: boolean;
  failBump?: boolean;
}

function makeMockDB(opts: MockDBOpts = {}) {
  const rules: AutoApprovalRuleRow[] = [...(opts.rules ?? [])];

  const matchTriple = (
    visitorPred?: string,
    hostPred?: string,
    unitPred?: string,
  ) =>
    rules.filter((r) => {
      if (visitorPred && r.visitorName.toLowerCase() !== visitorPred) {
        return false;
      }
      if (hostPred && r.host.toLowerCase() !== hostPred) return false;
      if (unitPred && r.unit.toLowerCase() !== unitPred) return false;
      return true;
    });

  const selectMock = vi.fn().mockImplementation(() => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation(async (_clause: unknown) => {
        if (opts.failSelect) throw new Error("DB transient");
        // We just return the whole rules set; the service filters with
        // its own predicate. (The where() clause object is opaque here.)
        return rules.slice();
      }),
      // For list endpoints that don't call .where() at all
      then: undefined,
    }),
  }));

  // Make the .from() chain await-able directly (no .where())
  const fromAwaitable = vi.fn().mockImplementation(() => {
    const chain: any = {
      where: vi.fn().mockImplementation(async () => {
        if (opts.failSelect) throw new Error("DB transient");
        return rules.slice();
      }),
    };
    // Make chain itself awaitable for list with no filter
    Object.defineProperty(chain, "then", {
      get: () => (resolve: (rows: AutoApprovalRuleRow[]) => void) =>
        resolve(rules.slice()),
    });
    return chain;
  });

  const selectAwaitableMock = vi.fn().mockImplementation(() => ({
    from: fromAwaitable,
  }));

  const insertMock = vi.fn().mockImplementation(() => ({
    values: vi.fn().mockImplementation((row: Partial<AutoApprovalRuleRow>) => ({
      returning: vi.fn().mockImplementation(async () => {
        if (opts.failInsert) throw new Error("DB insert failed");
        const inserted: AutoApprovalRuleRow = {
          id: `rule-${rules.length + 1}`,
          visitorName: row.visitorName ?? "",
          host: row.host ?? "",
          unit: row.unit ?? "",
          plateRequired: row.plateRequired ?? null,
          createdByGuardId: row.createdByGuardId ?? "guard-1",
          active: row.active ?? true,
          expiresAt: row.expiresAt ?? new Date(),
          createdAt: row.createdAt ?? new Date(),
          updatedAt: row.updatedAt ?? new Date(),
          lastMatchedAt: row.lastMatchedAt ?? null,
          matchCount: row.matchCount ?? 0,
        };
        rules.push(inserted);
        return [inserted];
      }),
    })),
  }));

  const updateMock = vi.fn().mockImplementation(() => ({
    set: vi.fn().mockImplementation((patch: Partial<AutoApprovalRuleRow>) => ({
      where: vi.fn().mockImplementation(async () => {
        if (opts.failBump) throw new Error("DB bump failed");
        // Apply patch to whichever single rule the caller targeted.
        // Tests that need precision can inspect `rules` directly.
        if (rules.length > 0) {
          rules[0] = { ...rules[0], ...patch };
        }
      }),
      returning: vi.fn().mockImplementation(async () => {
        if (rules.length === 0) return [];
        rules[0] = { ...rules[0], ...patch };
        return [rules[0]];
      }),
    })),
  }));

  // .update().set().where().returning() chain
  const updateWithReturning = vi.fn().mockImplementation(() => ({
    set: vi.fn().mockImplementation((patch: Partial<AutoApprovalRuleRow>) => {
      let lastTarget: AutoApprovalRuleRow | null = null;
      return {
        where: vi.fn().mockImplementation((_clause: unknown) => ({
          returning: vi.fn().mockImplementation(async () => {
            if (rules.length === 0) return [];
            rules[0] = { ...rules[0], ...patch };
            lastTarget = rules[0];
            return [rules[0]];
          }),
          // Plain await on .where() — used by bump path
          then: (resolve: () => void) => {
            if (opts.failBump) {
              throw new Error("DB bump failed");
            }
            if (rules.length > 0) {
              rules[0] = { ...rules[0], ...patch };
            }
            resolve();
          },
        })),
      };
    }),
  }));

  return {
    rules,
    db: {
      select: selectAwaitableMock,
      insert: insertMock,
      update: updateWithReturning,
      transaction: vi.fn(),
      query: {},
    },
    matchTriple,
  };
}

function ruleRow(overrides: Partial<AutoApprovalRuleRow> = {}): AutoApprovalRuleRow {
  return {
    id: "rule-1",
    visitorName: "Maya Chen",
    host: "Alex Park",
    unit: "12A",
    plateRequired: null,
    createdByGuardId: "guard-1",
    active: true,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    createdAt: new Date(Date.now() - 60 * 60 * 1000),
    updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    lastMatchedAt: null,
    matchCount: 0,
    ...overrides,
  };
}

// ─── evaluate() ──────────────────────────────────────────────────────────────

describe("evaluate()", () => {
  beforeEach(() => {
    clearAuditLog();
  });

  it("INPUT_INCOMPLETE — empty visitor name short-circuits to non-match", async () => {
    const { db } = makeMockDB({ rules: [ruleRow()] });
    const decision = await evaluate(
      { visitorName: "", host: "Alex Park", unit: "12A" },
      db,
    );
    expect(decision.match).toBe(false);
    expect(decision.reason).toBe("INPUT_INCOMPLETE");
    expect(decision.rule).toBeNull();
  });

  it("INPUT_INCOMPLETE — empty host short-circuits", async () => {
    const { db } = makeMockDB({ rules: [ruleRow()] });
    const decision = await evaluate(
      { visitorName: "Maya Chen", host: "  ", unit: "12A" },
      db,
    );
    expect(decision.match).toBe(false);
    expect(decision.reason).toBe("INPUT_INCOMPLETE");
  });

  it("NO_RULE — no rule for the triple returns non-match without throwing", async () => {
    const { db } = makeMockDB({ rules: [] });
    const decision = await evaluate(
      { visitorName: "Random Person", host: "Alex Park", unit: "12A" },
      db,
    );
    expect(decision.match).toBe(false);
    expect(decision.reason).toBe("NO_RULE");
    expect(decision.rule).toBeNull();
  });

  it("RULE_EXPIRED — triple matches but expires_at < now, emits audit, non-match", async () => {
    const expired = ruleRow({
      expiresAt: new Date(Date.now() - 1000),
    });
    const { db } = makeMockDB({ rules: [expired] });
    const decision = await evaluate(
      { visitorName: "Maya Chen", host: "Alex Park", unit: "12A" },
      db,
    );
    expect(decision.match).toBe(false);
    expect(decision.reason).toBe("RULE_EXPIRED");
    expect(getAuditEventsByType("auto_approval_rule_expired")).toHaveLength(1);
  });

  it("RULE_INACTIVE — triple matches but rule.active=false", async () => {
    const inactive = ruleRow({ active: false });
    const { db } = makeMockDB({ rules: [inactive] });
    const decision = await evaluate(
      { visitorName: "Maya Chen", host: "Alex Park", unit: "12A" },
      db,
    );
    expect(decision.match).toBe(false);
    expect(decision.reason).toBe("RULE_INACTIVE");
  });

  it("PLATE_MISMATCH — rule pins a plate, walk-in's plate differs", async () => {
    const withPlate = ruleRow({ plateRequired: "TX-123" });
    const { db } = makeMockDB({ rules: [withPlate] });
    const decision = await evaluate(
      {
        visitorName: "Maya Chen",
        host: "Alex Park",
        unit: "12A",
        plate: "CA-999",
      },
      db,
    );
    expect(decision.match).toBe(false);
    expect(decision.reason).toBe("PLATE_MISMATCH");
  });

  it("PLATE_MISMATCH — rule pins a plate, walk-in has no plate", async () => {
    const withPlate = ruleRow({ plateRequired: "TX-123" });
    const { db } = makeMockDB({ rules: [withPlate] });
    const decision = await evaluate(
      { visitorName: "Maya Chen", host: "Alex Park", unit: "12A" },
      db,
    );
    expect(decision.match).toBe(false);
    expect(decision.reason).toBe("PLATE_MISMATCH");
  });

  it("match — case-insensitive triple, no plate constraint", async () => {
    const rule = ruleRow();
    const { db, rules } = makeMockDB({ rules: [rule] });
    const decision = await evaluate(
      {
        visitorName: "MAYA CHEN",
        host: "alex park",
        unit: "12a",
      },
      db,
    );
    expect(decision.match).toBe(true);
    expect(decision.rule?.id).toBe(rule.id);
    expect(decision.reason).toBeNull();
    // last_matched_at and match_count are bumped (best-effort)
    expect(rules[0].matchCount).toBe(1);
    expect(rules[0].lastMatchedAt).not.toBeNull();
  });

  it("match — plate matches case-insensitively", async () => {
    const rule = ruleRow({ plateRequired: "TX-123" });
    const { db } = makeMockDB({ rules: [rule] });
    const decision = await evaluate(
      {
        visitorName: "Maya Chen",
        host: "Alex Park",
        unit: "12A",
        plate: "tx-123",
      },
      db,
    );
    expect(decision.match).toBe(true);
    expect(decision.rule?.plateRequired).toBe("TX-123");
  });

  it("EVALUATOR_ERROR — DB throws → non-match, NEVER bubbles", async () => {
    const { db } = makeMockDB({ rules: [ruleRow()], failSelect: true });
    const decision = await evaluate(
      { visitorName: "Maya Chen", host: "Alex Park", unit: "12A" },
      db,
    );
    expect(decision.match).toBe(false);
    expect(decision.reason).toBe("EVALUATOR_ERROR");
    expect(decision.rule).toBeNull();
  });

  it("match persists even when bump fails — failure is best-effort", async () => {
    const rule = ruleRow();
    const { db } = makeMockDB({ rules: [rule], failBump: true });
    const decision = await evaluate(
      {
        visitorName: "Maya Chen",
        host: "Alex Park",
        unit: "12A",
      },
      db,
    );
    expect(decision.match).toBe(true);
    expect(decision.rule?.id).toBe(rule.id);
  });

  it("inactive rule wins over active in result selection — sort picks active first", async () => {
    // Both rules share the same triple. Active should be picked even
    // if inactive has more recent updatedAt (active=true is preferred).
    const inactiveNewer = ruleRow({
      id: "rule-old",
      active: false,
      updatedAt: new Date(Date.now()),
    });
    const activeOlder = ruleRow({
      id: "rule-new",
      active: true,
      updatedAt: new Date(Date.now() - 60_000),
    });
    const { db } = makeMockDB({ rules: [inactiveNewer, activeOlder] });
    const decision = await evaluate(
      { visitorName: "Maya Chen", host: "Alex Park", unit: "12A" },
      db,
    );
    expect(decision.match).toBe(true);
    expect(decision.rule?.id).toBe("rule-new");
  });
});

// ─── seedAutoApprovalRule() ──────────────────────────────────────────────────

describe("seedAutoApprovalRule()", () => {
  beforeEach(() => clearAuditLog());

  it("rejects empty visitor name with VALIDATION_ERROR (422, field='visitor_name')", async () => {
    const { db } = makeMockDB();
    await expect(
      seedAutoApprovalRule(
        "guard-1",
        {
          visitorName: "",
          host: "Alex Park",
          unit: "12A",
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
        db,
      ),
    ).rejects.toMatchObject({
      code: "RULE_INVALID_INPUT",
      statusCode: 422,
      field: "visitor_name",
    });
  });

  it("rejects TTL below MIN_RULE_TTL_MS", async () => {
    const { db } = makeMockDB();
    await expect(
      seedAutoApprovalRule(
        "guard-1",
        {
          visitorName: "Maya Chen",
          host: "Alex Park",
          unit: "12A",
          // Only 1 minute from now, below 5-minute minimum
          expiresAt: new Date(Date.now() + 60_000),
        },
        db,
      ),
    ).rejects.toMatchObject({
      code: "RULE_INVALID_INPUT",
      field: "expires_at",
    });
  });

  it("rejects TTL above MAX_RULE_TTL_MS (365 days)", async () => {
    const { db } = makeMockDB();
    await expect(
      seedAutoApprovalRule(
        "guard-1",
        {
          visitorName: "Maya Chen",
          host: "Alex Park",
          unit: "12A",
          expiresAt: new Date(Date.now() + MAX_RULE_TTL_MS + 60_000),
        },
        db,
      ),
    ).rejects.toMatchObject({
      code: "RULE_INVALID_INPUT",
      field: "expires_at",
    });
  });

  it("rejects duplicate active rule for same lower(triple) with RULE_DUPLICATE (409)", async () => {
    const existing = ruleRow();
    const { db } = makeMockDB({ rules: [existing] });
    await expect(
      seedAutoApprovalRule(
        "guard-1",
        {
          visitorName: "maya chen",
          host: "ALEX PARK",
          unit: "12A",
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
        db,
      ),
    ).rejects.toMatchObject({
      code: "RULE_DUPLICATE",
      statusCode: 409,
    });
  });

  it("inserts the rule, emits auto_approval_rule_created, returns view", async () => {
    const { db } = makeMockDB({ rules: [] });
    const view = await seedAutoApprovalRule(
      "guard-1",
      {
        visitorName: "Maya Chen",
        host: "Alex Park",
        unit: "12A",
        plateRequired: "TX-123",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
      db,
    );
    expect(view.visitorName).toBe("Maya Chen");
    expect(view.plateRequired).toBe("TX-123");
    expect(view.active).toBe(true);
    expect(view.matchCount).toBe(0);
    expect(getAuditEventsByType("auto_approval_rule_created")).toHaveLength(1);
  });
});

// ─── deactivateAutoApprovalRule() ────────────────────────────────────────────

describe("deactivateAutoApprovalRule()", () => {
  beforeEach(() => clearAuditLog());

  it("404 when rule does not exist", async () => {
    const { db } = makeMockDB({ rules: [] });
    await expect(
      deactivateAutoApprovalRule("guard-1", "nonexistent", db),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      statusCode: 404,
    });
  });

  it("flips active=false and emits auto_approval_rule_deactivated", async () => {
    const rule = ruleRow();
    const { db, rules } = makeMockDB({ rules: [rule] });
    const view = await deactivateAutoApprovalRule("guard-1", rule.id, db);
    expect(view.active).toBe(false);
    expect(rules[0].active).toBe(false);
    expect(getAuditEventsByType("auto_approval_rule_deactivated")).toHaveLength(1);
  });

  it("is idempotent — deactivating an inactive rule is a no-op (no second audit row)", async () => {
    const inactive = ruleRow({ active: false });
    const { db } = makeMockDB({ rules: [inactive] });
    const view = await deactivateAutoApprovalRule("guard-1", inactive.id, db);
    expect(view.active).toBe(false);
    // Idempotent — no new audit row written
    expect(getAuditEventsByType("auto_approval_rule_deactivated")).toHaveLength(0);
  });
});

// ─── listAutoApprovalRules() ─────────────────────────────────────────────────

describe("listAutoApprovalRules()", () => {
  beforeEach(() => clearAuditLog());

  it("returns active rules by default, ordered by updatedAt desc", async () => {
    const older = ruleRow({
      id: "rule-older",
      updatedAt: new Date(Date.now() - 3600_000),
    });
    const newer = ruleRow({
      id: "rule-newer",
      visitorName: "Other Person",
      updatedAt: new Date(Date.now()),
    });
    const { db } = makeMockDB({ rules: [older, newer] });
    const rules = await listAutoApprovalRules({}, db);
    expect(rules).toHaveLength(2);
    expect(rules[0].id).toBe("rule-newer");
    expect(rules[1].id).toBe("rule-older");
  });

  it("excludes inactive rules unless includeInactive=true", async () => {
    const active = ruleRow({ id: "rule-a", active: true });
    const inactive = ruleRow({
      id: "rule-i",
      visitorName: "Inactive Person",
      active: false,
    });
    const { db } = makeMockDB({ rules: [active, inactive] });

    const defaultList = await listAutoApprovalRules({}, db);
    expect(defaultList.map((r) => r.id)).toEqual(["rule-a"]);

    const withInactive = await listAutoApprovalRules(
      { includeInactive: true },
      db,
    );
    expect(withInactive.map((r) => r.id).sort()).toEqual(["rule-a", "rule-i"]);
  });

  it("returns the rule view shape (ISO timestamps, no createdByGuardId)", async () => {
    const rule = ruleRow();
    const { db } = makeMockDB({ rules: [rule] });
    const list = await listAutoApprovalRules({}, db);
    expect(list[0]).toHaveProperty("expiresAt");
    expect(typeof list[0].expiresAt).toBe("string");
    expect(list[0]).not.toHaveProperty("createdByGuardId");
  });
});

// ─── Constants ───────────────────────────────────────────────────────────────

describe("module constants", () => {
  it("MIN_RULE_TTL_MS is 5 minutes", () => {
    expect(MIN_RULE_TTL_MS).toBe(5 * 60 * 1000);
  });

  it("MAX_RULE_TTL_MS is 365 days", () => {
    expect(MAX_RULE_TTL_MS).toBe(365 * 24 * 60 * 60 * 1000);
  });

  it("ServiceError is re-exported", () => {
    expect(ServiceError).toBeDefined();
  });
});
