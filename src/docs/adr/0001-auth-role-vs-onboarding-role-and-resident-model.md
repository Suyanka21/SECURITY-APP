# ADR 0001 — auth-role vs onboarding-role, and the resident interface model

- Status: Accepted
- Date: 2026-05-13
- Related: `src/docs/specs/auth-and-role-routing.md` (Phase 1 spec)
- Deciders: brayo (product), Devin (implementation)

## Context

GatePass gained real authentication (Supabase Auth) and role-based
post-onboarding routing. Two design decisions made during that work are
load-bearing and easy for a future edit to silently undo. This ADR records them
so the reasoning survives.

## Decision 1 — Two separate "role" concepts; never merge them

There are two independent notions of role. They must remain **structurally
separate flags**, owned by different modules, with different trust levels.

| | onboarding-role | auth-role |
|---|---|---|
| Storage | `localStorage["gatepass_role"]` | App DB `guards.role`, exposed via `GET /api/auth/me` |
| Type | `StakeholderRole = "guard" \| "resident" \| "admin"` | `GuardRole = "guard" \| "senior-guard" \| "admin"` |
| Trust | Untrusted, client-editable, cosmetic | Trusted, DB-verified |
| Controls | Which onboarding tutorial plays | What UI renders + which API calls are allowed |

### Why

- **Security.** Authorization must key off a source the client cannot forge.
  `requireRole` already reads `guards.role` from the DB; the frontend's
  interface selection must use that same DB-sourced value (via `/api/auth/me`),
  never localStorage and never Supabase user metadata / JWT custom claims
  (both are editable and therefore untrustworthy for access decisions).
- **They genuinely differ.** The onboarding set has `resident` (no DB role); the
  auth set has `senior-guard` (no dedicated tutorial). A single merged flag
  cannot represent both correctly.

### Consequences

- After login, routing uses auth-role **only**. onboarding-role never selects
  the rendered interface.
- If a resolved auth-role has no interface built, the app shows an explicit
  "not available" state and **never falls back to the guard console**.
- A regression that reads `localStorage` role (or a Supabase claim) to decide
  rendering/authorization violates this ADR.

## Decision 2 — Residents use the one-off magic-link model, NOT a persistent console

### Decision

Residents do **not** get a persistent, authenticated portal. Their model is the
existing one-off tokenized magic-link (`/approve/:id`) plus, where useful, a
token-scoped visitor-invitation preview (`/pass/:token`). The role-selection
screen may still offer a "Resident / Host" onboarding tutorial (cosmetic), but
after onboarding a resident sees an explicit "residents don't sign in here"
informational state — not a console.

### Why

- **No resident account exists in the backend.** `guards` is the only identity
  table `requireRole` reads; there is no resident auth row and no `resident`
  value in `GuardRole`. Residents cannot hold a token that grants standing,
  cross-visitor access.
- **Residents already act through one-off tokens.** `POST /api/approvals/:id/decide`
  deliberately runs without `requireAuth` — the 256-bit token in the request IS
  the authorization, scoped to a single approval (see `resident-approval-flow.md`
  §7). This matches how residents really interact: a link per visitor.
- **A resident console would imply access the backend does not grant.** A
  "my visitors / my history" dashboard needs a durable authenticated resident
  session and an endpoint returning a resident's records. Neither exists, and
  building them is out of scope. Rendering such a console would either 401 on
  every call or require client-trusted identity — both unacceptable.

### Alternatives considered

- **Persistent resident portal backed by a new `residents` auth role.** Rejected:
  expands backend authorization surface we were told not to touch, and creates a
  standing-access model the product does not need.
- **Let residents fall through to the guard console.** Rejected: leaks the guard
  workflow to residents and is exactly the bug this work fixes.

### Consequences

- Supabase login issues sessions for guard / senior-guard / admin only.
- If Supabase magic-link/OTP is later used for residents, it only ever authorizes
  the same one-off, token-scoped actions — never a standing `guards` role, never a
  console.
- Removing the resident "not available" state and pointing the resident route at
  `GatePassApp` (or a fabricated resident dashboard) violates this ADR.

## Decision 3 — Accounts are admin-provisioned (A1); no public signup; role is server-controlled

- Status: Accepted (Stage 1, 2026-05-13). Confirmed by product ("A1 + B1, confirmed").
- Related: `src/server/routes/accounts.ts`, `src/server/services/account-service.ts`,
  `scripts/bootstrap-first-admin.mjs`, `src/docs/deploy/first-admin-bootstrap.md`.

### Decision

Guard / senior-guard / admin accounts are created **only** by an authenticated
admin through `POST /api/admin/accounts` (gated `requireAuth` → strict limiter →
`requireRole("admin")`). The **role is chosen by the server**, validated against
the closed set `{guard, senior-guard, admin}`, and persisted in `guards.role`.

- There is **no public signup route** — not a live one, not a dormant one, not a
  hidden UI. The onboarding role-picker remains cosmetic (see Decision 1) and
  grants no access.
- End users never select their own authorization role. A client may only *request*
  one of the allowed values; the server re-validates it and is the sole authority.
- The **first admin** is created by a one-time, manually-invoked bootstrap
  (`npm run bootstrap:admin`), because under A1 no admin exists yet to create one.
  The bootstrap is **idempotent**: if any `guards.role='admin'` row already exists,
  it refuses and no-ops — it can never mint a second "first" admin.

### Why

- **Least privilege / no client-controlled escalation.** Options A2 (self-signup +
  pending approval) and A3 (user-picked role) were rejected: A3 is client-controlled
  privilege escalation outright; A2 still creates an unauthenticated write surface
  and a dormant "pending" account model the product does not need.
- **Single source of truth.** Keeping role assignment server-side preserves the
  Decision 1 invariant (authorization keys off `guards.role`, never client input).
- **Secrets stay server-side.** Account creation needs Supabase **Admin Auth**
  (service-role key). That key lives only in the server / bootstrap process; it is
  never `VITE_`-prefixed, never returned by an API, never logged, never sent to the
  browser.

### One-time credential handling

`POST /api/admin/accounts` accepts an optional admin-chosen password. If omitted,
the server generates a strong password and returns it **once** in the response for
the admin to relay out-of-band; it is never persisted in plaintext and never
logged. This is the explicitly-adopted one-time credential design (an emailed
invite/OTP flow is a possible future refinement, out of Stage 1 scope).

### Consequences

- Provisioning is a privileged, audited action: every success writes an
  `account_provisioned` audit event (created guard id, badge, role, email — **no**
  password/token/secret in the payload).
- Cross-system creation (Supabase Auth user + `guards` row) uses a compensating
  delete: if the DB insert fails after the Auth user is created, the Auth user is
  deleted so no orphaned auth identity is left behind.
- A future change that adds a self-signup endpoint, lets the client pick its own
  persisted role, or ships the service-role key to the browser violates this ADR.

## Decision 4 — Residents remain magic-link-only (B1); persistent portal (B2) deferred, not rejected

- Status: Accepted (Stage 1, 2026-05-13). Confirmed by product ("A1 + B1, confirmed").

### Decision

B1 is adopted: residents keep the one-off magic-link model from Decision 2. The
resident onboarding/help copy has been corrected so it **only** describes what that
flow actually does — approve or deny a specific visitor from a per-arrival link.

- Resident-managed **auto-approval rules** and resident-issued **QR passes** are
  **not** part of the resident model. Those remain admin/senior-guard actions; copy
  now says residents *ask an administrator* for them rather than self-serving.
- **B2** (a full authenticated resident portal with self-service rules/passes and a
  "my visitors" dashboard) is **explicitly deferred, not rejected**. It would
  reverse Decision 2 and needs its own specification cycle (new `residents` identity
  linkage, resident-scoped endpoints, and a security review) before any build.

### Why

- The prior copy over-promised features the backend cannot deliver for residents
  (no resident identity row, no resident-scoped endpoints). Truthful copy avoids
  implying access that would 401 or require client-trusted identity.

### Consequences

- No resident-facing account, dashboard, or self-service rule/pass management ships
  in v1. Reintroducing those promises in copy without the backing endpoints — or
  building B2 without its own ADR/spec — violates this ADR.
