/**
 * GatePass — Production configuration fail-fast tests.
 *
 * Source: Security-and-Hardening — "Fail loudly on misconfiguration".
 * Source: Trustless-System-Auditor — "Simulate the missing variable, do not
 *   assume the check exists".
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  assertProductionConfig,
  collectProductionConfigProblems,
  type ProductionEnv,
} from "../config/production-config";

const deployable = (): ProductionEnv => ({
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://postgres.ref:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres",
  PIN_PEPPER: "a-strong-random-server-secret-32chars!!",
  SUPABASE_URL: "https://kljrjofhzfbidddxtlkc.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_real_key_value",
  ALLOWED_ORIGINS: "https://gatepass.estate.co.ke",
  APP_PUBLIC_ORIGIN: "https://gatepass.estate.co.ke",
});

const names = (env: ProductionEnv) =>
  collectProductionConfigProblems(env).map((p) => p.name);

describe("production config fail-fast", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts a complete production configuration", () => {
    expect(collectProductionConfigProblems(deployable())).toEqual([]);
    expect(() => assertProductionConfig(deployable())).not.toThrow();
  });

  it.each([
    "DATABASE_URL",
    "PIN_PEPPER",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "ALLOWED_ORIGINS",
    "APP_PUBLIC_ORIGIN",
  ])("refuses to start when %s is missing", (name) => {
    const env = deployable();
    delete env[name];

    expect(names(env)).toEqual([name]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => assertProductionConfig(env)).toThrow(
      new RegExp(`\\[FATAL\\][\\s\\S]*${name} is not set`),
    );
  });

  it("reports every missing variable at once, not just the first", () => {
    const env: ProductionEnv = { NODE_ENV: "production" };
    expect(names(env)).toEqual([
      "DATABASE_URL",
      "PIN_PEPPER",
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "ALLOWED_ORIGINS",
      "APP_PUBLIC_ORIGIN",
    ]);
  });

  it("rejects .env.example placeholder values as if they were unset", () => {
    const env = deployable();
    env.PIN_PEPPER = "change-me-to-a-strong-random-server-secret";
    env.SUPABASE_SERVICE_ROLE_KEY = "<supabase-service-role-secret-key>";

    expect(names(env)).toEqual(["PIN_PEPPER", "SUPABASE_SERVICE_ROLE_KEY"]);
  });

  it("rejects a PIN_PEPPER shorter than 16 characters", () => {
    const env = deployable();
    env.PIN_PEPPER = "tooshort";
    expect(collectProductionConfigProblems(env)).toEqual([
      { name: "PIN_PEPPER", reason: "must be at least 16 characters" },
    ]);
  });

  it("rejects a non-https SUPABASE_URL", () => {
    const env = deployable();
    env.SUPABASE_URL = "http://ref.supabase.co";
    expect(names(env)).toEqual(["SUPABASE_URL"]);
  });

  it("rejects wildcard and localhost-only ALLOWED_ORIGINS", () => {
    const wildcard = deployable();
    wildcard.ALLOWED_ORIGINS = "https://gatepass.estate.co.ke, *";
    expect(names(wildcard)).toEqual(["ALLOWED_ORIGINS"]);

    const local = deployable();
    local.ALLOWED_ORIGINS = "http://localhost:5173,http://localhost:3000";
    expect(names(local)).toEqual(["ALLOWED_ORIGINS"]);

    const mixed = deployable();
    mixed.ALLOWED_ORIGINS = "http://localhost:5173,https://gatepass.estate.co.ke";
    expect(names(mixed)).toEqual([]);
  });

  it("rejects malformed, non-http(s), path-bearing and plain-http public origins", () => {
    for (const bad of [
      "gatepass.estate.co.ke",
      "ftp://gatepass.estate.co.ke",
      "javascript:alert(1)",
      "https://gatepass.estate.co.ke/",
      "https://gatepass.estate.co.ke/app",
      "http://gatepass.estate.co.ke",
      "not a url",
    ]) {
      const allowed = deployable();
      allowed.ALLOWED_ORIGINS = `https://gatepass.estate.co.ke,${bad}`;
      expect(names(allowed), `ALLOWED_ORIGINS=${bad}`).toEqual(["ALLOWED_ORIGINS"]);

      const pub = deployable();
      pub.APP_PUBLIC_ORIGIN = bad;
      expect(names(pub), `APP_PUBLIC_ORIGIN=${bad}`).toEqual(["APP_PUBLIC_ORIGIN"]);
    }

    const ok = deployable();
    ok.ALLOWED_ORIGINS = "https://gatepass.estate.co.ke:8443,http://localhost:5173";
    ok.APP_PUBLIC_ORIGIN = "https://gate.example.com:8443";
    expect(names(ok)).toEqual([]);
  });

  it("rejects a localhost APP_PUBLIC_ORIGIN (links would be unreachable)", () => {
    const env = deployable();
    env.APP_PUBLIC_ORIGIN = "http://localhost:5173";
    expect(names(env)).toEqual(["APP_PUBLIC_ORIGIN"]);
  });

  it("does not require JWT_SECRET in production", () => {
    const env = deployable();
    delete env.JWT_SECRET;
    expect(names(env)).toEqual([]);
  });

  it("is a no-op outside production so local fallbacks keep working", () => {
    expect(() =>
      assertProductionConfig({ NODE_ENV: "development" }),
    ).not.toThrow();
    expect(() => assertProductionConfig({ NODE_ENV: "test" })).not.toThrow();
    expect(() => assertProductionConfig({})).not.toThrow();
  });
});
