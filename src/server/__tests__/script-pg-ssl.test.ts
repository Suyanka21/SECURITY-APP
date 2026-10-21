/**
 * GatePass — standalone scripts' Postgres TLS settings (scripts/lib/pg-ssl.mjs).
 *
 * Source: node-postgres SSL docs — https://node-postgres.com/features/ssl
 */

import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { scriptPgSsl } from "../../../scripts/lib/pg-ssl.mjs";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
const HOSTED = "postgresql://u@aws-0-eu-west-1.pooler.supabase.com:5432/postgres";
const LOCAL = "postgresql://u@localhost:5432/gatepass";
const REPO = path.resolve(__dirname, "../../..");

const dir = mkdtempSync(path.join(tmpdir(), "pg-ssl-test-"));
const caFile = path.join(dir, "ca.crt");
const notCaFile = path.join(dir, "not-ca.txt");
writeFileSync(caFile, PEM);
writeFileSync(notCaFile, "hello");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const silent = () => {};

describe("scriptPgSsl", () => {
  it("uses no TLS for a local database", () => {
    expect(scriptPgSsl(LOCAL, { env: {} })).toBe(false);
    expect(scriptPgSsl("postgresql://u@[::1]:5432/x", { env: {} })).toBe(false);
  });

  it("verifies a hosted database by default", () => {
    expect(scriptPgSsl(HOSTED, { env: {} })).toEqual({ rejectUnauthorized: true });
  });

  it("verifies against the certificate text in DATABASE_SSL_CA, including \\n escapes", () => {
    const verified = { ca: PEM.trim(), rejectUnauthorized: true };
    expect(scriptPgSsl(HOSTED, { env: { DATABASE_SSL_CA: PEM } })).toEqual(verified);
    const oneLine = PEM.replace(/\n/g, "\\n");
    expect(scriptPgSsl(HOSTED, { env: { DATABASE_SSL_CA: oneLine } })).toEqual(verified);
  });

  it("verifies against the file named by DATABASE_SSL_ROOT_CERT", () => {
    expect(scriptPgSsl(HOSTED, { env: { DATABASE_SSL_ROOT_CERT: caFile } })).toEqual({
      ca: PEM,
      rejectUnauthorized: true,
    });
  });

  it("refuses both CA settings at once", () => {
    expect(() => scriptPgSsl(HOSTED, { env: { DATABASE_SSL_CA: PEM, DATABASE_SSL_ROOT_CERT: caFile } })).toThrow(
      "Set only one of DATABASE_SSL_CA and DATABASE_SSL_ROOT_CERT",
    );
  });

  it("refuses CA values that are not a PEM certificate", () => {
    expect(() => scriptPgSsl(HOSTED, { env: { DATABASE_SSL_CA: "hello" } })).toThrow(
      "DATABASE_SSL_CA does not contain a PEM certificate",
    );
    expect(() => scriptPgSsl(HOSTED, { env: { DATABASE_SSL_ROOT_CERT: notCaFile } })).toThrow(
      "DATABASE_SSL_ROOT_CERT does not contain a PEM certificate",
    );
  });

  it("refuses a CA together with the unverified opt-out", () => {
    const env = { DATABASE_SSL_CA: PEM, DATABASE_SSL_REJECT_UNAUTHORIZED: "false" };
    expect(() => scriptPgSsl(HOSTED, { env, allowUnverified: true })).toThrow(/contradicts a configured CA/);
  });

  describe("the unverified opt-out", () => {
    const optOut = { DATABASE_SSL_REJECT_UNAUTHORIZED: "false" };

    it("is refused by default whatever NODE_ENV is, local databases included", () => {
      for (const NODE_ENV of [undefined, "development", "test", "production"]) {
        for (const url of [HOSTED, LOCAL]) {
          expect(() => scriptPgSsl(url, { env: { ...optOut, NODE_ENV } })).toThrow(/refused by this script/);
        }
      }
    });

    it("is honoured with a warning for allowUnverified callers outside production", () => {
      const logs: string[] = [];
      const ssl = scriptPgSsl(HOSTED, { env: optOut, allowUnverified: true, log: (m: string) => logs.push(m) });
      expect(ssl).toEqual({ rejectUnauthorized: false });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/NOT verified/);
    });

    it("is refused in production even for allowUnverified callers", () => {
      expect(() =>
        scriptPgSsl(HOSTED, { env: { ...optOut, NODE_ENV: "production" }, allowUnverified: true, log: silent }),
      ).toThrow(/refused when NODE_ENV=production/);
    });
  });
});

describe("caller policy", () => {
  it("bootstrap-first-admin refuses the opt-out without NODE_ENV, against a local database", () => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SECRET_KEY: "sb_secret_test",
      DATABASE_URL: LOCAL,
      BOOTSTRAP_ADMIN_EMAIL: "admin@gatepass.test",
      BOOTSTRAP_ADMIN_NAME: "Test Admin",
      BOOTSTRAP_ADMIN_BADGE: "DEV-T1",
      DATABASE_SSL_CA: "",
      DATABASE_SSL_ROOT_CERT: "",
      DATABASE_SSL_REJECT_UNAUTHORIZED: "false",
    };
    const r = spawnSync(process.execPath, ["scripts/bootstrap-first-admin.mjs"], { cwd: REPO, env, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/DATABASE_SSL_REJECT_UNAUTHORIZED=false is refused by this script/);
  });

  it("only seed-dev-users opts in to the unverified opt-out", () => {
    const bootstrap = readFileSync(path.join(REPO, "scripts/bootstrap-first-admin.mjs"), "utf8");
    const seed = readFileSync(path.join(REPO, "scripts/seed-dev-users.mjs"), "utf8");
    expect(bootstrap).not.toMatch(/allowUnverified/);
    expect(seed).toMatch(/scriptPgSsl\(rawDbUrl, \{ allowUnverified: true \}\)/);
  });
});
