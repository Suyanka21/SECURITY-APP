# GatePass — Environment & Configuration Checklist

What must be set, where, and what the software does if it is missing. Values
are **never** written into this document, the repo, chat, or tickets.

Production and dev are separate Supabase projects (see the
[pilot checklist](./pilot-launch-checklist.md#two-supabase-projects-dev-and-production)).
Everything below is for **production**: values are set only on the host. The dev
project is temporary, holds only made-up data, and is deleted at go-live.

Related: [`deploy/first-admin-bootstrap.md`](../deploy/first-admin-bootstrap.md) ·
[`deploy/dependency-audit.md`](../deploy/dependency-audit.md) ·
[Pilot launch checklist](./pilot-launch-checklist.md)

## 1. Server (Express API) — production

Enforced by `src/server/config/production-config.ts` when `NODE_ENV=production`.
If any of these is missing or still a template placeholder, the server prints
`[FATAL] Production configuration is incomplete. The server will NOT start.`
and exits 1 before listening.

| Variable | What it is | Rules |
|---|---|---|
| `DATABASE_URL` | Postgres connection string for the **production** Supabase project. | Use the session pooler (`:5432`). Rotate if it ever appears in a log or chat. |
| `PIN_PEPPER` | Server-side secret mixed into one-time PIN hashes. | ≥16 random characters. **Changing it invalidates every PIN already issued.** Back it up with the database. |
| `SUPABASE_URL` | Project base URL (`https://<ref>.supabase.co`). | Turns on JWKS token verification. |
| `SUPABASE_SECRET_KEY` | Secret key (`sb_secret_…`) used only by account provisioning. Startup refuses any other key format. | Server-only. Never `VITE_`. Never logged. Rotate on any suspicion. |
| `ALLOWED_ORIGINS` | Comma-separated browser origins allowed by CORS. | Bare `https://host` origins only — no path, no trailing slash. No localhost in production. |
| `APP_PUBLIC_ORIGIN` | Origin used to build resident approval links and visitor pass links. | Same rules; this is what appears in SMS/WhatsApp messages. |

Optional server settings:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3001` | |
| `APPROVAL_TIMEOUT_SECONDS` | see `approval-service.ts` | How long a resident has to answer before the request expires. |
| `JWT_SECRET` | — | **Not used in production** (legacy HS256 path only runs when `SUPABASE_URL` is unset). Leave unset. |

## 2. Browser bundle (Vite) — production build

Checked in `vite.config.ts` when building with `--mode production`; a build
without them prints `[FATAL] Production build refused …` and exits 1
(CI's compile-only build sets `GATEPASS_ALLOW_UNCONFIGURED_BUILD=1`; never set
that for a real deploy).

| Variable | What it is | Rules |
|---|---|---|
| `VITE_SUPABASE_URL` | Same project URL as the server. | Public. |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Publishable key (`sb_publishable_…`) for the login UI. The build refuses any other format, and refuses any `VITE_` value holding an `sb_secret_` key. | Public by design, but must belong to the **new** project. |
| `VITE_API_BASE_URL` | Where the browser reaches the API. | `https://` API origin. |
| `VITE_SUPPORT_EMAIL`, `VITE_SUPPORT_PHONE` | Estate support desk shown on `/support`, `/support/incident`, `/legal/*`. | Optional; when both empty the pages say the contact is not yet published. Set before the pilot. |
| `VITE_DEV_JWT` | Dev-only pre-minted token. | **Must be empty** in any real build. |

Build with `NODE_ENV=production` so the DEV-ONLY simulate-offline / camera-failed
controls are excluded from the bundle. Verify: `grep -c "Simulate offline" dist/assets/*.js` → `0`.

## 2a. Supabase Auth settings (dashboard) — staff password reset

The staff password reset (`/reset-password`) depends on these project
settings. They live in the Supabase dashboard, not in environment variables.

| Setting | Where | Value |
|---|---|---|
| Site URL | Authentication → URL Configuration | `APP_PUBLIC_ORIGIN` (e.g. `https://gatepass.example`). |
| Redirect URLs | Authentication → URL Configuration | Exactly `APP_PUBLIC_ORIGIN/reset-password`. A redirect not on this list falls back to the Site URL, and the link then opens the sign-in page instead of the reset form. No wildcards, no localhost in production. |
| Custom SMTP | Authentication → Emails → SMTP Settings | The estate's own sender. The built-in sender is for testing only, is heavily rate limited and may only deliver to project team members. |
| "Reset password" email template | Authentication → Emails → Templates | Keep the default `{{ .ConfirmationURL }}` link. Do **not** switch it to a `{{ .TokenHash }}` link pointing at our site: that puts the token in the query string, which our host's access logs record. |
| Email OTP expiry | Authentication → Providers → Email | 1 hour or less. |

How the link stays out of logs: the email link goes to Supabase's own
`/auth/v1/verify` endpoint, which consumes the one-time token and redirects to
`APP_PUBLIC_ORIGIN/reset-password#access_token=…`. The part after `#` is never
sent to our host or in a `Referer` header, and the page removes it from the
address bar and history as soon as it has been read. Our server never sees a
reset token; it only receives the email address, in a POST body.

## 3. Things that must never be in the browser bundle or the repo

- `SUPABASE_SECRET_KEY`, `DATABASE_URL`, `PIN_PEPPER`, any `JWT_SECRET`.
- `.env`, `.env.local`, `.env.production` files (only `.env.example` is tracked).
- Any credential from the compromised Supabase project (see [pilot checklist A1](./pilot-launch-checklist.md)). Its keys are revoked; never look them up, copy them or reuse them.

Check before every deploy: `git status` shows no `.env*` staged; `grep -rl sb_secret_ dist/` returns nothing.

## 4. Database

- Schema: a fresh, empty project built with `scripts/build-db-from-sql.sh` (applies every
  `drizzle/*.sql` in order, one transaction per file, stops at the first error). Use the
  **session pooler**: user `postgres.<project-ref>`, port `5432`. Keep the password out of the
  URL and in `PGPASSWORD`. To verify the server's TLS certificate, download the project's CA
  (Dashboard → Database → SSL) and add `?sslmode=verify-full&sslrootcert=<path>` to the URL; the
  bootstrap and seed scripts read the same `DATABASE_SSL_ROOT_CERT` / `DATABASE_SSL_CA` settings
  as the server, with the same checks. `bootstrap-first-admin.mjs` refuses
  `DATABASE_SSL_REJECT_UNAUTHORIZED=false` whatever `NODE_ENV` is (it is the script run against
  production); only `seed-dev-users.mjs` keeps the logged opt-out, outside production.
- API server TLS: set **one** of `DATABASE_SSL_ROOT_CERT` (path to that CA file on the host) or
  `DATABASE_SSL_CA` (the certificate text itself, for hosts without files). The server refuses to
  start in production with neither, with both, or with a value that is not a PEM certificate.
  `DATABASE_SSL_REJECT_UNAUTHORIZED=false` is refused in production by the server; it is a
  dev-only fallback. TLS query params (`sslmode=…`) in `DATABASE_URL` are stripped
  so they cannot weaken verification.
- RLS: the migrations enable it on every `public` table, and the build script fails if any
  table lacks it. Re-check with
  `select tablename from pg_tables where schemaname='public' and not rowsecurity;` → empty.
- Backups: Supabase automatic daily backups on; one restore drill completed.
- Integration tests run only against a local Postgres; they refuse any hosted Supabase URL.

## 5. Rotation triggers

Rotate **immediately** (and treat as an incident) if any of the following
happens: a secret appears in a log, ticket, screenshot or chat; a laptop with
`.env.local` is lost; a staff member with production access leaves; Supabase
reports unusual activity. Order: secret key (`SUPABASE_SECRET_KEY`) → database
password → `PIN_PEPPER` only if compromised (it invalidates live PINs) → publishable
key last.
