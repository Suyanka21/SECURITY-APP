import { describe, it, expect } from "vitest";
import { assertLocalDatabaseUrl } from "./integration/hosted-db-guard";

describe("assertLocalDatabaseUrl", () => {
  it.each([
    "postgresql://postgres.abcdefghijklmnopqrst:s3cret@aws-0-eu-north-1.pooler.supabase.com:6543/postgres",
    "postgresql://postgres.abcdefghijklmnopqrst:s3cret@aws-0-eu-north-1.pooler.supabase.com:5432/postgres",
    "postgresql://postgres:s3cret@db.abcdefghijklmnopqrst.supabase.co:5432/postgres",
    "postgres://postgres:s3cret@DB.ABCDEFGHIJKLMNOPQRST.SUPABASE.CO/postgres",
    "postgresql://postgres:s3cret@db.abcdefghijklmnopqrst.supabase.co.:5432/postgres",
    "postgresql://postgres.ref:s3cret@aws-0-eu-north-1.pooler.supabase.com../postgres",
  ])("refuses a hosted Supabase URL: %s", (url) => {
    expect(() => assertLocalDatabaseUrl(url)).toThrow(/Refusing to run integration tests/);
  });

  it("never puts the password in the error", () => {
    const url = "postgresql://postgres.ref:s3cret-pw@aws-0-eu-north-1.pooler.supabase.com:6543/postgres";
    expect(() => assertLocalDatabaseUrl(url)).toThrow(/aws-0-eu-north-1\.pooler\.supabase\.com/);
    try {
      assertLocalDatabaseUrl(url);
    } catch (e) {
      expect((e as Error).message).not.toContain("s3cret-pw");
    }
  });

  it("refuses an unparseable URL that names a Supabase host", () => {
    expect(() => assertLocalDatabaseUrl("host=db.ref.supabase.co user=postgres")).toThrow(
      /Refusing to run integration tests/,
    );
  });

  it.each([
    "postgresql://postgres:gp@localhost:54329/gatepass",
    "postgresql://gp_owner:gp@127.0.0.1:54330/rehearsal17",
    "postgresql://postgres@notsupabase.com:5432/x",
  ])("allows a non-Supabase URL: %s", (url) => {
    expect(() => assertLocalDatabaseUrl(url)).not.toThrow();
  });

  it("does nothing when DATABASE_URL is unset", () => {
    expect(() => assertLocalDatabaseUrl(undefined)).not.toThrow();
  });
});
