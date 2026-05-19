# Feature 4 — Visitor Profile CRUD — Test Plan

PR: https://github.com/Suyanka21/SECURITY-APP/pull/5

## What changed (user-visible)

Admins now have a **Visitors** sub-panel inside the **admin** mode of the GatePass app. It lists every visitor profile in the directory with watch-flag indicators (`WATCH` pill + thick left accent border), and admins/senior-guards can create, edit, soft-delete, and restore profiles through a modal form. Reads are open to all roles; mutations are RBAC-locked — guard tokens get **403 AUTH_FORBIDDEN** and the UI must surface that without silently succeeding.

## What I'm testing (one continuous flow)

The audit harness at `http://localhost:8080/audit/index.html` mounts the real `<GatePassApp />` and injects a deterministic stub at the `visitorProfilesApi` boundary. I'll walk V1 → V5 in order through the **AUDIT** dropdown overlay (top-right). Each scenario picks a different API response so I can prove the exact UI surface the spec demands.

## Observed gap (will flag in the report)

During test setup I observed that **the Visitors admin panel does not auto-load the directory when the admin mode is entered**. The panel renders `"No visitors yet"` even though the harness stubs return 2 seeded profiles, because `loadVisitorProfiles()` is wired into the controller but no caller invokes it on mount (neither `GatePassApp` when switching to admin mode, nor the panel itself via a `useEffect`).

Impact:
- The reducer + controller dispatch contracts (V1–V5) are unaffected — every scenario can still be exercised by creating rows on the fly.
- The seed-list visuals (WATCH pill on `Risky Rita`, plain `Maya Chen` row) are NOT exercised in the harness recording — those visuals are covered by RTL unit tests in `GatePassPanels.visitors.test.tsx`.

The test plan below is adapted so that V4 / V5 first create a row, then delete / restore it.

## Adversarial assertion table

Every step has a specific pass/fail check. The "Why this would fail if broken" column proves the test distinguishes a working build from a broken one — if I removed the controller dispatch or swapped a success/failure branch, that exact assertion would visibly change.

### V1 — Create profile → 201 (happy path)

| # | Step | Pass criteria | Why this would fail if broken |
|---|---|---|---|
| 1 | AUDIT dropdown → `V1 · Create profile → 201 success`, click `admin` tab | Admin panel mounts. Visitors panel renders the header + `+ New visitor` button + `Show deleted` toggle + `"No visitors yet"` placeholder. (Auto-load gap noted above.) | If the panel itself failed to mount, the admin shell would show no Visitors section at all. |
| 2 | Click `+ New visitor` | Modal opens with empty form, `Create visitor` button visible | If the form wasn't wired to `openCreate`, the modal wouldn't appear. |
| 3 | Fill `Visitor name = "Audit V1"`, `Host = "Resident A"`, `Unit = "1A"`; click `Create visitor` | Modal closes; a new row `Audit V1` with host `Resident A` and unit `1A` appears in the table; total rows = **1** | If the controller didn't dispatch `UPSERTED`, the row wouldn't appear. If it dispatched but the panel didn't close the modal on success, the modal would remain. |

### V2 — Create profile → 409 PROFILE_DUPLICATE

| # | Step | Pass criteria | Why this would fail if broken |
|---|---|---|---|
| 1 | AUDIT dropdown → `V2 · Create profile → 409 PROFILE_DUPLICATE`, click `admin` tab | Visitors panel re-mounts on fresh state, empty table | Confirms scenario switch reset state. |
| 2 | Click `+ New visitor`; fill `Visitor name = "Dup"`, `Host = "H"`, `Unit = "U"`; click `Create visitor` | Modal **stays open**; form-level error reads exactly `PROFILE_DUPLICATE: A profile with this name + unit already exists.`; `Visitor name` input gets the destructive border (red); total rows = **0** (no new row added) | If failed-create silently succeeded, the modal would close and a phantom row would appear. If the field-error mapping (`errorField === "visitorName"`) was broken, the destructive border would be missing. |

### V3 — Create profile → 403 AUTH_FORBIDDEN (critical default-deny)

| # | Step | Pass criteria | Why this would fail if broken |
|---|---|---|---|
| 1 | AUDIT dropdown → `V3 · Create profile → 403 AUTH_FORBIDDEN guard token`, click `admin` tab | Visitors panel re-mounts on fresh state, empty table | Confirms scenario switch. |
| 2 | Click `+ New visitor`; fill `Visitor name = "Forbidden"`, `Host = "H"`, `Unit = "U"`; click `Create visitor` | Modal **stays open**; form-level error reads exactly `AUTH_FORBIDDEN: Guard tokens cannot mutate visitor profiles.`; total rows = **0** (no new row added) | This is the headline RBAC test. If the controller treated 403 as success, the form would close and the row would appear — which is exactly what spec §8 forbids. |

### V4 — Soft-delete profile → 200 (happy path)

| # | Step | Pass criteria | Why this would fail if broken |
|---|---|---|---|
| 1 | AUDIT dropdown → `V4 · Soft-delete profile → 200 success`, click `admin` tab | Visitors panel re-mounts, empty table | Confirms scenario switch. |
| 2 | Click `+ New visitor`; fill `Visitor name = "V4 Subject"`, `Host = "H"`, `Unit = "4U"`; click `Create visitor` | New row appears; total rows = **1** | createProfile defaults to 201 OK in the V4 scenario stub. |
| 3 | Click the row's `Delete` action | Row **disappears** from the table; total visible rows = **0** | If the controller didn't dispatch `REMOVED`, the row would stay. |
| 4 | Tick the `Show deleted` checkbox | The `V4 Subject` row reappears with: `data-deleted="true"`, opacity-60, a tombstone line `deleted <timestamp>`, and only a `Restore` button visible (no Edit / Delete buttons) | If the panel rendered Edit/Delete on tombstones, the soft-delete invariant would be visibly violated. |

### V5 — Restore profile → 409 PROFILE_RESTORE_CONFLICT

V5 simulates the case where the row state is out of sync with the server (e.g. another admin already restored it). The server rejects the restore and the frontend must surface the rejection inline without adding a phantom row.

| # | Step | Pass criteria | Why this would fail if broken |
|---|---|---|---|
| 1 | AUDIT dropdown → `V5 · Restore profile → 409 PROFILE_RESTORE_CONFLICT`, click `admin` tab | Visitors panel re-mounts, empty table | Confirms scenario switch. The V5 stub accepts `createProfile → 201` and `softDeleteProfile → 200` (V5 only overrides `restoreProfile`). |
| 2 | Click `+ New visitor`; fill `Visitor name = "V5 Subject"`, `Host = "H"`, `Unit = "5U"`; click `Create visitor` | New row appears; total rows = **1** | createProfile defaults to 201 OK in the V5 scenario stub. |
| 3 | Click the row's `Delete` action; then tick `Show deleted` | Tombstoned row reappears with the `Restore` button visible | Same dispatch pattern as V4. |
| 4 | Click `Restore` on the tombstone | Row **stays visible** with the tombstone still present; an inline per-row error appears beneath the action area reading exactly `PROFILE_RESTORE_CONFLICT: Profile is not in a deleted state — nothing to restore.`; total visible rows = **1** (no duplicate row appended) | If the controller treated 409 as success, the row would un-tombstone (lose `data-deleted`) and the inline error would be missing. If the reducer optimistically applied the restore, a duplicate row would appear. |

## Out of scope (intentionally not retested)

- Backend unit tests, server constraint tests — already 296/296 passing, evidence is the CI signal.
- Update / Edit happy path — covered by reducer/controller unit tests (slices 5+6), low marginal value to retest in the harness.
- Pagination controls — only one page worth of rows in the seeded list, controls are hidden when `totalPages = 1`.

## Recording plan

One continuous recording covering V1 → V5 in order. Annotations:

- `setup`: "Opening audit harness at /audit/index.html"
- `test_start`: each of `It should create a profile when the server returns 201 (V1)` through `It should surface PROFILE_RESTORE_CONFLICT inline without un-tombstoning the row (V5)`
- `assertion`: one consolidated assertion per test capturing the key state change

## Sign-off rule

If V3 does anything other than keep the modal open with the `AUTH_FORBIDDEN` error visible, the feature **does not ship**. Everything else is important; V3 is non-negotiable.
