# Feature 9 — Guard Notes (Stage 2)

Status: Accepted · Stage 2 of the GatePass v1 consolidated scope.

## 1. Problem

Guards need to attach short, standardised context to an entry/exit record —
e.g. "Delivered parcel", "Left ID at gate", "Escorted by resident" — so the
context is reportable later. Free-typed strings are not aggregatable and leak
inconsistent data into the audit trail. We need predefined tags plus one
capped free-text escape hatch ("Other").

## 2. Scope

- IN: predefined enum-backed tags attached to an existing `entry_records` or
  `exit_records` row; one capped free-text field usable only with the `other`
  tag; surfacing notes wherever entry/audit data already appears.
- OUT: editing/deleting notes (append-only, audit discipline); resident-authored
  notes; per-tag reporting dashboards (the enum makes this possible later).

## 3. Data model

`guard_note_tag` enum: `delivered_parcel`, `left_id_at_gate`,
`escorted_by_resident`, `other`.

`guard_notes` table (migration `drizzle/0011_guard_notes.sql`):

| column      | type                      | notes                                   |
|-------------|---------------------------|-----------------------------------------|
| id          | uuid pk                   | server-generated                        |
| entry_id    | uuid fk → entry_records   | XOR with exit_id                        |
| exit_id     | uuid fk → exit_records    | XOR with entry_id                       |
| guard_id    | uuid fk → guards NOT NULL | who attached the note                   |
| tag         | guard_note_tag NOT NULL   | standardised                            |
| note_text   | text NULL                 | required iff tag='other', ≤280 chars    |
| trace_id    | text NOT NULL             | audit correlation                       |
| created_at  | timestamptz(3) NOT NULL   | server-generated                        |

DB-enforced invariants (CHECK constraints): exactly one target (entry XOR
exit); free text present + bounded (1..280) only for `other`, absent otherwise.
No CASCADE deletes.

## 4. API

Single error shape (`{ error: { code, message, field?, traceId } }`), validated
at the boundary with zod. RBAC enforced server-side.

- `POST /api/entries/:entryId/notes` — `requireAuth` (any guard) + rate limit.
  Body: `{ tag, text? }`. Attaches a note to a visitor/delivery entry.
- `POST /api/exits/:exitId/notes` — `requireAuth` (any guard) + rate limit.
  Body: `{ tag, text? }`. Attaches a note to an exit record.
- `GET  /api/entries/:entryId/notes` — `requireAuth`. Lists notes for an entry.

`guardId` always comes from the verified JWT, never the request body.

Errors: `GUARD_NOTE_INVALID_INPUT` (422), `GUARD_NOTE_TARGET_NOT_FOUND` (404).

## 5. Surfacing

Guard notes appear in the two places entry/audit data already appears:

1. **Audit trail** — every successful note writes a `guard_note_added` audit
   event carrying the note id, target, and tag (never the free text, which may
   contain PII). This surfaces in the existing audit stream automatically.
2. **On-premise panel** — `GET /api/entries/on-premise` now returns each
   entry's notes (tag + optional text), rendered as a Notes column so staff see
   context alongside the visitor.
3. **Guard confirmation screen** — right after logging an entry, the guard can
   attach a note to the just-created entry (the primary capture surface).

### Deliberate non-change: shift-log aggregation

`shift-log-service` documents a hard privacy invariant: "No PII (names, plates,
phones, notes) is read from entry_records or audit_events; only guard_id is
grouped on." We intentionally do NOT surface note text in the shift-log to
preserve that invariant. The audit stream and on-premise panel are the correct
surfaces. Per-tag reporting can be built later off the enum without touching the
shift-log privacy contract.

## 6. Security

- All input validated at the route boundary (zod).
- Parameterised Drizzle queries only.
- `guardId` from verified token identity, never the body.
- Free text capped (DB CHECK + zod) to bound storage and avoid abuse.
- Audit payload excludes free text (PII-safe).

## 7. Acceptance criteria

- [ ] A guard can attach a predefined-tag note to an entry; it persists.
- [ ] `other` requires non-empty text ≤280 chars; other tags reject text.
- [ ] Attaching to a non-existent entry/exit → 404, no row written.
- [ ] Every successful note writes exactly one `guard_note_added` audit event.
- [ ] Notes surface in the on-premise panel and audit stream.
- [ ] Server + frontend tests cover the above; lint/typecheck/build clean.
