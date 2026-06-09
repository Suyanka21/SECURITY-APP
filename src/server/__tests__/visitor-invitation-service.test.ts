// @vitest-environment node
/**
 * GatePass — Visitor Invitation Service Tests (Feature 6)
 *
 * Source: src/docs/specs/guest-qr-ticket.md
 * Source: src/server/services/visitor-invitation-service.ts
 *
 * Coverage targets per Trustless-System-Auditor + TDD:
 *
 *   issueVisitorInvitation
 *     I1  happy path returns raw token + pass URL + ISO expiresAt
 *     I2  default TTL is 24h when ttlHours omitted
 *     I3  custom ttlHours respected
 *     I4  ttlHours clamped to MAX_TTL_HOURS even if Zod is bypassed
 *     I5  audit event emitted with hash, never raw token
 *     I6  pass URL uses APP_PUBLIC_ORIGIN env var
 *     I7  two consecutive issues mint different tokens (entropy)
 *     I8  INSERT failure surfaces as ServiceError INTERNAL_ERROR
 *     I9  plate persists when provided; null when omitted
 *
 *   previewVisitorInvitation
 *     P1  happy path returns ONLY safe display fields
 *     P2  not-found → 404 INVITATION_NOT_FOUND
 *     P3  expired → 410 INVITATION_EXPIRED
 *     P4  consumed → 410 INVITATION_CONSUMED
 *     P5  preview does NOT call update() (never marks is_used)
 *     P6  preview emits NO audit event (reads do not emit)
 *
 *   Token primitives
 *     T1  mintRawToken returns base64url chars only
 *     T2  buildPassUrl strips trailing slash from APP_PUBLIC_ORIGIN
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  issueVisitorInvitation,
  previewVisitorInvitation,
  mintRawToken,
  buildPassUrl,
} from "../services/visitor-invitation-service";
import { hashQrToken } from "../services/qr-service";
import { ServiceError } from "../services/errors";
import {
  clearAuditLog,
  getAuditEventsByType,
} from "../services/audit-logger";
import {
  DEFAULT_TTL_HOURS,
  MAX_TTL_HOURS,
  VisitorInvitationErrorCodes,
  type IssueInvitationInput,
} from "../validation/visitor-invitation-schemas";
import { authorizationDecisions } from "@/db/schema";

// ─── Mock DB ─────────────────────────────────────────────────────────────────

type Row = {
  id: string;
  visitorName: string;
  host: string;
  unit: string;
  plate: string | null;
  qrTokenHash: string;
  expiresAt: Date;
  isUsed: boolean;
  usedAt: Date | null;
  usedByGuardId: string | null;
  createdAt: Date;
};

function makeInsertedRow(input: Partial<Row> & Pick<Row, "qrTokenHash" | "expiresAt">): Row {
  return {
    id: input.id ?? "inv-uuid-001",
    visitorName: input.visitorName ?? "Maya Chen",
    host: input.host ?? "A. Okafor",
    unit: input.unit ?? "18B",
    plate: input.plate ?? null,
    qrTokenHash: input.qrTokenHash,
    expiresAt: input.expiresAt,
    isUsed: input.isUsed ?? false,
    usedAt: input.usedAt ?? null,
    usedByGuardId: input.usedByGuardId ?? null,
    createdAt: input.createdAt ?? new Date(),
  };
}

function createMockDB(opts: {
  selectRows?: Row[] | null;
  insertReturns?: Row[] | null;
  throwOnInsert?: boolean;
} = {}) {
  const updates: unknown[] = [];
  let lastInsertValues: Record<string, unknown> | null = null;

  return {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => ({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockImplementation(() => {
            if (table === authorizationDecisions) {
              return Promise.resolve(opts.selectRows ?? []);
            }
            return Promise.resolve([]);
          }),
        }),
      })),
    })),

    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        lastInsertValues = values;
        return {
          returning: vi.fn().mockImplementation(() => {
            if (opts.throwOnInsert) {
              return Promise.reject(new Error("simulated DB failure"));
            }
            const fallback = makeInsertedRow({
              qrTokenHash: String(values.qrTokenHash),
              expiresAt: values.expiresAt as Date,
              visitorName: String(values.visitorName),
              host: String(values.host),
              unit: String(values.unit),
              plate: values.plate as string | null,
            });
            return Promise.resolve(opts.insertReturns ?? [fallback]);
          }),
        };
      }),
    })),

    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation((data: unknown) => {
        updates.push(data);
        return { where: vi.fn().mockReturnValue(Promise.resolve()) };
      }),
    })),

    query: {},
    _updates: updates,
    _lastInsert: () => lastInsertValues,
  };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ACTOR = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

function validInput(): IssueInvitationInput {
  return {
    visitorName: "Maya Chen",
    host: "A. Okafor",
    unit: "18B",
  };
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  clearAuditLog();
  // Lock the env for deterministic pass URLs.
  delete process.env.APP_PUBLIC_ORIGIN;
});

afterEach(() => {
  delete process.env.APP_PUBLIC_ORIGIN;
});

// ─── Issue tests ─────────────────────────────────────────────────────────────

describe("issueVisitorInvitation", () => {
  it("I1: happy path returns raw token, pass URL, ISO expiresAt", async () => {
    const db = createMockDB();

    const { response, statusCode } = await issueVisitorInvitation(
      validInput(),
      ACTOR,
      db,
    );

    expect(statusCode).toBe(201);
    expect(response.invitation.id).toBeTruthy();
    expect(response.invitation.qrToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(response.invitation.passUrl).toContain(response.invitation.qrToken);
    expect(response.invitation.expiresAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(response.traceId).toMatch(/^trace-/);
  });

  it("I2: default TTL is 24h when ttlHours omitted", async () => {
    const before = Date.now();
    const db = createMockDB();

    const { response } = await issueVisitorInvitation(validInput(), ACTOR, db);

    const expiry = new Date(response.invitation.expiresAt).getTime();
    const diffHours = (expiry - before) / (1000 * 60 * 60);
    expect(diffHours).toBeGreaterThanOrEqual(DEFAULT_TTL_HOURS - 0.01);
    expect(diffHours).toBeLessThanOrEqual(DEFAULT_TTL_HOURS + 0.05);
  });

  it("I3: custom ttlHours respected", async () => {
    const before = Date.now();
    const db = createMockDB();

    const { response } = await issueVisitorInvitation(
      { ...validInput(), ttlHours: 72 },
      ACTOR,
      db,
    );

    const expiry = new Date(response.invitation.expiresAt).getTime();
    const diffHours = (expiry - before) / (1000 * 60 * 60);
    expect(diffHours).toBeGreaterThanOrEqual(71.99);
    expect(diffHours).toBeLessThanOrEqual(72.05);
  });

  it("I4: ttlHours clamped to MAX_TTL_HOURS even if Zod bypassed", async () => {
    const before = Date.now();
    const db = createMockDB();

    // Bypass Zod by casting — simulates a route that somehow forwarded
    // an out-of-bounds value. Service must clamp.
    const { response } = await issueVisitorInvitation(
      { ...validInput(), ttlHours: 9999 as number },
      ACTOR,
      db,
    );

    const expiry = new Date(response.invitation.expiresAt).getTime();
    const diffHours = (expiry - before) / (1000 * 60 * 60);
    expect(diffHours).toBeLessThanOrEqual(MAX_TTL_HOURS + 0.05);
  });

  it("I5: audit event uses hash, never the raw token", async () => {
    const db = createMockDB();

    const { response } = await issueVisitorInvitation(
      validInput(),
      ACTOR,
      db,
    );

    const events = getAuditEventsByType("qr_invitation_issued");
    expect(events).toHaveLength(1);

    const ev = events[0];
    const payload = ev.payload as Record<string, unknown>;
    expect(payload.qrTokenHash).toBe(hashQrToken(response.invitation.qrToken));
    // Critical: the raw token must NEVER appear in the audit payload.
    expect(JSON.stringify(ev)).not.toContain(response.invitation.qrToken);
    expect(ev.guardId).toBe(ACTOR);
  });

  it("I6: pass URL uses APP_PUBLIC_ORIGIN env var", async () => {
    process.env.APP_PUBLIC_ORIGIN = "https://gate.example.com/";
    const db = createMockDB();

    const { response } = await issueVisitorInvitation(
      validInput(),
      ACTOR,
      db,
    );

    expect(response.invitation.passUrl).toBe(
      `https://gate.example.com/pass/${response.invitation.qrToken}`,
    );
  });

  it("I7: two consecutive issues mint different tokens (entropy)", async () => {
    const db = createMockDB();

    const a = await issueVisitorInvitation(validInput(), ACTOR, db);
    const b = await issueVisitorInvitation(validInput(), ACTOR, db);

    expect(a.response.invitation.qrToken).not.toBe(
      b.response.invitation.qrToken,
    );
  });

  it("I8: INSERT failure surfaces as ServiceError INTERNAL_ERROR", async () => {
    const db = createMockDB({ throwOnInsert: true });

    let caught: unknown = null;
    try {
      await issueVisitorInvitation(validInput(), ACTOR, db);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    const se = caught as ServiceError;
    expect(se.code).toBe(VisitorInvitationErrorCodes.INTERNAL_ERROR);
    expect(se.statusCode).toBe(500);

    // No audit row was emitted because the insert failed.
    expect(getAuditEventsByType("qr_invitation_issued")).toHaveLength(0);
  });

  it("I9: plate persists when provided; null when omitted", async () => {
    const db = createMockDB();

    const { response } = await issueVisitorInvitation(
      { ...validInput(), plate: "KCA-123X" },
      ACTOR,
      db,
    );
    expect(response.invitation.plate).toBe("KCA-123X");

    const db2 = createMockDB();
    const { response: r2 } = await issueVisitorInvitation(
      validInput(),
      ACTOR,
      db2,
    );
    expect(r2.invitation.plate).toBeNull();
  });
});

// ─── Preview tests ───────────────────────────────────────────────────────────

describe("previewVisitorInvitation", () => {
  const RAW = "TEST_RAW_TOKEN_FORTY_THREE_CHARS_ABCDEFGHIJ";
  const HASH = hashQrToken(RAW);

  function freshRow(over: Partial<Row> = {}): Row {
    return makeInsertedRow({
      qrTokenHash: HASH,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      ...over,
    });
  }

  it("P1: happy path returns ONLY safe display fields", async () => {
    const db = createMockDB({ selectRows: [freshRow({ plate: "LND-482" })] });

    const { response, statusCode } = await previewVisitorInvitation(RAW, db);

    expect(statusCode).toBe(200);
    expect(response.invitation).toEqual({
      visitorName: "Maya Chen",
      host: "A. Okafor",
      unit: "18B",
      plate: "LND-482",
      expiresAt: expect.stringMatching(/Z$/),
    });
    // None of the internal fields leak.
    expect(response.invitation).not.toHaveProperty("id");
    expect(response.invitation).not.toHaveProperty("qrTokenHash");
    expect(response.invitation).not.toHaveProperty("isUsed");
    expect(response.invitation).not.toHaveProperty("usedAt");
  });

  it("P2: not-found → 404 INVITATION_NOT_FOUND", async () => {
    const db = createMockDB({ selectRows: [] });

    let caught: unknown = null;
    try {
      await previewVisitorInvitation(RAW, db);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe(
      VisitorInvitationErrorCodes.INVITATION_NOT_FOUND,
    );
    expect((caught as ServiceError).statusCode).toBe(404);
  });

  it("P3: expired → 410 INVITATION_EXPIRED", async () => {
    const db = createMockDB({
      selectRows: [freshRow({ expiresAt: new Date(Date.now() - 1000) })],
    });

    let caught: unknown = null;
    try {
      await previewVisitorInvitation(RAW, db);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe(
      VisitorInvitationErrorCodes.INVITATION_EXPIRED,
    );
    expect((caught as ServiceError).statusCode).toBe(410);
  });

  it("P4: consumed → 410 INVITATION_CONSUMED", async () => {
    const db = createMockDB({
      selectRows: [
        freshRow({ isUsed: true, usedAt: new Date(Date.now() - 60000) }),
      ],
    });

    let caught: unknown = null;
    try {
      await previewVisitorInvitation(RAW, db);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe(
      VisitorInvitationErrorCodes.INVITATION_CONSUMED,
    );
    expect((caught as ServiceError).statusCode).toBe(410);
  });

  it("P5: preview does NOT call update() — never marks is_used", async () => {
    const db = createMockDB({ selectRows: [freshRow()] });

    await previewVisitorInvitation(RAW, db);

    expect(db.update).not.toHaveBeenCalled();
    expect(db._updates).toHaveLength(0);
  });

  it("P6: preview emits NO audit event", async () => {
    const db = createMockDB({ selectRows: [freshRow()] });

    await previewVisitorInvitation(RAW, db);

    expect(getAuditEventsByType("qr_invitation_issued")).toHaveLength(0);
  });
});

// ─── Primitive tests ─────────────────────────────────────────────────────────

describe("token primitives", () => {
  it("T1: mintRawToken returns base64url characters only", () => {
    const t = mintRawToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes → 43 base64url chars (no padding).
    expect(t.length).toBe(43);
  });

  it("T2: buildPassUrl strips trailing slash from APP_PUBLIC_ORIGIN", () => {
    process.env.APP_PUBLIC_ORIGIN = "https://gate.example.com///";
    const url = buildPassUrl("abc123");
    expect(url).toBe("https://gate.example.com/pass/abc123");
  });
});
