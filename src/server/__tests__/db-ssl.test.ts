/**
 * GatePass — API server Postgres TLS settings (src/db/ssl.ts).
 *
 * Source: node-postgres SSL docs — https://node-postgres.com/features/ssl
 */

import { describe, it, expect } from "vitest";
import { resolveSSL, stripTlsParams } from "../../db/ssl";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
const noFile = (path: string): string => {
  throw new Error(`unexpected read of ${path}`);
};

describe("resolveSSL", () => {
  it("keeps TLS off for local development by default", () => {
    expect(resolveSSL({ NODE_ENV: "development" }, noFile)).toBe(false);
    expect(resolveSSL({ NODE_ENV: "development", DATABASE_SSL: "disable" }, noFile)).toBe(false);
  });

  it("ignores DATABASE_SSL=disable in production", () => {
    expect(resolveSSL({ NODE_ENV: "production", DATABASE_SSL: "disable" }, noFile)).toEqual({
      rejectUnauthorized: true,
    });
  });

  it("verifies against the CA file named by DATABASE_SSL_ROOT_CERT", () => {
    const reads: string[] = [];
    const ssl = resolveSSL({ NODE_ENV: "production", DATABASE_SSL_ROOT_CERT: "/ca.crt" }, (p) => {
      reads.push(p);
      return PEM;
    });
    expect(reads).toEqual(["/ca.crt"]);
    expect(ssl).toEqual({ ca: PEM, rejectUnauthorized: true });
  });

  it("verifies against inline PEM in DATABASE_SSL_CA, with \\n escapes expanded", () => {
    const escaped = PEM.trim().replace(/\n/g, "\\n");
    expect(resolveSSL({ NODE_ENV: "production", DATABASE_SSL_CA: escaped }, noFile)).toEqual({
      ca: PEM.trim(),
      rejectUnauthorized: true,
    });
    expect(resolveSSL({ DATABASE_SSL: "require", DATABASE_SSL_CA: PEM }, noFile)).toEqual({
      ca: PEM.trim(),
      rejectUnauthorized: true,
    });
  });

  it("refuses both CA settings at once", () => {
    expect(() =>
      resolveSSL(
        { NODE_ENV: "production", DATABASE_SSL_CA: PEM, DATABASE_SSL_ROOT_CERT: "/ca.crt" },
        () => PEM,
      ),
    ).toThrow(/only one of DATABASE_SSL_CA and DATABASE_SSL_ROOT_CERT/);
  });

  it("refuses a CA value that is not a PEM certificate", () => {
    expect(() =>
      resolveSSL({ NODE_ENV: "production", DATABASE_SSL_CA: "not-a-cert" }, noFile),
    ).toThrow(/DATABASE_SSL_CA does not contain a PEM certificate/);
    expect(() =>
      resolveSSL({ NODE_ENV: "production", DATABASE_SSL_ROOT_CERT: "/x" }, () => "garbage"),
    ).toThrow(/DATABASE_SSL_ROOT_CERT does not contain a PEM certificate/);
  });

  it("refuses the unverified opt-out alongside a CA", () => {
    expect(() =>
      resolveSSL(
        { NODE_ENV: "production", DATABASE_SSL_CA: PEM, DATABASE_SSL_REJECT_UNAUTHORIZED: "false" },
        noFile,
      ),
    ).toThrow(/contradicts a configured CA/);
  });

  it("still honours the opt-out without a CA (production refuses it in production-config)", () => {
    expect(
      resolveSSL({ DATABASE_SSL: "require", DATABASE_SSL_REJECT_UNAUTHORIZED: "false" }, noFile),
    ).toEqual({ rejectUnauthorized: false });
  });
});

describe("stripTlsParams", () => {
  it("removes TLS query params that would override the ssl object", () => {
    const out = stripTlsParams(
      "postgresql://u:p@db.example.com:5432/postgres?sslmode=no-verify&sslrootcert=/x&application_name=gp",
    );
    expect(out).toBe("postgresql://u:p@db.example.com:5432/postgres?application_name=gp");
  });

  it("passes through unset and unparseable values", () => {
    expect(stripTlsParams(undefined)).toBeUndefined();
    expect(stripTlsParams("not a url")).toBe("not a url");
  });
});
