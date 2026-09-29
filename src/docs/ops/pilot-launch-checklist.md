# GatePass — Pilot Launch Checklist

One estate, one security company, a small number of guards. Work top to bottom.
Every box has an **owner** and a **how to verify**; do not tick a box from
memory. Anything marked **GAP** is a known limitation to accept in writing
before go-live, not something to skip past.

Sign-off table is at the bottom. Nothing goes live until every signature is in.

Related: [Operations runbook](./operations-runbook.md) ·
[Environment & configuration checklist](./environment-configuration-checklist.md) ·
[Technical pre-ship report (Task 6)](../GatePass-Antigravity-Handoff.md)

## A. Infrastructure

| # | Check | Owner | How to verify |
|---|---|---|---|
| A1 | Fresh Supabase project created; the compromised project (`uawkuimxaxbhrccfhoag`) is deleted or paused and all its keys revoked. | Technical | Supabase dashboard shows only the new project; old anon/service keys rejected. |
| A2 | Postgres schema applied to the new database. **GAP:** migrations in `drizzle/` do not apply cleanly in file order (`0001` references `audit_events` before it exists). Use `drizzle-kit push` for the pilot and record that decision. | Technical | `\dt` lists every table; `npx vitest run --config vitest.integration.config.ts` passes against a copy (see env checklist §4). |
| A3 | Row-Level Security enabled on **every** public table. **GAP:** the RLS script is not in this repository — the technical contact must keep it with the deploy notes and apply it after the schema. | Technical | `select tablename from pg_tables where schemaname='public' and not rowsecurity` returns zero rows. |
| A4 | Database backups on and tested: daily automatic backup **plus one manual restore drill** into a scratch project. | Technical | Restore drill notes: date, duration, row counts matched. |
| A5 | Production environment variables set exactly per the [environment checklist](./environment-configuration-checklist.md). Server refuses to start if any is missing — confirm it did so once on purpose. | Technical | Start with one variable unset → `[FATAL] Production configuration is incomplete`, exit 1. |
| A6 | `ALLOWED_ORIGINS` and `APP_PUBLIC_ORIGIN` are the real `https://` domain(s), nothing else. | Technical | A request from another origin gets no CORS headers; pass links in SMS point at the real domain. |
| A7 | `NODE_ENV=production` on the server host; browser bundle built with `--mode production` (dev-only controls absent). | Technical | `grep -c "Simulate offline" dist/assets/*.js` → 0. |
| A8 | Frontend and API are served over HTTPS only. | Technical | `curl -I http://…` redirects or fails; browser padlock present. |
| A9 | `VITE_SUPPORT_EMAIL` / `VITE_SUPPORT_PHONE` set to the estate's real support desk. | Estate manager + Technical | Open `/support` — contact shown, no "not yet published" notice. |

## B. Accounts

| # | Check | Owner | How to verify |
|---|---|---|---|
| B1 | First admin created with `npm run bootstrap:admin` ([procedure](../deploy/first-admin-bootstrap.md)); generated password stored in the estate's password manager, not in chat. | Technical + Admin | Admin signs in to dashboard. |
| B2 | Initial senior guard(s) and guards created from the dashboard, each with a **unique badge number** and their own email. | Admin | Each signs in on the console; header shows their own name and badge. |
| B3 | No shared logins. Every device sign-in is a named person. | Supervisor | Ask each guard to sign in in front of you. |
| B4 | Deactivation and password-reset procedures (done outside the app — **GAP**) rehearsed once on a test account. | Technical | Test guard set `is_active=false` → console shows access refused on next action. |
| B5 | Test accounts used during setup removed or deactivated before go-live. | Admin | Accounts list shows only real staff. |

## C. Behaviour proven on the real deployment

| # | Check | Owner | How to verify |
|---|---|---|---|
| C1 | Walk-in entry logged by a guard appears in the senior guard's shift log within seconds. | Supervisor | Two devices side by side. |
| C2 | Resident approval: request sent → link opens on the **resident's own phone** (no login) → approve → console shows approved. Then deny path. Then let one expire. | Supervisor + one real resident | Three requests, three outcomes visible on console. |
| C3 | Visitor QR pass: issued → visitor opens `/pass/:token` on their phone → scanned at gate → admitted → second scan refused as used. | Supervisor | Second scan shows "already used". |
| C4 | PIN backup: correct PIN admits; 5 wrong PINs → pass **Locked**, visitor page says Locked, correct PIN and QR then refused. | Supervisor | Do it once on a throw-away pass. |
| C5 | Exit recorded; on-premise list shrinks accordingly. | Senior guard | On-premise panel before/after. |
| C6 | **Offline queue:** turn the device's Wi-Fi/data off, log a walk-in, turn it back on → entry syncs automatically, pending counter returns to 0, entry appears once in the shift log. | Supervisor | Watch the counter; check the log for duplicates (must be none). |
| C7 | Offline continuity: signed-in guard, network off, **wake the tab / lock-unlock the phone** → still signed in with the identity marker, not thrown to login. | Supervisor | Header shows name + "not re-verified" marker. |
| C8 | Sign-out returns to login; next guard signs in as themselves. | Supervisor | Shift-handover rehearsal. |
| C9 | Audit persistence: an override made today has a matching row in `audit_events` (`override_authorized`) **and** in `override_events`. Restart the server: the row is still in the table. | Technical | SQL count before/after restart. **GAP:** the `/api/audit` view is in-memory and empties on restart. |
| C10 | Public pages leak nothing: open `/pass/not-a-real-token` and `/approve/not-a-real-id` — plain-language message, no code like `INVITATION_NOT_FOUND`, no "Bearer token". | Supervisor | Screenshot both. |
| C11 | `/legal/privacy`, `/legal/terms`, `/support`, `/support/incident` open **without signing in** and show the DRAFT banner on the two legal pages. | Estate manager | Open all four in a private window. |
| C12 | Guard (not senior) console has **no admin tab**; a guard's session calling `/api/audit/events` directly gets 403. | Technical | Browser dev tools or `curl` with a guard token. |

## D. People & process

| # | Check | Owner | How to verify |
|---|---|---|---|
| D1 | Every guard has read the guard section of the [runbook](./operations-runbook.md) §6–§7, §11–§14 and signed the training sheet. | Supervisor | Signed sheet on file. |
| D2 | Senior guards/admins have read the [SOPs](./admin-sops.md) and the [incident response guide](./incident-response.md). | Estate manager | Signed sheet on file. |
| D3 | Support & escalation contacts filled in: runbook §15, `/support` page, incident guide §0. | Estate manager | No "(fill in)" left anywhere. |
| D4 | Residents told, in plain language, what GatePass records about their visitors and where the (draft) privacy notice is. | Estate manager | Notice sent; copy on file. |
| D5 | **Privacy notice and terms reviewed by a Kenyan lawyer or compliance professional — or the estate accepts in writing that the pilot runs with DRAFT text.** | Estate manager | Reviewer's written sign-off, or a signed acceptance of the draft status. |
| D6 | Retention period for visitor records decided and written into the privacy notice (**GAP:** nothing is auto-deleted today). | Estate manager + Legal reviewer | Number of days appears in `/legal/privacy`. |
| D7 | Rollback plan: who can switch the gate back to paper, and how queued entries are recovered afterwards. | Supervisor | One paragraph, on file. |
| D8 | Pilot review date set (suggest 2–4 weeks) with the list of things to measure: failed syncs, overrides per shift, resident non-response rate, incidents. | Estate manager | Calendar entry + metric list. |

## E. Known gaps accepted for the pilot

Tick only if the sign-off group accepts each in writing.

- [ ] No in-app account deactivation or password reset (done via database / Supabase dashboard by the technical contact).
- [ ] No in-app visitor-history export (database query on written request).
- [ ] Audit **API** is in-memory; durable audit is the database table only.
- [ ] No offline page reload (no service worker); queue survives, page does not.
- [ ] No automatic data deletion / retention enforcement.
- [ ] Legal/privacy text is DRAFT until professionally reviewed.
- [ ] Migration files do not apply in order on a fresh DB; `drizzle-kit push` used instead.

## F. Sign-off

Go-live requires **all** of the following signatures.

| Role | Name | Signature | Date |
|---|---|---|---|
| Estate manager (data owner) | | | |
| Security company supervisor | | | |
| Technical contact (deployer) | | | |
| Legal / compliance reviewer (or written acceptance of draft status, D5) | | | |
