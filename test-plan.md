# GatePass Trustless Audit — Test Plan

PR: https://github.com/Suyanka21/SECURITY-APP/pull/1

## What changed (user-visible)

The frontend used to "log" entries locally with no backend involvement. Now every entry goes through a real API call, and the UI is forced to render the *actual* server response — including failures. The audit must prove **no silent success** exists in any failure path, and that **partial sync surfaces per-entry rejections**.

## What we will test (primary flow)

Three deterministic scenarios driven through the running app. Each uses the existing `controller.api` injection point so we can reproduce exact backend responses without a live database. The reducer + controller + UI rendering paths under test are identical to what runs in production — only the transport boundary is stubbed.

| # | Scenario | Why |
|---|---|---|
| 1 | Submit walk-in → backend returns **500** | Proves API failure surfaces explicit error; UI never reaches `confirmed` |
| 2 | Submit walk-in → backend returns **422 with `field=unit`** | Proves validation contract is honored end-to-end (banner + field highlight) |
| 3 | Queue two offline entries → sync returns **207 partial** (one synced, one rejected) | Proves the user sees *which* entry failed |

## Scenarios

### Scenario 1 — API failure (500) does not produce a silent success

Steps:
1. Open the audit harness with scenario `submit-500`.
2. Navigate to **Walk-in**.
3. Type `Ada Lovelace` / `Bola` / `4A` into the three fields.
4. Click **Log entry**.

Pass criteria (all must hold):
- Banner shows `Code: INTERNAL_ERROR` (visible text on the page).
- The page is in the **Entry blocked** error state, not the **Entry recorded** confirmation.
- No entry appears in the audit-side "Entries logged: 1" counter — it stays at 0.
- The "Use walk-in" recovery button is visible.

A broken implementation that silently succeeded would show "Entry recorded" with the success banner — visibly different.

### Scenario 2 — 422 highlights the offending field

Steps:
1. Switch the harness to scenario `submit-422-unit`.
2. Navigate to **Walk-in**, fill `Ada Lovelace` / `Bola` / `4A`, click **Log entry**.

Pass criteria:
- Banner text contains `UNIT_REQUIRED` (the backend's contract code).
- The Unit input field renders with the destructive border class (red).
- Counter "Entries logged" remains 0.

### Scenario 3 — Partial sync surfaces per-entry rejection

Steps:
1. Switch the harness to scenario `sync-207-partial`.
2. Click the **Simulate offline** button in the status banner.
3. Submit one entry: `Ada Lovelace` / `Bola` / `4A`. Click **Next arrival**.
4. Submit a second entry: `Rejected Guest` / `Bola` / `4A`. Click **Next arrival**.
5. Verify the audit drawer shows `Pending sync: 2`.
6. Click **Simulate online** — this triggers `useGatePassController`'s auto-sync.

Pass criteria:
- Banner shows `Sync partial: 1 reconciled, 1 rejected — review the queue.`
- Audit drawer shows `Pending sync: 1` (the rejected one stayed queued — the synced one was reconciled away).
- The remaining queued entry has a visible red border and shows the rejection code (`VALIDATION_ERROR` or similar) with its message.
- The "Last sync results" panel lists both entries — one as `synced`, one as `rejected` with its error text.

A broken implementation that quietly dropped failed entries (or silently said "sync complete") would show `Pending sync: 0` or a green success banner. The plan distinguishes both visibly.

## Feature 1 — Resident approval flow (added in PR #2)

Source: `src/docs/specs/resident-approval-flow.md`. The audit must prove
the no-silent-success contract holds across the new approval lifecycle.

| # | Scenario | What it proves |
|---|---|---|
| S4 | Approval → approved + entry created | Happy path: poll observes pending → approved; controller synthesizes an EntryRecord with `entryId` and the guard sees "Entry recorded". |
| S5 | Approval → denied with reason | Poll observes pending → denied; UI shows the denial reason; no entry is created. |
| S6 | Approval → expired (lazy server flip) | Server's lazy expiry: status returns `expired` without any background job; UI surfaces the expired state explicitly. |
| S7 | createApproval → 409 duplicate | UI never enters awaiting-approval mode; the 409 is rendered with the backend code. |
| S8 | Polling → transient network blip | First poll returns `status=0` (transport error). The poll loop keeps trying; UI does not silently resolve. After the blip, polling resumes and shows the real state. |

### Pass criteria summary

- **S4**: After scenario picker → click Walk-in → fill draft → **Request resident approval** → awaiting-approval panel mounts with countdown + magic link. After ~3s (two poll cycles at 1500 ms), the page flips to the success banner with the approved entry. The counter `Entries logged` increments to 1.
- **S5**: Same flow as S4, but the page lands on the denial banner. `Entries logged` stays at 0. The denial reason "Not expected today" is visible.
- **S6**: Awaiting panel mounts; on first poll the server returns `expired`. The page surfaces the expired state explicitly. `Entries logged` stays at 0.
- **S7**: Clicking **Request resident approval** surfaces `APPROVAL_DUPLICATE` immediately. The guard remains on the walk-in form (not the awaiting panel). No silent fallthrough.
- **S8**: Awaiting panel mounts; first poll fails with `NETWORK_ERROR` (status=0). The countdown keeps ticking and the polling indicator stays visible. The second poll succeeds and shows the pending state. The UI never claims success during the blip.

These scenarios extend the same `controller.api` + `controller.approvalApi` injection seam used by S1–S3, so the reducer + controller + UI paths under test are identical to production.

## Feature 2 — WhatsApp/SMS notifications channel

Source: `src/docs/specs/notifications.md`. The audit must prove the
no-silent-success contract holds across the notifications stream AND
that the two-stream contract (§5) survives every failure mode — a
notifications failure must NEVER collapse the approval stream and vice
versa.

| # | Scenario | What it proves |
|---|---|---|
| N1 | Notification queued → sent | Status row advances from `queued` to `sent` on screen as polls land. No page reload required. Proves the polling stream observes the state machine transition. |
| N2 | Provider 5xx → row stuck on `failed` | Row visibly displays `failed` with the last error code (`PROVIDER_5XX`). Resend button is the only path forward. No silent retry-forever. |
| N3 | List `GET /api/notifications` → 500 | Approval awaiting panel stays alive with the magic link still copyable; notifications list shows its own error banner with the backend code. Two-stream isolation contract (spec §5). |
| N4 | Resend → 202 success + cooldown | After clicking Resend, the button vanishes and a "Resend in 30s" cooldown counter takes its place. Spec §6 manual-retry cap surfaced in the UI; double-click bypass is structurally impossible (the button is gone, not just disabled). |
| N5 | Resend → 429 `RETRY_RATE_LIMITED` | After the first manual retry, a second attempt is rejected by the server with a 429. The UI surfaces `RETRY_RATE_LIMITED` on the row, not a silent no-op. |

### Pass criteria summary

- **N1**: Open scenario `notif-queued-to-sent`. Click Walk-in, fill draft, type `+15551230001` into the host-phone field, click **Request resident approval**. The delivery-status block appears with channel `whatsapp` → `+15••••0001` (PII mask intact). On first poll, row shows `queued`. On second poll (~1.5s later), row flips to `sent` and a green check / `sent` badge replaces the queued state.
- **N2**: Open scenario `notif-provider-5xx`. Same setup as N1. The delivery row appears already in `failed` state with `PROVIDER_5XX` visible. Resend button is present. No `Resending…` spinner is ever triggered automatically.
- **N3**: Open scenario `notif-list-500`. Same setup as N1. The awaiting-approval panel mounts with countdown + magic link. Inside the delivery-status block, an explicit error banner reads `INTERNAL_ERROR: Notifications service temporarily unavailable.` Two-stream contract holds: the approval panel does NOT collapse to an error mode.
- **N4**: Open scenario `notif-retry-ok`. Setup as N1. Delivery row appears as `failed`. Click **Resend**. Immediately the Resend button disappears and `Resend in 30s` countdown appears. A second click during the cooldown is structurally impossible (button is gone). PII mask remains intact throughout.
- **N5**: Open scenario `notif-retry-rate-limited`. Setup as N1. Click **Resend** — first attempt succeeds (202), cooldown appears. (To prove the 429 contract end-to-end, wait for the cooldown to expire or open a second tab and trigger a second Resend; this surfaces the `RETRY_RATE_LIMITED` code on the row's retry-error line, NOT a silent no-op.)

These scenarios extend the same injection seam used by S1–S8, now also passing through `controller.notificationsApi`. The reducer + controller + UI paths under audit are identical to production.

## Feature 3 — Auto-approval engine

Source: `src/docs/specs/auto-approval.md`. The audit must prove the
default-deny contract: a matching active rule short-circuits the manual
flow with a louder audit trail, AND every non-match reason
(expired / no rule / plate mismatch / malformed payload / evaluator
failure) falls back to the manual approval flow without any silent
bypass. The "no silent success" guarantee must hold across the
boundary where a human-in-the-loop is replaced by a rule.

| # | Scenario | What it proves |
|---|---|---|
| A1 | Rule matches → entry logged | Page lands directly on the confirmation panel with the AUTO pill, accent border, and `Rule:` audit line. `Entries logged` increments by 1. The awaiting-approval panel NEVER mounts. `Auto-approved` admin stat increments by 1. |
| A2 | Rule expired → manual flow | Server returns a normal manual approval response (no `autoApproved` field). The guard lands on the awaiting-approval panel exactly as before. Server-side, the rule evaluator's `RULE_EXPIRED` reason was logged but is server-internal; the frontend MUST NOT show any auto-approval UI. |
| A3 | No matching rule → manual flow | Same external behavior as A2 — server's `NO_RULE` reason is server-internal. Awaiting-approval panel mounts; no AUTO pill anywhere. |
| A4 | Malformed `autoApproved=true` payload → default-deny | Server signals `autoApproved=true` but the response is missing the `entry` field. The controller's defensive parser flips to `APPROVAL_REQUEST_FAILED` with code `AUTO_APPROVAL_MALFORMED`. The error panel mounts with the explicit error code visible. `Entries logged` stays at 0. The UI NEVER lands in `confirmed` on a bad payload. |
| A5 | `plateRequired=true` rule, plate mismatch → manual flow | Same external behavior as A2/A3 — server's `PLATE_MISMATCH` reason is server-internal. Awaiting-approval panel mounts; no AUTO pill. Proves a rule with stricter conditions does NOT silently match when the conditions aren't satisfied. |

### Pass criteria summary

- **A1**: Open scenario `auto-rule-match`. Click Walk-in → fill draft (Visitor `Maya Chen`, Host `A. Okafor`, Unit `18B`) → click **Request resident approval**. The page lands DIRECTLY on the confirmation panel — no awaiting-approval state flashes. The heading reads `Entry auto-approved`, the `AUTO` pill is present with accent border, and a `Rule:` line shows the rule's visitor/host/unit. `Entries logged` is 1, `Auto-approved` admin stat is 1, `Override flags` admin stat is 0.
- **A2 / A3 / A5**: Open scenario `auto-rule-expired` / `auto-no-rule` / `auto-plate-mismatch`. Same setup. Page lands on the **awaiting-approval panel** with the magic-link / countdown. The confirmation panel never appears. No `AUTO` pill anywhere. `Entries logged` is 0. Demonstrates that every non-match reason on the server side surfaces as a normal manual approval — the frontend cannot distinguish *which* non-match reason fired (correctly: that's server-internal audit detail, not guard-facing).
- **A4**: Open scenario `auto-malformed`. Same setup. Page lands on the **error panel** with code `AUTO_APPROVAL_MALFORMED` visible. The error message guides the guard to retry or use override. `Entries logged` stays at 0. The confirmation panel NEVER mounts. Proves the controller's defensive parser refuses to log an entry on a malformed auto-approval — the trustless contract.

These scenarios extend the same `controller.approvalApi` injection seam used by S4–S8. The server-side default-deny mechanics are already covered by 26 evaluator unit tests + 9 wiring tests, so this harness focuses on the frontend's response to each server-side outcome.

## Out of scope

- Real backend round-trips: backend has no `dev:server` script and requires a Postgres DB + seeded guard + signed JWT. Out of scope for a deterministic audit. Unit + integration tests against the real Express server (133 server tests) already cover the backend side.
- 401 / 429 / network paths: covered by the 16 controller unit tests and 19 client unit tests. Adversarial UI flow is sufficiently proven by scenarios 1-3.
- Regression of unchanged buttons (home, admin shell). Not within scope of this PR.
