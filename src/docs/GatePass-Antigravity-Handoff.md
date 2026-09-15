# GatePass — Handoff to Google Antigravity

Read this whole file before doing anything. It replaces the missing conversation history —
Devin has been working this project for weeks and knows all of this already; you don't, so
everything you need is written out below rather than assumed.

## 0. One correction before you start

I checked: Gemini 3.8 Flash is not a downgrade. It's Google's current release, benchmarked
above 3.7 Flash on agentic and multi-step reasoning tasks. So the caution in this document
isn't "the model is weak" — it's that **you (Antigravity + this repo) have zero track record
together**, unlike Devin, which has been through 28+ merged PRs on this exact codebase and has
its own accumulated project-specific skill file. Treat every instruction below as fully
explicit on purpose — not because you need hand-holding, but because there's no shared history
to lean on yet.

## 1. Skills — read these before touching code

This repo has its skill files committed at:
- `.agent/skills/` — general skills (note: a few filenames have typos, e.g.
  `Trusltess-system-auditor.SKILL.md`, `performance-optimization. SKIIL.md` — match by name
  similarity, not exact string).
- `.agents/skills/testing-gatepass/SKILL.md` — project-specific: how to boot the app, required
  env vars, and known gotchas from prior sessions (including a note already added about the
  resident-role onboarding trap and the lock-aware refusal screen).

**Global Reasoning Layer + CodeRabbit DNA apply on every task, always, without being invoked** —
read `.agent/skills/GLOBAL REASONING LAYER SKILL.md` first, in full, before starting Task 1.
Task-specific skill names are called out per task below; use the matching file in `.agent/skills/`.

**Read `.agents/skills/testing-gatepass/SKILL.md` before running or testing anything** — it has
required env vars (`PIN_PEPPER` etc.) and startup steps that will otherwise waste your first
session rediscovering them.

## 2. What's actually true right now (verified directly against `main`, not assumed)

Merged and working, do not re-touch:
- Stages 1–6 (admin-provisioned accounts, Supabase auth, guard notes, vehicle verification,
  PIN backup with rate-limiting, watchlist with warn-never-block, and the Stage 6 closeout
  fixes — password-on-audit-failure, locked-pass truth-telling, guard approval-outcome display).
- PR A (`#26`) — guard console now shows real signed-in identity + working sign-out; audit
  panel shows the real guard, not `guard-west-04`.
- PR `#27` — mid-shift network-drop no longer force-logs-out an already-authenticated guard
  (transport failures ≠ auth failures); guard-console-only identity caching added, scoped
  deliberately narrow (never caches admin/no-guard-profile from disk).
- PR `#28` — the offline `pendingSync` queue is now persisted (was pure React state before,
  meaning any unmount silently destroyed unsynced entries — that's fixed).

**Open and currently blocked: PR B (`#29`)** — a real bug was found in Devin's own review,
confirmed by direct inspection (see Task 1 below). Fix this first.

**Not started at all: PR C, PR D, PR E.** No branches exist for these yet.

**Two large follow-up passes exist in a separate doc** (technical pre-ship hardening, then
operations/privacy/legal scaffolding) — those come **after** C, D, E land, not now. They're
included below as Tasks 6 and 7 with corrections applied from direct verification.

**Reserved for Devin, not you:** the final live-recording trustless-audit pass, using Devin's
remaining trial time. Your job is entirely code + tests + written verification. Do not attempt
video recordings — report raw command output instead (test counts, lint output, build output).
That's the agreed cadence for this whole remaining stretch, to conserve credits.

---

## TASK 1 — Fix PR B (`#29`): the resident-role trap fix has a real bug

**Skill: debugging-and-error-recovery.**

### What's actually wrong (verified, not just relayed from the review comment)

`useOnboarding()` in `src/features/onboarding/useOnboarding.ts` is a bare React hook — it holds
its state in a local `useState`, only synced one-directionally to `localStorage` on writes. It
is called independently in **exactly two places** (confirmed by repo-wide search — do not
assume there might be more without re-checking):
- `src/features/onboarding/OnboardingGate.tsx` (line ~38)
- `src/pages/Index.tsx` (line ~38)

These are **two separate instances with two separate copies of state.** `OnboardingGate` is the
actual gatekeeper — it decides whether `Index` (or the role picker, or the walkthrough) renders
at all, based on **its own** copy of `state.role`/`state.completed`. When `Index` calls
`resetOnboarding()` (wired to the "Staff sign in" button on the resident info screen), it
clears `localStorage` and updates **only its own local copy** of state — `OnboardingGate`'s
separate in-memory copy is never told about the change. `OnboardingGate` only re-reads
`localStorage` on mount, so its stale copy can persist for the rest of the session, and on any
future remount it may re-derive a phase decision from data that no longer matches reality —
this is exactly what the review comment means by "hide staff consoles or restore the resident
tutorial after Staff sign-in."

### Root cause, precisely

Two independent hook instances holding a duplicate copy of state that should be single-sourced.
This is a textbook case for lifting state into a shared source of truth.

### Fix — do this, not a smaller patch

Convert `useOnboarding` from a bare hook into a **React Context Provider**, with exactly **one**
live instance of the underlying state for the whole app:

1. Create an `OnboardingContext` + `OnboardingProvider` (wrap the existing hook logic inside
   the provider — the internal `readStorage`/`writeStorage`/`selectRole`/`resetOnboarding`/etc.
   logic doesn't need to change, only how it's exposed).
2. Wrap the app root with `OnboardingProvider` once (check `src/App.tsx` for where this needs
   to sit — it must wrap both `OnboardingGate` and everything `OnboardingGate` renders as
   children, including `Index`).
3. Change `useOnboarding` to `useContext(OnboardingContext)` in both current call sites
   (`OnboardingGate.tsx`, `Index.tsx`) — do not leave either one calling a standalone hook.
4. Re-run the repo-wide search for `useOnboarding()` after your change to confirm there are
   still exactly the two call sites you expect, both now consuming the same context instance.

### Verification (text only, no video)
- Write a test that reproduces the actual bug: render both `OnboardingGate` and `Index` sharing
  one provider, select "Resident", complete onboarding, call the staff-sign-in reset from
  `Index`, then assert `OnboardingGate`'s own rendering reflects the reset (e.g. it no longer
  thinks onboarding is complete for a resident role that no longer exists) — this test should
  FAIL against the old two-hook-instance code and PASS after the fix.
- Run the full suite (`npm test` equivalents for both frontend and server configs) and paste
  the raw pass/fail counts.
- Run `tsc --noEmit` and the linter, paste raw output.
- Update `.agents/skills/testing-gatepass/SKILL.md` with a short note on this fix, matching the
  existing entries for the lock-aware refusal screen and the original trap — this file has a
  documented pattern of recording exactly this kind of gotcha.

Report back with the diff summary and raw verification output. Do not proceed to Task 2 until
this is confirmed working.

---

## TASK 2 — PR C: role-gate the guard console's admin tab

**Skill: security-and-hardening** (even though the backend is already correct — this is about
not offering a UI destination a role can't use).

The guard console (`src/features/gatepass/GatePassApp.tsx`) shows an `admin` tab to every role,
including plain guards. As guard, this tab renders panels backed by admin/senior-guard-only
endpoints (`/api/admin/shifts`, `/api/entries/on-premise`, `/api/entries/deliveries`,
`POST /api/visitor-invitations`) and shows the guard raw authorization failures.

Fix: hide the tab entirely for `guard` role, or show an explicit "not available for your role"
state — match whatever pattern is already used elsewhere in this codebase for unhandled/
unauthorized states (check `src/features/auth/NotAvailable.tsx` for the existing pattern before
inventing a new one).

Verification (text only): raw test/lint/build output, plus confirm by reading the rendered
component tree in a test that a `guard`-role session never receives the admin tab's routes/data
fetch calls at all (not just that the tab is visually hidden — confirm the underlying fetches
don't even fire for a guard session).

---

## TASK 3 — PR D: human-readable refusals on public-facing surfaces

**Skill: frontend-ui-engineering**, paired with **api-and-interface-design** for how you map
codes to messages.

Priority order — fix these two files first, they're seen by non-technical people outside your
organization, before touching any internal guard/admin panel:
1. `src/pages/ResidentApproval.tsx` — currently shows raw backend text like
   `AUTH_TOKEN_MISSING` / "Provide Bearer token in Authorization header" as the heading a
   resident sees when their link is broken. Replace with plain language. Keep a trace ID
   visible somewhere small for support purposes, but it should not be the headline.
2. `src/pages/VisitorPass.tsx` — currently prints a bare `INVITATION_NOT_FOUND` badge under
   otherwise friendly copy. Same treatment.

Internal guard/admin panels (`GatePassPanels.tsx`, `AdminDashboard.tsx`) can keep raw codes
visible for now — those are trained users, not the general public. Don't expand scope into
those files in this task.

Verification (text only): raw test/lint/build output, plus a short before/after text sample of
what each fixed screen now says for at least one real error case each.

---

## TASK 4 — PR E: remove or clearly label dev-only affordances

**Skill: security-and-hardening.**

- "Simulate offline / Simulate online" (`GatePassPanels.tsx`) — currently visible to every role
  on every tab, with nothing marking it as a simulation once toggled. Either remove it from the
  production build entirely, or add an unmissable visual marker distinguishing a simulated
  state from a real one — a guard must never be able to mistake a fake "offline" banner for a
  real connectivity loss.
- "Camera failed" manual trigger sitting in the normal QR scanning UI — same treatment, lower
  urgency.

Verification (text only): raw test/lint/build output, plus confirmation of which approach you
took (removed vs. labeled) and why.

---

## TASK 5 — do NOT start yet

Tasks 6 and 7 below depend on Tasks 1–4 being merged first. Stop and report back once Task 4 is
done, verified, and merged — wait for confirmation before starting Task 6.

---

## TASK 6 — Technical pre-ship hardening pass

**Skills: trustless-system-auditor, security-and-hardening, code-review-and-quality,
test-driven-development, shipping-and-launch, incremental-implementation.**

Do not add new product features. Goal: verify whether GatePass is safe enough for a controlled
pilot with a real security company. Focus only on launch-blocking correctness, security, audit
truth, and real-world guard/resident/visitor behavior.

### 6.1 — Confirm Tasks 1–4 (PRs B–E) are truly complete on `main`
Verify these live in code and tests, not just in a PR description:
- The onboarding state bug from Task 1 is fixed at the root (single Context instance), not
  patched around.
- Guard role cannot reach or see the admin tab/surfaces.
- `ResidentApproval.tsx` and `VisitorPass.tsx` show human-readable refusals as the primary
  visible message.
- Dev-only controls are removed from production or clearly gated as dev-only.

### 6.2 — Fix the override audit-ordering bug (verified real, root cause confirmed directly)
**This is confirmed, not a claim to re-investigate — go straight to the fix.**

The bug: `createOverrideEvent()` in `src/server/services/override-service.ts` calls
`emitAuditEvent("override_authorized", ...)` (line ~158) **before returning** to its caller.
`emitAuditEvent` → `persistAuditEvent` in `src/server/services/audit-logger.ts` writes via a
**separate, independent `auditDB` connection** — not the `tx` transaction object that wraps the
entry+override insert in the caller. Confirmed in `src/server/services/entry-service.ts`
(~line 159–175): the whole entry+override write is wrapped in `db.transaction(async (tx) => {...})`,
but `createOverrideEvent` (called inside that block) commits its audit row through the
*separate* `auditDB` connection immediately — outside `tx`, unsynchronized with it. If the
transaction later fails or rolls back (e.g. the override row insert fails after the audit event
already committed), the audit log now permanently claims `override_authorized` for an override
that never actually exists in `entry_records`/`override_events`.

**This is not a single-call-site bug** — `createOverrideEvent` is called from three places
(`entry-service.ts`, `delivery-service.ts`, `sync-service.ts`, confirmed by repo-wide search).
The root cause lives in the shared function, not any individual caller — **fix it once, in
`override-service.ts`/`audit-logger.ts`, not three times at each call site.**

Preferred approach:
- Separate override validation/row construction from audit emission inside
  `createOverrideEvent` — don't emit the audit event until the caller's transaction has
  actually committed.
- Simplest correct shape: have `createOverrideEvent` return the constructed override result
  *without* emitting the audit event, let the caller insert the override row inside its own
  `tx`, and only emit `override_authorized` after the surrounding transaction resolves
  successfully — in all three call sites, via a shared helper so the ordering can't drift
  between them again.
- Alternative if it fits the existing audit design better: make `persistAuditEvent` accept an
  optional transaction handle and pass the caller's `tx` through, so the audit row is actually
  part of the same atomic commit. Pick whichever approach is more consistent with how the rest
  of the audit system already works — state your reasoning either way.
- Add a failure-injection regression test proving that if the override row insert fails, no
  `override_authorized` audit event is left in the persisted audit log. This must be a real
  test that forces the failure, not a mock that assumes the ordering is already correct.

### 6.3 — Production config fail-fast checks
Check whether production startup fails loudly when required env vars are missing:
`DATABASE_URL`, `PIN_PEPPER`, Supabase URL/anon key, Supabase service-role key (for admin
provisioning). `JWT_SECRET` is legacy — Supabase auth is what's actually in use now, so do
**not** make production startup require `JWT_SECRET` unless some code path still genuinely
depends on it; confirm which, if any, before adding a requirement nobody needs. Also check
`ALLOWED_ORIGINS`/frontend origin config fails loudly if unset.

### 6.4 — Dependency security audit
Run `npm audit --omit=dev --json`. For every high-severity production finding: upgrade if
safe, move build-only packages from `dependencies` to `devDependencies` if they're not runtime
dependencies, or document why the advisory isn't reachable in production. Don't leave any
high-severity production finding unexplained.

### 6.5 — Full verification, raw output only
Report raw output for: `npm ci`, lint, both test suites (frontend + server configs), build,
`npm audit --omit=dev`. If a command has warnings, state plainly whether they're acceptable for
a pilot launch or need fixing before one.

### 6.6 — Real database integration check
Use the existing integration test setup (`vitest.integration.config.ts`) against a real
Postgres/Supabase-compatible database for: entry creation, override logging (specifically
re-testing 6.2's fix), offline sync replay, locked-pass refusal, audit persistence. Don't rely
only on mocked-DB tests for this final check.

### 6.7 — Final verification, text-only (not video)
Do **not** attempt a video recording — that's reserved for Devin's final pass. Instead, produce
a written walkthrough confirming each of the following is true, with the specific command,
test, or manual verification step that proves it (not narration):
- Guard sign-in with real identity + sign-out (already covered by PR A, re-confirm still true)
- Audit panel shows the real signed-in guard
- Resident wrong-tap recovers to staff login without clearing storage (Task 1's fix)
- Guard console's admin tab is hidden/gated (Task 2)
- Resident-approval and visitor-pass refusals are in plain English (Task 3)
- Dev-only controls are removed/gated (Task 4)
- Locked pass says "Locked," not "Valid"
- Offline walk-in entry queues, survives a reload, and syncs on reconnect
- On-premise populated state renders correctly with real data
- Admin/senior-guard can view admin surfaces; a regular guard cannot

### Deliverable for Task 6
A written trustless pre-ship report: PASS/FAIL verdict for a controlled pilot, exact commits/
PRs included, raw command outputs, CI status (link if available; otherwise confirm local
verification stands in for it), any remaining launch blockers, and any non-blocking issues that
can wait until after the pilot.

**Stop here and report back — do not proceed to Task 7 until this report is reviewed.**

---

## TASK 7 — Operations + privacy/legal launch preparation

**Skills: trustless-system-auditor, security-and-hardening, documentation-and-adrs,
shipping-and-launch, api-and-interface-design, code-review-and-quality.**

Only start this once Task 6 passes. Goal: prepare GatePass for a controlled pilot with a real
security company and estate — operational readiness, privacy expectations, data handling, admin
procedures, incident response, launch documentation.

**Do not invent legal guarantees. This is not legal advice.** Everything you write here is
scaffolding for a human — specifically a Kenyan lawyer or compliance professional — to review
before commercial rollout. Mark it as such, unmissably, everywhere it appears.

1. **Operations runbook** (plain English): who can create guard/admin accounts; who can
   deactivate a guard; password reset process; what to do if a guard leaves; what happens when
   internet is down; what happens when offline entries fail to sync; who can view audit logs;
   who can export/review visitor history; how a supervisor reviews suspicious overrides; what to
   do when a pass is locked; what to do when a resident denies or doesn't respond; shift
   handover procedure; what to do if a guard device is lost or stolen.

2. **Pilot launch checklist**: create admin account; add initial guards/senior guards; configure
   Supabase/Postgres; configure production env vars; configure allowed origins; confirm database
   backups; confirm audit log persistence; confirm offline queue behavior; confirm test
   resident/visitor flows; confirm support/escalation contact; confirm who signs off before
   go-live.

3. **Privacy and data-handling draft** (plain English, explicitly marked as a draft for
   review, not a final document): what visitor/resident/guard data is stored and why; who can
   access it; retention period; when data may be deleted; how visitor records and audit logs
   are protected; what should never be shown publicly; what happens if data is entered
   incorrectly; what happens if there's a suspected data breach.

4. **Visible privacy/support pages**: if the app doesn't already have them, add simple
   production-safe routes for Privacy Notice, Terms/Acceptable Use, Support/Contact, Incident
   Reporting. Mark legal/privacy content "draft pending legal review" wherever it appears — the
   same unmissable-placeholder standard already agreed for this project.

5. **Admin/supervisor SOPs**: creating a guard account; deactivating one; reviewing a shift log;
   reviewing override activity; reviewing on-premise visitors; handling a locked pass;
   responding to failed sync; responding to device loss; responding to suspicious access
   activity.

6. **Incident response guidance** for: a compromised guard account; a lost/stolen device; a
   wrongly-admitted visitor; offline entries failing to sync; audit logs appearing incomplete; a
   resident disputing an approval; a database/service outage.

7. **Verify audit/admin access boundaries in code and tests** (not just in docs): regular
   guards cannot view admin-only operational reports; senior guards/admins can; audit logs are
   never public; public visitor/resident pages never expose internal trace IDs, raw codes, or
   unnecessary personal data.

8. **Launch documentation index**: create or update a docs index linking to the GatePass
   definition, the Task 6 technical pre-ship report, the operations runbook, pilot launch
   checklist, privacy/data-handling draft, admin SOPs, incident response guide, and env/config
   checklist.

9. **Verification**: raw output for lint, both test suites, and build. Also report: files
   created/updated, any legal/privacy items requiring professional review, and any remaining
   operational blockers before pilot.

### Deliverable for Task 7
A concise pilot-readiness report: PASS/FAIL for operations readiness, PASS/FAIL for privacy/
legal scaffolding readiness, links to created docs/pages, and remaining items requiring human/
legal/business sign-off.

---

## After Task 7

Everything above is your scope. Once Task 7's report comes back PASS, stop — do not attempt a
final video walkthrough or declare the project shippable yourself. That final live-recording
trustless-audit pass is reserved for Devin, using its remaining trial time, against everything
you've built. Push all work to `main` (or leave clean, reviewed, mergeable PRs) and hand back.
