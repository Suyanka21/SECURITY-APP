// @vitest-environment node
/**
 * GatePass — staff password reset request (POST /api/auth/password-reset).
 *
 * Pins: the response never depends on whether the email has an account;
 * the Supabase call runs after the response; per-email cooldown; per-IP
 * rate limit; the email address never reaches the logs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import {
  makePasswordResetHandler,
  PASSWORD_RESET_EMAIL_COOLDOWN_MS,
  PASSWORD_RESET_MESSAGE,
  passwordResetCooldownSize,
  resetPasswordResetCooldowns,
} from "../routes/password-reset";
import { createApp } from "../app";

function ctx(body: unknown) {
  let status = 0;
  let json: unknown = null;
  const order: string[] = [];
  const req = { body } as unknown as Request;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(payload: unknown) {
      json = payload;
      order.push("response");
      return res;
    },
  } as unknown as Response;
  return { req, res, status: () => status, json: () => json as Record<string, unknown>, order };
}

const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SECRET_KEY };

beforeEach(() => {
  resetPasswordResetCooldowns();
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_unit_test_only";
});

afterEach(() => {
  vi.restoreAllMocks();
  if (saved.url === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = saved.url;
  if (saved.key === undefined) delete process.env.SUPABASE_SECRET_KEY;
  else process.env.SUPABASE_SECRET_KEY = saved.key;
});

describe("POST /api/auth/password-reset", () => {
  it("answers 202 with the same body whether or not the email has an account", async () => {
    const known = vi.fn().mockResolvedValue(undefined);
    const unknown = vi.fn().mockRejectedValue(new Error("Supabase recover returned HTTP 400"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const a = ctx({ email: "admin@gatepass.test" });
    makePasswordResetHandler(known)(a.req, a.res);
    const b = ctx({ email: "nobody@example.com" });
    makePasswordResetHandler(unknown)(b.req, b.res);
    expect(a.status()).toBe(202);
    expect(b.status()).toBe(202);
    const { traceId: _a, ...bodyA } = a.json();
    const { traceId: _b, ...bodyB } = b.json();
    expect(bodyA).toEqual({ message: PASSWORD_RESET_MESSAGE });
    expect(bodyB).toEqual(bodyA);
    await Promise.resolve();
  });

  it("sends the response before calling Supabase, with a /reset-password redirect", () => {
    process.env.APP_PUBLIC_ORIGIN = "https://gate.example.com/";
    const c = ctx({ email: "  Guard@GatePass.test " });
    const send = vi.fn(async () => {
      c.order.push("send");
    });
    makePasswordResetHandler(send)(c.req, c.res);
    delete process.env.APP_PUBLIC_ORIGIN;
    expect(c.order).toEqual(["response", "send"]);
    expect(send).toHaveBeenCalledWith("guard@gatepass.test", "https://gate.example.com/reset-password");
  });

  it("silently skips a repeat for the same email inside the cooldown, still answering 202", () => {
    let t = 1_000_000;
    const send = vi.fn().mockResolvedValue(undefined);
    const handler = makePasswordResetHandler(send, () => t);
    for (const delta of [0, 1000, PASSWORD_RESET_EMAIL_COOLDOWN_MS]) {
      t = 1_000_000 + delta;
      const c = ctx({ email: "guard@gatepass.test" });
      handler(c.req, c.res);
      expect(c.status()).toBe(202);
    }
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("422 for a malformed email or unknown fields; Supabase is not called", () => {
    const send = vi.fn();
    for (const body of [undefined, {}, { email: "not-an-email" }, { email: "a@b.co", role: "admin" }]) {
      const c = ctx(body);
      makePasswordResetHandler(send)(c.req, c.res);
      expect(c.status()).toBe(422);
      expect(c.json()).toMatchObject({ error: { code: "VALIDATION_ERROR", field: "email" } });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("never logs the email address when the Supabase call fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const c = ctx({ email: "secret.person@gatepass.test" });
    makePasswordResetHandler(vi.fn().mockRejectedValue(new Error("Supabase recover returned HTTP 500")))(c.req, c.res);
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toHaveBeenCalledTimes(1);
    const logged = errors.mock.calls.flat().join(" ");
    expect(logged).toContain("email#");
    expect(logged).not.toContain("secret.person");
    expect(logged).not.toContain("gatepass.test");
  });

  it("the per-email cooldown map sweeps expired entries instead of growing without bound", () => {
    let t = 1_000_000;
    const handler = makePasswordResetHandler(vi.fn().mockResolvedValue(undefined), () => t);
    for (let i = 0; i < 1_000; i += 1) {
      const c = ctx({ email: `bulk${i}@example.com` });
      handler(c.req, c.res);
    }
    expect(passwordResetCooldownSize()).toBe(1_000);
    t += PASSWORD_RESET_EMAIL_COOLDOWN_MS;
    const c = ctx({ email: "fresh@example.com" });
    handler(c.req, c.res);
    expect(passwordResetCooldownSize()).toBe(1);
  });

  it("is rate limited per IP: the 6th request in 15 minutes is 429", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env.SUPABASE_SECRET_KEY;
    const server: Server = createServer(createApp({} as never));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const r = await fetch(`${base}/api/auth/password-reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: `user${i}@example.com` }),
      });
      statuses.push(r.status);
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
  });
});
