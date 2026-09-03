# Auth & Role-Based Post-Onboarding Routing — Spec

Status: DRAFT (Phase 1 deliverable)
Author: Devin
Related skills: spec-driven-development, planning-and-task-breakdown,
api-and-interface-design, security-and-hardening, trustless-system-auditor

---

## 1. Context & Problem

GatePass's backend hardening is real and audited: JWT auth (`requireAuth`),
DB-verified role checks on every protected route (`requireRole`), transactional
writes. **None of that is re-touched by this work.**

Two gaps block real-world use:

1. **No login exists.** The client's bearer token comes only from a dev
   convenience env var (`VITE_DEV_JWT`) or a value someone manually drops in
   `sessionStorage["gatepass.jwt"]` (`src/lib/api/auth.ts`). There is no way
   for a real user to authenticate.

2. **Every role lands on the guard console.** `src/pages/Index.tsx` is
   literally `const Index = () => <GatePassApp />`. The role-selection screen
   (`RoleSelection.tsx` / `OnboardingGate.tsx`) is cosmetic — it only decides
   which onboarding tutorial plays. After onboarding, a resident or an admin
   still sees the guard console.

This spec defines **three separate post-onboarding interfaces**, one per role,
and the routing that selects between them. Phase 2 implements it.

---

## 2. The Two Role Namespaces (do NOT merge them)

There are two independent notions of "role" in this system. They must stay
structurally separate. A future edit that collapses them into one flag
reintroduces exactly the bug this work fixes (and a security hole).

| | **onboarding-role** | **auth-role** |
|---|---|---|
| Source | `localStorage["gatepass_role"]` | App DB tables (`guards.role`) via server |
| Type | `StakeholderRole = "guard" \| "resident" \| "admin"` | `GuardRole = "guard" \| "senior-guard" \| "admin"` |
| Trust | **Untrusted** — client-editable, cosmetic | **Trusted** — DB-verified, same source `requireRole` reads |
| Decides | Which tutorial content plays | What is rendered + which API calls are allowed |
| Set by | `RoleSelection.tsx` button click | Login → server-verified session |
| Owner | `src/features/onboarding/useOnboarding.ts` | `src/lib/auth/*` (new, Phase 2) |

**Namespace mismatch note (important):** the onboarding `StakeholderRole` and
the backend `GuardRole` are *not* the same set:

- Onboarding has `resident`; the backend has **no `resident` role** (residents
  have no standing account — see §5).
- The backend has `senior-guard`; onboarding has no such tutorial (a
  senior-guard is onboarded as a guard).

The routing layer (§4) maps the trusted auth-role to an interface. The cosmetic
onboarding-role never participates in that decision.

---

## 3. Interface 1 — Guard (unchanged)

- **auth-role that renders it:** `guard` and `senior-guard`.
- **Component:** existing `src/features/gatepass/GatePassApp.tsx`. **No change.**
- **Rationale:** the guard console is the audited, working F1–F8 surface. A
  senior-guard is a guard with extra read permissions (visitor-profile reads,
  shift/on-premise/delivery lists) — those extra reads are enforced server-side
  by `requireRole`, not by giving them a different console. Keeping one console
  for both avoids duplicating the entire guard workflow.

---

## 4. Interface 2 — Admin dashboard (new)

- **auth-role that renders it:** `admin`.
- **Component:** new `src/features/admin/AdminDashboard.tsx` (Phase 2).
- **Scope:** a read-oriented operations dashboard over endpoints that **already
  exist and are already role-gated to admin/senior-guard** in `app.ts`. This
  work does not add or change any backend authorization.

| Panel | Endpoint | Existing `requireRole` allowlist (app.ts) |
|---|---|---|
| Shift log | `GET /api/admin/shifts` | `admin`, `senior-guard` |
| Currently on-premise | `GET /api/entries/on-premise` | `admin`, `senior-guard` |
| Deliveries | `GET /api/entries/deliveries` | `admin`, `senior-guard` |
| Auto-approval rules | `GET /api/auto-approval-rules` | `admin`, `senior-guard` |
| (rule create/deactivate) | `POST /api/auto-approval-rules`, `.../:id/deactivate` | `admin` only |

**Allowlist discipline (Phase 4 verifies this):** the admin dashboard must call
**only** the endpoints above. It must not assume access to any endpoint the UI
"feels like" it should have. Every call is checked against the real
`requireRole` allowlist in `app.ts`, not against UI assumptions. Because the
dashboard renders for `admin`, and all four read endpoints allow `admin`, every
call is permitted; the rule create/deactivate actions (admin-only) are also
permitted for `admin`. A `senior-guard` never reaches this dashboard (they get
the guard console), so no allowlist conflict arises there.

---

## 5. Interface 3 — Resident (DECISION: magic-link model, NOT a persistent console)

### 5.1 Decision

**Residents do NOT get a persistent, authenticated portal.** The resident model
is the **existing one-off tokenized magic-link** (`/approve/:id`) plus, where
useful, a token-scoped visitor-invitation view — nothing that implies standing
access.

### 5.2 Why (grounded in the backend, not aspiration)

The Trustless rule here is: *the UI must not imply access the backend does not
grant.* Three facts from the code force this decision:

1. **No resident account exists.** The `guards` table is the only identity
   table `requireRole` reads. There is no `residents` auth row and no
   `resident` value in `GuardRole`. A resident cannot hold a bearer token that
   any protected endpoint would accept for standing, cross-visitor access.

2. **Residents already act through one-off tokens.** The approval flow
   (`resident-approval-flow.md` §7) is built around a 256-bit token that IS the
   auth for exactly one decision: `POST /api/approvals/:id/decide` deliberately
   runs **without** `requireAuth` because the token in the body is the
   authorization, scoped to that single approval. This matches how residents
   really interact: they get a link (SMS/WhatsApp), approve/deny one visitor,
   done.

3. **Building a "resident console" would be a lie.** A persistent dashboard
   listing "my visitors / my history" implies a durable, authenticated resident
   session and an endpoint that returns a resident's records. No such
   authenticated endpoint exists, and adding one is explicitly **out of scope**
   (it would be new backend authorization surface, which we were told not to
   build). Rendering such a console would either 401 on every call or require
   fabricating client-trusted identity — both forbidden.

### 5.3 What a resident actually sees

- **Their real entry point stays the magic link:** `/approve/:id` (approve/deny
  a specific visitor) and `/pass/:token` (visitor-facing QR pass view). These
  are unchanged, public-by-token routes — no login, no standing session.
- **After onboarding, if a user's *onboarding-role* is `resident`** (cosmetic
  choice on the role-selection screen) they are **not** logged into a console.
  They see an explicit **"Residents don't sign in here"** informational state
  that:
  - explains residents receive an approval link on their phone for each visitor,
  - does **not** render the guard console (no silent fallback — see §6),
  - offers the tutorial replay + Help Center (already built),
  - optionally links to the approval page if they arrived via a link,
  - offers a **"Staff sign in"** exit that clears the stored onboarding-role and
    returns to the login. The onboarding-role is a tile tap, not a credential:
    it must never trap a staff member, and an already-authenticated staff
    session always routes by auth-role regardless of the stored value.
- Optional (Phase 2, only if trivially token-scoped): a **visitor-invitation
  preview** reachable by token, reusing the existing public
  `GET /api/visitor-invitations/:token/preview`. This is token-scoped, not a
  logged-in portal, so it does not violate the decision.

### 5.4 Consequence for login

The Supabase login built in Phase 2 issues sessions for **guard / senior-guard /
admin** (the DB-backed roles). Residents are **not** expected to log in to a
console. If Supabase magic-link/OTP is later used for residents (Phase 2
"consider"), it only ever authorizes the same one-off, token-scoped resident
actions — it never grants a standing role in `guards` and never renders a
console.

---

## 6. Routing model & the "not available" rule

```
                       ┌──────────────────────────────────────┐
  first launch ──▶ OnboardingGate (cosmetic onboarding-role) ──┤
                       └──────────────────────────────────────┘
                                        │ onboarding complete
                                        ▼
                              ┌───────────────────┐
                              │  logged in?        │── no ─▶ Login screen
                              └───────────────────┘          (guard/admin)
                                        │ yes
                                        ▼
                        auth-role from server (DB-verified, §7)
                                        │
              ┌─────────────────────────┼─────────────────────────┐
              ▼                         ▼                          ▼
        guard / senior-guard          admin                    (any role with
              │                         │                     no interface built)
              ▼                         ▼                          │
        <GatePassApp/>          <AdminDashboard/>                  ▼
        (unchanged)                (new)              explicit "not available"
                                                      state — NEVER GatePassApp
```

**Hard rules:**

- Routing keys off **auth-role only**. The onboarding-role never selects the
  interface.
- **No default fallback to the guard console.** If the resolved auth-role has no
  interface built (e.g. a role we haven't shipped a UI for), render an explicit
  "this interface is not available for your role yet" state. Never render
  `GatePassApp` as a catch-all. This is the single most important behavioral
  requirement of Phase 2 and is what the Phase 7 negative test verifies.
- The onboarding-role `resident` maps to the §5.3 informational state, not a
  console.

---

## 7. Source of truth for auth-role

- The client learns its auth-role from the **server**, which reads it from the
  `guards` table — the same source `requireRole` already trusts.
- Mechanism (Phase 2): a new **read-only** `GET /api/auth/me` route behind the
  existing `requireAuth`, returning `{ id, name, role }` from the DB row. This
  adds no new authorization surface and does not change `requireAuth`/
  `requireRole` structurally — it just exposes the already-trusted role to the
  client so the client can pick an interface.
- **Never** derive auth-role from:
  - Supabase user metadata or custom claims (client-editable → untrusted),
  - the JWT payload contents beyond identity (`sub`),
  - localStorage / onboarding-role.
- If `GET /api/auth/me` fails or returns no role → treat as unauthenticated
  (show login), never guess a role.

---

## 8. Phase 2 task breakdown (implementation slices)

Each slice leaves the app working and is committed separately.

1. **DB:** add nullable `supabase_user_id uuid` (unique) to `guards` (+ FK to
   Supabase `auth.users` where the migration runs against Supabase). Mirror in
   `schema.ts`. No backfill needed (nullable).
2. **Server verify:** verify the Supabase-issued JWT in `requireAuth` (Supabase
   JWT secret / JWKS) instead of the self-issued `JWT_SECRET`. Map token subject
   → `guards.supabase_user_id` → guard row. `requireRole` unchanged (still reads
   `guards.role`).
3. **Server `/api/auth/me`:** read-only, `requireAuth`, returns DB role.
4. **Client auth:** Supabase client login (email/password for guard/admin;
   magic-link/OTP optional for the resident token flow). Store the Supabase
   session; feed its access token to `getAuthToken()`.
5. **Client role resolution:** after login, call `/api/auth/me`; hold auth-role
   in an auth context, separate from `useOnboarding`.
6. **Routing:** replace `Index.tsx`'s unconditional `GatePassApp` with an
   auth-role switch (guard/senior-guard → GatePassApp, admin → AdminDashboard,
   else → not-available; resident onboarding-role → §5.3 state).
7. **AdminDashboard:** the four read panels of §4.
8. **Negative-path + tests:** resident/guard token hitting an admin route shows
   403; unit/RTL tests for the router and the not-available state.

---

## 9. Acceptance criteria

- [ ] Guard / senior-guard logging in see `GatePassApp`, unchanged.
- [ ] Admin logging in sees `AdminDashboard`; its calls all resolve against the
      real `requireRole` allowlists (no forbidden calls).
- [ ] Resident onboarding-role never renders a console; shows §5.3 state.
- [ ] No role ever silently falls back to the guard console.
- [ ] auth-role is always server/DB-sourced; nothing reads Supabase metadata for
      authorization.
- [ ] onboarding-role (localStorage) and auth-role remain separate flags.
- [ ] A resident/guard token hitting an admin-only route gets 403 on screen
      (Phase 7 negative test).
