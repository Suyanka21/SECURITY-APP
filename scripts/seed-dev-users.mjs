/**
 * GatePass — dev test users (throwaway DEV project only)
 *
 * Creates or updates one Supabase Auth login per test role and links the
 * staff ones to a `guards` row, so the app can be exercised end to end on a
 * dev project. Never for production: production staff are created with
 * `npm run bootstrap:admin` and then from the admin dashboard.
 *
 * Refuses to run unless:
 *   - NODE_ENV is not "production";
 *   - SEED_DEV_PROJECT_REF names the dev project, and both SUPABASE_URL and
 *     DATABASE_URL point at that project ("local" for a localhost stack);
 *   - every SEED_*_PASSWORD below is set (12+ characters).
 *
 * Passwords are read only from the environment and are never printed.
 * Reads `.env.local`, then `.env` (gitignored), then the process env.
 *
 * ENV:
 *   SUPABASE_URL, SUPABASE_SECRET_KEY (sb_secret_…), DATABASE_URL,
 *   SEED_DEV_PROJECT_REF,
 *   SEED_GUARD_PASSWORD, SEED_SENIOR_GUARD_PASSWORD, SEED_ADMIN_PASSWORD,
 *   SEED_RESIDENT_PASSWORD
 *
 * USAGE:
 *   npm run seed:dev-users
 */

import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });

const USERS = [
  { email: "guard@gatepass.test", role: "guard", badge: "DEV-G1", name: "Dev Guard", passwordVar: "SEED_GUARD_PASSWORD" },
  { email: "senior@gatepass.test", role: "senior-guard", badge: "DEV-S1", name: "Dev Senior Guard", passwordVar: "SEED_SENIOR_GUARD_PASSWORD" },
  { email: "admin@gatepass.test", role: "admin", badge: "DEV-A1", name: "Dev Admin", passwordVar: "SEED_ADMIN_PASSWORD" },
  // No guards row on purpose: exercises the "Account not linked" path.
  { email: "resident@gatepass.test", role: null, badge: null, name: null, passwordVar: "SEED_RESIDENT_PASSWORD" },
];

const MIN_PASSWORD_LENGTH = 12;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function fail(msg) {
  console.error(`[seed-dev-users] ERROR: ${msg}`);
  process.exit(1);
}

function parseUrl(name, raw) {
  try {
    return new URL(raw);
  } catch {
    fail(`${name} is not a valid URL`);
  }
}

if (process.env.NODE_ENV === "production") {
  fail("NODE_ENV=production. This script only seeds a throwaway dev project.");
}

const ref = (process.env.SEED_DEV_PROJECT_REF || "").trim();
const rawBase = (process.env.SUPABASE_URL || "").trim();
const secretKey = process.env.SUPABASE_SECRET_KEY || "";
const rawDbUrl = process.env.DATABASE_URL || "";

if (!ref) fail("SEED_DEV_PROJECT_REF is not set (the dev project's reference ID, or \"local\")");
if (!rawBase) fail("SUPABASE_URL is not set");
if (!secretKey) fail("SUPABASE_SECRET_KEY is not set");
if (!secretKey.startsWith("sb_secret_")) fail("SUPABASE_SECRET_KEY must be a Supabase secret key (sb_secret_…)");
if (!rawDbUrl) fail("DATABASE_URL is not set");

const supabaseUrl = parseUrl("SUPABASE_URL", rawBase);
const dbUrl = parseUrl("DATABASE_URL", rawDbUrl);

if (ref === "local") {
  if (!LOCAL_HOSTS.has(supabaseUrl.hostname)) fail("SEED_DEV_PROJECT_REF=local but SUPABASE_URL is not localhost");
  if (!LOCAL_HOSTS.has(dbUrl.hostname)) fail("SEED_DEV_PROJECT_REF=local but DATABASE_URL is not localhost");
} else {
  if (supabaseUrl.hostname !== `${ref}.supabase.co`) {
    fail("SUPABASE_URL does not belong to SEED_DEV_PROJECT_REF");
  }
  const dbUser = decodeURIComponent(dbUrl.username);
  if (dbUser !== `postgres.${ref}` && dbUrl.hostname !== `db.${ref}.supabase.co`) {
    fail("DATABASE_URL does not belong to SEED_DEV_PROJECT_REF");
  }
}

const missing = USERS.map((u) => u.passwordVar).filter(
  (name) => (process.env[name] || "").length < MIN_PASSWORD_LENGTH,
);
if (missing.length > 0) {
  fail(`set ${missing.join(", ")} (each at least ${MIN_PASSWORD_LENGTH} characters)`);
}

const base = rawBase.replace(/\/+$/, "");
const headers = { apikey: secretKey, "Content-Type": "application/json" };

async function authError(r) {
  const body = await r.json().catch(() => ({}));
  return `status ${r.status}${body.error_code ? ` ${body.error_code}` : ""}`;
}

async function findAuthUser(email) {
  for (let page = 1; ; page += 1) {
    const r = await fetch(`${base}/auth/v1/admin/users?page=${page}&per_page=200`, { headers });
    if (!r.ok) fail(`could not list auth users (${await authError(r)})`);
    const list = (await r.json()).users || [];
    const found = list.find((u) => (u.email || "").toLowerCase() === email);
    if (found) return found;
    if (list.length < 200) return null;
  }
}

async function upsertAuthUser(email, password) {
  const existing = await findAuthUser(email);
  if (existing) {
    const r = await fetch(`${base}/auth/v1/admin/users/${existing.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ password, email_confirm: true }),
    });
    if (!r.ok) fail(`could not update ${email} (${await authError(r)})`);
    return { id: existing.id, action: "updated" };
  }
  const r = await fetch(`${base}/auth/v1/admin/users`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!r.ok) fail(`could not create ${email} (${await authError(r)})`);
  return { id: (await r.json()).id, action: "created" };
}

async function main() {
  const client = new pg.Client({
    connectionString: rawDbUrl,
    ssl: LOCAL_HOSTS.has(dbUrl.hostname) ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    for (const u of USERS) {
      const { id, action } = await upsertAuthUser(u.email, process.env[u.passwordVar]);
      if (u.role) {
        await client.query(
          `INSERT INTO guards (badge_number, name, role, supabase_user_id, is_active)
           VALUES ($1, $2, $3, $4, true)
           ON CONFLICT (badge_number) DO UPDATE
             SET name = EXCLUDED.name, role = EXCLUDED.role,
                 supabase_user_id = EXCLUDED.supabase_user_id, is_active = true`,
          [u.badge, u.name, u.role, id],
        );
        console.log(`[seed-dev-users] ${u.email}: auth ${action}, guards ${u.badge} role=${u.role}`);
      } else {
        const linked = await client.query("SELECT badge_number FROM guards WHERE supabase_user_id = $1", [id]);
        if (linked.rows.length > 0) fail(`${u.email} must not have a guards row (found ${linked.rows[0].badge_number})`);
        console.log(`[seed-dev-users] ${u.email}: auth ${action}, no guards row`);
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
