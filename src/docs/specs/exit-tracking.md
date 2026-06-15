# Feature 7 — Exit Tracking — Specification

> Status: **DRAFT v1** — assumptions open to revision until first code lands.
> After Slice 0 (this spec) is committed, changes require an ADR.
>
> Scope: entry-to-exit lifecycle for existing `entry_records` rows.
> Adds an `exit_records` table, a service, routes, frontend slice,
> and an admin "Currently on-premise" panel.

---

## 1. Problem Statement

Today every visitor entry is write-once. A guard logs an entry via
walk-in, QR, override, auto-approval, or resident approval — but there
is **no exit event**. The data model captures "who came in and when" but
not "who left and when."

This creates three operational gaps:

1. **No duration visibility.** A security investigation cannot answer
   "how long was this visitor on-premise?" without cross-referencing
   the physical sign-out book (which may not exist or may be illegible).
2. **No currently-on-premise view.** The admin cannot see a real-time
   list of visitors who have entered but not yet exited. During an
   incident (fire, security breach), this is the single most important
   data surface.
3. **No exit audit trail.** There is no record of which guard processed
   the departure, or when. The audit log is one-sided.

This is ChatGPT critique point #4 ("Vehicle Tracking — time entered,
time exited, vehicle registration. Useful when incidents occur.") and a
prerequisite for any production deployment where accountability extends
beyond the gate.

## 2. Goals

1. A guard (any role) can record a visitor's exit against an existing
   open entry. The exit surfaces the entry's visitor name, host, unit,
   and plate for visual confirmation before submission.
2. An admin or senior-guard can view a "Currently on-premise" panel
   showing all entries that have no matching exit record.
3. Every exit record carries the guard ID of the guard who processed it,
   a server-generated timestamp, and a trace ID for audit correlation.
4. An exit without a matching open entry is **rejected with an explicit
   error code** (`EXIT_NO_OPEN_ENTRY`). No orphan exit rows.
5. An exit against an entry that already has an exit is **rejected**
   (`EXIT_ALREADY_RECORDED`). No double-exit.
6. Server errors (5xx) during exit recording surface an explicit error
   banner on the guard's UI; the form stays mounted so the guard can
   retry. No silent failure.
7. Two new audit event types (`exit_recorded`, `exit_blocked`) are
   emitted for every exit attempt — successful or not.

## 3. Non-Goals (Out of Scope)

- **Automatic exit detection** (e.g., via plate recognition camera at
  the exit gate). v1 is manual — the guard taps "Record exit" on a
  specific entry. Camera integration is a separate feature.
- **Bulk exit** ("close all entries older than 24h"). Useful for
  overnight cleanup but a separate spec with its own audit scenarios.
- **Exit reason or notes field.** v1 captures who, when, and which
  guard — no free-text. If needed, it's additive (new nullable column).
- **Resident notification on exit.** Feature 2's notification channel
  could be wired to exit events, but that's a follow-up.
- **Cross-tenant exit** (exit an entry from a different estate). The
  data model is single-tenant; this is a non-issue until F9.
- **Recursive exit** (exit of an exit). An exit is terminal.

## 4. Assumptions

| # | Assumption | Validation strategy |
|---|---|---|
| A1 | A new `exit_records` table is the right home — not a nullable `exited_at` column on `entry_records`. Rationale: a separate table carries the exit guard's ID independently (the entry guard and exit guard may differ), preserves entry immutability (no UPDATE on entry_records), and mirrors the audit-log principle of append-only state transitions. | Schema design review in this spec; no migration on entry_records. |
| A2 | Any guard role (`guard`, `senior-guard`, `admin`) can record an exit. Exit is a low-privilege operational action — unlike visitor-profile CRUD (admin-only) or shift-log read (admin/senior-guard). | Reuse `requireAuth` without `requireRole` on the exit POST route. |
| A3 | The "Currently on-premise" panel is admin/senior-guard only. Guards see their own recent entries but NOT the cross-guard on-premise view. | `requireRole('admin', 'senior-guard')` on the GET route. |
| A4 | `exit_records.entry_id` has a UNIQUE constraint. One exit per entry. The service checks this before INSERT; the DB enforces it as a backstop. | Schema CHECK + service-level guard + test. |
| A5 | The two new audit event types (`exit_recorded`, `exit_blocked`) must be added to both the TypeScript `auditEventTypeEnum` and a Postgres migration — the F6 hotfix (PR #10) proved that TS-only additions break on real DB traffic. | Migration `0007_exit_records.sql` adds both enum values AND the table. Drift-guard test extended. |
| A6 | Duration is computed client-side from `entry.createdAt` and `exit.createdAt`. No stored `durationMs` column — derived data stays derived. | Frontend formats `exit.createdAt - entry.createdAt` in the on-premise panel. |

## 5. Data Model

### New table: `exit_records`

```sql
CREATE TABLE exit_records (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id      UUID NOT NULL UNIQUE REFERENCES entry_records(id),
  guard_id      UUID NOT NULL REFERENCES guards(id),
  trace_id      TEXT NOT NULL,
  created_at    TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE INDEX idx_exit_records_entry_id ON exit_records(entry_id);
CREATE INDEX idx_exit_records_guard_id ON exit_records(guard_id);
```

**Constraints:**
- `entry_id UNIQUE` — one exit per entry (A4).
- `guard_id NOT NULL` — every exit must be attributed (same hard rule as entries).
- `trace_id NOT NULL` — audit correlation.
- No CASCADE DELETE — mirrors the entry_records / audit_events pattern.

### New audit event types

```sql
ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS 'exit_recorded';
ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS 'exit_blocked';
```

### Drizzle schema additions

```typescript
export const exitRecords = pgTable("exit_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  entryId: uuid("entry_id").notNull().unique()
    .references(() => entryRecords.id),
  guardId: uuid("guard_id").notNull()
    .references(() => guards.id),
  traceId: text("trace_id").notNull(),
  createdAt: timestamp("created_at", { precision: 3, withTimezone: true })
    .notNull().defaultNow(),
});
```

## 6. API Surface

### POST /api/entries/:entryId/exit

Records an exit for the given entry.

**Auth:** `requireAuth` (any authenticated guard).

**Path params:** `entryId` (UUID).

**Request body:** _(empty — guard identity comes from JWT, timestamp is
server-generated)_

**Success response (201):**
```json
{
  "exit": {
    "id": "<uuid>",
    "entryId": "<uuid>",
    "guardId": "<uuid>",
    "createdAt": "<ISO-8601>",
    "traceId": "<trace-uuid>"
  },
  "traceId": "<trace-uuid>"
}
```

**Error responses:**

| HTTP | Code | Condition |
|---|---|---|
| 404 | `EXIT_NO_OPEN_ENTRY` | `entryId` does not exist in `entry_records` |
| 409 | `EXIT_ALREADY_RECORDED` | An `exit_records` row already exists for this `entryId` |
| 401 | `AUTH_REQUIRED` | Missing/invalid JWT |
| 500 | `INTERNAL_ERROR` | DB or unexpected failure |

Audit events:
- On success: `exit_recorded` with `{ entryId, exitId }`.
- On 404/409: `exit_blocked` with `{ entryId, code }`.

### GET /api/entries/on-premise

Returns all entries that have no matching exit record.

**Auth:** `requireAuth` + `requireRole('admin', 'senior-guard')`.

**Query params:** _(none for v1; pagination is additive if needed)_

**Success response (200):**
```json
{
  "entries": [
    {
      "id": "<entry-uuid>",
      "visitorName": "Maya Chen",
      "host": "A. Okafor",
      "unit": "18B",
      "plate": "LND-482",
      "method": "walk-in",
      "guardId": "<uuid>",
      "createdAt": "<ISO-8601>"
    }
  ],
  "count": 1,
  "traceId": "<trace-uuid>"
}
```

**Error responses:**

| HTTP | Code | Condition |
|---|---|---|
| 401 | `AUTH_REQUIRED` | Missing/invalid JWT |
| 403 | `AUTH_FORBIDDEN` | Guard role not permitted |
| 500 | `INTERNAL_ERROR` | DB or unexpected failure |

## 7. Default-Deny Invariants

These are the non-negotiable contracts F7 must preserve:

| # | Invariant | Layer | Verification |
|---|---|---|---|
| D1 | An exit cannot exist without a matching open entry. | Service + DB UNIQUE | E2 audit scenario |
| D2 | A double-exit is rejected with `EXIT_ALREADY_RECORDED`. | Service + DB UNIQUE | E3 audit scenario |
| D3 | Server 5xx on exit → UI stays mounted, error banner visible, no exit row created. | Route + reducer + UI | E5 audit scenario |
| D4 | Guard-role token on the on-premise list → 403 `AUTH_FORBIDDEN`. | `requireRole` middleware | E4 audit scenario |
| D5 | Every exit attempt (success or failure) emits an audit event. | Service | Unit tests |

## 8. Frontend State

### New types

```typescript
export type ExitRecordView = {
  id: string;
  entryId: string;
  guardId: string;
  createdAt: string;
  traceId: string;
};

export type OnPremiseEntryView = {
  id: string;
  visitorName: string;
  host: string;
  unit: string;
  plate: string | null;
  method: EntryMethod;
  guardId: string;
  createdAt: string;
};

export type ExitTrackingState = {
  onPremise: OnPremiseEntryView[];
  loading: boolean;
  lastError?: GatePassError;
  /** Per-entry exit-in-flight flag. */
  exitInFlight: Record<string, boolean>;
  /** Per-entry exit error. */
  exitErrors: Record<string, GatePassError>;
  /** Last successfully recorded exit (for the confirmation banner). */
  lastExit?: ExitRecordView;
};
```

### New actions

```
EXIT_TRACKING_LIST_STARTED
EXIT_TRACKING_LIST_LOADED   { entries, count, traceId }
EXIT_TRACKING_LIST_FAILED   { error }
EXIT_RECORD_STARTED         { entryId }
EXIT_RECORD_SUCCEEDED       { exit }
EXIT_RECORD_FAILED          { entryId, error }
```

### Reducer rules

- `EXIT_TRACKING_LIST_LOADED` replaces `onPremise` + clears `loading`.
- `EXIT_RECORD_STARTED` sets `exitInFlight[entryId] = true`.
- `EXIT_RECORD_SUCCEEDED` removes the entry from `onPremise`, clears
  `exitInFlight[entryId]`, sets `lastExit`.
- `EXIT_RECORD_FAILED` clears `exitInFlight[entryId]`, sets
  `exitErrors[entryId]` with the structured error. **No silent failure.**
- `RESET_FLOW` does NOT clear `exitTracking` — it belongs to the admin
  subview, not the per-walk-in lifecycle.

## 9. UI

### Admin panel: "On-Premise" tab

Rendered alongside the existing `VisitorsAdminPanel` and `ShiftLogPanel`
in admin mode. Shows a table of currently-on-premise visitors with
columns: Visitor · Host · Unit · Plate · Method · Entered · Duration ·
Action.

- Duration is live-computed from `entry.createdAt` to now.
- Action column: "Record exit" button per row, disabled while
  `exitInFlight[id]` is true.
- Per-row error: if `exitErrors[id]` exists, render inline below the
  row with the error code and message.
- Success: row disappears from the table after
  `EXIT_RECORD_SUCCEEDED`.
- Empty state: "No visitors currently on-premise."
- Loading state: skeleton rows.
- Error state (list failed): banner with error code + traceId.

### Guard view: exit affordance

On the "confirmed" panel (after a successful entry), add a secondary
"Record exit" link that navigates to admin mode's on-premise tab. This
is a shortcut — the canonical exit path is through the admin panel.

## 10. Audit Harness Scenarios

| ID | Scenario | Precondition | Action | Expected |
|---|---|---|---|---|
| **E1** | Happy exit | Entry exists, no exit | Record exit | Exit row created, entry removed from on-premise list, duration visible, `Entries on-premise` count decrements by 1 |
| **E2** | Exit without open entry | No entry for given ID | Record exit | 404 `EXIT_NO_OPEN_ENTRY`, error banner visible, no row added, on-premise count unchanged |
| **E3** | Double exit (replay) | Entry already has exit | Record exit again | 409 `EXIT_ALREADY_RECORDED`, error banner visible, on-premise count unchanged |
| **E4** | Guard RBAC on on-premise list | Guard-role token | Load on-premise panel | 403 `AUTH_FORBIDDEN`, error banner with traceId, zero rows visible |
| **E5** | Server error on exit | API stub returns 500 | Record exit | Error banner visible with `INTERNAL_ERROR`, form stays mounted, no exit row created |

## 11. Slice Plan

| Slice | Deliverable | Acceptance criteria |
|---|---|---|
| 0 | This spec | Committed, reviewed |
| 1 | DB migration `0007_exit_records.sql` + Drizzle schema | `exit_records` table + UNIQUE on `entry_id` + 2 audit enum values. Drift-guard test updated. |
| 2 | `exit-tracking-service.ts` + tests | `recordExit` (default-deny on no-entry + already-exited) + `listOnPremise` (LEFT JOIN exclusion). ≥15 unit tests. |
| 3 | Routes `exit-tracking.ts` + validation schemas + tests | POST /:entryId/exit + GET /on-premise. RBAC on GET. ≥10 route tests. |
| 4 | API client `exit-tracking-api.ts` + tests | `recordExit(entryId)` + `listOnPremise()`. ≥6 tests. |
| 5 | Reducer actions + tests | 6 new action types. ≥8 tests covering every transition. |
| 6 | Controller integration + tests | `recordExit` + `loadOnPremise` controller methods. ≥4 tests. |
| 7 | UI: `OnPremisePanel` + RTL tests | Table, exit button, per-row errors, empty/loading/error states. ≥6 RTL tests. |
| 8 | Audit harness E1–E5 | All 5 scenarios wired in the AUDIT dropdown. API stubs return deterministic responses. |

## 12. Definition of Done

- All slices committed (one commit per slice).
- `npm test` — all server + frontend tests pass.
- `npx tsc --noEmit` — clean.
- `npx eslint .` — no new errors.
- Audit harness E1–E5 all render the expected state.
- PR created, CI green.
