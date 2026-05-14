# Feature 4 — Visitor Profile CRUD — Specification

> Status: **DRAFT** — pending review before code lands.
> Source skills: Spec-Driven-Development, Idea-Refine, Security-and-Hardening,
> API-and-Interface-Design, Frontend-UI-Engineering, Trustless-System-Auditor.

---

## 1. Purpose and Scope

Today, "visitors" are read-only in the GatePass frontend. The recognition
list is computed at query time from `entry_records` (see
`src/server/services/visitor-service.ts` — it groups by visitor name and
assigns a `pre-approved` / `frequent` / `watch` tag from the entry
history). There is no first-class visitor profile, no way to flag a
visitor, no way to attach a phone number for notifications, no way to
record notes, and no way to remove a profile.

This feature adds **a first-class `visitor_profiles` table** with full
CRUD, soft-delete, and an admin UI. Visitor profiles become the canonical
source for:

- The phone number used when delivering an approval magic link by
  WhatsApp/SMS (Feature 2 currently reads it from the host phone in the
  walk-in draft only).
- The **watch flag** — a visitor explicitly flagged for extra scrutiny
  (e.g. trespass history, banned by HOA). Watch-flagged visitors are
  visually distinct in the search panel.
- Free-form **notes** the resident or admin wants future guards to see
  (e.g. "deliveries only, never to the door").

Profiles are scoped to a (visitor name, host, unit) triple — exactly the
same key the recognition algorithm uses. A profile *augments* the
algorithmic recognition tag; it never silently overrides it.

### In scope

- A single `visitor_profiles` table with soft-delete (`deleted_at` /
  `deleted_by_guard_id`) and tracking columns (`created_by_guard_id`,
  `updated_at`).
- CRUD service:
  - `createVisitorProfile(input, db)` → 201 with the new profile.
  - `updateVisitorProfile(id, patch, db)` → 200 with the updated profile.
  - `listVisitorProfiles(query, db)` → paginated list, default excludes
    soft-deleted.
  - `getVisitorProfile(id, db)` → 200 with profile (or 404).
  - `softDeleteVisitorProfile(id, by, db)` → 204; sets `deleted_at`.
  - `restoreVisitorProfile(id, db)` → 200; clears `deleted_at`.
- CRUD routes mounted at `/api/visitor-profiles` (REST style).
- RBAC: `admin` and `senior-guard` may create / update / soft-delete /
  restore. `guard` may **only read** (list + get). The same
  `requireRole` middleware introduced in Feature 3 is reused.
- Audit events for every mutation
  (`visitor_profile_created` / `_updated` / `_soft_deleted` / `_restored`).
- Frontend reducer + controller for the CRUD surface (new actions:
  `VISITOR_PROFILES_LOADED`, `VISITOR_PROFILE_CREATED`,
  `VISITOR_PROFILE_UPDATED`, `VISITOR_PROFILE_DELETED`,
  `VISITOR_PROFILE_RESTORED`, plus paired `_FAILED` variants).
- Admin UI: a new "Visitors" tab under the Admin shell with a list, a
  create form, an edit dialog, a soft-delete confirmation, and a
  restore action.
- Audit harness scenarios V1–V5.

### Out of scope (this PR)

- Merging two visitor profiles. Dedup is a separate workflow that
  requires its own state machine (which entries belong to which profile
  after merge, what happens to the audit trail). Punted.
- Bulk import / export. Single-row CRUD only.
- Pictures / attachments. Profiles are text-only.
- Wiring the phone number into Feature 2's notification dispatch. We
  expose it on the profile and surface it in the UI; the wiring lives
  with Feature 2's delivery loop and can land in a follow-up PR without
  changing this table.
- Affecting how `recognized` visitors are computed. The existing
  visitor-service continues to derive recognition from entry history.
  Profiles **augment** it (a profile is shown next to the algorithmic
  tag) but never override it. Reasoning: silent override is a
  security regression — a flagged visitor must never look pre-approved.

---

## 2. Data Model

### `visitor_profiles` table

| Column | Type | Constraint |
|---|---|---|
| `id` | uuid | PK, default randomUUID |
| `visitor_name` | text | NOT NULL, length(trim) BETWEEN 1 AND 120 |
| `host` | text | NOT NULL, length(trim) BETWEEN 1 AND 120 |
| `unit` | text | NOT NULL, length(trim) BETWEEN 1 AND 32 |
| `plate` | text | NULL OR length(trim) BETWEEN 1 AND 32 |
| `phone_e164` | text | NULL OR matches `^\+[1-9]\d{1,14}$` (E.164) |
| `notes` | text | NULL OR length(trim) BETWEEN 1 AND 1000 |
| `watch_flag` | boolean | NOT NULL DEFAULT false |
| `created_by_guard_id` | uuid | FK → guards.id, NOT NULL |
| `created_at` | timestamptz(3) | NOT NULL DEFAULT now() |
| `updated_at` | timestamptz(3) | NOT NULL DEFAULT now() |
| `deleted_at` | timestamptz(3) | NULL — soft-delete marker |
| `deleted_by_guard_id` | uuid | NULL, FK → guards.id |

### Indices & uniqueness

- Partial UNIQUE index on `(lower(visitor_name), lower(host), lower(unit))
  WHERE deleted_at IS NULL` — exactly one *active* profile per triple.
  A soft-deleted profile does NOT block a new active profile with the
  same identity (so re-adding a previously-deleted visitor works).
- Index on `(host, unit) WHERE deleted_at IS NULL` for resident-scoped
  listings.
- Index on `watch_flag WHERE watch_flag = true AND deleted_at IS NULL` —
  cheap lookup for the watch list.

### CHECK constraints (DB-enforced)

- `visitor_profile_name_bounded` — visitor_name length 1..120 after trim.
- `visitor_profile_host_bounded` — host length 1..120 after trim.
- `visitor_profile_unit_bounded` — unit length 1..32 after trim.
- `visitor_profile_plate_bounded` — plate NULL OR length 1..32 after trim.
- `visitor_profile_phone_e164_format` — phone NULL OR matches `^\+[1-9]\d{1,14}$`.
- `visitor_profile_notes_bounded` — notes NULL OR length 1..1000 after trim.
- `visitor_profile_soft_delete_consistent` — `(deleted_at IS NULL) = (deleted_by_guard_id IS NULL)`.

---

## 3. State Machine

Visitor profiles have a simple, explicit lifecycle:

```
       [not exists]
            │ POST /api/visitor-profiles (admin/senior-guard only)
            ▼
        ┌────────┐  PATCH (admin/senior-guard)   ┌────────┐
        │ active │ ◄───────────────────────► │ active │
        └────────┘                           └────────┘
            │ DELETE (admin/senior-guard)
            ▼
       ┌──────────┐   POST /restore (admin/senior-guard)
       │ deleted  │ ────────────────────────────────► active
       └──────────┘
            │ (no hard delete; soft-deleted forever)
            ▼
       [retained for audit]
```

**Default-deny on guard mutations.** Routes that mutate (POST / PATCH /
DELETE / restore) MUST reject `role=guard` tokens with `403
GUARD_CANNOT_MUTATE_PROFILES`. Read routes accept any authenticated
role.

---

## 4. API Surface

### Create — `POST /api/visitor-profiles`

Role: `admin` or `senior-guard`. Body:

```json
{
  "visitorName": "Maya Chen",
  "host": "A. Okafor",
  "unit": "18B",
  "plate": "LND-482",         // optional
  "phoneE164": "+15551230001", // optional
  "notes": "deliveries only",  // optional
  "watchFlag": false           // optional, default false
}
```

**Responses:**
- `201 Created` — `{ profile: VisitorProfileView, traceId }`
- `409 PROFILE_DUPLICATE` — an active profile already exists for this
  (visitor, host, unit) triple. Body includes the existing
  `profile.id` so the UI can offer "edit instead".
- `422 VALIDATION_ERROR` — field-level error (`field: "phoneE164"`
  for E.164 mismatch, etc.).
- `403 GUARD_CANNOT_MUTATE_PROFILES` — guard token.
- `401 UNAUTHENTICATED`, `500 INTERNAL_ERROR`.

### List — `GET /api/visitor-profiles?host=&unit=&q=&page=&pageSize=&includeDeleted=`

Role: any authenticated. Returns:

```json
{
  "profiles": [VisitorProfileView, ...],
  "pagination": { page, pageSize, totalItems, totalPages },
  "traceId"
}
```

Default `includeDeleted=false`. Set `?includeDeleted=true` to include
soft-deleted rows (admin diagnostic; UI surfaces them in a separate tab).

### Get — `GET /api/visitor-profiles/:id`

Role: any authenticated. Returns `200 { profile, traceId }` or
`404 PROFILE_NOT_FOUND`.

### Update — `PATCH /api/visitor-profiles/:id`

Role: `admin` or `senior-guard`. Body: any subset of the create fields. The
service applies the patch, bumps `updated_at`, and emits a
`visitor_profile_updated` audit event with the diff in the payload.

**Responses:** `200`, `404`, `409` (rename would clash with an existing
active profile), `422`, `403`, `401`, `500`.

### Soft-delete — `DELETE /api/visitor-profiles/:id`

Role: `admin` or `senior-guard`. Idempotent: deleting an already-deleted
profile returns `204` without writing a second audit event. Sets
`deleted_at = now()` and `deleted_by_guard_id`.

**Responses:** `204`, `404`, `403`, `401`, `500`.

### Restore — `POST /api/visitor-profiles/:id/restore`

Role: `admin` or `senior-guard`. Clears `deleted_at` and `deleted_by_guard_id`.
Fails with `409 PROFILE_RESTORE_CONFLICT` if an active profile with the
same identity now exists (caller must rename it first or merge —
out of scope).

**Responses:** `200 { profile }`, `404`, `409`, `403`, `401`, `500`.

---

## 5. Audit Trail

Every mutation writes exactly one row to `audit_events`. Read operations
do **not** write to audit (would flood the log; the reads themselves are
visible in HTTP logs). Audit event types added (extends
`audit_event_type` enum):

- `visitor_profile_created`
- `visitor_profile_updated` — payload includes `{ before, after, diff }`
- `visitor_profile_soft_deleted`
- `visitor_profile_restored`

Each audit row carries the profile id, the acting guard, the traceId,
and the relevant payload fields. The frontend reducer surfaces the
audit row in the admin shell's audit log alongside Feature 1, 2, 3
events.

---

## 6. Frontend Surface

### Reducer actions

Additive — pre-Feature-4 callers are unaffected:

- `VISITOR_PROFILES_LOADING` / `VISITOR_PROFILES_LOADED` / `_FAILED`
- `VISITOR_PROFILE_CREATED` / `_FAILED`
- `VISITOR_PROFILE_UPDATED` / `_FAILED`
- `VISITOR_PROFILE_DELETED` / `_FAILED`
- `VISITOR_PROFILE_RESTORED` / `_FAILED`

### Controller

A new `visitorProfilesApi` boundary, dependency-injected like
`approvalApi` / `notificationsApi`. Test boundary: harness stubs
`controller.visitorProfilesApi`.

### UI

A new **Visitors** subview in the Admin shell with:

- A paginated list of active profiles (visitor name, host, unit, plate,
  phone, watch flag, notes preview).
- A "Create profile" form with the same fields and inline validation.
- An "Edit" dialog for each row.
- A "Delete" confirmation (soft-delete only; no hard delete).
- A "Deleted" tab showing soft-deleted profiles with a "Restore" action.
- Watch-flagged profiles render with a destructive-accent border + WATCH
  pill, mirroring Feature 3's AUTO pill discipline.

---

## 7. Default-Deny Trustless Contract

Per Trustless-System-Auditor: there is no way for an unauthorized actor
to mutate a profile, and there is no way for a mutation to silently
succeed without an audit row.

| Defense | Enforced where |
|---|---|
| Guard tokens cannot create / update / delete / restore | `requireRole` middleware on every mutation route |
| Service never accepts plaintext fields longer than the contract bounds | CHECK constraints in DB + Zod schema in handler |
| Soft-delete inconsistency (one of `deleted_at` / `deleted_by_guard_id` set, other not) | CHECK constraint |
| Two active profiles for the same identity | Partial UNIQUE index |
| Update with an empty patch | Service returns 200 with the unchanged profile — does NOT write an audit row |
| Audit row missing after a mutation | Mutation + audit row are wrapped in `db.transaction()`; both commit or neither does |
| Frontend silently lands "deleted" on a 4xx response | Reducer + controller refuse to apply state changes on any non-2xx response |

---

## 8. Audit Harness Scenarios (V1–V5)

Per the no-silent-success contract, each scenario exercises one
externally-observable behavior on the **real** `<GatePassApp />` with a
stubbed `visitorProfilesApi`.

| ID | Scenario | Stub | UI assertion |
|---|---|---|---|
| V1 | `visitor-create-ok` | POST → 201 + profile | Toast "Profile created", row visible in list |
| V2 | `visitor-update-ok` | PATCH → 200 + updated profile | Row updates inline, watch flag re-renders |
| V3 | `visitor-delete-ok` | DELETE → 204 | Row vanishes from active list, appears in Deleted tab |
| V4 | `visitor-create-409` | POST → 409 PROFILE_DUPLICATE | Error banner with code visible, no row added |
| V5 | `visitor-create-403` | POST → 403 GUARD_CANNOT_MUTATE_PROFILES | Error banner with code visible, no row added |

---

## 9. Migration

`drizzle/0005_visitor_profiles.sql`:

```sql
CREATE TABLE visitor_profiles (...);  -- columns as in §2
-- Partial UNIQUE on lower(name, host, unit) WHERE deleted_at IS NULL
-- Indices
-- CHECK constraints
ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS 'visitor_profile_created';
ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS 'visitor_profile_updated';
ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS 'visitor_profile_soft_deleted';
ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS 'visitor_profile_restored';
```

Rollback: `DROP TABLE visitor_profiles`; the four audit_event_type values
remain harmlessly unused (PostgreSQL doesn't allow removing enum
values).

---

## 10. Test Counts (target)

- Server: +35 tests (service create/update/list/get/softDelete/restore +
  validation + RBAC + audit-row coverage).
- Frontend: +20 tests (reducer +8, controller +6, UI panel +6).
- Audit harness: 5 new scenarios (V1–V5).

---

## 11. Slices

Each slice is one commit, tested before the next:

1. **Slice 0** — This spec.
2. **Slice 1** — DB migration + schema definition.
3. **Slice 2** — Backend service `visitor-profile-service.ts` + tests.
4. **Slice 3** — Backend routes + RBAC + tests.
5. **Slice 4** — API client + types + tests.
6. **Slice 5** — Reducer actions + tests.
7. **Slice 6** — Controller integration + tests.
8. **Slice 7** — UI surface (Admin "Visitors" subview) + tests.
9. **Slice 8** — Audit harness V1–V5 + test plan section.

---

## 12. Open questions / future work

- **Phone number wiring into Feature 2.** This spec adds the field
  but does not change Feature 2's delivery path (which reads phone from
  the walk-in draft). A follow-up can teach Feature 2 to prefer the
  profile's phone when the visitor matches a profile.
- **Search panel integration.** The recognized-visitors endpoint
  (`/api/visitors/recognized`) still derives its list from entry history.
  A future slice can left-join profiles to surface watch flags and
  notes inline in the search results.
- **Merge / dedupe.** Two profiles for the same person under different
  spellings is real. Out of scope here; needs its own state machine.

---

## 13. Idea-Refine notes (what we intentionally did NOT build)

- **A "blocked" status** that prevents entry. Considered, rejected:
  blocking is a guard's decision at the moment of entry (override
  flow), not a static profile field. A watch flag is enough signal —
  the guard reads it and decides. Building "blocked" would create a
  silent-deny surface ("the profile blocked them" with no human in the
  loop), which is worse than the silent-allow we're already guarding
  against.
- **Per-profile permission overrides.** "This visitor is pre-approved
  for unit 18B but not 18C." Rejected: scope creep into the
  auto-approval engine. Auto-approval rules already model that and a
  profile shouldn't duplicate them.
- **Profile versioning.** Considered keeping every version of every
  profile. Rejected: audit events with `{before, after, diff}` payloads
  already give a reconstructable history without doubling the storage
  footprint of every edit.
