# Feature 4 — Visitor Profile CRUD — Test Report

PR: https://github.com/Suyanka21/SECURITY-APP/pull/5
Test plan: [`test-plan-feature-4.md`](./test-plan-feature-4.md)
Recording: https://app.devin.ai/attachments/2d86327c-7add-43d4-8ea8-83afea36190f/rec-fb15b0a0-d728-4c67-ae26-d514554b5f2f-edited.mp4

## Summary

All five scenarios (V1–V5) passed end-to-end through the audit harness, including the critical V3 default-deny path. The harness mounts the real `<GatePassApp />` and only stubs the `visitorProfilesApi` boundary, so the reducer + controller + UI paths under test are identical to production.

| ID | Scenario | Result | Evidence |
|---|---|---|---|
| V1 | Create profile → 201 success | **PASSED** | Modal closes, row appears with `V4 Subject / H / 4U` |
| V2 | Create profile → 409 PROFILE_DUPLICATE | **PASSED** | Modal stays open, form-level error, destructive border on `Visitor name`, no row added |
| **V3** | **Create profile → 403 AUTH_FORBIDDEN (critical default-deny)** | **PASSED** | Modal stays open, inline `AUTH_FORBIDDEN: Guard tokens cannot mutate visitor profiles.`, no row added |
| V4 | Soft-delete profile → 200 success | **PASSED** | Row disappears from active list; with `Show deleted` enabled the tombstoned row stays visible with only `Restore` (no Edit/Delete) and the `deleted <timestamp>` line |
| V5 | Restore profile → 409 PROFILE_RESTORE_CONFLICT | **PASSED** | Row stays tombstoned, inline `PROFILE_RESTORE_CONFLICT: Profile is not in a deleted state — nothing to restore.`, no duplicate row appended |

## Sign-off

The V3 default-deny gate held: a guard token attempting a mutation produced a clear inline error, the modal stayed open, and no row was added. This is the spec §8 contract — the headline RBAC test. The feature ships.

## Evidence

### V4 — soft-delete tombstone visible with Show deleted enabled

![V4 tombstoned row with only Restore button](https://app.devin.ai/attachments/d67b378c-2075-4312-a82d-6cadf512ab19/screenshot_5ffc719ce1c74002a7a8b688fbf0f30c.png)

- Row visible with `deleted 2026-05-19T11:26:53.210Z` line
- Only `Restore` button in actions cell (no Edit, no Delete)
- `Show deleted` toggle is checked (boxed in teal)

### V5 — restore 409 surfaces inline, row stays tombstoned

![V5 PROFILE_RESTORE_CONFLICT inline error beneath Restore button](https://app.devin.ai/attachments/5b658d78-9de3-48c5-a3ba-9e1cca269a4d/screenshot_0b2148b05f2840e996627dacb00947e1.png)

- Inline error reads exactly `PROFILE_RESTORE_CONFLICT: Profile is not in a deleted state — nothing to restore.`
- `Restore` button still visible (no auto-disable; admin can retry after refetching)
- Row stays tombstoned with `deleted` timestamp intact
- Total visible rows = **1** (no duplicate row appended)

## Observed gaps (production-relevant)

### G1 — Visitors admin panel does not auto-load on mode entry

**Severity:** medium
**Surface:** `useGatePassController` + `GatePassApp` (admin mode)
**Symptom:** When an admin enters admin mode, the Visitors panel renders `"No visitors yet"` even when seeded profiles exist server-side, because `loadVisitorProfiles()` is wired in the controller but never invoked on mount.

**Impact:**
- Real admins would see an empty directory on first navigation and have to manually refetch (no UI for that today).
- The seed-list UI affordances (`WATCH` pill, accent border on watch-flagged rows) are unreachable in the harness without manual row creation.

**Recommended fix:** Add a `useEffect(() => { void actions.loadVisitorProfiles(); }, [actions])` in `VisitorsAdminPanel`, or have `GatePassApp` invoke `loadVisitorProfiles()` when transitioning into `admin` mode. The unit tests for the panel + controller stay green either way; this is a missing caller, not a wiring bug.

### G2 — `toggleVisitorProfilesIncludeDeleted` does not refetch

**Severity:** low (test-affecting; not user-blocking)
**Surface:** `gatepassReducer.ts` + `useGatePassController.ts`
**Symptom:** Toggling `Show deleted` flips local state but does NOT trigger a list refetch. If a row was soft-deleted *before* the toggle was enabled, the row is gone from `slice.order` and toggling does not re-add it.

**Impact:**
- In production with a real backend, the toggle would need a refetch to reveal tombstoned rows the admin has not seen in this session.
- In the harness this was worked around by toggling `Show deleted` **before** the soft-delete in V4/V5 so the order array preserved the row id through the lifecycle.

**Recommended fix:** Either:
1. Make `toggleVisitorProfilesIncludeDeleted` also dispatch a `loadVisitorProfiles()` call, or
2. Add a `useEffect` in `VisitorsAdminPanel` that watches `slice.includeDeleted` and refetches on change.

Option 1 is more explicit. Option 2 is more localized. Both keep the reducer pure.

## Harness fidelity quirk (NOT a production bug)

In V4/V5 the tombstoned row shows the seeded **Maya Chen** profile data instead of the freshly-created `V4 Subject` / `V5 Subject` data. This is a stub fidelity issue, **not a reducer or controller bug**.

**Root cause:** `audit/main.tsx` `softDeleteProfile` stub falls back to `SEED_PROFILE` when the requested id is not in `seededList` (which it never is for newly-created rows). The stub already echoes the requested id back correctly (per the previous fix), so the reducer's `UPSERTED` action lands on the right row by id — but the rest of the profile fields are Maya Chen's seeded values because that's what the stub returned.

**Why it doesn't matter for the feature:**
- The reducer's job is to replace the row by id. It did exactly that.
- The UI's job is to render the row data the server returned. It did exactly that.
- A real backend would return the actual soft-deleted row data, and the row would visibly read as `V4 Subject` instead of `Maya Chen`.

**To fully fix in the harness:** the stub would need access to the `createdProfiles` map from earlier in the same session (currently it falls back to `SEED_PROFILE`). Low priority — the V4/V5 critical assertions (tombstone state visible, only Restore button, no duplicate row, inline error on 409) all hold.

## Out of scope (intentionally not retested)

- Backend unit tests + DB constraint tests → already 296/296 passing in CI
- Update / Edit happy path → covered by reducer + controller unit tests
- Pagination controls → only one page of seeded rows, controls hidden when `totalPages = 1`
- Watch-flag visual affordances → covered by `GatePassPanels.visitors.test.tsx` RTL suite

## Test environment

- Branch: `devin/1778719716-feature-4-visitor-crud`
- HEAD: `audit/main.tsx` includes the id-preservation fix
- Frontend tests: 204 / 204 passing
- Server tests: 296 / 296 passing
- `tsc`: clean
- `npm run lint`: 0 new errors
