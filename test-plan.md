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

## Out of scope

- Real backend round-trips: backend has no `dev:server` script and requires a Postgres DB + seeded guard + signed JWT. Out of scope for a deterministic audit. Unit + integration tests against the real Express server (133 server tests) already cover the backend side.
- 401 / 429 / network paths: covered by the 16 controller unit tests and 19 client unit tests. Adversarial UI flow is sufficiently proven by scenarios 1-3.
- Regression of unchanged buttons (home, admin shell). Not within scope of this PR.
