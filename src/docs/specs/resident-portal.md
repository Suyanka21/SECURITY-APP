# Spec: Resident Portal (self-serve residents, own-unit scope)

Status: **APPROVED as written (owner, 2026-05). §10 decisions recorded in §11. R1 in progress.**
Supersedes: the "resident is link-only, never signs in" principle in
`auth-and-role-routing.md` and `stakeholder-onboarding.md` for the resident role.
Related: `guest-qr-ticket.md` (F6), `visitor-profiles.md` (F4), `auto-approval.md` (F3),
`resident-approval-flow.md` (F1), `notifications.md` (F2).

---

## 0. Assumptions I am making — correct these before approving

1. **Phone OTP is new, not reused.** The app today authenticates staff with
   `supabase.auth.signInWithPassword` (email + password) only. There is no
   `signInWithOtp` / `verifyOtp` anywhere in the repo, and the Supabase project
   has no SMS provider configured. So "same mechanism already used elsewhere" is
   not true today: resident login requires (a) enabling the Phone provider in
   Supabase Auth, (b) an SMS OTP provider (Twilio Verify / MessageBird / Vonage /
   Textlocal are what Supabase supports natively), (c) new client code. This is a
   billed third-party dependency and a credential you will need to provide.
2. **A resident phone number is the resident's identity.** One Supabase user =
   one phone = one resident = one unit. Two people in the same unit are two
   resident rows pointing at the same unit.
3. **Units are pre-registered by an admin; residents are not.** "Nobody creates
   their account for them" is honoured for the *account*, but a resident must be
   *linked to a unit* by someone trusted — otherwise anyone with a phone can
   claim unit 12B and issue passes for it. The linkage mechanism is the central
   design question (§2.3); I propose an admin-issued one-time claim code.
4. **`unit` stays a free-text label** (`text`, ≤32 chars, case-insensitive) in
   `authorization_decisions`, `visitor_profiles`, `auto_approval_rules` — that
   is how the working matching engine keys today. The new `units` table becomes
   the canonical source of those labels; existing tables are not re-keyed by FK
   in this feature (see §2.4 for why).
5. **No real WhatsApp/SMS notification delivery is in scope.** Sharing a pass is
   the resident copying/`navigator.share`-ing the `/pass/:token` link into
   WhatsApp themselves. The notification provider remains the default-deny mock;
   wiring a real provider is a separate PR (flagged in `pilot-readiness-report.md`).
6. **Guard/admin/senior-guard behaviour does not change.** The guard console,
   scan flow, `qr-service.validateQrToken`, PIN backup and audit are untouched.

→ If any of these is wrong, the table shape in §2 changes; say so first.

---

## 1. Objective

Turn the resident from an approve-on-arrival participant into the initiator of
visitor access, scoped strictly to their own unit, using the primitives that
already work at the gate.

Three capabilities, in priority order, one screen, one login:

| # | Capability | Reuses |
|---|---|---|
| 1 | **Send a pass to an expected visitor** | `issueVisitorInvitation` → `authorization_decisions` → `/pass/:token` → guard scan / PIN backup |
| 2 | **Register household members / workers** | `visitor_profiles` + `auto_approval_rules` (matching engine) |
| 3 | **Register vehicles** | same rows, `plate` / `plate_required` |

Explicitly **out of scope**: dashboard, inbox, notification centre, visit
history, resident-to-resident anything, editing other units, real WhatsApp
delivery, PWA/offline for residents.

**Success looks like:** a resident on their phone signs in with an OTP, taps
"Send a pass", enters a name (and optional plate), gets a `/pass/…` link and
shares it via WhatsApp; the visitor shows the QR at the gate; the guard scans and
the entry is recorded with `unit = resident's unit`, with no guard/admin
involvement and no possible way for that resident to affect any other unit.

---

## 2. Data model — the piece everything depends on

### 2.1 `units`

```sql
CREATE TABLE units (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label       text NOT NULL,               -- "12B", "House 4" — the value written into
                                           -- authorization_decisions.unit etc.
  label_norm  text GENERATED ALWAYS AS (lower(trim(label))) STORED,
  is_active   boolean NOT NULL DEFAULT true,
  created_by_guard_id uuid NOT NULL REFERENCES guards(id),   -- the admin who registered it
  created_at  timestamptz(3) NOT NULL DEFAULT now(),
  updated_at  timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT units_label_bounded CHECK (length(trim(label)) BETWEEN 1 AND 32),
  CONSTRAINT units_label_norm_unique UNIQUE (label_norm)
);
```

Why a separate table rather than a column on `residents`: two residents per
unit must share exactly one label; deactivating a unit (tenant moves out) must
cut off every resident of that unit at once; and the admin needs a list of units
to issue claim codes against.

### 2.2 `residents`

```sql
CREATE TABLE residents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supabase_user_id  uuid NOT NULL,                  -- auth.users.id (FK added guarded, like migration 0009)
  unit_id           uuid NOT NULL REFERENCES units(id),
  display_name      text NOT NULL,
  phone_e164        text NOT NULL,                  -- copied from auth.users.phone at claim time
  is_active         boolean NOT NULL DEFAULT true,
  claimed_at        timestamptz(3) NOT NULL DEFAULT now(),
  deactivated_at    timestamptz(3),
  deactivated_by_guard_id uuid REFERENCES guards(id),
  created_at        timestamptz(3) NOT NULL DEFAULT now(),
  updated_at        timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT residents_name_bounded  CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  CONSTRAINT residents_phone_e164    CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT residents_deactivation_consistent
    CHECK ((deactivated_at IS NULL) = (deactivated_by_guard_id IS NULL))
);
CREATE INDEX residents_unit_idx ON residents(unit_id);
CREATE INDEX residents_supabase_user_idx ON residents(supabase_user_id);
CREATE UNIQUE INDEX residents_active_user_unique  ON residents(supabase_user_id) WHERE is_active = true;
CREATE UNIQUE INDEX residents_active_phone_unique ON residents(phone_e164)       WHERE is_active = true;
```

**Exactly-one-unit is structural:** `unit_id NOT NULL` + at most one *active*
row per `supabase_user_id` (partial unique index) means a Supabase user acts
for at most one unit at a time. A `residents` row is one **membership** (user ×
unit) and is never re-pointed: moving units = admin deactivates the old row and
issues a new claim code; redeeming it **inserts a new row**. No `UPDATE
unit_id` path exists, so every historical reference (`unit_claim_codes.
used_by_resident_id`, `audit_events.resident_id`, resident-created profiles,
rules and passes) keeps resolving to the unit it was made for.
`requireResidentAuth` resolves the active row only.

`residents` is deliberately **not** a row in `guards` with `role='resident'`:
`requireAuth` resolves `sub → guards.supabase_user_id` and `requireRole` reads
`guards.role`; letting a resident row exist there would make every
`requireRole` check a one-typo blast radius. Residents get their own middleware
(§3.1) and can never satisfy a guard-side check.

### 2.3 `unit_claim_codes` — how a resident gets linked to a unit

```sql
CREATE TABLE unit_claim_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id       uuid NOT NULL REFERENCES units(id),
  code_hash     text NOT NULL UNIQUE,     -- SHA-256 of the 8-char code; raw code shown to admin once
  issued_by_guard_id uuid NOT NULL REFERENCES guards(id),
  expires_at    timestamptz(3) NOT NULL,  -- default 72h, max 7d
  used_at       timestamptz(3),
  used_by_resident_id uuid REFERENCES residents(id),
  created_at    timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT claim_used_consistent CHECK ((used_at IS NULL) = (used_by_resident_id IS NULL))
);
```

Flow: admin picks a unit → gets a code (e.g. `K7P4-Q2MZ`) → hands it to the
tenant (in person / WhatsApp, outside the app) → tenant signs in with phone OTP
→ enters the code once → `residents` row is created inside the same transaction
that marks the code used. Self-serve account, trusted linkage, no admin typing
phone numbers, and the compromise blast radius of a leaked code is one unit for
≤72h. Same hash-then-store / one-shot / lockout patterns already used for QR
tokens and PINs, so no new crypto.

*R1 as built:* `code_hash` is an HMAC-SHA256 keyed with `PIN_PEPPER` (same
helper as PINs) rather than a bare SHA-256, so a database leak alone cannot be
replayed as a code. Wrong-code lockout is tracked per **authenticated Supabase
user** (`resident_claim_attempts`: 5 failures → 15-minute lock) instead of a
counter on the code row, because a wrong code cannot be mapped to any code
row. Failures older than the 15-minute window are forgotten (the count restarts
atomically in the same upsert), so only 5 failures *within* a window lock. The
caller receives generic `CLAIM_CODE_INVALID` / `CLAIM_CODE_EXPIRED`
(never "used" vs "unknown"). Unit labels are unique case/whitespace-
insensitively via a generated `label_norm` column.

Alternative I considered and rejected: admin pre-registers the phone number and
the resident just signs in. Simpler, but it means the admin types phone numbers
(the same failure mode as `hostPhoneE164` today), and a typo silently gives a
stranger a unit.

### 2.4 Why existing tables are **not** re-keyed by `unit_id` now

`authorization_decisions.unit`, `visitor_profiles.unit`, `auto_approval_rules.unit`
and `approval_requests` all key on the text label and the matching engine does
`lower(unit) = lower(?)`. Re-keying them is a migration across five tables plus
every matching query — real risk, zero resident-facing value. Instead the
resident write paths **derive** `unit` from `residents → units.label` server-side
and never accept it from the client. `units.label_norm UNIQUE` keeps the label
canonical. Re-keying can be a later ADR if wanted.

### 2.5 Attribution columns

`visitor_profiles.created_by_guard_id` and `auto_approval_rules.created_by_guard_id`
are `NOT NULL`. Residents are not guards. Proposal: add nullable
`created_by_resident_id uuid REFERENCES residents(id)` to both, relax
`created_by_guard_id` to nullable, and add
`CHECK (num_nonnulls(created_by_guard_id, created_by_resident_id) = 1)`.
Same for `authorization_decisions`: add `issued_by_resident_id` (nullable; today
issuer identity lives only in the audit row). Views/exports show
"resident: <display_name> (unit 12B)" where they show a guard today.

**Ask-first item:** this is a schema change to three existing tables.

---

## 3. Server

### 3.1 Auth: `requireResidentAuth`

New middleware in `src/server/middleware/auth.ts` sharing the JWKS verification
with `requireAuthSupabase`, then resolving `sub → residents.supabase_user_id`
where `is_active AND units.is_active`. Injects `req.resident = { id, unitId,
unitLabel }`. Fails closed:

| Situation | Response |
|---|---|
| valid token, no residents row | `403 AUTH_NO_RESIDENT_LINK` (the client shows the claim-code screen) |
| resident deactivated | `403 RESIDENT_INACTIVE` |
| unit deactivated | `403 UNIT_INACTIVE` |
| token is a guard's | `403 AUTH_NO_RESIDENT_LINK` (a guard is not a resident; no cross-over) |

`requireAuth` (guard side) is unchanged and a resident token still gets
`403 AUTH_NO_GUARD_LINK` there. There is no route that accepts both.

*R1 as built:* lives in `src/server/middleware/resident-auth.ts` (not
`auth.ts`, so guard auth is untouched) and injects `req.resident =
{ residentId, supabaseUserId, displayName, phoneE164, unitId, unitLabel }`.
A sibling `requireSupabaseUser` verifies the token only (no resident row
required) and is used solely by `POST /api/resident/claim`. The verifier now
surfaces the token's `phone` claim (normalised to E.164) so the claim can bind
the verified phone.

Legacy HS256 mode (`SUPABASE_URL` unset, dev/tests): `sub` plays the role of
the Supabase user UUID and an optional `phone` claim mirrors Supabase's, so
the server test suite needs no Supabase.

### 3.2 Routes (`src/server/routes/resident.ts`, all `requireResidentAuth` + `strictLimiter`)

```
GET  /api/resident/me                          → { resident, unit }
POST /api/resident/claim                       → { code }  (token-authed, NOT resident-authed —
                                                  the only route a linked-nothing user can call)
POST /api/resident/passes                      → capability 1
GET    /api/resident/registrations             → capabilities 2 + 3 (own registrations only)
POST   /api/resident/registrations             → { kind: 'person', label } | { kind: 'vehicle', label, plate }
DELETE /api/resident/registrations/:id         → soft-delete profile + deactivate rule
POST   /api/resident/registrations/:id/renew   → rule expires_at = now + 90 days
```

As built (R3): one resource for both kinds, so list/remove/renew share one
ownership check. Another resident's id is a 404, never a 403.

Admin (`requireAuth` + `requireRole('admin')`):
```
POST /api/admin/units                 GET /api/admin/units
POST /api/admin/units/:id/claim-codes         → raw code returned exactly once
POST /api/admin/units/:id/deactivate          → cascades in one transaction: residents inactive, open passes for the
                                                  label expired (§11.4), active auto-approval rules for the label
                                                  deactivated (active=false). Claim-code issuance and claim redemption
                                                  share-lock the unit row, so neither can commit against a unit whose
                                                  deactivation (FOR UPDATE) committed first.
GET  /api/admin/residents?unitId=&includeInactive=
POST /api/admin/residents/:id/deactivate
```

### 3.3 Capability 1 — `POST /api/resident/passes`

Body: `{ visitorName, plate?, ttlHours? }`. **No `host`, no `unit`** — server sets
`unit = req.resident.unitLabel`, `host = resident.display_name`. Calls the
existing `issueVisitorInvitation()` with `actor = { kind: 'resident', id }`
(today it takes `actorId: string`; it gains a discriminated actor so the audit
row and `issued_by_resident_id` are correct). Everything downstream —
`/pass/:token`, preview endpoint, guard scan, PIN backup, expected-plate
soft-mismatch warning, `is_used` consumption — is unchanged and already tested.

Limits (new, resident-only): TTL max **48h** (staff keep 168h), at most **10
unissued/unexpired passes per unit**, per-resident limiter. Response is the
existing `IssueInvitationResponse` (raw token once, pass URL, PIN, passRef).

Client: one form → result screen with QR preview, "Share via WhatsApp"
(`navigator.share` → fallback `https://wa.me/?text=…` → fallback copy). The
PIN is shown once with "send this separately" copy.

**As built in R2** (`src/server/services/resident-pass-service.ts`):
- Separate `issueResidentPass()` rather than a discriminated actor on
  `issueVisitorInvitation()`. The resident path needs the unit row locked
  `FOR UPDATE`, the resident row `FOR SHARE`, the open-pass count, the insert
  and the `qr_invitation_issued` audit row in **one** transaction (published
  only after commit). The staff service has none of that, and its behaviour is
  left untouched. Both share `mintRawToken`, `hashQrToken`, `buildPassUrl`,
  `generatePassRef`, `generatePin`/`hashPin`, so the row and response are
  identical in shape and redeem through the same preview/scan/PIN paths.
- The cap counts **resident-issued** (`issued_by_resident_id IS NOT NULL`),
  unused, unexpired passes for the unit. Staff-issued passes for the same unit
  do not consume it.
- `ttlHours` > 48 is rejected (422), not clamped. Default 24.
- Rate limit: 30 issues/hour keyed by resident id (after auth), on top of the
  global limiter.
- Audit: `audit_events.resident_id` = resident, `guard_id` NULL; payload has
  `qrTokenHash`, never the raw token, PIN or phone.

### 3.4 Capabilities 2 & 3 — write into existing matching tables via a thin scoped table

**Decision: thin resident-scoped table feeding the existing rows, not direct writes.**

```sql
CREATE TABLE unit_registrations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id        uuid NOT NULL REFERENCES units(id),
  resident_id    uuid NOT NULL REFERENCES residents(id),
  kind           text NOT NULL CHECK (kind IN ('person','vehicle')),
  label          text NOT NULL,          -- person name, or vehicle description ("white Vitz")
  plate          text,                   -- required for kind='vehicle', optional for 'person'
  visitor_profile_id     uuid REFERENCES visitor_profiles(id),
  auto_approval_rule_id  uuid REFERENCES auto_approval_rules(id),
  created_at / updated_at / deleted_at  timestamptz(3)
);
```

Reasoning:
- `visitor_profiles` and `auto_approval_rules` are keyed by the *triple*
  `(visitor_name, host, unit)` and `visitor_profiles` requires a name. A
  vehicle-only registration ("any driver of KDA 123X") has no natural name and
  would need a synthetic one — the thin table holds the resident's real intent
  and the derived rows carry whatever the engine needs (name = label,
  `plate_required = plate`).
- Residents must list/delete **only their own** registrations. Filtering
  `visitor_profiles WHERE lower(unit)=…` would also expose guard-created
  profiles for that unit (and their `notes`/`watch_flag`, which are staff-only
  fields). Ownership via `unit_registrations.resident_id` is exact.
- Deleting a registration soft-deletes the profile and deactivates the rule in
  one transaction; the engine's partial-unique-index on active triples is
  respected because the resident path goes through `createVisitorProfile` /
  `seedAutoApprovalRule` (existing service functions), not raw inserts.
- Rule TTL: `auto_approval_rules.expires_at` is `NOT NULL`. Resident-created
  rules get **90 days** and the portal shows "renew" when < 14 days remain,
  matching the watchlist's re-confirmation cadence. A household member is not a
  permanent pre-approval — that is the existing engine's safety property and I
  don't propose weakening it.
- `watch_flag`, `notes` are never settable by residents (not in the Zod schema).

Household = `kind='person'` → profile + rule (`plate_required = plate ?? null`).
Vehicle = `kind='vehicle'` → profile (name = label) + rule with
`plate_required = plate` **required**.

Cap: 20 registrations per unit (both kinds combined).

**As built in R3 (owner decisions 2026-05, §11 rows R3-a..c):**
- Migration `0015_unit_registrations.sql`. `profile`/`rule` FKs are `NOT NULL`;
  generated `plate_norm` (uppercase, separators stripped) with a partial
  UNIQUE `(unit_id, plate_norm) WHERE kind='vehicle' AND deleted_at IS NULL`.
- `visitor_profiles.deleted_by_resident_id`; the soft-delete CHECK is now
  "active ⇒ no remover, deleted ⇒ exactly one remover (guard or resident)".
- Writes go through `unit-registration-service.ts`, not `createVisitorProfile`
  / `seedAutoApprovalRule`: those take a guard id and audit outside any
  transaction. The resident service locks unit then resident, writes profile +
  rule + registration + audit row in one transaction, then publishes. The
  active-triple uniqueness is checked explicitly inside that transaction.
- `kind='person'` takes **no plate** (a person rule pinned to a plate would
  refuse them on foot). Profile/rule `visitor_name` = label; for vehicles
  `"<label> (<PLATE>)"` with `plate_required = plate`.
- **Matching.** Person rules match only on the existing exact
  name/host/unit triple — the portal copy says so plainly. Resident
  **vehicle** rules additionally match in `evaluate()` on unit + plate,
  ignoring name/host, via a second lookup that runs only when the unchanged
  triple lookup did not match, and only for rules owned by a live
  `unit_registrations` row with `kind='vehicle'` whose resident and unit are
  active and whose `created_by_resident_id` is that resident. Staff rules never
  enter this path. Expired rules return `RULE_EXPIRED`; the expiry audit row is
  attributed to the creating resident when there is no creating guard.
- Resident deactivation disables that resident's active rules (unit
  deactivation already disabled the unit's rules). A rule switched off by
  staff stays off: renew returns `409 REGISTRATION_DISABLED`.
- **Staff block.** When an admin deactivates a resident-created rule
  (`POST /api/auto-approval-rules/:id/deactivate`, optional
  `{ reason }`, 3–500 chars), the linked `unit_registrations` row is marked
  `blocked_at` / `blocked_by_guard_id` / `block_reason`, in the same
  transaction as the rule switch-off and its audit rows
  (`auto_approval_rule_deactivated`, `resident_registration_blocked`). The
  block outlives the row's soft delete. While it stands, `createRegistration`
  refuses the same subject for that **unit** (any resident of it) with
  `409 REGISTRATION_BLOCKED`: same normalized plate for a vehicle
  (`plate_norm`), same name for a person (`label_norm` = lower-cased,
  whitespace-collapsed). Blocking also switches off any other live
  registration of the same subject in the unit. It also applies when the
  resident had already removed the registration. Re-deactivating is a no-op.
- **Clearing a block** is admin-only and needs a reason:
  `POST /api/auto-approval-rules/:id/clear-block` `{ reason }` (3–500 chars)
  sets `block_cleared_at` / `block_cleared_by_guard_id` /
  `block_clear_reason` and writes `resident_registration_block_cleared`.
  `409 REGISTRATION_NOT_BLOCKED` if there is no standing block; `404` if the
  rule has no resident registration. Clearing does not turn the old rule
  back on; the resident registers again. The block reason stays on the row
  only; audit payloads carry `reasonProvided`, not the free text.

### 3.5 Audit

New `audit_events.event_type` values (enum migration like 0006/0010):
`unit_created`, `unit_deactivated`, `unit_claim_code_issued`, `resident_claimed`,
`resident_deactivated`, `resident_registration_created`,
`resident_registration_removed`, and (0015) `resident_registration_renewed`. Existing `qr_invitation_issued` gains
`actor: { kind: 'resident', residentId, unitId }` in payload. No raw codes,
tokens or phone numbers in payloads (phone appears only as last-4).

---

## 4. Client

Route: `Index.tsx` currently sends unauthenticated `state.role === "resident"` to
`ResidentMagicLinkInfo`. That becomes `ResidentLogin` (phone → OTP). A signed-in
Supabase user with no guard profile *and* a resident row → `ResidentPortal`; with
neither → `ClaimUnitScreen`; guard/admin routing untouched.

`AuthContext` gains a parallel resolution: after `getSession()`, call
`GET /api/resident/me` only if `/api/auth/me` returned `no-guard-profile`
(one extra request, only for non-staff). No caching of resident identity —
residents are online-only; the offline cache stays guard-console-only per PR #27.

`ResidentPortal`: header (name · unit · sign out), three cards in the agreed
priority order, each a single form. Public footer from PR #35. Nothing else.

**As built in R2:** the portal renders capability 1 (`SendPassCard`) only; the
household and vehicle cards arrive with R3 rather than as placeholders. The
resident lookup runs only when the Supabase session carries a phone (an email
staff account without a guard row still gets `no-guard-profile`). Statuses:
`resident` → portal, `resident-unclaimed` → `ClaimUnitScreen`,
`resident-inactive` → access-ended notice, transport failure → signed out
(fail closed, no cache).

---

## 5. Project structure

```
drizzle/0014_units_residents.sql                new tables + attribution columns + enum values
src/db/schema.ts                                units, residents, unitClaimCodes, unitRegistrations
src/server/middleware/auth.ts                   requireResidentAuth
src/server/routes/resident.ts, admin-units.ts
src/server/services/resident-service.ts         claim, me, deactivate
src/server/services/unit-service.ts
src/server/services/unit-registration-service.ts   cap 2/3 → profiles + rules
src/server/validation/resident-schemas.ts
src/features/resident/{ResidentLogin,ClaimUnitScreen,ResidentPortal,SendPassCard,HouseholdCard,VehiclesCard}.tsx
src/features/resident/__tests__/
src/server/__tests__/resident-*.test.ts, src/server/__tests__/integration/resident-flows.integration.test.ts
src/docs/ops/*                                  runbook/SOP additions (unit + claim code + resident deactivation)
```

## 6. Commands

```
npx eslint .                                              0 errors
npx tsc --noEmit
npx vitest run                                            frontend
SUPABASE_URL= npx vitest run --config vitest.server.config.ts
npx vitest run --config vitest.integration.config.ts      real Postgres (docker gp-pg :54329)
NODE_ENV=production npx vite build
```

## 7. Testing strategy

- **Scope tests are the point of this feature.** For every resident route: a
  resident of unit A with a body containing `unit: "B"` / `host: "…"` gets the
  server-derived values, never the supplied ones (assert on the inserted row).
  Resident A cannot list, delete or issue against anything owned by unit B
  (404, not 403 — no existence oracle).
- Claim code: wrong code ×5 voids it; used code is refused; expired refused;
  the resident row and code consumption are atomic (failure-injection, same
  harness as `override-audit-atomicity.test.ts`).
- Guard token on resident routes → 403; resident token on guard routes →
  `no-guard-profile`; resident token on `/api/audit`, `/api/admin/*` → 403.
- Capability 1 end-to-end on real Postgres: resident issues → preview public →
  `validateQrToken` consumes with `unit = unit label` → second scan refused.
- Capability 2/3 end-to-end: registration → `evaluate()` matches a walk-in with
  that name/unit (and plate when required); delete → no longer matches.
- Unit deactivation cascades: resident 403, rules stop firing, outstanding passes
  for the label are **not** revoked automatically (state this; see open question 4).
- Boundary tests extended: resident portal leaks no other unit's data, no raw
  codes, no trace IDs.

## 8. Boundaries

- **Always:** derive `unit`/`host` server-side; hash codes/tokens before storage;
  route resident writes through existing service functions; fail closed on any
  resolution failure; run all §6 gates before each PR.
- **Ask first:** the schema changes in §2.5 to existing tables; adding the
  Supabase SMS provider dependency; any change to `qr-service`,
  `auto-approval-service.evaluate`, or guard-side middleware.
- **Never:** accept `unit` or role from the client; put residents in `guards`;
  let residents set `watch_flag`/`notes`; restore resident identity from cache;
  log phone numbers or raw codes; commit provider credentials.

## 9. Delivery plan (one PR each, in this order, each gated on your merge)

1. **PR R1 — schema + units/residents/claim codes + admin routes + `requireResidentAuth`.** No UI. Tests for claim/scope/attribution. *(Foundation; nothing else compiles without it.)*
2. **PR R2 — capability 1: resident pass issuing, server + portal shell + login/claim/send-pass UI.** Integration test through gate scan. First resident-visible value.
3. **PR R3 — capabilities 2 + 3: `unit_registrations` → profiles/rules, household + vehicles cards.**
4. **PR R4 — ops docs, SOP additions, readiness report update, onboarding copy (`ResidentMagicLinkInfo` retired).**

Supabase phone provider configuration is an operator step before R2 can be
tested live; R1 and R2 server tests run in legacy mode without it.

## 11. Decisions (owner answers to §10 — binding)

| # | Question | Decision |
|---|---|---|
| 1 | SMS OTP provider | **Twilio Verify.** Owner confirms the account and +254 delivery before R2 live testing. Does not block R1/R2 server work (legacy mode). |
| 2 | Unit linkage | **Admin-issued one-time claim codes** (§2.3), not admin-entered phone numbers. |
| 3 | Resident pass caps | **48 h TTL cap, 10 open passes per unit** as starting defaults — constants, tunable later. |
| 4 | Unit deactivation vs issued passes | **Auto-expire** outstanding passes for that unit label on deactivation (fail-closed). Implemented in R1 `deactivateUnit`. |
| 5 | Household rule TTL | **90 days with renew prompt.** Household members are not permanent pre-approvals. |
| 6 | Who issues claim codes | **Admin only** (account-provisioning level). May extend to senior-guard later on a real operational need. |
| R3-a | Resident removal of a registration | **`visitor_profiles.deleted_by_resident_id`**, same shape as `created_by_*`; CHECK requires exactly one remover. |
| R3-b | Expiry audit for resident-created rules | **Attributed to the resident** (no creating guard exists). |
| R3-c | Vehicle matching | **Resident-vehicle rules match on plate within the unit**, name/host ignored; staff rules and household rules keep the exact triple unchanged. Household copy states the exact-name limitation. |
| §2.5 | Attribution columns | **Approved:** nullable `created_by_resident_id` on `visitor_profiles` and `auto_approval_rules`, `created_by_guard_id` relaxed to nullable, `CHECK (num_nonnulls(...) = 1)`; `authorization_decisions.issued_by_resident_id` added; `audit_events` gains `resident_id` with an exactly-one-actor CHECK. Migration `0014_units_residents.sql`. |

## 10. Open questions (resolved — see §11; kept for the record)

1. **SMS OTP provider for Supabase** — Twilio Verify is the least-friction option
   Supabase supports; do you have/want an account, and who owns the credential?
   (Kenyan numbers: confirm the provider can deliver to +254.)
2. **Claim-code linkage (§2.3) vs admin-entered phone** — confirm claim code.
3. **Resident pass TTL cap 48h and 10 open passes/unit** — right numbers?
4. **Unit deactivation and already-issued passes** — auto-expire outstanding
   passes for that label (safer, my recommendation) or leave them valid?
5. **Household rule TTL 90 days with renew prompt** — acceptable, or do you want
   residents' household members to be indefinite (engine change)?
6. **Should a senior-guard be allowed to issue claim codes**, or admin only?
   I propose admin only.
