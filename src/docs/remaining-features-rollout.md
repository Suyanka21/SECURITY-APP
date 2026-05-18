# GatePass — Remaining Features Rollout Plan

This document tracks the rollout of the five features called out as
out-of-scope in `gatepass-api-contract.md §6`. The goal is a **fully
functional** GatePass app — meaning every path described in
`GATEPASS DEFINITION.md` is represented in the reducer, the backend,
and the UI, with audit-harness scenarios proving none of them can fail
silently.

> "Adding these requires new reducer actions first." — gatepass-api-contract.md §6

Each feature lands in its own PR. Each PR includes: a spec under
`src/docs/specs/`, reducer actions + tests, backend endpoints + tests,
frontend UI + tests, and at least one new scenario in `audit/main.tsx`.

---

## Order and Dependencies

```
1. Resident approval flow       ─┐
                                  │
2. Notifications (WA/SMS)       ──┤  delivery channel for #1
                                  │
3. Auto-approval engine         ──┤  rule-based bypass of #1
                                  │
4. Visitor profile CRUD         ──┤  PII model, dedup, soft delete
                                  │
5. Shift log aggregation        ──┘  read-model over everything above
```

The order is not arbitrary:

- **#1 first** — approval is the actual security primitive. Notifications
  (#2), auto-approval (#3), and the admin view (#5) only have meaning
  once approval works manually.
- **#2 second** — needs a real payload to deliver. Building it after
  #1 means we send something real, not a stub.
- **#3 third** — auto-approval is the bypass for the manual flow. It's
  irresponsible to build it before the manual flow exists to compare
  against.
- **#4 before #5** — the admin view (#5) is mostly read-mode over the
  visitor model; building CRUD first means the admin view doesn't need
  to scaffold its own data layer.
- **#5 last** — pure read aggregation. Lowest risk, lands cleanly once
  everything above is stable.

---

## Cross-cutting Rules (Apply to Every Feature)

1. **Reducer first, backend second, UI third.** The reducer's lifecycle
   contract is the source of truth. If the reducer can't represent the
   state, the backend can't be wired and the UI can't render it.
2. **Explicit lifecycle dispatch.** Every async outcome — success,
   failure, partial, timeout — gets its own action. No simulated success.
3. **No silent success.** Every backend response code maps to a visible
   banner and/or banner+field. The trustless audit harness gets a new
   scenario per feature.
4. **Tests come before the fix.** Failing reducer test → fix → green.
   Same for backend and controller.
5. **Audit harness scenario per feature.** `audit/main.tsx` gains at
   least one scenario per feature exercising the failure path
   (approval timeout, notification 5xx, auto-approve denial, etc.).
6. **One PR per feature.** Stacked on the previous PR if it isn't
   merged yet. Each PR keeps the same template as PR #1.

---

## Feature 1 — Resident Approval Flow

**Spec:** `src/docs/specs/resident-approval-flow.md`

**One-line:** Guard requests resident's approval for a walk-in; resident
approves via single-use magic link; entry is logged once approved (or
explicitly blocked on deny/timeout).

**New reducer actions:**
- `APPROVAL_REQUEST_STARTED` → `APPROVAL_REQUEST_SUCCEEDED` | `APPROVAL_REQUEST_FAILED`
- `APPROVAL_POLLED` (status update: pending | approved | denied | expired)
- `APPROVAL_DECISION_RESOLVED` (final transition: approved triggers entry log; denied/expired blocks)

**New endpoints:**
- `POST /api/approvals` — create approval request (guard auth)
- `GET /api/approvals/:id/status` — poll status (guard auth)
- `POST /api/approvals/:id/decide` — resident decision (no JWT; magic-link token auth)

**Audit scenarios:**
- Approval timeout (expires before resident decides) → entry never logged
- Resident denies → entry blocked with explicit code
- Resident approves but server fails on final entry write → entry rolled back

**Dependencies:** PR #1 (explicit lifecycle reducer, ApiResult client).

---

## Feature 2 — Notifications (WhatsApp / SMS)

**Spec:** `src/docs/specs/notifications.md` (to be written when #1 lands)

**One-line:** Deliver approval magic-links (and other resident alerts)
via WhatsApp Cloud API with SMS fallback.

**Key risks:**
- Third-party SDK churn — pin SDK versions, cite docs in the spec
- Webhook signature verification (never trust an inbound callback)
- PII in message bodies (templating, no free-form)
- Rate limit on outbound (provider + per-resident)

**Audit scenarios:**
- WA returns 5xx → SMS fallback fires
- Both channels 5xx → approval request marked `delivery_failed`, guard sees explicit error
- Webhook with bad signature → 401, no state change

**Dependencies:** Feature 1 (needs an approval payload to send).

---

## Feature 3 — Auto-approval Engine

**Spec:** `src/docs/specs/auto-approval.md`

**One-line:** Rule-based auto-approval for walk-ins that match
pre-configured criteria (e.g. host's pre-approved frequent visitors).
**Default-deny.** Every auto-decision writes a louder audit row than a
manual entry, never a quieter one.

**Key risks:**
- Becoming a silent-success surface (the whole point of this codebase
  is to prevent that — auto-approval has to scream when it fires)
- Rule complexity creep — resist a DSL, use 5 booleans
- Stale rules — every rule has a TTL

**Audit scenarios:**
- Rule matches → entry logged with `method: "auto"`, audit row tagged `auto_approved`
- Rule expired → falls through to manual approval, no silent bypass
- No rule matches → falls through, guard sees the manual approval UI

**Dependencies:** Feature 1 (needs the manual approval path as the fallback).

---

## Feature 4 — Visitor Profile CRUD

**Spec:** `src/docs/specs/visitor-crud.md`

**One-line:** Admin / privileged-guard surface to manage recognized
visitors (the static seed in `recognizedVisitors` becomes a real model).

**Key risks:**
- PII storage — minimize fields, encrypt at rest where possible
- Hard delete loses the audit trail — must be soft delete with retention
- Dedup / merge is its own state machine
- Optimistic UI hides backend failures — show pending state

**Audit scenarios:**
- Delete a visitor with attached entries → soft delete, entries still
  link, audit row records the delete
- Create with duplicate (name + unit + plate) → 409 with merge prompt
- Search with empty result → empty state, never "no visitors exist"

**Dependencies:** None hard; can be parallelized with Feature 3 if needed.

---

## Feature 5 — Shift Log Aggregation (Admin View)

**Spec:** `src/docs/specs/shift-log.md`

**One-line:** Read-only admin view over all entries, grouped by guard
and shift, with filters and export.

**Key risks:**
- Aggregation correctness — no double counting, no dropped rows
- Performance on large datasets — paginate, index, cache where safe
- Admin role separation — read-only admin must not be able to write
- Export reveals PII — same minimization rules as Feature 4

**Audit scenarios:**
- Filter that excludes failed entries → still visible somewhere (no
  silent hide)
- Pagination boundary (last page) → no off-by-one
- Export → row count matches filtered view exactly

**Dependencies:** Features 1–4 should be stable so the aggregation is
over a complete model.

---

## Pre-Ship Gate (Applies to Each Feature Before Production)

From `Shipping-and-Launch SKILL`:

- [ ] Feature flag wired (kill switch)
- [ ] Monitoring/log query saved for the new endpoints
- [ ] Rollback plan documented (revert the migration? toggle the flag?)
- [ ] Trustless audit harness re-run end-to-end (`audit/?scenario=...`)
- [ ] CodeRabbit / human review passed
- [ ] Lint + frontend tests + server tests green

## Final Audit (After All Five Features Land)

A full re-run of the trustless audit harness covering at minimum:

| Scenario | Expected |
|---|---|
| `approval-timeout` | Entry never logged, guard sees "request expired", audit row records timeout |
| `approval-denied` | Entry blocked, banner shows resident's decision, audit row records denial |
| `notification-5xx` | Approval request retries on alternate channel; both 5xx → `delivery_failed` |
| `auto-approve-match` | Entry logged with `method=auto`, audit row tagged louder than manual |
| `auto-approve-stale-rule` | Falls through to manual flow, no silent bypass |
| `visitor-delete-with-entries` | Soft delete, entries still resolve, audit row recorded |
| `admin-filter-hides-failure` | Failed entry surfaces in a "failures" tab, never silently filtered |

The audit must pass before the app is declared production-ready.
