# Spec — Resident Approval Flow (Feature 1)

> Status: **DRAFT v1** — assumptions are open to revision until first
> code lands. After Commit 1 (this spec) is merged, changes require an
> ADR.
>
> Scope: This spec ONLY covers the resident approval flow. Notification
> delivery (WhatsApp/SMS) is Feature 2 — out of scope here.

---

## 1. Problem Statement

The current frontend has no path for the "request approval" branch of
the user flow in `GATEPASS DEFINITION.md §USER FLOW.2.B`:

> System decides: auto-approve OR **request approval** OR fallback call

A guard handling a walk-in for a visitor whose host hasn't pre-approved
them has no way to ask the resident for a decision. Today the guard
either uses Manual Override (logged, accountable, but bypasses the
resident) or denies entry. Neither matches the DEFINITION's intent.

This feature adds the manual approval path: guard requests a decision,
resident makes a decision via a single-use magic link, entry is logged
(or explicitly blocked) according to that decision.

## 2. Goals

1. The guard can request a resident's approval from the walk-in form.
2. The resident can approve or deny on their phone in under 30 seconds,
   with no app install and no login.
3. Every decision is audited: who requested, who decided, when, and from
   which IP (resident side).
4. A timeout closes pending requests so they cannot linger and become a
   silent-success surface (no entry created from a "pending" state).
5. The guard's UI always reflects the real backend state — no
   simulated success, no fake "approved" screens.

## 3. Non-Goals (Out of Scope for This Feature)

- Delivering the magic link via WhatsApp/SMS — that is Feature 2. In
  this feature the link is displayed in the guard's UI (with a "copy"
  button and a QR code rendering of the URL). The guard can hand their
  phone to the resident or have the resident scan the QR code.
- Auto-approval (Feature 3).
- Resident account management / login (a magic-link is the only auth).
- Push notifications to a resident app — there is no resident app.

## 4. Assumptions (Surfaced Per Spec-Driven-Development Skill)

| # | Assumption | Validation strategy |
|---|---|---|
| A1 | Residents have a phone capable of opening a URL or scanning a QR code. If they don't, the guard falls back to Manual Override (already supported). | Acceptable trade-off for v1. |
| A2 | A 5-minute approval timeout is acceptable given the DEFINITION's "speed of entry" requirement (5–10s entry, with approval as a special case). Configurable per deployment via `APPROVAL_TIMEOUT_SECONDS`. | Make configurable; default 300s; covered by a reducer test. |
| A3 | Polling every 2 seconds from the guard's UI is good enough for v1. SSE/WebSocket transport is a separate ADR if latency becomes an issue. | Reducer + controller don't know about transport — easy to swap later. |
| A4 | The host's identity (name + unit) is enough to scope an approval request. We don't need a normalized resident table until Feature 4 (Visitor profile CRUD). | The approval row stores `host` and `unit` as text, same shape as `entry_records`. |
| A5 | The magic-link page must be reachable WITHOUT a JWT. The token in the URL IS the auth. The token is single-use and short-lived. | Token is 32 random bytes, base64url-encoded; server stores only SHA-256 hash. |
| A6 | Once approved, the entry is created by the BACKEND (not by a follow-up call from the guard). This avoids a race where the guard's network drops between "approved" and "submit entry". | Backend `approve` endpoint creates the entry transactionally. |

If any assumption is wrong, this spec gets an ADR before code changes.

## 5. State Machine

```
        ┌───────────────────────┐
        │  IDLE (walk-in form)  │
        └───────────┬───────────┘
                    │ guard clicks "Request approval"
                    ▼
        ┌───────────────────────┐
        │ APPROVAL_REQUESTING   │  (POST /api/approvals in flight)
        └───────────┬───────────┘
                    │
       ┌────────────┼────────────┐
       │            │            │
   422/400      success      transport
       │            │       error / 5xx
       ▼            ▼            ▼
 ┌──────────┐ ┌────────────┐ ┌──────────┐
 │  ERROR   │ │ AWAITING   │ │  ERROR   │
 │ (block)  │ │ APPROVAL   │ │ (block)  │
 └──────────┘ └──────┬─────┘ └──────────┘
                    │
                    │ poll every 2s
                    ▼
        ┌───────────────────────┐
        │ APPROVAL_POLLED       │
        │ status: pending |     │
        │ approved | denied |   │
        │ expired               │
        └───────────┬───────────┘
                    │
       ┌────────────┼────────────┬────────────┐
       │            │            │            │
   pending     approved       denied      expired
       │            │            │            │
       │ (keep      ▼            ▼            ▼
       │  polling) CONFIRMED   ERROR        ERROR
       │           (entry      (banner:     (banner:
       │            logged     "Resident    "Request
       │            by         denied")     expired —
       │            backend                  re-request
       │            during                   or use
       │            approve)                 override")
       │
       ▼
   (continues polling until terminal state or timeout)
```

Terminal states: `confirmed`, `error`. No state where an entry can be
created without going through this machine.

## 6. Reducer Additions

New action types (additive — do not break existing lifecycle):

```ts
| { type: "APPROVAL_REQUEST_STARTED" }
| { type: "APPROVAL_REQUEST_SUCCEEDED"; request: ApprovalRequestView }
| { type: "APPROVAL_REQUEST_FAILED"; error: GatePassError }
| { type: "APPROVAL_POLLED"; request: ApprovalRequestView }
| { type: "APPROVAL_RESOLVED"; entry: EntryRecord }   // approved + entry logged
| { type: "APPROVAL_DENIED"; reason: string }
| { type: "APPROVAL_EXPIRED" }
```

`GatePassMode` gains: `awaiting-approval`.

`GatePassState` gains:

```ts
pendingApproval?: {
  id: string;
  draft: EntryDraft;           // the walk-in draft that triggered it
  magicLinkUrl: string;        // shown to the guard
  expiresAt: string;           // ISO; UI renders a countdown
  status: "pending" | "approved" | "denied" | "expired";
  decidedAt?: string;
  deniedReason?: string;
  traceId: string;
};
```

## 7. Backend Endpoints

### 7.1 `POST /api/approvals` (guard auth, strict rate-limited)

Request:
```ts
{
  draft: EntryDraft;
  guardId: string;
  offlineId: string;        // same UUID used for the deferred entry
  hostContactHint?: string; // free-form; saved for audit, never displayed
}
```

Response (201):
```ts
{
  approvalId: string;
  magicLinkUrl: string;       // contains the raw token, shown ONCE
  expiresAt: string;          // ISO 8601
  traceId: string;
}
```

Server side:
- Generate `token = crypto.randomBytes(32).toString("base64url")`
- Store `SHA-256(token)` only
- Insert `approval_requests` row with `status = "pending"`, `expires_at = now + APPROVAL_TIMEOUT_SECONDS`
- Emit audit event `approval_requested`

### 7.2 `GET /api/approvals/:id/status` (guard auth)

Response (200):
```ts
{
  approvalId: string;
  status: "pending" | "approved" | "denied" | "expired";
  expiresAt: string;
  decidedAt?: string;
  deniedReason?: string;
  entry?: EntryRecord;        // present only when status === "approved"
  traceId: string;
}
```

If `expires_at < now` and status is still `pending`, the server lazily
flips it to `expired` on read AND on next `POST /:id/decide`. This means
there is no window where the guard sees `pending` past the deadline.

### 7.3 `POST /api/approvals/:id/decide` (no JWT — magic-link auth)

Request:
```ts
{
  token: string;                       // raw token from the magic link
  decision: "approve" | "deny";
  reason?: string;                     // required when decision = deny
}
```

Validation order (all returning 4xx with a specific code, never 5xx):
1. `token` hashes to a row → else 401 `APPROVAL_TOKEN_INVALID`
2. Row's `status === "pending"` → else 409 `APPROVAL_ALREADY_DECIDED`
3. `expires_at > now` → else 410 `APPROVAL_EXPIRED`
4. If `decision === "deny"`: `reason` non-empty → else 422 `APPROVAL_REASON_REQUIRED`

On approve:
- Transactionally: flip status, insert `entry_records` row (method =
  `walk-in`, with `pre_approval_id` linking to this approval), insert
  audit event `approval_approved`, return the new entry.

On deny:
- Flip status to `denied`, record `denied_reason` (sanitized), insert
  audit event `approval_denied`, return 200 with the decision row.

Single-use: after a successful decision, the token hash is wiped from
the row so a replay returns `APPROVAL_ALREADY_DECIDED`.

## 8. DB Migration

New table `approval_requests`:

```sql
CREATE TABLE approval_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offline_id      uuid NOT NULL UNIQUE,           -- ties to deferred entry
  visitor_name    text NOT NULL,
  host            text NOT NULL,
  unit            text NOT NULL,
  plate           text,
  reason          text,
  method          entry_method NOT NULL,           -- always 'walk-in' in v1
  requested_by_guard_id uuid NOT NULL REFERENCES guards(id),
  token_hash      text UNIQUE,                     -- nullable after decision (single-use)
  status          text NOT NULL CHECK (status IN ('pending','approved','denied','expired')),
  decided_at      timestamptz,
  denied_reason   text,
  entry_id        uuid REFERENCES entry_records(id),
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  trace_id        text NOT NULL
);

CREATE INDEX approval_requests_status_idx ON approval_requests (status, expires_at);
CREATE INDEX approval_requests_guard_idx ON approval_requests (requested_by_guard_id);
```

CHECK constraint: rows with `status = 'approved'` must have `entry_id`
populated; rows with `status = 'denied'` must have `denied_reason`.

## 9. Security Considerations

Source: `Security-and-Hardening SKILL.md`.

| Concern | Mitigation |
|---|---|
| Magic-link token guessable | 32 bytes of `crypto.randomBytes` = 256 bits of entropy. SHA-256 hash stored. |
| Replay after decision | Token hash wiped after first successful `decide`. Re-submission returns 409. |
| Token leaked in logs | Raw token NEVER logged. Only `traceId` and `approvalId`. |
| Brute force on `/decide` | Strict per-IP rate limit (10/min). |
| CSRF on `/decide` | No cookies in scope; token is the auth. POST with explicit `Content-Type: application/json` only. |
| XSS in `deniedReason` | Sanitize on input (strip control chars, trim, length cap 200). Render as text, never HTML. |
| Approval bound to wrong guard | `requested_by_guard_id` is set from the JWT, not the request body. |
| Approval used by wrong entry | `offline_id` is unique per approval; backend rejects re-use. |
| Late approval past deadline | Server checks `expires_at > now` on every read AND every decision. No client-side trust. |

## 10. UI

Guard side:

- Walk-in form gets a "Request approval" button next to "Log entry".
- Clicking it transitions to `awaiting-approval` mode.
- Awaiting screen shows:
  - Visitor name + host + unit (read-only)
  - Magic link URL with a Copy button
  - QR code rendering of the URL (using existing `qrcode` lib or
    server-rendered SVG)
  - Countdown timer (mm:ss) until `expiresAt`
  - "Cancel request" button
  - Real-time status indicator (poll every 2s; show "Last checked: …")
- On `approved`: transition to `confirmed` with the entry record visible.
- On `denied`: transition to `error` with `banner.tone = "danger"` and
  the `deniedReason` visible.
- On `expired`: transition to `error` with `banner.tone = "warning"` and
  a "Request again or use Manual Override" suggestion.

Resident side (`/approve/:approvalId?token=...`):

- Single-screen, mobile-first, no app chrome.
- Shows: "Hi! `<visitorName>` is at the gate requesting to visit
  `<host>` at unit `<unit>`."
- Two buttons: `[Approve]` `[Deny]`
- Deny opens a small textarea for reason (required).
- On submit: shows "Done. The guard has been notified." No back button
  needed; the page is dead after the decision.
- If `expired` or `already decided` on first load: explicit message,
  no buttons.

Accessibility:
- Both screens hit WCAG AA contrast.
- Buttons are large (min 44×44 px touch target).
- Countdown is announced to screen readers via `aria-live="polite"`.

## 11. Testing Strategy

Per `Test-Driven-Development SKILL`:

**Reducer tests (`gatepassReducer.test.ts`):**
- `APPROVAL_REQUEST_STARTED` flips to `awaiting-approval`, clears
  lastError, sets inFlight.
- `APPROVAL_REQUEST_SUCCEEDED` stores `pendingApproval`.
- `APPROVAL_REQUEST_FAILED` flips to `error` with the right banner.
- `APPROVAL_POLLED` updates `pendingApproval.status` without losing
  draft.
- `APPROVAL_RESOLVED` logs the entry (mirrors `ENTRY_SUCCEEDED`).
- `APPROVAL_DENIED` flips to `error`, banner contains the reason.
- `APPROVAL_EXPIRED` flips to `error`, banner contains "expired".

**Service tests (server-side):**
- Creating an approval inserts a row with `status = pending`.
- Decision with invalid token returns 401 `APPROVAL_TOKEN_INVALID`.
- Decision past `expires_at` returns 410 `APPROVAL_EXPIRED`.
- Second decision on same approval returns 409 `APPROVAL_ALREADY_DECIDED`.
- Approve inserts the entry transactionally; rollback if entry insert
  fails (no half-state).
- `GET /:id/status` lazily flips expired pending rows on read.

**Controller tests (`useGatePassController.test.tsx`):**
- `requestApproval()` happy path.
- Polling stops after terminal state.
- 500 on poll surfaces as `APPROVAL_REQUEST_FAILED` but doesn't lose
  the pending request (retries on next poll).
- Cancel before decision: stops polling, returns to walk-in form.

**Audit harness scenarios (`audit/main.tsx`):**
- `approval-timeout` — backend returns `pending` forever; reducer
  flips to `error` once `expiresAt < now`.
- `approval-denied` — backend returns `denied` with reason; UI shows
  reason verbatim.
- `approval-approved-but-entry-write-fails` — `decide` returns 500;
  approval row remains `pending` (no half-state); guard sees error.

## 12. Open Questions (To Be Resolved Before First Implementation Commit)

None blocking. Assumptions A1–A6 are commitments unless an ADR overrides.

## 13. References

- `src/docs/GATEPASS DEFINITION.md` — §USER FLOW.2.B and §3 Authorization Layer
- `src/docs/gatepass-api-contract.md` — error code conventions, traceId
- `src/docs/remaining-features-rollout.md` — order + dependencies
- React useReducer — https://react.dev/reference/react/useReducer
- OWASP — magic-link best practices: short-lived, single-use, hashed at rest
