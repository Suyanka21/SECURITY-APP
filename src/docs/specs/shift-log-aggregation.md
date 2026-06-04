# Feature 5 — Shift Log Aggregation (Admin View) — Specification

> Status: **DRAFT** — pending review before code lands.
> Source skills: Spec-Driven-Development, Idea-Refine, Security-and-Hardening,
> API-and-Interface-Design, Trustless-System-Auditor, Frontend-UI-Engineering.

---

## 1. Purpose and Scope

`GATEPASS DEFINITION §2` calls for an admin view that summarises *what
happened on a shift*: how many entries each guard processed, how many
were auto-approved vs. overridden vs. manually walked in, and how many
approvals were denied or expired. Today the data exists — every entry
writes to `entry_records`, every mutation writes to `audit_events`, and
those tables are timestamped and guard-attributed — but there is no
endpoint or UI surface that aggregates them.

This feature adds a **read-only aggregation endpoint** and an admin
panel that consumes it. There is **no new persistent state**. A "shift"
is not a stored entity; an admin picks a date range and the server
groups the existing rows by guard.

### In scope

- A `shift-log-service` that aggregates `entry_records` and
  `audit_events` over a `(fromIso, toIso)` window into one row per guard.
- A `GET /api/admin/shifts` endpoint protected by `requireRole(['admin',
  'senior-guard'])`. `guard` tokens get **403 AUTH_FORBIDDEN**.
- A typed API client + reducer slice + controller method on the
  frontend.
- A `ShiftLogPanel` rendered alongside `VisitorsAdminPanel` in admin
  mode. Date-range picker (defaults to "today, system TZ"), optional
  per-guard filter, sortable columns, empty state, error banner,
  loading state.
- Audit harness scenarios SH1–SH4 (happy, date-range filter, 403
  default-deny, 500 server error).

### Out of scope (this PR)

- A `shifts` table or shift entity. Shifts are not first-class. If we
  ever need them (e.g., to model rotating crews), that's a separate
  spec.
- Exporting to CSV / PDF. Read-only API + on-screen table only.
- Real-time updates (polling, SSE, WebSocket). Admin clicks "Refresh"
  to re-fetch. This matches the read-only nature of the surface.
- Aggregation across more than one organisation / building. The data
  model is already single-tenant; the aggregation inherits that.
- Charting. Tables only. Charts are a separate UI concern and a
  separate spec.
- Modifying audit events to add a "shift_id". Aggregation works fine
  against the existing schema; introducing a denormalised shift_id is
  a write-path change with its own ripple effects.

---

## 2. Data Model

**No new tables.** The aggregation reads from:

| Source table | Columns used | Why |
|---|---|---|
| `entry_records` | `guard_id`, `method`, `created_at`, `status` | Counts of entries by method (qr / walk-in / override / recognized / auto) within the window. |
| `audit_events` | `guard_id`, `event_type`, `created_at` | Counts of `approval_denied`, `approval_expired`, `override_authorized`, `auto_approval_matched` within the window. |
| `guards` | `id`, `name`, `badge_number` | Display columns for each row of the aggregation. |

Reads are **read-committed**. The endpoint never blocks any write path
and never mutates state.

### Performance note

The aggregation issues two grouped queries (one per source table) and
joins the results in application code. The largest expected window is
30 days × 50 guards × low-thousands of entries per guard per day; even
at 100× that, two indexed `GROUP BY guard_id` scans complete in tens of
milliseconds. If aggregation becomes hot we can revisit with a
materialised view; until then the spec deliberately avoids
infrastructure that the read load does not justify (`Code-Simplification
SKILL.md`).

---

## 3. Time Window & Shift Semantics

### What "a shift" means here

A shift is just a **time window the admin chose**. The server does
not infer shift boundaries from guard activity (we don't have a "guard
clocked in" event yet; pretending we do would be silent fabrication).
A shift window is therefore:

- `fromIso` — inclusive lower bound on `created_at`
- `toIso` — exclusive upper bound on `created_at`

### Defaults & limits

- Default window if neither bound is supplied: **start of today (UTC)
  through now** — same definition `Stat` cards use elsewhere.
- Both bounds, when supplied, MUST be ISO-8601 UTC strings (`Z`
  suffix). The server rejects unparseable values with 422.
- Window MUST be ≤ 31 days. Larger windows return 422
  `SHIFT_WINDOW_TOO_LARGE` — this protects against pathological
  queries on the audit table.
- `fromIso < toIso` is enforced. Inverted ranges return 422
  `SHIFT_WINDOW_INVALID`.

These bounds are a **boundary validation**, not a business rule —
they live in the Zod schema and are tested at the route layer.

---

## 4. API

### Request

```
GET /api/admin/shifts?fromIso=2024-01-15T00:00:00.000Z&toIso=2024-01-16T00:00:00.000Z&guardId=<uuid?>
Authorization: Bearer <token>
```

| Query param | Type | Required | Notes |
|---|---|---|---|
| `fromIso` | ISO-8601 UTC string | optional | Defaults to start-of-today UTC. |
| `toIso` | ISO-8601 UTC string | optional | Defaults to current `now()`. |
| `guardId` | uuid | optional | When supplied, restricts the aggregation to a single guard. |

### Success — 200

```jsonc
{
  "window": {
    "fromIso": "2024-01-15T00:00:00.000Z",
    "toIso":   "2024-01-16T00:00:00.000Z"
  },
  "shifts": [
    {
      "guardId":     "00000000-0000-4000-8000-000000000001",
      "guardName":   "Sgt. A. Okafor",
      "badgeNumber": "G-1042",
      "totals": {
        "entries":             27,
        "qr":                  10,
        "walkIn":               9,
        "override":             3,
        "recognized":           4,
        "auto":                 1,
        "approvalsDenied":      2,
        "approvalsExpired":     1,
        "autoApprovalsMatched": 1,
        "overrideAuthorized":   3
      }
    }
  ],
  "traceId": "trace-shift-list-…"
}
```

Notes:

- `shifts` is always an array. Empty window → `shifts: []`, not `null`.
- A guard who had **zero activity** in the window does NOT appear in
  the list. The UI shows an empty-state message when the array is
  empty.
- The order of `shifts` is **deterministic**: sorted descending by
  `totals.entries`, then ascending by `badgeNumber` (ties broken
  alphabetically so the UI is stable between refreshes).

### Errors — single error shape

| Code | HTTP | Trigger |
|---|---|---|
| `SHIFT_WINDOW_INVALID` | 422 | `fromIso >= toIso`, or one bound is unparseable. |
| `SHIFT_WINDOW_TOO_LARGE` | 422 | `toIso - fromIso > 31 days`. |
| `AUTH_REQUIRED` | 401 | No bearer token. |
| `AUTH_FORBIDDEN` | 403 | Guard token (role !== `admin` and !== `senior-guard`). |
| `INTERNAL_ERROR` | 500 | Database failure or any unexpected exception. |

All errors follow the standard envelope:

```jsonc
{ "error": { "code": "<CODE>", "message": "<human-readable>", "traceId": "<id>" } }
```

A 403 from this endpoint MUST surface inline in the admin UI as
"You don't have permission to view shift activity." with no rows
rendered. This is the same default-deny discipline that Features 3
and 4 enforced on their admin surfaces.

---

## 5. Backend Service Contract

```ts
// src/server/services/shift-log-service.ts
export type ShiftSummary = {
  guardId: string;
  guardName: string;
  badgeNumber: string;
  totals: {
    entries: number;
    qr: number;
    walkIn: number;
    override: number;
    recognized: number;
    auto: number;
    approvalsDenied: number;
    approvalsExpired: number;
    autoApprovalsMatched: number;
    overrideAuthorized: number;
  };
};

export type ShiftQuery = {
  fromIso: string;     // ISO-8601 UTC, inclusive
  toIso: string;       // ISO-8601 UTC, exclusive
  guardId?: string;    // optional single-guard filter
};

export type ShiftListResult = {
  window: { fromIso: string; toIso: string };
  shifts: ShiftSummary[];
};

export async function listShifts(
  query: ShiftQuery,
  db: DbHandle,
): Promise<ShiftListResult>;
```

The service:

1. Validates the window (`from < to`, ≤ 31 days). Boundary errors
   throw a typed `ShiftWindowError` the route maps to 422.
2. Issues two queries:
   - Aggregated `entry_records` grouped by `guard_id` and `method`.
   - Aggregated `audit_events` grouped by `guard_id` and `event_type`
     restricted to the four event types listed in §2.
3. Joins the two row sets in application code keyed by `guard_id`,
   pulls display columns from `guards`, and returns the
   deterministic order from §4.

The service never emits audit rows of its own — it is read-only. The
existing `auto_approval_matched`, `override_authorized`, etc. events
remain the source of truth.

---

## 6. UI Surface (`ShiftLogPanel`)

Lives in `src/features/gatepass/components/GatePassPanels.tsx`, mounted
in `GatePassApp.tsx` admin mode beneath `VisitorsAdminPanel`. Three
distinct states:

| State | Trigger | Visible elements |
|---|---|---|
| Loading | `slice.loading` | `Loading shift activity…` row. |
| Loaded — empty | `slice.shifts.length === 0` | "No activity in this window." empty-state, controls still enabled. |
| Loaded — rows | `slice.shifts.length > 0` | Table: Guard, Badge, Entries, QR, Walk-in, Override, Recognized, Auto, Denied, Expired, Auto-matched. |
| Error | `slice.lastError` | Banner above table: `CODE: message`. Same UX as `VisitorsAdminPanel`. |

Controls (always visible above the table):

- Two `<input type="datetime-local">` for `fromIso` / `toIso`. The UI
  converts to UTC ISO on submit.
- A `<select>` of guards (filled from the most recent successful
  response). Selecting a guard re-issues the query with `guardId` set.
- A "Refresh" button — same query, latest data.

The panel auto-loads when admin mode is entered (the G1 fix's
useEffect pattern, scoped to this slice).

---

## 7. Frontend Reducer Contract

New slice on `GatePassState`:

```ts
state.shifts: {
  window:     { fromIso: string; toIso: string } | undefined;
  rows:       ShiftSummary[];
  loading:    boolean;
  lastError?: { code: string; message: string };
  query:      { fromIso?: string; toIso?: string; guardId?: string };
}
```

New actions (paired starts and terminals — no silent transitions):

| Action | Payload | Effect |
|---|---|---|
| `SHIFTS_LIST_STARTED` | `{ query }` | `loading=true`, clears `lastError`, stores `query`. |
| `SHIFTS_LIST_LOADED` | `{ window, shifts }` | `loading=false`, `window=window`, `rows=shifts`. |
| `SHIFTS_LIST_FAILED` | `{ error }` | `loading=false`, `lastError=error`, **`rows` unchanged** — a failed refresh does NOT wipe the previously-loaded data. |
| `SHIFTS_QUERY_CHANGED` | `{ patch }` | Merges `patch` into `query` (UI-only, doesn't trigger refetch). |

The reducer enforces no-silent-success: `loading=false` is set only on
`LOADED` or `FAILED`, never on its own.

---

## 8. Audit Harness Scenarios

| ID | Scenario | Stub behaviour | Acceptance |
|---|---|---|---|
| SH1 | Happy path | `GET /admin/shifts` returns 200 with two guards. | Panel shows both rows; counts match stub; `Loading shift activity…` clears. |
| SH2 | Date-range filter | Same as SH1, but `fromIso` set to a window with zero rows. | `No activity in this window.` empty-state visible. No error banner. |
| SH3 | 403 default-deny | Stub returns `AUTH_FORBIDDEN`. | Banner shows `AUTH_FORBIDDEN: You don't have permission to view shift activity.` Table empty. **No rows rendered**. |
| SH4 | 500 server error | Stub returns `INTERNAL_ERROR`. | Banner shows `INTERNAL_ERROR: <message>`. Previously-loaded rows remain visible (we don't wipe on a failed refresh). |

Each scenario produces a **distinct, observable** UI state. SH3 is the
linchpin: no silent success even if the server lies.

---

## 9. Security & RBAC

- Route mounted under `/api/admin/*` and protected by `requireAuth +
  requireRole(['admin', 'senior-guard'])` — reuses the middleware
  introduced in Feature 3 and re-applied in Feature 4. `guard` tokens
  receive 403 with no rows returned.
- The aggregation never returns visitor PII (no names, plates,
  phones, notes). Counts only. This intentionally keeps the
  surface lower-privilege than the visitor directory.
- Query parameters are validated at the boundary (Zod schema) before
  reaching the service. The service trusts already-validated input.

---

## 10. Observability

- Every request gets a `traceId` written into the success or error
  envelope.
- The endpoint itself does NOT emit audit events — it is read-only.
  Auditing reads is a deliberate non-goal here (the read surface is
  low-risk and high-frequency; auditing every read would flood the
  log). If we ever want admin-read auditing it deserves its own ADR.

---

## 11. Acceptance Criteria

- [ ] `GET /api/admin/shifts` with no params returns today's
      window with all guards that had activity, sorted as in §4.
- [ ] With `fromIso` / `toIso` set to a window with zero activity, the
      endpoint returns `{ shifts: [] }`.
- [ ] With `guardId` set, the response contains at most one row.
- [ ] A `guard` token receives 403 `AUTH_FORBIDDEN`. No rows leak.
- [ ] An inverted window returns 422 `SHIFT_WINDOW_INVALID`.
- [ ] A 32-day window returns 422 `SHIFT_WINDOW_TOO_LARGE`.
- [ ] Frontend reducer's `SHIFTS_LIST_FAILED` does NOT wipe previously
      loaded rows.
- [ ] All four audit harness scenarios (SH1–SH4) produce distinct UI
      states matching §8.
- [ ] No silent-success path exists: every dispatch path goes through
      a `LOADED` or `FAILED` terminal.

---

## 12. Rollout

Feature 5 builds on top of PR #5 (Feature 4) and lands as PR #6.
Slices, in order:

| Slice | Scope | Tests added |
|---|---|---|
| 0 | This spec | — |
| 1 | Drizzle schema (no migration; index audit). | — |
| 2 | Backend service + Zod + service tests | +10 |
| 3 | Backend route + RBAC + route tests | +6 |
| 4 | API client + types + client tests | +5 |
| 5 | Reducer slice + actions + reducer tests | +6 |
| 6 | Controller method + controller tests | +4 |
| 7 | `ShiftLogPanel` UI + RTL tests | +6 |
| 8 | Audit harness SH1–SH4 + test plan | — |

Every slice MUST be lint-clean, tsc-clean, and have a passing test
suite before the next slice opens.
