// @vitest-environment node
/**
 * GatePass — Access boundaries (Task 7.7)
 *
 * Runs the REAL Express app (createApp) over a real socket so the full
 * middleware stack — helmet, CORS, rate limits, requireAuth, requireRole —
 * decides every response. Nothing here mocks authorization.
 *
 * Proves, at the HTTP boundary:
 *   - audit logs are never public (401 with no token)
 *   - a plain guard cannot read audit logs or admin-only operational
 *     reports (403 AUTH_FORBIDDEN, handler never runs)
 *   - senior-guard and admin are not refused by the role gate on those
 *     same reports
 *   - the public resident/visitor endpoints reject bad tokens with a
 *     plain-language message and no internal detail (no stack, SQL, driver
 *     text or auth-header instructions). The opaque random traceId is kept
 *     on purpose: the pages show it only as a labelled support reference so
 *     an incident can be correlated with server logs (PR #31).
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "net";
import type { Server } from "http";
import * as jwt from "jsonwebtoken";

import { createApp } from "../app";
import { getJWTSecret } from "../middleware/auth";

const IDS = {
  guard: "11111111-1111-4111-8111-111111111111",
  "senior-guard": "22222222-2222-4222-8222-222222222222",
  admin: "33333333-3333-4333-8333-333333333333",
} as const;
type Role = keyof typeof IDS;

// A DB double that answers requireRole's `select().from().where()` with the
// guard row matching the id in the where-clause. It also answers any other
// select with an empty list so report handlers (which we do not test here)
// simply return "nothing found" instead of crashing.
function makeDb() {
  const rows = (Object.entries(IDS) as Array<[Role, string]>).map(([role, id]) => ({
    id,
    role,
    isActive: true,
    name: `${role} user`,
    badgeNumber: `B-${role}`,
  }));
  // Collect bound parameter values out of a drizzle SQL clause (it is a
  // circular structure, so no JSON.stringify).
  function boundValues(node: unknown, out: string[] = [], depth = 0): string[] {
    if (depth > 8 || node === null || typeof node !== "object") return out;
    const rec = node as { value?: unknown; queryChunks?: unknown[] };
    if (typeof rec.value === "string") out.push(rec.value);
    if (Array.isArray(rec.queryChunks)) {
      for (const c of rec.queryChunks) boundValues(c, out, depth + 1);
    }
    return out;
  }
  // Every builder step returns the same thenable so both `await db.select()
  // .from().where()` and `.where().limit(1)` resolve to the matched rows.
  function resultFor(clause: unknown) {
    const values = boundValues(clause);
    const hit = rows.find((r) => values.includes(r.id));
    const result = hit ? [hit] : [];
    const thenable = {
      then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
        Promise.resolve(result).then(ok, ko),
      limit: () => thenable,
      offset: () => thenable,
      orderBy: () => thenable,
      groupBy: () => thenable,
    };
    return thenable;
  }
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn((clause: unknown) => resultFor(clause)),
    leftJoin: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    orderBy: vi.fn(() => resultFor(undefined)),
    limit: vi.fn(() => resultFor(undefined)),
  };
  return { select: vi.fn(() => chain) };
}

function tokenFor(role: Role): string {
  return jwt.sign({ sub: IDS[role] }, getJWTSecret(), { algorithm: "HS256", expiresIn: "5m" });
}

let server: Server;
let base: string;
const savedSupabaseUrl = process.env.SUPABASE_URL;

beforeAll(async () => {
  delete process.env.SUPABASE_URL; // legacy HS256 mode — no network verification
  const app = createApp(makeDb());
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (savedSupabaseUrl !== undefined) process.env.SUPABASE_URL = savedSupabaseUrl;
});

async function call(
  method: "GET" | "POST",
  path: string,
  opts: { role?: Role; body?: unknown } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (opts.role) headers.authorization = `Bearer ${tokenFor(opts.role)}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(base + path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

function errorCode(body: Record<string, unknown>): unknown {
  return (body.error as { code?: unknown } | undefined)?.code;
}

const AUDIT_ROUTES = [
  "/api/audit/events",
  "/api/audit/entries/00000000-0000-4000-8000-000000000000",
  `/api/audit/shifts/${IDS.guard}?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z`,
];

const ADMIN_REPORTS = [
  "/api/admin/shifts",
  "/api/entries/on-premise",
  "/api/entries/deliveries",
  "/api/auto-approval-rules",
  "/api/watchlist",
];

describe("audit logs are never public", () => {
  for (const path of AUDIT_ROUTES) {
    it(`GET ${path.split("?")[0]} without a token → 401`, async () => {
      const r = await call("GET", path);
      expect(r.status).toBe(401);
      expect(errorCode(r.body)).toBe("AUTH_TOKEN_MISSING");
    });
  }

  it("a plain guard is refused (403 AUTH_FORBIDDEN) on every audit route", async () => {
    for (const path of AUDIT_ROUTES) {
      const r = await call("GET", path, { role: "guard" });
      expect(r.status, path).toBe(403);
      expect(errorCode(r.body), path).toBe("AUTH_FORBIDDEN");
    }
  });

  it("senior-guard and admin pass the role gate on the audit log", async () => {
    for (const role of ["senior-guard", "admin"] as const) {
      const r = await call("GET", "/api/audit/events", { role });
      expect(r.status, role).toBe(200);
      expect(r.body).toHaveProperty("events");
    }
  });
});

describe("admin-only operational reports", () => {
  it("are not public (401)", async () => {
    for (const path of ADMIN_REPORTS) {
      const r = await call("GET", path);
      expect(r.status, path).toBe(401);
    }
  });

  it("refuse a plain guard with 403 AUTH_FORBIDDEN", async () => {
    for (const path of ADMIN_REPORTS) {
      const r = await call("GET", path, { role: "guard" });
      expect(r.status, path).toBe(403);
      expect(errorCode(r.body), path).toBe("AUTH_FORBIDDEN");
    }
  });

  it("do not refuse senior-guard or admin at the role gate", async () => {
    for (const role of ["senior-guard", "admin"] as const) {
      for (const path of ADMIN_REPORTS) {
        const r = await call("GET", path, { role });
        expect([401, 403], `${role} ${path} → ${r.status}`).not.toContain(r.status);
      }
    }
  });

  it("a deactivated or unknown account is refused even with a valid token", async () => {
    const ghost = jwt.sign(
      { sub: "99999999-9999-4999-8999-999999999999" },
      getJWTSecret(),
      { algorithm: "HS256", expiresIn: "5m" }
    );
    const res = await fetch(`${base}/api/audit/events`, {
      headers: { authorization: `Bearer ${ghost}` },
    });
    expect([401, 403]).toContain(res.status);
  });
});

describe("public resident / visitor endpoints leak nothing internal", () => {
  const forbiddenKeys = ["stack", "sql", "query", "cause", "detail"];

  function assertClean(body: Record<string, unknown>) {
    const flat = JSON.stringify(body);
    for (const k of forbiddenKeys) expect(flat, k).not.toContain(`"${k}"`);
    expect(flat).not.toMatch(/Bearer|Authorization header|postgres|drizzle|ECONN|Failed query/i);
    const err = body.error as { code?: unknown; message?: unknown; traceId?: unknown } | undefined;
    expect(typeof err?.code).toBe("string");
    expect(typeof err?.message).toBe("string");
    // a public error body carries nothing beyond code / message / field / traceId
    const allowed = new Set(["code", "message", "field", "traceId"]);
    for (const k of Object.keys(err ?? {})) expect(allowed.has(k), `unexpected key ${k}`).toBe(true);
    if (err?.traceId !== undefined) expect(err.traceId).toMatch(/^trace-[0-9a-f-]{36}$/);
  }

  it("approval preview with a bad token → plain-language refusal, no internal detail", async () => {
    const r = await call("POST", "/api/approvals/00000000-0000-4000-8000-000000000000/preview", {
      body: { token: "a".repeat(64) },
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    assertClean(r.body);
  });

  it("approval decide with a bad token → plain-language refusal, no internal detail", async () => {
    const r = await call("POST", "/api/approvals/00000000-0000-4000-8000-000000000000/decide", {
      body: { token: "a".repeat(64), decision: "approve" },
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    assertClean(r.body);
  });

  it("public pass lookup with an unknown token → 4xx refusal, no internal detail", async () => {
    const r = await call("GET", `/api/visitor-invitations/${"b".repeat(64)}/preview`);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    assertClean(r.body);
  });

  it("the status route residents used to hit is NOT public (guard-only)", async () => {
    const r = await call("GET", "/api/approvals/00000000-0000-4000-8000-000000000000/status");
    expect(r.status).toBe(401);
  });
});
