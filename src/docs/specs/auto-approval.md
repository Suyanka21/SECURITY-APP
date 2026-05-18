# Feature 3 — Auto-Approval Engine — Specification

> Status: **DRAFT** — pending review before code lands.
> Source skills: Spec-Driven-Development, Idea-Refine, Security-and-Hardening,
> API-and-Interface-Design, Trustless-System-Auditor.

---

## 1. Purpose and Scope

GatePass currently requires a resident to manually approve every walk-in
visitor — even ones the resident has already pre-approved a dozen times
(family, regular contractors, the kid's piano teacher). That friction
is acceptable for *truly* unknown visitors but is the wrong default for
visitors a resident has explicitly whitelisted in advance.

This feature adds a **bounded, default-deny rule evaluator** that runs
inside the approval-create path. If — and only if — a walk-in matches
*every* condition of an active rule, the approval is short-circuited
to `approved` and an entry is created **synchronously**, with a louder
audit row than a manual entry.

If no rule matches, **or** any rule check fails for any reason, the
guard sees the existing manual approval flow (Feature 1) — unchanged.
Auto-approval is a **bypass**, never a **substitute**.

### In scope

- A single `auto_approval_rules` table keyed by `(visitorName, host, unit)`
  with a TTL (`expires_at`) and an explicit `active` boolean. Rules are
  scoped to a single host+unit pair — a rule never approves visitors
  for another resident.
- A rule evaluator that runs inside the existing approval-create service
  *before* the magic-link token is generated. Default-deny: every check
  must return `match=true` for the rule to fire; any check that throws
  is treated as a non-match.
- A new entry method `"auto"` recorded on `entry_records.method` and a
  louder `entry.auto_approved` audit row tagged with the matching rule
  id and the conditions that matched.
- An additive `autoApproved` lifecycle field on the existing approval
  request response so the UI can render the auto-approved branch
  without a second API call.
- An admin-only `GET /api/auto-approval-rules` endpoint so the guard
  can see *why* a visitor was auto-approved if asked. (Mutations to
  rules are deferred — see §12.)

### Out of scope (this PR)

- Rule CRUD UI (create/edit/delete). Rules are seeded via migration or
  direct SQL until Feature 4 lands a real admin shell. The spec defines
  the table; the UI for editing it is Feature 4 territory.
- Rule DSL / scripting. The evaluator supports **exactly the booleans
  defined in §4** — no expressions, no scripting hooks, no plugins. This
  is non-negotiable. A DSL is how auto-approval becomes a silent-success
  surface; see Idea-Refine notes in §13.
- Time-of-day or day-of-week rules. Only the visitor identity and the
  active+TTL check gate the bypass. Recurring schedules are a future
  extension after we have audit data on what residents actually want.
- Approval propagation. An auto-approval does **not** notify the
  resident in this PR (Feature 2 is the WhatsApp channel; we explicitly
  do NOT auto-send a `your visitor was let in` message yet — that is
  Feature 4 + 5 territory once the visitor profile and shift log give
  us a clean recipient list).
- Multiple matching rules. If two rules match, we use the most recently
  updated rule and ignore the rest; we do NOT merge their conditions
  or run an OR across them. Spec §4 is the only matcher.

### Why "default-deny" is the contract

The principle is borrowed from `Security-and-Hardening SKILL` §3-tier:
the safe default for any access-control system is to refuse, and the
permissive path must be unambiguously affirmed. For auto-approval, that
means:

1. The visitor's `name + host + unit` triple must exactly match an
   active, non-expired rule.
2. Every additional check (e.g. `visitor.plate` if the rule pins a
   plate) must affirmatively match.
3. Any error during evaluation (DB transient, schema mismatch, type
   coercion failure) returns `match=false` — never `match=true`. The
   approval falls through to the manual flow.

A buggy rule does not auto-approve. A missing rule does not auto-approve.
A stale rule (`expires_at < now`) does not auto-approve. A deactivated
rule does not auto-approve. Auto-approval requires **every** gate to
pass; a single failure surfaces the manual flow.

---

## 2. User Stories

> Source: `GATEPASS DEFINITION.md` line 18 ("Pre-approved frequent
> visitors should not need re-approval every time."). Refined via
> Idea-Refine §13 to surface trade-offs.

| As a … | I want … | So that … |
|---|---|---|
| Resident | a way to mark visitors as pre-approved | my kid's piano teacher doesn't wake me up every Tuesday |
| Guard | the GatePass UI to log a walk-in immediately if the resident pre-approved that visitor | I don't have to wait 60s while the resident is asleep |
| Guard | a visible audit trail when auto-approval fires | I can answer "who let X in?" without ambiguity |
| Admin | the ability to see all active rules | I can audit residents who over-grant pre-approval |
| Admin | rules to expire automatically | a one-time pre-approval doesn't become a permanent backdoor |
| Security | every auto-approval to be louder, not quieter, in the audit log | I can detect rule abuse without trawling logs |

---

## 3. Data Model

### `auto_approval_rules` table

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | server-issued, never client-supplied |
| `visitor_name` | text NOT NULL | case-insensitive match (server lowercases on read+write) |
| `host` | text NOT NULL | matches `entry_records.host` exactly (case-insensitive) |
| `unit` | text NOT NULL | matches `entry_records.unit` exactly (case-insensitive) |
| `plate_required` | text NULL | if set, walk-in's plate must equal this; if NULL, plate is not checked |
| `created_by_guard_id` | uuid NOT NULL FK → `guards.id` | who seeded the rule |
| `active` | boolean NOT NULL DEFAULT true | hard kill switch |
| `expires_at` | timestamptz NOT NULL | enforced TTL — rule never fires after this |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |
| `updated_at` | timestamptz NOT NULL DEFAULT now() | |
| `last_matched_at` | timestamptz NULL | for "stale rule" audit reports |
| `match_count` | integer NOT NULL DEFAULT 0 | for "stale rule" audit reports |

### Constraints (all DB-enforced — never trust application code alone)

- `CHECK (length(visitor_name) BETWEEN 1 AND 120)` — same bound as
  `entry_records.visitor_name`.
- `CHECK (length(host) BETWEEN 1 AND 120)`.
- `CHECK (length(unit) BETWEEN 1 AND 32)`.
- `CHECK (plate_required IS NULL OR length(plate_required) BETWEEN 1 AND 32)`.
- `CHECK (expires_at > created_at)` — a rule must have a positive TTL.
- `UNIQUE (lower(visitor_name), lower(host), lower(unit))` partial
  index `WHERE active = true` — one active rule per identity triple.

### Audit-event extensions

`audit_events.event_type` gains:

- `auto_approval_rule_created`
- `auto_approval_rule_deactivated`
- `auto_approval_rule_expired` (lazy, on read)
- `auto_approval_matched` — written **alongside** the existing
  `entry_created` row so the audit trail records both the entry and
  the rule that triggered it. Payload includes the rule id, the
  matched conditions, and the visitor/host/unit triple verbatim.

### Migration policy

Migration `drizzle/0004_auto_approval_rules.sql` adds the table, the
enum extensions, and the partial index. It is **forward-only**; a
rollback would need a hand-written reverse migration because dropping
the enum values requires PG 12+ syntax that we keep out of the auto
migration for safety.

---

## 4. Match Algorithm (Default-Deny Boolean Grid)

```
input: AutoApprovalInput { visitorName, host, unit, plate? }
output: AutoApprovalDecision { match: boolean, rule?: AutoApprovalRule, reason: AutoApprovalNonMatchReason | null }
```

Pseudo-code (the actual implementation lives in
`src/server/services/auto-approval-service.ts`):

```ts
function evaluate(input): Decision {
  if (!input.visitorName || !input.host || !input.unit) {
    return { match: false, reason: "INPUT_INCOMPLETE", rule: null };
  }
  const rule = db.findActiveRuleByTriple(
    lower(input.visitorName),
    lower(input.host),
    lower(input.unit),
  );
  if (!rule) {
    return { match: false, reason: "NO_RULE", rule: null };
  }
  if (rule.expiresAt <= now()) {
    audit.write("auto_approval_rule_expired", { ruleId: rule.id });
    return { match: false, reason: "RULE_EXPIRED", rule: null };
  }
  if (!rule.active) {
    return { match: false, reason: "RULE_INACTIVE", rule: null };
  }
  if (rule.plateRequired && lower(rule.plateRequired) !== lower(input.plate ?? "")) {
    return { match: false, reason: "PLATE_MISMATCH", rule: null };
  }
  return { match: true, reason: null, rule };
}
```

### Non-match reasons (closed set)

| Code | When |
|---|---|
| `INPUT_INCOMPLETE` | One of visitorName / host / unit is empty. Caller's bug — log at ERROR. |
| `NO_RULE` | No active rule matches the triple. Expected. Log at INFO. |
| `RULE_EXPIRED` | Triple matched but the rule's TTL has passed. Lazy expiry. |
| `RULE_INACTIVE` | Triple matched but the rule's `active=false`. Admin kill switch fired. |
| `PLATE_MISMATCH` | Triple matched, rule pins a plate, the walk-in's plate differs. |
| `EVALUATOR_ERROR` | Any exception during evaluation. Treated as non-match. Caller's job is to fall through to manual approval. |

`EVALUATOR_ERROR` is the **only** branch where we do NOT log the rule
id (the rule object may be malformed). All other non-match branches
record a structured INFO-level log so the trustless audit can prove
the bypass did not fire.

---

## 5. State Machine (Approval Lifecycle Extension)

Feature 1's approval state machine had three terminal states: `approved`,
`denied`, `expired`. Feature 3 adds **one** new starting transition —
the create-approval call may short-circuit to `approved` in the same
HTTP response without ever emitting a magic link.

```
                  ┌───────────────────────────────────────────┐
guard POST       │                                           │
/approvals       ▼                                           │
─────────► [evaluate rule]                                  │
                  │                                           │
            match? │                                           │
                  ├── yes ──► [create entry tx] ──► response   │
                  │                                  status=   │
                  │                                  approved   │
                  │                                  +entryId   │
                  │                                  +autoApproved=true
                  │
                  └── no  ──► [existing flow] ──► response
                                                  status=pending
                                                  +magicLinkUrl
                                                  +autoApproved=false
```

### Wire-format compatibility

The `POST /api/approvals` response gains **one** additive field:

- `autoApproved: boolean` — defaults to `false`. When `true`, the
  response also includes `entryId` directly (skipping the polling round
  trip) and `magicLinkUrl` is `null` (the link was never minted).

Feature 1 callers that ignore `autoApproved` continue to work, because
when `autoApproved=false` the response shape is byte-identical to the
existing one. This is the additive-only rule from
`API-and-Interface-Design SKILL` §1 ("Hyrum's Law").

---

## 6. Error Codes

All boundary errors use the existing `ApiResult` envelope.

| HTTP | Code | When | Action |
|---|---|---|---|
| 422 | `RULE_INVALID_INPUT` | server-side guard rule rejects a malformed seed (validation) | reject the seed |
| 409 | `RULE_DUPLICATE` | seeding a rule with a triple that already has an active rule | admin must dedupe |
| 500 | `INTERNAL_ERROR` | unknown failure during rule evaluation; auto-approval falls through to manual | bubble traceId |

`/approvals` itself never returns a new error code for Feature 3 — if
the rule evaluator fails, the response is the same as a no-rule path
(`autoApproved=false`, magic link minted, status=pending). The failure
is logged at WARN level and surfaces in the audit, but the guard's
flow is identical to the manual case so they can keep working.

---

## 7. Boundaries (Validation)

| Boundary | What is validated | Who validates |
|---|---|---|
| `POST /api/auto-approval-rules` (seed) | visitorName/host/unit length, plate length, expiresAt > now+5min, expiresAt < now+365d | Zod at route, DB CHECK constraints |
| Rule evaluator input | non-empty visitorName/host/unit | service module |
| `GET /api/auto-approval-rules` admin filter | pagination, optional `host`/`unit` filters | Zod at route |
| Audit payload | structured types, never free-form text | drizzle insert |

---

## 8. Security

- **Default-deny** is the entire posture. See §1 and §4.
- The seed endpoint (`POST /api/auto-approval-rules`) requires
  `guard.role = 'admin'`. Non-admin guards get 403.
- The list endpoint (`GET /api/auto-approval-rules`) requires
  `guard.role IN ('admin', 'senior-guard')`. Standard guards never
  see the rules list; if they want to know why an entry was
  auto-approved, the audit trail surfaces the rule id.
- Rules never store free-form text from a visitor. Every field is
  one of the four typed columns; nothing is rendered as HTML.
- Auto-approval **never** bypasses an `entry_records` block-list
  check. If the visitor's name appears in the blocklist (Feature 0
  baseline), the auto-approval evaluator must return `match=false`
  with reason `BLOCKED_OVERRIDES_RULE`. (This is enforced by the
  blocklist check living in the entry-create path, *after* the
  approval is short-circuited; an auto-approved approval still
  routes through `entry-service.create` which runs the blocklist
  check.) See §12.
- The `auto_approval_matched` audit row is written **inside** the same
  transaction that creates the entry, so a partial write cannot leave
  an auto-approved entry without its rule provenance.

---

## 9. PII Handling

Same rules as Feature 1 + Feature 2:

- Rule rows carry `visitor_name`, `host`, `unit`, and an optional
  `plate_required`. All four are operational PII; the audit log
  rotates them under the same retention policy as `entry_records`.
- API responses never include the guard's email; `created_by_guard_id`
  is a uuid only. The admin list endpoint joins to `guards.display_name`
  separately.
- Logs never include the visitor's plate. The `auto_approval_matched`
  audit row stores the rule id only — the rule's columns are joined on
  read.

---

## 10. Failure Scenarios (Trustless Harness)

These five scenarios become `audit/main.tsx` cases (A1–A5) so the
no-silent-success contract holds. The harness must prove the audit
trail records every non-match reason and every match.

| # | Scenario | What it proves |
|---|---|---|
| A1 | Rule matches → entry created synchronously | Happy path: response carries `autoApproved=true` + `entryId`. The awaiting-approval panel is NEVER mounted (no flash). The audit row is written. |
| A2 | Rule expired (lazy) | The triple exists but `expires_at < now`. Response is `autoApproved=false`, status=pending, magic-link minted. Audit row `auto_approval_rule_expired` is written and the guard sees the manual flow with no degradation. |
| A3 | Rule deactivated (`active=false`) | Triple exists, rule inactive. Same fallthrough as A2 but with a different non-match reason. |
| A4 | Plate mismatch | Rule pins a plate, walk-in's plate differs. Fallthrough to manual. Audit row records `PLATE_MISMATCH` so admin can see "the rule almost matched". |
| A5 | Evaluator throws | Simulated DB transient. Decision is `EVALUATOR_ERROR`, fallthrough to manual, WARN log emitted, audit row tagged `evaluator_error`. The guard's UX is identical to the no-rule path. |

The harness MUST also verify the **negative** contract: a blocklist
match overrides an auto-approval (`auto_approval` must NOT fire when
the visitor name is blocked).

---

## 11. UI Hints

This feature is mostly server-side; the UI surface is intentionally
small (Feature 4 is where the admin rule editor lives).

- The guard's walk-in panel learns one new branch: when `POST /approvals`
  returns `autoApproved=true`, the reducer dispatches
  `APPROVAL_AUTO_APPROVED` instead of `APPROVAL_REQUEST_SUCCEEDED`. The
  awaiting-approval panel is bypassed; the success banner reads
  "Auto-approved by pre-approval rule" with a tooltip showing the rule
  id (read-only, for triage).
- The success banner is visibly distinct from a manual approval — a
  pill that says `auto` next to the entry method. This is the
  audit-louder-not-quieter rule from §1 made visible. A guard who
  glances at the screen can tell the difference at a distance.
- The Pending Sync drawer and Entries logged counter treat auto-approved
  entries identically to manual ones for counting purposes; the method
  pill is the only visible signal.

---

## 12. Deferred to a Follow-Up PR

The following items are explicitly **not** in this PR:

- Rule CRUD UI. The admin shell that gets a real visitor model in
  Feature 4 is where the rule editor will live.
- `BLOCKED_OVERRIDES_RULE` non-match reason. The blocklist check runs
  inside `entry-service.create` after the auto-approval path commits
  to creating the entry. To enforce "blocklist beats rule" we'd need
  to either run the blocklist check pre-approval or wrap the entry
  creation in a savepoint that can roll back. **Decision:** the
  blocklist check stays where it is; if it fires after auto-approval,
  the entry is rejected with `ENTRY_REJECTED` and the audit row records
  the rejection. The auto-approval row remains but is paired with an
  `entry_rejected` row. This is acceptable because the guard sees an
  explicit error and the entry is NOT logged. The harness scenario A6
  (deferred) will exercise this collision.
- Bulk rule expiry sweep. The current design relies on lazy expiry on
  evaluator read. A scheduled job to mark `active=false` on
  long-expired rules would reduce table size for admin queries but is
  not required for correctness.
- Rule edit history. We do not version rule changes; an `updated_at`
  bump is the only record. If admins want a full change log, that's a
  schema change for Feature 4 or later.
- Notification of resident on auto-approval. See §1 "Out of scope".

---

## 13. Idea-Refine Notes

Surfacing assumptions that were sharpened during refinement:

1. **A DSL would be a silent-success surface.** The most attractive
   alternative — letting residents author rules in some lightweight
   expression syntax (e.g. `(visitor.plate startswith "TX")`) — was
   considered and rejected. A DSL invites edge cases the residents
   don't understand and the guards can't audit. Five booleans are
   enough.
2. **Why not just a "frequent visitors" toggle on the entry form?**
   Considered. Rejected because the toggle is asymmetric — a guard
   could check it for a visitor the resident hasn't pre-approved.
   The rule lives in a table owned by the admin, not the guard.
3. **Why does the rule require name + host + unit?** Name alone is
   ambiguous (two residents may know two different Maya Chens). Name +
   host pins it to a specific relationship. Name + host + unit adds
   defense in depth so a rule cannot accidentally fire if the resident
   moves to a different unit.
4. **Why a 365-day max TTL?** A rule that never expires is a forever
   backdoor. The admin must reaffirm intent annually. 365 days is a
   compromise between "every visit" and "forever".
5. **Why is the seed endpoint admin-only when residents would benefit
   from authoring their own rules?** Residents don't have accounts in
   this codebase. Feature 4 introduces the visitor / resident profile
   model; once it lands, a separate spec will define resident-authored
   rules. For now, an admin acts on behalf of the resident.

---

## 14. Open Questions for Review

Resolve before code lands.

1. **Max TTL:** 365 days as proposed, or shorter (e.g. 90 days)?
2. **Plate matching:** Case-insensitive as proposed, or strict-case
   to support license-plate jurisdictions that distinguish?
3. **Rule deduplication:** The unique index is on `(lower(name),
   lower(host), lower(unit))` filtered to `active=true`. Should an
   inactive rule with the same triple block re-activation, or should
   we permit overlap as long as only one is active at a time?
4. **`BLOCKED_OVERRIDES_RULE` race condition:** Accept the post-hoc
   rejection in §12, or do the pre-flight blocklist check before the
   evaluator? Pre-flight is cleaner but adds one extra query to every
   approval path, including manual.
5. **Audit row pairing:** Today, every approval emits one audit row.
   An auto-approval emits two (rule_matched + entry_created). Is the
   admin tooling OK with two rows per auto-approved entry, or should
   we merge into a single composite row?

The implementation will pick the proposed default in each question
and call out any deviations in the PR body.
