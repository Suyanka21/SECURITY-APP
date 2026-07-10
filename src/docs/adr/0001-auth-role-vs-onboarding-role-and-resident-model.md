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
