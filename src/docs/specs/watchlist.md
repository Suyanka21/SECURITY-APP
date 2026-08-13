# Feature 12 — Watchlist (Stage 5)

Source prompt: "Admin/estate-manager only can add someone to a watchlist
(reuse existing `requireRole` — no new role logic). Reason is mandatory on
creation and stored, not a boolean flag. At entry, a match shows the guard a
warning with the reason and requires escalation to a supervisor — the system
never auto-denies entry on its own. Watchlist entries need a review/expiry
mechanism, not permanence by default — spec exactly how (fixed TTL vs.
required periodic re-confirmation) and flag the tradeoff before building."

## 1. Scope

In scope:

- A watchlist of subjects (by normalized name, optional plate) that a guard
  should be warned about at entry time.
- Admin / senior-guard managed CRUD (reuse `requireRole("admin",
  "senior-guard")` — no new role logic; senior-guard is the estate-manager /
  supervisor tier already used for every other privileged endpoint).
- A **mandatory free-text reason** stored on every entry (not a boolean).
- At entry (walk-in create, QR validate, PIN validate) a match returns a
  **soft warning** carrying the reason. Entry is **never auto-denied**.
- **Supervisor escalation**: proceeding past a watchlist warning requires an
  explicit supervisor acknowledgement, reusing the existing override
  mechanism (`override_events`) rather than inventing a new one.
- A **review/expiry mechanism** so entries are not permanent by default
  (exact mechanism is the open decision in §7 — flagged before building).
- Audit events on add / match / escalate / remove / expire.

Out of scope:

- Auto-denial or hard blocking of any kind (explicitly forbidden).
- New roles or role logic.
- Fuzzy/AI name matching (v1 uses deterministic normalized equality).
- Resident-visible watchlist surfaces.

## 2. Data model — new table `watchlist_entries`

| column | type | notes |
|---|---|---|
| `id` | uuid PK | server-generated |
| `subject_name` | text, not null | stored normalized (see §4) for matching |
| `subject_name_display` | text, not null | original casing for display |
| `subject_plate` | text, nullable | normalized plate (reuse `normalizePlate`), optional |
| `reason` | text, not null, CHECK length 1..500 | MANDATORY — never a boolean |
| `status` | text, not null, default `active`, CHECK in (`active`,`removed`) | no `expired` — Option 2 never auto-drops an entry (§7) |
| `added_by_guard_id` | uuid, not null, FK guards(id) | from verified JWT, never body |
| `last_reviewed_at` | timestamptz, not null | = `created_at` at creation; reset on reconfirm |
| `review_due_at` | timestamptz, not null | `last_reviewed_at + 90 days`; overdue is **derived**, not a stored status |
| `removed_by_guard_id` | uuid, nullable, FK guards(id) | set when status→removed |
| `removed_reason` | text, nullable | required when removing |
| `created_at` / `updated_at` | timestamptz, not null | standard |

A CHECK enforces removal coherence: `status='removed'` requires both
`removed_by_guard_id` and `removed_reason`; `status='active'` requires both to
be NULL. Indexes: `(subject_name)` and `(subject_plate)` for the entry-time
lookup; `(status, review_due_at)` for the overdue-review query. RLS enabled (default-deny), consistent with
every other table; the server connects as table owner and bypasses RLS.

## 3. API

All management endpoints: `requireAuth → strictLimiter → requireRole("admin",
"senior-guard")`. Guard identity always from the verified JWT.

- `POST /api/watchlist` — create. Body `{ subjectName, subjectPlate?, reason }`.
  `reason` mandatory (422 `WATCHLIST_INVALID_INPUT` if missing/blank/too long).
  Emits `watchlist_entry_added`.
- `GET /api/watchlist?status=active|removed|all&needsReview=true` —
  list for the admin management view; each row carries a derived
  `reviewOverdue` flag.
- `PATCH /api/watchlist/:id` — reconfirm (resets `last_reviewed_at` /
  `review_due_at`) and/or edit `reason`. Emits `watchlist_entry_reviewed`.
- `DELETE /api/watchlist/:id` — soft remove (`status=removed`, requires
  `removedReason`). Emits `watchlist_entry_removed`. No hard delete (audit).

Entry-time matching (no new endpoint — augments existing responses):

- `POST /api/entries`, `POST /api/entries/qr/validate`,
  `POST /api/entries/pin/validate` gain an optional response field:

  ```ts
  watchlistMatch?: {
    matched: true;
    entryId: string;      // watchlist_entries.id
    reason: string;       // the stored mandatory reason
    matchedOn: "name" | "plate" | "name+plate";
    requiresEscalation: true;
  }
  ```

  The presence of `watchlistMatch` is a **warning only** — the entry/scan
  still succeeds with its normal payload. Emits `watchlist_matched`
  (payload: watchlist entryId, matchedOn, guardId, traceId — never anything
  sensitive beyond the already-stored reason).

Escalation: when `watchlistMatch` is present, the guard UI must require an
explicit **supervisor override** before the entry is finalized. This reuses
the existing override flow (`override_events` + `override_authorized` /
`override_rejected`); the watchlist reason is shown in the override prompt.
The system records who escalated and the supervisor decision; it still never
auto-denies — a supervisor may authorize entry.

## 4. Matching semantics

Deterministic, case/space-insensitive equality (no fuzzy matching in v1):

- Name: `subject_name` compared against a normalized visitor name
  (trim → collapse internal whitespace → uppercase). Store normalized +
  display forms.
- Plate: when the watchlist entry has a plate AND the entry has a plate,
  compare using the existing `normalizePlate` (reuse Feature 10 helper).
- Match precedence for `matchedOn`: `name+plate` > `plate` > `name`.
- Only `status = active` entries can match. An overdue-for-review entry is
  still active and still matches (§7) — review state never silences a warning.

## 5. Frontend

- **Admin management panel** (admin/senior-guard): list + add form (reason is
  a required textarea with a visible "required" affordance and character
  counter), review/reconfirm action, remove action (reason required). Loading
  / empty / error states; keyboard accessible; no color-only signalling
  (icon + text for status).
- **Guard entry surface**: when `watchlistMatch` is returned, render a
  prominent `role="alert"` warning banner naming the reason and stating
  "This does not block entry — escalate to a supervisor to proceed." The
  proceed/Log-entry control triggers the supervisor override flow rather than
  logging directly. The warning is text+icon, never color alone.

## 6. Audit events (append-only)

New `audit_event_type` values: `watchlist_entry_added`, `watchlist_matched`,
`watchlist_entry_reviewed`, `watchlist_entry_removed`. (No `..._expired` — under
the chosen model in §7 nothing ever expires on its own.) Payloads carry the watchlist entryId, matchedOn,
guardId, and traceId. Escalation reuses existing `override_authorized` /
`override_rejected`.

## 7. Review / expiry mechanism — DECIDED: Option 2

**Decision (approved by the product owner before implementation): Option 2 —
required periodic re-confirmation, 90-day interval.** Option 1 is retained
below only to document the rejected alternative and the tradeoff.

The prompt requires entries to be non-permanent and asks us to choose between
a **fixed TTL** and **required periodic re-confirmation**, and to flag the
tradeoff. Both satisfy "not permanent by default"; they fail differently.

### Option 1 — Fixed TTL (auto-expire)

Each entry gets `expires_at = created_at + TTL` (proposed default **90 days**).
A lightweight sweep (and a lazy check at match time) flips lapsed entries to
`status = expired`; expired entries stop matching. Admins can re-add.

- Pros: self-cleaning, dead simple, guarantees no stale-forever entries, no
  ongoing process burden.
- **Cons (the danger): a genuinely dangerous subject silently falls off the
  list when the timer elapses and nobody re-adds them.** Silent loss of a
  security control is the worst failure mode for this feature.

### Option 2 — Required periodic re-confirmation (recommended)

Entry stays `active` indefinitely but carries a **review due date**
(`last_reviewed_at + REVIEW_INTERVAL`, proposed **90 days**). When overdue, the
entry is flagged **"review overdue"** in the admin list (and
`GET ...?needsReview=true` surfaces them) — but it **keeps warning guards**
until an admin either reconfirms (resets the clock, emits
`watchlist_entry_reviewed`) or explicitly removes it.

- Pros: forces human accountability; a dangerous entry is **never silently
  dropped** — it nags instead of disappearing. Matches the product's
  "never auto-deny / human-in-the-loop" philosophy.
- Cons: requires the review UI + surfacing overdue items; entries can pile up
  if admins ignore reviews (mitigated by the overdue badge / filter).

### Rationale for the accepted option

**Option 2 (required periodic re-confirmation), 90-day interval.** For a
security watchlist, silently ceasing to warn (Option 1's failure) is more
dangerous than an overdue entry that keeps warning until a human acts. This
also mirrors the escalation model — the system surfaces and defers to a human,
never silently changes a safety outcome on its own.

### As built

- `WATCHLIST_REVIEW_INTERVAL_DAYS = 90`.
- On create: `last_reviewed_at = now`, `review_due_at = now + 90d`.
- On reconfirm (`PATCH`): both are reset from `now`.
- Overdue is **derived** (`review_due_at < now`), never a stored status and
  never a background job — so there is no sweep that can silently fail and no
  state that can drift out of sync with the clock.
- **An overdue entry still matches and still warns.** Overdue only changes how
  it is presented to admins (`reviewOverdue: true` + the `needsReview` filter).
  The only way an entry stops warning is an explicit human removal with a
  reason, which is audited.

## 8. Acceptance criteria

- Only admin/senior-guard can create/list/modify/remove watchlist entries;
  guard tokens get 403.
- Reason is mandatory and stored as text on every entry; blank/oversized
  rejected at the boundary.
- A matching entry at walk-in / QR / PIN returns `watchlistMatch` with the
  reason; the entry/scan still succeeds (never auto-denied).
- Proceeding past a match requires the supervisor override flow; the decision
  is audited.
- Entries are not permanent by default per the §7 decision; the chosen
  mechanism is covered by tests.
- Every add / match / review / remove / expire emits its audit event;
  no sensitive data beyond the already-stored reason enters payloads.
