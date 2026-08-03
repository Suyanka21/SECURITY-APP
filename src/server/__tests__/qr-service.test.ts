// @vitest-environment node
/**
 * GatePass — QR Service Tests (TDD)
 *
 * Source: gatepass-api-contract.md §3.1
 * Tests QR validation business logic with mocked DB.
 *
 * Phase 5 additions: audit event emission, edge case hardening.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateQrToken, hashQrToken } from "../services/qr-service";
import { ServiceError } from "../services/entry-service";
import type { QrValidateInput } from "../validation/qr-schemas";
import { guards, authorizationDecisions } from "@/db/schema";
import { clearAuditLog, getAuditEventsByType } from "../services/audit-logger";

// ─── Mock DB Factory ─────────────────────────────────────────────────────────

function createMockDB(overrides: {
  guardResult?: { id: string; isActive: boolean }[];
  approvalResult?: Record<string, unknown>[];
  /** Rows RETURNed by the atomic `is_used=false` guarded consume update.
   *  Empty array simulates losing the race to a concurrent redemption. */
  consumeResult?: { id: string }[];
} = {}) {
  const {
    consumeResult = [{ id: "approval-uuid-001" }],
    guardResult = [{ id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", isActive: true }],
    approvalResult = [{
      id: "approval-uuid-001",
      visitorName: "Maya Chen",
      host: "A. Okafor",
      unit: "18B",
      plate: "LND-482",
      qrTokenHash: hashQrToken("valid-qr-token"),
      expiresAt: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
      isUsed: false,
      usedAt: null,
      usedByGuardId: null,
      createdAt: new Date().toISOString(),
    }],
  } = overrides;

  const updates: unknown[] = [];

  return {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => ({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockImplementation(() => {
            if (table === guards) return Promise.resolve(guardResult);
            if (table === authorizationDecisions) return Promise.resolve(approvalResult);
            return Promise.resolve([]);
          }),
        }),
      })),
    })),
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation((data: unknown) => {
        updates.push(data);
        return {
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue(consumeResult),
          }),
        };
      }),
    })),
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockReturnValue(Promise.resolve()),
    })),
    query: {},
    _updates: updates,
  };
}

function validQrInput(): QrValidateInput {
  return {
    qrToken: "valid-qr-token",
    guardId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    scannedAt: new Date().toISOString(),
  };
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  clearAuditLog();
});

// ─── Service Tests ───────────────────────────────────────────────────────────

describe("QrService.validateQrToken", () => {
  // Test 1: Valid QR → returns visitor data
  // Source: contract §3.1 — 200 OK
  it("returns visitor data for valid QR token", async () => {
    const db = createMockDB();
    const { response, statusCode } = await validateQrToken(validQrInput(), db);

    expect(statusCode).toBe(200);
    expect(response.outcome).toBe("valid");
    expect(response.visitor.name).toBe("Maya Chen");
    expect(response.visitor.host).toBe("A. Okafor");
    expect(response.visitor.unit).toBe("18B");
    expect(response.visitor.preApprovalId).toBe("approval-uuid-001");
    expect(response.traceId).toMatch(/^trace-/);
  });

  // Test 2: QR not found → QR_NOT_FOUND (404)
  it("throws QR_NOT_FOUND when token not in DB", async () => {
    const db = createMockDB({ approvalResult: [] });

    try {
      await validateQrToken(validQrInput(), db);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe("QR_NOT_FOUND");
      expect((err as ServiceError).statusCode).toBe(404);
    }
  });

  // Test 3: QR already used → QR_REPLAYED (409)
  it("throws QR_REPLAYED when token already used", async () => {
    const db = createMockDB({
      approvalResult: [{
        id: "approval-uuid-001",
        visitorName: "Maya Chen",
        host: "A. Okafor",
        unit: "18B",
        plate: null,
        qrTokenHash: hashQrToken("valid-qr-token"),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        isUsed: true,
        usedAt: new Date().toISOString(),
        usedByGuardId: "other-guard-id",
        createdAt: new Date().toISOString(),
      }],
    });

    try {
      await validateQrToken(validQrInput(), db);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe("QR_REPLAYED");
      expect((err as ServiceError).statusCode).toBe(409);
    }
  });

  // Test 4: QR expired → QR_EXPIRED (410)
  it("throws QR_EXPIRED when token past expiry", async () => {
    const db = createMockDB({
      approvalResult: [{
        id: "approval-uuid-001",
        visitorName: "Maya Chen",
        host: "A. Okafor",
        unit: "18B",
        plate: null,
        qrTokenHash: hashQrToken("valid-qr-token"),
        expiresAt: new Date(Date.now() - 3600000).toISOString(),
        isUsed: false,
        usedAt: null,
        usedByGuardId: null,
        createdAt: new Date().toISOString(),
      }],
    });

    try {
      await validateQrToken(validQrInput(), db);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe("QR_EXPIRED");
      expect((err as ServiceError).statusCode).toBe(410);
    }
  });

  // Test 5: Guard not found → GUARD_SESSION_EXPIRED (403)
  it("throws GUARD_SESSION_EXPIRED when guard not found", async () => {
    const db = createMockDB({ guardResult: [] });

    try {
      await validateQrToken(validQrInput(), db);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe("GUARD_SESSION_EXPIRED");
      expect((err as ServiceError).statusCode).toBe(403);
    }
  });

  // Test 6: Token is hashed before lookup (SHA-256)
  it("hashes QR token with SHA-256 before DB lookup", () => {
    const hash = hashQrToken("test-token");

    expect(hash).toBeDefined();
    expect(hash.length).toBe(64);
    expect(hash).not.toBe("test-token");
  });

  // Test 7: Marks QR as used after successful validation
  it("marks QR as used with guard ID after validation", async () => {
    const db = createMockDB();
    await validateQrToken(validQrInput(), db);

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db._updates.length).toBe(1);
    expect(db._updates[0]).toMatchObject({
      isUsed: true,
      usedByGuardId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    });
  });

  // Test 7b: atomic consume guard — losing the race is a replay, not a double-consume.
  it("rejects with QR_REPLAYED when the atomic consume update affects 0 rows", async () => {
    // The record read as unused, but the guarded `is_used=false` update
    // returned no rows — a concurrent PIN/QR redemption consumed it first.
    const db = createMockDB({ consumeResult: [] });
    await expect(validateQrToken(validQrInput(), db)).rejects.toMatchObject({
      code: "QR_REPLAYED",
      statusCode: 409,
    });
    expect(getAuditEventsByType("qr_scan_succeeded").length).toBe(0);
  });

  // Test 8: Response includes traceId for audit
  it("generates traceId for audit correlation", async () => {
    const db = createMockDB();
    const { response } = await validateQrToken(validQrInput(), db);

    expect(response.traceId).toBeDefined();
    expect(response.traceId).toMatch(/^trace-/);
  });

  // ── Phase 5: Audit Event Emission (no silent failures) ──────────────────

  // Test 9: Valid QR emits qr_scan_succeeded audit event
  it("emits qr_scan_succeeded audit event on valid scan", async () => {
    const db = createMockDB();
    await validateQrToken(validQrInput(), db);

    const events = getAuditEventsByType("qr_scan_succeeded");
    expect(events.length).toBe(1);
    expect(events[0].guardId).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    expect(events[0].payload).toMatchObject({
      preApprovalId: "approval-uuid-001",
      visitorName: "Maya Chen",
    });
  });

  // Test 10: Replay attempt emits qr_scan_rejected with previouslyUsedBy
  it("emits qr_scan_rejected with replay details on reuse", async () => {
    const db = createMockDB({
      approvalResult: [{
        id: "approval-uuid-001",
        visitorName: "Maya Chen",
        host: "A. Okafor",
        unit: "18B",
        plate: null,
        qrTokenHash: hashQrToken("valid-qr-token"),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        isUsed: true,
        usedAt: "2026-05-13T10:00:00Z",
        usedByGuardId: "first-guard-id",
        createdAt: new Date().toISOString(),
      }],
    });

    try { await validateQrToken(validQrInput(), db); } catch { /* expected */ }

    const events = getAuditEventsByType("qr_scan_rejected");
    expect(events.length).toBe(1);
    expect(events[0].payload).toMatchObject({
      reason: "QR_REPLAYED",
      previouslyUsedBy: "first-guard-id",
    });
  });

  // Test 11: Expired QR emits qr_scan_rejected
  it("emits qr_scan_rejected audit event on expired QR", async () => {
    const db = createMockDB({
      approvalResult: [{
        id: "approval-uuid-001",
        visitorName: "Maya Chen",
        host: "A. Okafor",
        unit: "18B",
        plate: null,
        qrTokenHash: hashQrToken("valid-qr-token"),
        expiresAt: new Date(Date.now() - 3600000).toISOString(),
        isUsed: false,
        usedAt: null,
        usedByGuardId: null,
        createdAt: new Date().toISOString(),
      }],
    });

    try { await validateQrToken(validQrInput(), db); } catch { /* expected */ }

    const events = getAuditEventsByType("qr_scan_rejected");
    expect(events.length).toBe(1);
    expect(events[0].payload).toMatchObject({ reason: "QR_EXPIRED" });
  });

  // Test 12: Guard failure emits qr_scan_rejected
  it("emits qr_scan_rejected audit event on guard failure", async () => {
    const db = createMockDB({ guardResult: [] });

    try { await validateQrToken(validQrInput(), db); } catch { /* expected */ }

    const events = getAuditEventsByType("qr_scan_rejected");
    expect(events.length).toBe(1);
    expect(events[0].payload).toMatchObject({ reason: "GUARD_SESSION_EXPIRED" });
  });

  // ── Phase 5: Edge Case Hardening ────────────────────────────────────────

  // Test 13: SHA-256 hash is deterministic
  it("produces deterministic SHA-256 hash for same token", () => {
    const hash1 = hashQrToken("consistent-token");
    const hash2 = hashQrToken("consistent-token");
    expect(hash1).toBe(hash2);
  });

  // Test 14: Inactive guard is rejected (not just missing)
  it("rejects inactive guard (isActive=false)", async () => {
    const db = createMockDB({
      guardResult: [{ id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", isActive: false }],
    });

    try {
      await validateQrToken(validQrInput(), db);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe("GUARD_SESSION_EXPIRED");
    }
  });
});
