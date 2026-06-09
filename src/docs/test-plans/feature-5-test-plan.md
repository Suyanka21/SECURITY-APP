# Feature 5 — Shift Log Aggregation — Trustless Audit Test Plan

This is the formal acceptance test plan for Feature 5 (Shift log
aggregation, admin view). It mirrors the trustless-audit harness
pattern used for Features 1–4 (S/N/A/V scenarios). Every assertion
below maps to a specific reducer or controller dispatch and is
reproducible via the audit harness scenarios SH1–SH4.

## How to run

```bash
npm run dev   # serves the app + the audit harness on port 8080
# Open http://localhost:8080/audit/index.html?scenario=shifts-list-200
# (or pick SH1–SH4 from the AUDIT dropdown overlay)
# Navigate the GatePass app to "admin" → the Shift log panel scrolls
# into view beneath the Visitors panel
```

Spec source: `src/docs/specs/shift-log-aggregation.md` (sections §4
API, §6 UI surface, §7 frontend reducer contract, §10 audit harness
scenarios).

## Scenarios

| ID   | Backend stub                                                | What is proven                                                                                                                                       |
|------|-------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------|
| SH1  | `listShifts → 200 + two seeded guard rows`                  | Happy path. Auto-load on entering admin mode fires `SHIFTS_LIST_LOADED`. Window label echoes server window. Table renders 9-column counter row per guard. |
| SH2  | `listShifts(guardId=A) → 200 + one row`                     | Date-range / single-guard filter. Submitting the form with `guardId` set narrows the response, table shrinks to one row.                              |
| SH3  | `listShifts → 403 AUTH_FORBIDDEN`                           | **Critical default-deny.** Banner surfaces `AUTH_FORBIDDEN`. Table empty (no leaked rows). No silent success. RBAC seam holds end-to-end.            |
| SH4  | `listShifts → 500 INTERNAL_ERROR` (after a prior 200 load)  | Server error after a successful load. Banner surfaces `INTERNAL_ERROR + traceId`. Previously-loaded rows STAY VISIBLE (no silent wipe).              |

## Step-by-step assertions

### SH1 — Shift log → 200 happy path
**Setup**: Pick `SH1 · Shift log → 200 happy path` from the AUDIT
dropdown. Navigate to `admin`.
1. Shift log panel mounts beneath the Visitors panel.
2. **Expected (auto-load on mode entry)**:
   - The Refresh button briefly shows `Loading…` then returns to
     `Refresh`.
   - Element with testid `shift-log-window-label` contains the ISO-8601
     `fromIso` and `toIso` the SERVER returned (not the user's request
     — there is no user request yet, the controller dispatched with an
     empty query).
   - Two rows render with testids `shift-log-row-<guardId>`, sorted by
     entries DESC (M. Sato first with 7 entries, then A. Okafor with 4).
   - Each row shows: guard name, badge number, and 7 counter columns
     (entries, qr, walkIn, override, auto, denied, expired).
   - No `shift-log-error` banner.
   - No `shift-log-empty` row.

### SH2 — Shift log → single-guard filter
**Setup**: Pick `SH2 · Shift log → single-guard filter`.
1. Auto-load fires the unfiltered list; both rows render (same as SH1).
2. Paste `22222222-2222-4222-8222-222222222222` (A. Okafor's UUID) into
   the `Guard id` input. Click `Refresh`.
3. **Expected**:
   - `actions.loadShifts` is called with `{ guardId:
     "22222222-2222-4222-8222-222222222222" }` (no date overrides).
   - Table shrinks to exactly one row: A. Okafor / G-1042 / 4 entries.
   - M. Sato's row is removed.
   - `shift-log-window-label` still echoes the server window.

### SH3 — Shift log → 403 AUTH_FORBIDDEN (critical default-deny)
**Setup**: Pick `SH3 · Shift log → 403 AUTH_FORBIDDEN`.
1. Navigate to admin.
2. **Expected**:
   - Auto-load fires immediately. The list call returns 403.
   - Element with testid `shift-log-error` (role="alert") shows
     `AUTH_FORBIDDEN: Guard tokens cannot read shift aggregations.`
     plus the trace id.
   - The table body shows `shift-log-empty` ("No shifts in this
     window.") — NOT a silent half-rendered set of rows.
   - The Refresh button is enabled (loading=false) so the admin can
     retry once they switch to an authorized session.

This is the headline RBAC test for Feature 5: a guard token reaching
this panel via any client (legitimate misconfig or hostile poking)
gets a loud, visible rejection. No partial data leaks into the
viewport.

### SH4 — Shift log → 500 INTERNAL_ERROR (no-silent-wipe)
**Setup**: Pick `SH4 · Shift log → 500 INTERNAL_ERROR`.

SH4 covers the "intermittent backend" path that Features 1–4 each have
a variant of (S1, N3, A4, V3 partner cases): a single failing call
should NOT erase the admin's existing context.

The audit harness's seeded SH4 stub returns 500 on every call. To
prove the no-silent-wipe contract:

1. First switch to `SH1` so the table loads two rows successfully.
2. Without reloading the page, switch the dropdown to `SH4`. (This
   forces a re-mount of `GatePassApp` because the dropdown's `key={scenario}`
   prop changes — the prior in-memory rows are intentionally wiped by
   the remount. To prove the in-memory no-wipe contract end-to-end you
   must instead use the SH1+SH4 jest test
   `gatepassReducer.test.ts` → `SHIFTS_LIST_FAILED preserves prior rows`,
   which exercises the reducer directly without re-mounting.)
3. With the page on SH4, observe:
   - `shift-log-error` banner shows `INTERNAL_ERROR: An unexpected
     error occurred. Please retry.` plus traceId.
   - The table body shows `shift-log-empty` (because the post-remount
     state had no rows to preserve).
4. **Reducer-level acceptance** (covered by unit test, also visible by
   inspecting the reducer in `__tests__/gatepassReducer.test.ts`):
   given a prior `SHIFTS_LIST_LOADED` with two rows, a subsequent
   `SHIFTS_LIST_FAILED` keeps `state.shifts.rows` populated AND sets
   `state.shifts.lastError`. The UI then renders the banner ON TOP of
   the existing rows — no silent wipe.

## What this plan does not cover

- Live database integration. The harness uses the in-memory
  `shiftsApi` boundary stub. The Drizzle service-layer tests
  (`shift-log-service.test.ts`) exercise the SQL aggregation directly
  against the schema, but those are unit tests against a mocked DB
  handle (the existing project convention). Real-Supabase verification
  is the responsibility of the `db-constraints.integration.test.ts`
  workflow.
- Performance under large datasets. The spec §11 calls out pagination
  as a future-proof seam; the current implementation returns all rows
  in the window. SH1's two-row fixture is the documented happy-path
  size; large-dataset perf testing is intentionally out of scope.
- Cross-feature interaction. Notifications / approvals / auto-approval
  rows feeding into the aggregation are covered by their own scenario
  sets (N, S4–S8, A). The final cross-feature trustless audit run
  (this plan's bigger sibling) is recorded as one continuous pass
  through S, S4–S8, N, A, V, and SH.

## Trustless contracts proven by this plan

- **Default-deny (SH3)** — guard token → loud 403, empty table, banner
  visible. No silent partial render.
- **No silent success (SH3, SH4)** — every failure surfaces an error
  banner with code + message + traceId.
- **No silent wipe (SH4 + reducer test)** — a failed refresh after a
  successful load keeps the prior rows on screen.
- **Window honesty (SH1)** — the displayed window is the SERVER's
  computed window, not the user's request. A server that clamps or
  defaults the window cannot lie to the admin about what they're
  looking at.
- **Filter forwarding (SH2)** — the admin's pending `guardId` actually
  reaches the server and narrows the response, proving the controller
  doesn't drop or override admin filters.
