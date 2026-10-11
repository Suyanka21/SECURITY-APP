# GatePass — Environment & Configuration Checklist

What must be set, where, and what the software does if it is missing. Values
are **never** written into this document, the repo, chat, or tickets.

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
| `DATABASE_URL` | Postgres connection string for the **new** Supabase project. | Use the session pooler (`:5432`). Rotate if it ever appears in a log or chat. |
| `PIN_PEPPER` | Server-side secret mixed into one-time PIN hashes. | ≥16 random characters. **Changing it invalidates every PIN already issued.** Back it up with the database. |
| `SUPABASE_URL` | Project base URL (`https://<ref>.supabase.co`). | Turns on JWKS token verification. |
| `SUPABASE_SERVICE_ROLE_KEY` | Admin Auth key used only by account provisioning. | Server-only. Never `VITE_`. Never logged. Rotate on any suspicion. |
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
| `VITE_SUPABASE_ANON_KEY` | Anon/public key for the login UI. | Public by design, but must belong to the **new** project. |
| `VITE_API_BASE_URL` | Where the browser reaches the API. | `https://` API origin. |
| `VITE_SUPPORT_EMAIL`, `VITE_SUPPORT_PHONE` | Estate support desk shown on `/support`, `/support/incident`, `/legal/*`. | Optional; when both empty the pages say the contact is not yet published. Set before the pilot. |
| `VITE_DEV_JWT` | Dev-only pre-minted token. | **Must be empty** in any real build. |

Build with `NODE_ENV=production` so the DEV-ONLY simulate-offline / camera-failed
controls are excluded from the bundle. Verify: `grep -c "Simulate offline" dist/assets/*.js` → `0`.

## 3. Things that must never be in the browser bundle or the repo

- `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `PIN_PEPPER`, any `JWT_SECRET`.
- `.env`, `.env.local`, `.env.production` files (only `.env.example` is tracked).
- Any credential from the compromised Supabase project (see [pilot checklist A1](./pilot-launch-checklist.md)). Its keys are revoked; never look them up, copy them or reuse them.

Check before every deploy: `git status` shows no `.env*` staged; `grep -rl service_role dist/` returns nothing.

## 4. Database

- Schema: applied with `drizzle-kit push` for the pilot (the SQL files in
  `drizzle/` do not apply in file order on an empty database — known gap).
- RLS: enable on every `public` table; verify with
  `select tablename from pg_tables where schemaname='public' and not rowsecurity;` → empty.
- Backups: Supabase automatic daily backups on; one restore drill completed.
- Integration proof against a copy of the real schema:
  `DATABASE_URL=<copy> npx vitest run --config vitest.integration.config.ts` → 25 tests pass.

## 5. Rotation triggers

Rotate **immediately** (and treat as an incident) if any of the following
happens: a secret appears in a log, ticket, screenshot or chat; a laptop with
`.env.local` is lost; a staff member with production access leaves; Supabase
reports unusual activity. Order: service-role key → database password →
`PIN_PEPPER` only if compromised (it invalidates live PINs) → anon key last.
