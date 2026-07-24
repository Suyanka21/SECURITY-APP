/**
 * GatePass — First-Admin Bootstrap (Decision A1)
 *
 * Source: src/docs/adr/0001-auth-role-vs-onboarding-role-and-resident-model.md
 *         — A1: accounts are provisioned by an authenticated admin. This is the
 *         ONE controlled exception used to create the very first admin, since
 *         under A1 no admin exists yet to create one through the dashboard.
 * Source: deploy docs — src/docs/deploy/first-admin-bootstrap.md
 *
 * GUARANTEES (per the user's Stage 1 requirements):
 *   - MANUALLY invoked only. Nothing in the running server imports this file;
 *     it is a standalone script (`node scripts/bootstrap-first-admin.mjs`).
 *   - IDEMPOTENT. If ANY admin already exists in `guards`, it refuses and
 *     no-ops with a clear message — it can never mint a second "first" admin.
 *   - The SUPABASE_SERVICE_ROLE_KEY is read from the environment inside THIS
 *     process only. It is never printed, logged, or written anywhere.
 *
 * REQUIRED ENV (see .env.local / deploy docs):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL
 *   BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_NAME, BOOTSTRAP_ADMIN_BADGE
 *   BOOTSTRAP_ADMIN_PASSWORD (optional — a strong one is generated if absent)
 *
 * USAGE:
 *   node scripts/bootstrap-first-admin.mjs
 */

import "dotenv/config";
import { randomBytes } from "crypto";
import pg from "pg";

const { Client } = pg;

// ─── Config (no secrets echoed) ──────────────────────────────────────────────

const base = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Session pooler (5432) is required for reliable DDL/session statements.
const dbUrl = (process.env.DATABASE_URL || "").replace(":6543", ":5432");

const email = (process.env.BOOTSTRAP_ADMIN_EMAIL || "").trim().toLowerCase();
const name = (process.env.BOOTSTRAP_ADMIN_NAME || "").trim();
const badge = (process.env.BOOTSTRAP_ADMIN_BADGE || "").trim();
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || generatePassword();
const passwordWasGenerated = !process.env.BOOTSTRAP_ADMIN_PASSWORD;

function generatePassword() {
  return `Gp!${randomBytes(24).toString("base64url")}9`;
}

function fail(msg) {
  // Never include secrets in the message.
  console.error(`[bootstrap] ERROR: ${msg}`);
  process.exit(1);
}

if (!base) fail("SUPABASE_URL is not set");
if (!svc) fail("SUPABASE_SERVICE_ROLE_KEY is not set");
if (!dbUrl) fail("DATABASE_URL is not set");
if (!email) fail("BOOTSTRAP_ADMIN_EMAIL is not set");
if (!name) fail("BOOTSTRAP_ADMIN_NAME is not set");
if (!badge) fail("BOOTSTRAP_ADMIN_BADGE is not set");

const H = {
  apikey: svc,
  Authorization: `Bearer ${svc}`,
  "Content-Type": "application/json",
};

// ─── Supabase Admin Auth helpers ──────────────────────────────────────────────

async function findAuthUserByEmail(targetEmail) {
  const r = await fetch(`${base}/auth/v1/admin/users?per_page=200`, {
    headers: H,
  });
  if (!r.ok) fail(`could not list auth users (status ${r.status})`);
  const j = await r.json();
  const list = j.users || j || [];
  return list.find((u) => u.email === targetEmail) || null;
}

async function createAuthUser() {
  const r = await fetch(`${base}/auth/v1/admin/users`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (r.status === 200 || r.status === 201) {
    return (await r.json()).id;
  }
  // Already exists in Auth (e.g. a prior partial run) — reuse it.
  if (r.status === 422) {
    const existing = await findAuthUserByEmail(email);
    if (existing) return existing.id;
  }
  fail(`could not create auth user (status ${r.status})`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    // IDEMPOTENCY GATE — refuse if ANY admin already exists.
    const existingAdmins = await client.query(
      "SELECT count(*)::int AS n FROM guards WHERE role = 'admin'",
    );
    const adminCount = existingAdmins.rows[0]?.n ?? 0;
    if (adminCount > 0) {
      console.log(
        `[bootstrap] An admin already exists (${adminCount} found). ` +
          "Refusing to create another 'first' admin. No changes made.",
      );
      console.log(
        "[bootstrap] Create further accounts from the admin dashboard " +
          "(POST /api/admin/accounts).",
      );
      return;
    }

    // Guard against a badge collision that isn't an admin.
    const badgeClash = await client.query(
      "SELECT role FROM guards WHERE badge_number = $1",
      [badge],
    );
    if (badgeClash.rows.length > 0) {
      fail(
        `badge ${badge} already belongs to a non-admin guard; ` +
          "choose a different BOOTSTRAP_ADMIN_BADGE",
      );
    }

    // Create (or reuse) the Auth user, then link the admin guards row.
    const authUserId = await createAuthUser();
    await client.query(
      `INSERT INTO guards (badge_number, name, role, supabase_user_id, is_active)
       VALUES ($1, $2, 'admin', $3, true)`,
      [badge, name, authUserId],
    );

    console.log("[bootstrap] First admin created successfully:");
    console.log(`  name:  ${name}`);
    console.log(`  badge: ${badge}`);
    console.log(`  email: ${email}`);
    console.log("  role:  admin");
    if (passwordWasGenerated) {
      // The password is a secret; print it EXACTLY ONCE to the operator's
      // terminal so they can relay it. It is never persisted or logged.
      console.log(
        `\n[bootstrap] Generated one-time password (store securely, rotate after first login):\n  ${password}`,
      );
    } else {
      console.log(
        "\n[bootstrap] Using the password supplied via BOOTSTRAP_ADMIN_PASSWORD.",
      );
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // Surface a safe message; never dump env or secrets.
  fail(err instanceof Error ? err.message : String(err));
});
