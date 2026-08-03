# Feature 11 — One-Time PIN Backup (Stage 4)

Status: Accepted · Stage 4 of the GatePass v1 consolidated scope.
Decision: **Option A** (pass-reference + PIN, per-pass lockout) — confirmed by
the project owner.

## 1. Problem

A QR pass is the only way to redeem a pre-approved visit today. If the guard's
scanner is unavailable or the visitor's phone is dead, there is no fallback and
the guard must fall back to a manual override (which weakens the audit trail).
We want a **6-digit PIN** issued alongside every QR pass as an alternate way to
redeem the **same** `authorization_decisions` record, with brute-force
protection that is mandatory — the feature does not ship without the limiter.

## 2. Scope

- IN: at invitation issue, mint a 6-digit PIN + a short, human-typable **pass
  reference** alongside the existing QR token; a guard redemption endpoint that
  accepts `{ passRef, pin }`; **per-pass lockout** after repeated wrong PINs;
  audit of every PIN redemption / failure / lockout; PIN expiry = QR expiry;
  redeeming by QR **or** PIN invalidates both (shared `is_used`).
- OUT: no SMS/email delivery of the PIN (it surfaces once in the issue response,
  same discipline as the raw QR token); no PIN reset/rotation; no change to the
  QR validation path's contract; no new role logic.

## 3. Why a pass reference (Option A)

A bare 6-digit PIN is not globally unique, so it cannot identify a pass on its
own, and "lock the pass after N wrong guesses" requires attributing failures to
a specific pass. So redemption is keyed on a short, **non-secret** pass
reference (like a ticket number), and the PIN is the secret verified against
that pass:

- `passRef` — 8 chars, Crockford base32 (no `I L O U`), unique among passes.
  Not a secret; identifies the record. Shown on the issued pass + visitor pass
  page so the visitor can read it to the guard.
- `pin` — 6 digits, the secret. Stored only as
  `HMAC-SHA256(PIN_PEPPER, "<decisionId>:<pin>")` (hex). The per-record id salts
  the hash; the server-side `PIN_PEPPER` (never in the DB) defeats offline brute
  force even if the DB leaks. 10^6 space is safe because the limiter caps online
  guessing at 5 per pass.

## 4. Data model (migration `0012_one_time_pin.sql`)

Add to `authorization_decisions` (all nullable / defaulted → back-compat with
existing rows, which simply have no PIN):

| column                | type                       | notes                                    |
|-----------------------|----------------------------|------------------------------------------|
| `pass_ref`            | `text` UNIQUE              | short identifier; NULL for legacy rows   |
| `pin_hash`            | `text`                     | `HMAC(pepper, id:pin)`; never the PIN    |
| `pin_failed_attempts` | `integer NOT NULL DEF 0`   | consecutive wrong PINs for this pass     |
| `pin_locked_until`    | `timestamptz`              | non-null + future ⇒ pass is locked       |

`audit_event_type` gains `pin_redeemed`, `pin_failed`, `pin_locked`
(`ALTER TYPE ... ADD VALUE IF NOT EXISTS`, non-destructive).

## 5. Issue (extends `issueVisitorInvitation`)

Order (atomic — id is generated up front so the PIN hash can be salted with it):

1. Mint raw QR token (unchanged) + its SHA-256 hash.
2. Generate `decisionId = randomUUID()`.
3. Generate `pin` = 6 random digits (`crypto.randomInt`), `passRef` = 8 base32.
4. `pinHash = HMAC(PIN_PEPPER, "<decisionId>:<pin>")`.
5. INSERT the row with the explicit id + `pass_ref` + `pin_hash`
   (`pin_failed_attempts=0`, `pin_locked_until=null`). `expires_at` is the same
   value the QR uses, so **PIN expiry = QR expiry** by construction.
6. Emit `qr_invitation_issued` (unchanged; payload never carries the PIN/hash).
7. Response adds `pin` and `passRef` to the `invitation` object — the raw PIN
   leaves the server **exactly once**, same as the QR token.

If `PIN_PEPPER` is unset the issue fails loud (`INTERNAL_ERROR`) — no insecure
fallback secret.

## 6. Redeem (`POST /api/entries/pin/validate`)

Auth: `requireAuth` + `strictLimiter` + guard identity from the JWT (never the
body), mirroring the QR route. Body: `{ passRef, pin, scannedAt }`.

Decision flow (default-deny; each branch audits):

1. Guard not active → `403 GUARD_SESSION_EXPIRED`.
2. Look up by `pass_ref`. Not found → `404 PIN_NOT_FOUND`, audit `pin_failed`
   (reason `PIN_NOT_FOUND`, no pass to lock).
3. Already used → `409 PIN_REPLAYED` (QR or PIN already consumed this record).
4. Locked (`pin_locked_until` in the future) → `423 PIN_LOCKED`, audit
   `pin_failed` (reason `LOCKED`). PIN is not even checked.
5. Expired (`expires_at` ≤ now) → `410 PIN_EXPIRED`.
6. No PIN on file (legacy row) → `404 PIN_NOT_FOUND`.
7. Verify `HMAC(pepper, id:pin)` with `timingSafeEqual`:
   - **Mismatch** → `pin_failed_attempts += 1`; if it reaches
     `MAX_PIN_ATTEMPTS (5)` set `pin_locked_until = now + LOCK_WINDOW_MS (15m)`
     and audit `pin_locked`. Audit `pin_failed` (reason `PIN_INVALID`,
     `attemptsRemaining`). Return `401 PIN_INVALID` with `attemptsRemaining`.
   - **Match** → set `is_used=true, used_at, used_by_guard_id`, reset
     `pin_failed_attempts=0`. This **invalidates the QR too** (shared row).
     Audit `pin_redeemed`. Return `200` with the **same `QrValidateResponse`
     shape** as the QR path so the frontend reuses the confirmation screen.

Hard rules:

- A mismatch **never** silently succeeds; the limiter ships in this same PR.
- No audit payload ever contains the PIN or `pin_hash` — only `passRef`,
  `preApprovalId`, reason, and counters.
- Lockout is checked **before** the PIN is verified, so a locked pass cannot be
  brute-forced further even with the correct PIN until the window elapses.

## 7. Frontend

- Guard QR-scan panel gains a "Use PIN instead" sub-form (`passRef` + 6-digit
  `pin`). On success it dispatches the same `QR_SCAN_SUCCEEDED` path (visitor
  data + `expectedPlate`) so vehicle verification (Feature 10) still applies.
- Errors surface the code + message; `PIN_LOCKED` and `attemptsRemaining` are
  shown so the guard understands the lockout (they are the authenticated user,
  not the attacker).
- Admin issue success card shows the `passRef` + `pin` once, next to the QR,
  with a "shown once" caveat. Visitor pass page shows the `passRef` (not the
  PIN — the visitor already has that from the issuer).

## 8. Acceptance criteria

1. Issuing an invitation returns a 6-digit `pin` and an 8-char `passRef`; the DB
   row stores only `pin_hash` (never the PIN) and shares `expires_at` with QR.
2. Correct `{ passRef, pin }` redeems the record, returns visitor data, and
   flips `is_used` — a subsequent QR scan of the same token is `QR_REPLAYED`.
3. Redeeming by QR first makes the PIN return `PIN_REPLAYED`.
4. Wrong PIN increments the per-pass counter and returns `PIN_INVALID` with
   `attemptsRemaining`; it never blocks the guard from retrying until the cap.
5. On the 5th wrong PIN the pass locks (`pin_locked_until` set, `pin_locked`
   audited); further attempts return `PIN_LOCKED` without checking the PIN,
   even if the correct PIN is supplied.
6. Expired pass → `PIN_EXPIRED`; unknown `passRef` → `PIN_NOT_FOUND`.
7. Every redemption / failure / lockout writes an audit row with no PIN/hash.
8. Existing QR validation, replay-prevention, and issue flows are unchanged
   apart from the additive PIN fields.
