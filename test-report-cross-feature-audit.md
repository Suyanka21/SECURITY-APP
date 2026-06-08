# Cross-feature trustless audit re-run — test report

**PR under test:** [#7 — Feature 5: Shift log aggregation](https://github.com/Suyanka21/SECURITY-APP/pull/7) (stacked on PRs #5 → #4 → #3 → #2 → main)
**Branch:** `devin/1780589768-feature-5-shift-log`
**Harness:** `audit/index.html` mounts the real `<GatePassApp />` and stubs only the API boundary. Reducer + controller + UI lifecycle paths under test are identical to production.
**Method:** One continuous annotated recording walking 24 scenarios across 6 feature sets (S → S4–S8 → N → A → V → SH). Scenarios switched via the AUDIT dropdown overlay. Each scenario boundary annotated with `setup`/`test_start`/`assertion(passed|failed)` so the recording is reviewable without scrubbing.
**Test plan:** [test-plan-cross-feature-audit.md](./test-plan-cross-feature-audit.md)

---

## One-line summary

**24 / 24 scenarios PASSED.** All three critical default-deny gates (A4 malformed auto-approval · V3 guard-token RBAC · SH3 shift-log RBAC) hold. No silent success on any hostile or unauthorized server response.

---

## Per-set results

### S — Original GatePass core (3/3 PASSED)

| ID | Scenario | Result |
|---|---|---|
| S1 | POST /entries → 500 → INTERNAL_ERROR banner; entry NOT logged; `Failed submissions` counter = 1 | PASSED |
| S2 | POST /entries → 422 with `field: "unit"` → inline error on Unit field; destructive border | PASSED |
| S3 | POST /sync → 207 partial → top banner "Synced 1 of 2 entries. 1 failed and remains queued."; failed entry stays in offline queue | PASSED |

### S4–S8 — Feature 1 Resident approval flow (5/5 PASSED)

| ID | Scenario | Result |
|---|---|---|
| S4 | Resident clicks Approve → resident page success; guard view shows confirmed; `Entries logged` = 1 | PASSED |
| S5 | Resident clicks Deny with reason → guard view shows error panel `APPROVAL_DENIED` with reason echoed; entry NOT logged | PASSED |
| S6 | Approval not decided in 5min, server returns expired (lazy) → guard view shows `APPROVAL_EXPIRED`; entry NOT logged | PASSED |
| S7 | Guard creates approval for already-pending entry → 409 → inline `APPROVAL_DUPLICATE`; awaiting panel does NOT mount | PASSED |
| S8 | Approval poll → transient 5xx then success → guard stays on awaiting panel through the blip; lands on confirmed; no error banner | PASSED |

### N — Feature 2 Notifications (5/5 PASSED)

| ID | Scenario | Result |
|---|---|---|
| N1 | Notification queued → polled → flips to sent → chip "Sent · WhatsApp · …"; `Notifications sent` admin counter = 1 | PASSED |
| N2 | Provider returns 5xx → chip "Failed · WhatsApp" with destructive accent; `Notifications failed` counter = 1 | PASSED |
| N3 | Notification list endpoint → 500 → awaiting panel banner `NOTIF_LIST_ERROR`; approval still alive | PASSED |
| N4 | Resend → 202 with cooldown → button disables; "Retry in 30s" countdown; chip refreshes to Queued | PASSED |
| N5 | Resend → 429 RATE_LIMITED → cooldown banner; button disabled; existing chip unchanged | PASSED |

### A — Feature 3 Auto-approval (5/5 PASSED · A4 critical default-deny)

| ID | Scenario | Result |
|---|---|---|
| A1 | Rule matches → AUTO pill + rule line `Maya Chen · A. Okafor · 18B`; `Entries logged` = 1; `Auto-approved` admin stat = 1 | PASSED |
| A2 | Rule expired → awaiting-approval panel; no AUTO pill; `Entries logged` = 0 | PASSED |
| A3 | No matching rule → awaiting-approval panel; no AUTO pill | PASSED |
| **A4** ⚠ | **Server returns `autoApproved: true` with `entry: null` (malformed) → error panel; banner `AUTO_APPROVAL_MALFORMED`; `Entries logged` = 0; confirmation panel NEVER mounts** | **PASSED (critical)** |
| A5 | plateRequired mismatch → awaiting-approval panel (manual fallback); no AUTO pill | PASSED |

### V — Feature 4 Visitor profile CRUD (5/5 PASSED · V3 critical default-deny)

| ID | Scenario | Result |
|---|---|---|
| V1 | Create profile → modal closes; new row prepended; total rows = 3 | PASSED |
| V2 | Create with duplicate name+unit → 409 → modal stays open; error `PROFILE_DUPLICATE: A profile with this name + unit already exists.`; Visitor name input destructive border; no row added | PASSED |
| **V3** ⚠ | **Add as guard token → 403 → modal stays open; error `AUTH_FORBIDDEN: Guard tokens cannot mutate visitor profiles.`; no row added; silent success would be a security regression** | **PASSED (critical)** |
| V4 | Soft-delete + toggle Show deleted → row drops; toggle shows tombstoned row with `data-deleted="true"`, opacity-60, "deleted &lt;timestamp&gt;" line, only Restore button (no Edit/Delete) | PASSED |
| V5 | Click Restore on row in deleted state → 409 → row stays tombstoned; inline `PROFILE_RESTORE_CONFLICT: Profile is not in a deleted state — nothing to restore.`; no duplicate appended | PASSED |

### SH — Feature 5 Shift log aggregation (4/4 PASSED · SH3 critical default-deny)

| ID | Scenario | Result |
|---|---|---|
| SH1 | Auto-load happy path → 2 rows DESC by entries: M. Sato (G-1099, entries=10, qr=5, walkIn=2, auto=3, expired=2) first; A. Okafor (G-1042, entries=4) second; window label `2024-02-01T00:00:00.000Z → 2024-02-01T08:00:00.000Z` | PASSED |
| SH2 | Pin guardId to A. Okafor UUID → Refresh → table narrows to 1 row (A. Okafor); guardId form input shows the UUID | PASSED |
| **SH3** ⚠ | **403 AUTH_FORBIDDEN → banner `AUTH_FORBIDDEN: Guard tokens cannot read shift aggregations.` with `trace-AUTH_FORBIDDEN`; table empty showing "No shifts in this window."; ZERO rows leak** | **PASSED (critical)** |
| SH4 | 500 INTERNAL_ERROR → banner `INTERNAL_ERROR: An unexpected error occurred. Please retry.` with `trace-INTERNAL_ERROR`; table empty | PASSED† |

† **SH4 caveat (honest reporting per Trustless-Auditor):** The within-mount "previously-loaded rows STAY VISIBLE on subsequent error" contract is exercised by the reducer/RTL unit tests on PR #7 (`SHIFTS_LIST_FAILED` action preserves prior `rows` slice — see `src/features/gatepass/__tests__/gatepassReducer.test.ts`). The audit harness uses `key={scenario}` on the GatePassApp mount, so switching from SH1 to SH4 via the AUDIT dropdown re-mounts the app with fresh state — there are no "prior rows" to preserve in the SH4 mount. This is a harness limitation, not a frontend bug. Visually, the SH4 recording shows the banner + traceId surface correctly with an empty table, which is the stub's first-call-fails behaviour.

---

## Default-deny gates (critical contract)

The three critical scenarios prove the no-silent-success contract end-to-end:

| Gate | What hostile/unauthorized server says | What frontend MUST do | What frontend DID |
|---|---|---|---|
| **A4** | "I auto-approved this entry" but `entry: null` | Refuse to confirm; surface code; do NOT log | Error panel `AUTO_APPROVAL_MALFORMED`; `Entries logged` = 0; confirmation panel NEVER mounts |
| **V3** | "You are forbidden" (403 to a guard token) | Keep modal open; surface code; do NOT add row | Modal stays open; error `AUTH_FORBIDDEN`; no row added |
| **SH3** | "You are forbidden" (403 to a guard token) | Show banner; do NOT render any rows | Banner `AUTH_FORBIDDEN` with traceId; "No shifts in this window."; ZERO rows leak |

All three gates hold.

---

## Key evidence (this-session screenshots)

Visual evidence captured directly during this session (V4 → SH4). The full A1–A5, V1–V3, S1–S8, N1–N5 visual evidence is in the attached recording.

### V4 — Tombstoned row with Restore-only button
![V4 tombstoned row](https://app.devin.ai/attachments/062c470a-2041-48c9-81cc-6b66841971dd/screenshot_35964139e83b44d8b9c8c1ef229ec417.png)

### V5 — Inline PROFILE_RESTORE_CONFLICT error
![V5 inline 409 error](https://app.devin.ai/attachments/1556215b-8b29-4926-b143-7551e6a34c1e/screenshot_fa06f40bdc044c32a3a616ba7edc7bab.png)

### SH1 — 2 rows DESC by entries (M. Sato first, entries=10)
![SH1 happy path](https://app.devin.ai/attachments/35114f3c-54fe-4829-97b7-3ac5a2252729/screenshot_49e37c3dd997493496558d111034f563.png)

### SH2 — Filtered to A. Okafor only
![SH2 single-guard filter](https://app.devin.ai/attachments/356e879b-ec51-46a0-9416-8c5ffa9786ba/screenshot_a98b1c576c2a471182fde6408a9a26af.png)

### SH3 (CRITICAL) — Default-deny banner, zero rows leak
![SH3 default-deny](https://app.devin.ai/attachments/eab7c5fb-7434-4a5b-996c-f944a42ab82b/screenshot_1b5d927cfdb7404d86b937b215ed0c63.png)

### SH4 — INTERNAL_ERROR banner + traceId
![SH4 internal error](https://app.devin.ai/attachments/d510e3bc-223c-4ac2-9973-591ca270be82/screenshot_424586e0e8c749869535fba263577449.png)

---

## Production-relevant gaps (NOT regressions; feature-complete but worth noting)

1. **G1 / G2 fixes from PR #8** — admin auto-load on mode entry and `toggleVisitorProfilesIncludeDeleted` refetch — were merged before this audit run. The audit harness reflects post-fix behaviour.
2. **SEED_SHIFT_ROW_B fixture invariant fix** (commit `d44712b`, this branch) — `entries: 7 → 10` so the SH1 fixture row is reproducible by the real `incrementMethod` invariant. Confirmed by CodeRabbit review.

---

## Recording

Attached as the single PR comment alongside this report.

---

## Auditor confidence

**HIGH.** All 24 scenarios were walked through the audit harness with structured annotations. The three critical default-deny gates were verified with explicit visual evidence. The SH4 caveat is documented honestly: the within-mount row-preservation contract is covered by unit tests, not by the audit harness, because the harness re-mounts on scenario change. No silent success was observed on any hostile/unauthorized response.

Verdict: **READY FOR REVIEWER MERGE** of PR #7 → main (and the merge-train of PRs #5 → #4 → #3 → #2 that PR #7 stacks on).
