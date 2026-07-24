# Deploy — First-Admin Bootstrap & Account Provisioning (A1)

> Decision: `src/docs/adr/0001-auth-role-vs-onboarding-role-and-resident-model.md`
> §Decision 3. Under A1 there is **no public signup**. All guard/senior-guard/
> admin accounts are created by an authenticated admin. This doc explains the
> one exception used to create the **first** admin, and how everything after is
> created from the dashboard.

## 1. Why a bootstrap step exists

A1 says only an admin can create accounts. On a brand-new database `guards` is
empty, so no admin exists to create the first one. The bootstrap script
(`scripts/bootstrap-first-admin.mjs`) is the controlled, one-time way to seed
that first admin. It is **not** part of normal server startup — nothing the
running server imports calls it. You run it by hand, once, per environment.

## 2. Required environment variables

Set these in the deploy environment (or `.env.local` for local runs). None of
them are echoed by the script.

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Project base URL (no `/rest/v1`). |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only Admin Auth key. **Never** `VITE_`-prefixed, never sent to the browser, never logged. |
| `DATABASE_URL` | Postgres URI. Use the **session pooler `:5432`** (the script auto-rewrites `:6543`→`:5432`). Paste the URI only — no `DATABASE_URL=` prefix, no quotes. |
| `BOOTSTRAP_ADMIN_EMAIL` | Email for the first admin's Supabase Auth login. |
| `BOOTSTRAP_ADMIN_NAME` | Display name stored on the `guards` row. |
| `BOOTSTRAP_ADMIN_BADGE` | Unique badge number for the `guards` row. |
| `BOOTSTRAP_ADMIN_PASSWORD` | *(optional)* If omitted, the script generates a strong password and prints it **once**. |

## 3. Exact command

```bash
# from the repo root, with the env vars above in scope (e.g. via .env.local)
npm run bootstrap:admin
# equivalently: node scripts/bootstrap-first-admin.mjs
```

Expected output on a fresh DB:

```
[bootstrap] First admin created successfully:
  name:  <BOOTSTRAP_ADMIN_NAME>
  badge: <BOOTSTRAP_ADMIN_BADGE>
  email: <BOOTSTRAP_ADMIN_EMAIL>
  role:  admin

[bootstrap] Generated one-time password (store securely, rotate after first login):
  <shown once — only when BOOTSTRAP_ADMIN_PASSWORD was not supplied>
```

## 4. Idempotency / rerun behavior

The script is safe to run more than once:

- If **any** `guards` row with `role='admin'` already exists, it prints a notice
  and **makes no changes** — it will never create a second "first" admin.
- If the badge you chose already belongs to a non-admin guard, it aborts and
  asks you to pick a different `BOOTSTRAP_ADMIN_BADGE` (no partial writes).
- If a matching Supabase Auth user already exists from a prior partial run, it
  reuses that Auth user rather than failing.

So the intended lifecycle is: run once to create the first admin; any later run
is a harmless no-op.

## 5. Handling the service-role key safely

- Keep `SUPABASE_SERVICE_ROLE_KEY` only in the server/bootstrap environment.
- It is never `VITE_`-prefixed (Vite would otherwise bundle it into the browser).
- The script and the API never print, log, or return it.
- Rotate it if it is ever exposed, and re-run nothing — the admin already exists.

## 6. Creating every subsequent account (no more bootstrap)

After the first admin exists, **do not run the bootstrap again.** Create all
further guard / senior-guard / admin accounts from the admin dashboard:

1. Sign in as an admin.
2. In the admin dashboard, use the **"Create staff account"** panel.
3. Enter name, badge number, email, and role; optionally set a temporary
   password (leave blank to have the server generate one, shown once).
4. Submit. This calls `POST /api/admin/accounts`
   (`requireAuth` → strict limiter → `requireRole("admin")`), which:
   - validates the role against `{guard, senior-guard, admin}`,
   - creates the Supabase Auth user (server-side Admin Auth),
   - inserts the linked `guards` row with the **server-chosen** role,
   - writes an `account_provisioned` audit event (no secrets in the payload),
   - returns the created account (and the one-time password if generated).
5. Relay the credentials to the new staff member securely; ask them to change
   the password after first sign-in.

## 7. Migration note

The `account_provisioned` audit enum value is added by
`drizzle/0010_account_provisioned_audit_enum.sql`. Apply migrations against the
target database (`npx drizzle-kit migrate` or the project's migrate step) before
provisioning accounts, so the audit write succeeds.
