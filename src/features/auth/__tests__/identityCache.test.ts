/**
 * Offline shift continuity — last-known guard identity cache.
 *
 * The cache exists so a network drop mid-shift does not throw an
 * already-authenticated guard to a login screen they cannot use offline. It is
 * not an authority: these tests pin the refusals (other user, expired,
 * malformed, admin) as hard as the happy path.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  IDENTITY_CACHE_MAX_AGE_MS,
  cachedIdentityToMe,
  clearCachedIdentity,
  readCachedIdentity,
  writeCachedIdentity,
} from "../identityCache";
import type { AuthMe } from "@/lib/api/me";

const USER = "9f2c1f8e-0000-4000-8000-000000000001";
const OTHER_USER = "9f2c1f8e-0000-4000-8000-000000000002";
const STORAGE_KEY = "gatepass.identity.v1";

function me(overrides: Partial<AuthMe> = {}): AuthMe {
  return {
    guardId: "11111111-1111-4111-8111-111111111111",
    role: "guard",
    name: "N. Adeyemi",
    badgeNumber: "G-001",
    isActive: true,
    traceId: "trace-me",
    ...overrides,
  };
}

describe("identity cache", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips a guard identity for the same Supabase user", () => {
    writeCachedIdentity(USER, me());

    const cached = readCachedIdentity(USER);
    expect(cached).toMatchObject({
      supabaseUserId: USER,
      guardId: "11111111-1111-4111-8111-111111111111",
      role: "guard",
      name: "N. Adeyemi",
      badgeNumber: "G-001",
    });
  });

  it("restores a senior-guard identity too", () => {
    writeCachedIdentity(USER, me({ role: "senior-guard" }));
    expect(readCachedIdentity(USER)?.role).toBe("senior-guard");
  });

  it("never persists an admin identity", () => {
    writeCachedIdentity(USER, me({ role: "admin" }));

    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(readCachedIdentity(USER)).toBeNull();
  });

  it("refuses a record belonging to a different Supabase user", () => {
    writeCachedIdentity(USER, me());
    expect(readCachedIdentity(OTHER_USER)).toBeNull();
  });

  it("refuses to restore without a Supabase user", () => {
    writeCachedIdentity(USER, me());
    expect(readCachedIdentity(null)).toBeNull();
  });

  it("does not write without a Supabase user", () => {
    writeCachedIdentity(null, me());
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("expires a record older than the max age and drops it", () => {
    writeCachedIdentity(USER, me());
    const past = Date.now() + IDENTITY_CACHE_MAX_AGE_MS + 1;

    expect(readCachedIdentity(USER, past)).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("keeps a record that is still inside the max age", () => {
    writeCachedIdentity(USER, me());
    const soon = Date.now() + IDENTITY_CACHE_MAX_AGE_MS - 1000;

    expect(readCachedIdentity(USER, soon)).not.toBeNull();
  });

  it.each([
    ["not json", "{{{"],
    ["not an object", '"cached"'],
    ["missing fields", JSON.stringify({ supabaseUserId: USER })],
    [
      "an escalated role",
      JSON.stringify({
        supabaseUserId: USER,
        guardId: "g",
        role: "admin",
        name: "n",
        badgeNumber: "b",
        cachedAt: Date.now(),
      }),
    ],
    [
      "a non-numeric timestamp",
      JSON.stringify({
        supabaseUserId: USER,
        guardId: "g",
        role: "guard",
        name: "n",
        badgeNumber: "b",
        cachedAt: "now",
      }),
    ],
  ])("rejects and clears a cache containing %s", (_label, raw) => {
    window.localStorage.setItem(STORAGE_KEY, raw);

    expect(readCachedIdentity(USER)).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("clears on demand (sign-out)", () => {
    writeCachedIdentity(USER, me());
    clearCachedIdentity();
    expect(readCachedIdentity(USER)).toBeNull();
  });

  it("maps a cached record onto the identity shape the console needs", () => {
    writeCachedIdentity(USER, me());
    const cached = readCachedIdentity(USER);
    expect(cached).not.toBeNull();

    expect(cachedIdentityToMe(cached!)).toEqual({
      guardId: "11111111-1111-4111-8111-111111111111",
      role: "guard",
      name: "N. Adeyemi",
      badgeNumber: "G-001",
      isActive: true,
      traceId: "cached-identity",
    });
  });
});
