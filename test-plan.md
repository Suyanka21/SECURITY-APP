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

## Out of scope

- Real backend round-trips: backend has no `dev:server` script and requires a Postgres DB + seeded guard + signed JWT. Out of scope for a deterministic audit. Unit + integration tests against the real Express server (133 server tests) already cover the backend side.
- 401 / 429 / network paths: covered by the 16 controller unit tests and 19 client unit tests. Adversarial UI flow is sufficiently proven by scenarios 1-3.
- Regression of unchanged buttons (home, admin shell). Not within scope of this PR.
