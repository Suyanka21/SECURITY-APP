# Spec — Guest QR Ticket (Feature 6)

> Status: **DRAFT v1** — assumptions are open to revision until first
> code lands. After Slice 1 (this spec) is merged, changes require an
> ADR.
>
> Scope: This spec ONLY covers the visitor-facing QR credential lifecycle
> (issue → deliver → render → scan → consume). It deliberately reuses
> the existing `authorization_decisions` table + `qr-service.ts` rather
> than building a parallel system.

---

## 1. Problem Statement

Today the GatePass app has two approval paths and zero visitor-held credentials:

1. **Guard-initiated approval (Feature 1)**: visitor is at the gate; resident approves
   via magic-link; backend transactionally inserts an `entry_records` row.
2. **Auto-approval (Feature 3)**: resident-authored rule matches; backend auto-approves
   on the guard's scan.

Both paths confirm the visitor **at the moment of arrival**. Neither leaves a credential
in the visitor's hand. Real estates need a third path: **pre-arrival approval**, where
the resident issues a visitor invitation before the visitor arrives, the visitor receives
a QR pass, and the guard scans it on arrival without phoning the resident.

This is the operational gap ChatGPT's critique surfaced (their points 1 + 2 — "Pre-approved
visitors" + "QR Code Entry"). It is also the missing complement to the existing
`authorization_decisions` table, which the contract §3.1 already defined the verify side of
but for which we have no issue side.

## 2. Goals

1. An admin or senior-guard (acting on a resident's request, captured via name + unit)
   can issue a visitor invitation in under 60 seconds, producing a QR pass the visitor
   can show at the gate. A resident-self-service portal is a separate feature; v1's
   audience is the staff issuing on the resident's behalf.
2. The guard scanning the QR sees the same `Entry confirmed` panel as today — zero new UI
   on the guard side.
3. Every issued ticket has an explicit expiry. Expired QRs **never** create an entry.
4. Every QR is single-use. A replayed QR — including one that worked correctly five seconds
   ago — **never** creates a second entry.
5. The raw QR token leaves the server **exactly once**, at issue time. The server stores
   only the SHA-256 hash, matching the existing `qr-service.ts` discipline.
6. A tampered or malformed token surfaces an explicit error code (`QR_INVALID`,
   `QR_EXPIRED`, `QR_REPLAYED`, `QR_NOT_FOUND`) — never a silent success, never a generic
   "scan failed".

## 3. Non-Goals (Out of Scope for This Feature)

- **Resident self-service login.** v1 issues invitations from the existing admin shell
  using the same `requireRole('admin', 'senior-guard')` middleware that gates visitor-
  profile CRUD (Feature 4). A standalone resident portal with passwordless login is a
  separate feature.
- **Visitor identity verification at scan time** (face match, ID check). Out of scope.
  The QR is the credential; the guard is the verifier.
- **Push delivery of the QR.** The pass URL is returned to the issuer and shared by them
  (copy link, WhatsApp paste). Feature 2's notifications channel will be wired in as a
  follow-up slice if F2 is on `main`; not a blocker for F6 acceptance.
- **Recurring invitations** (e.g., weekly maid). v1 issues single-use tickets. Recurring
  is a separate feature.
- **QR rotation / re-issue** if lost. v1: revoke + issue a fresh one. No mid-life rotation.

## 4. Assumptions (Surfaced Per Spec-Driven-Development Skill)

| # | Assumption | Validation strategy |
|---|---|---|
| A1 | The existing `authorization_decisions` table is the right home for these tickets. It already has `qr_token_hash` UNIQUE, `expires_at`, `is_used`, `used_at`, `used_by_guard_id`, `created_at`. **No schema migration is required.** Tracing an invitation to its issuer is captured in the existing `audit_log` table (`qr_invitation_issued` event with `actorId`). | Schema verified against src/db/schema.ts lines 130-200; no slice 1 needed. |
| A2 | The existing `qr-service.validateQrToken` already covers verify with default-deny on `QR_NOT_FOUND` / `QR_REPLAYED` / `QR_EXPIRED`. No changes to verify; F6 only adds an **issue** path. | Code reading completed (src/server/services/qr-service.ts lines 1-100); existing audit-harness QR scenarios still pass after F6 lands. |
| A3 | The token is 32 random bytes, base64url-encoded — same shape as Feature 1's magic-link token. SHA-256 hashing matches the existing `hashQrToken` helper. | Cryptographic primitives reused verbatim. |
| A4 | Issuing role is `admin` OR `senior-guard` (same as Feature 4 visitor-profile CRUD; verified the actual `GuardRole` enum is `"guard" \| "senior-guard" \| "admin"` — no `resident` role exists in the auth layer). A standalone resident self-service portal is a separate feature. Audit harness stubs the auth boundary the same way Feature 4 and Feature 5 do. | Reuse `requireRole('admin', 'senior-guard')` middleware verbatim; add 1 routing test that 403s a regular guard token. |
| A5 | Default TTL is **24 hours**; configurable per invitation up to a 7-day cap. A guard-shift window is ~8 hours, so 24h covers same-day visits with margin. Beyond 7 days, the resident should re-issue. | `MAX_INVITATION_TTL_HOURS=168`; covered by service test. |
| A6 | The visitor's pass URL is unauthenticated. The token IN the URL is the auth, same as Feature 1's magic-link pattern. The pass page is read-only and renders the QR PNG client-side. | Token has 256 bits of entropy → unguessable. Pass page does NOT consume the QR — only display. Consumption happens on guard scan. |
| A7 | Pass URL format: `${PUBLIC_BASE_URL}/pass/${token}`. The pass page is a static React route that calls `GET /api/visitor-invitations/:token/preview` (read-only, returns only safe display fields: visitorName, host, unit, expiresAt, isUsed). It does NOT mark the QR as used. | Preview endpoint is idempotent and rate-limited. |
| A8 | The QR PNG is rendered **client-side** from the raw token. We do not store, log, or transmit the QR PNG. | Reduces server load + keeps the secret on the visitor's device. |

If any assumption is wrong, this spec gets an ADR before code changes.

## 5. Lifecycle

```
ISSUE                                          CONSUME
─────                                          ───────

[Resident/Admin]                               [Visitor at gate]
      │                                              │
      │ POST /api/visitor-invitations                │ shows QR on phone
      │                                              │
      ▼                                              ▼
┌──────────────────┐                          [Guard]
│ INVITATION_ISSUED│                                │
│ (in admin UI)    │                                │ scans with QR module
└──────┬───────────┘                                │
       │                                            ▼
       │ pass URL                            ┌──────────────────┐
       ▼                                     │ POST /api/entries│
[Visitor opens]                              │ /qr/validate     │
       │                                     └────────┬─────────┘
       ▼                                              │
GET /api/visitor-invitations/:token/preview           │
(read-only render — does NOT consume)                 │
       │                                              ▼
       ▼                                     [qr-service.validateQrToken]
[Pass page renders QR PNG]                            │
                                              ┌───────┴────────┐
                                              ▼                ▼
                                       valid + unused    invalid / expired
                                       / unexpired       / replayed
                                              │                │
                                              ▼                ▼
                                       mark is_used=true  ServiceError(
                                       insert entry row    QR_NOT_FOUND |
                                                           QR_EXPIRED |
                                                           QR_REPLAYED)
```

The consume side is **already implemented**. F6 only adds the issue + preview side.

## 6. Backend — Endpoints

### `POST /api/visitor-invitations` — Issue (resident/admin)

**Auth:** `requireAuth` + `requireRole('admin', 'senior-guard')`. Regular guard tokens → 403 `AUTH_FORBIDDEN`. Missing/expired token → 401 `AUTH_REQUIRED`.

**Request:**
```ts
{
  visitorName: string;     // required, 1-120 chars, trimmed
  host: string;            // required, 1-120 chars (resident's name)
  unit: string;            // required, 1-30 chars (e.g. "18B")
  plate?: string | null;   // optional, 1-12 chars uppercase
  ttlHours?: number;       // optional, default 24, min 1, max 168
}
```

**Validation:** Zod schema at boundary. All string fields trimmed; rejected if length out of bounds.

**Behavior (atomic, single transaction):**
1. Mint a raw token: `randomBytes(32).toString('base64url')`.
2. Hash it: `sha256(token).hex()`.
3. Compute `expiresAt = now + ttlHours * 3600 * 1000`.
4. Insert `authorization_decisions` row: `{ visitor_name, host, unit, plate, qr_token_hash, expires_at, is_used: false }`.
5. Insert `audit_log` row: `qr_invitation_issued` with traceId, hash (never raw), expiresAt.

**Response (201):**
```ts
{
  invitation: {
    id: string;             // authorization_decisions.id
    qrToken: string;        // raw — sent ONCE, never logged, never retrievable
    passUrl: string;        // ${PUBLIC_BASE_URL}/pass/${qrToken}
    visitorName: string;
    host: string;
    unit: string;
    plate: string | null;
    expiresAt: string;      // ISO 8601
  };
  traceId: string;
}
```

**Errors:**
| Code | Status | Trigger |
|---|---|---|
| `AUTH_REQUIRED` | 401 | Missing or expired JWT. |
| `AUTH_FORBIDDEN` | 403 | Regular guard token attempted issue. Default-deny. |
| `VALIDATION_ERROR` | 422 | Zod failure; field-specific message. |
| `INTERNAL_ERROR` | 500 | DB transaction failure (returned with traceId). |

### `GET /api/visitor-invitations/:token/preview` — Preview (public, read-only)

**Auth:** None. The token IS the auth. Token is hashed before lookup.

**Behavior:**
1. Hash `:token` with SHA-256.
2. Look up `authorization_decisions` by `qr_token_hash`.
3. If not found → 404 `INVITATION_NOT_FOUND` (do not leak whether the token format was valid).
4. If expired → 410 `INVITATION_EXPIRED` (still 410, not 200 with `expired: true`).
5. If already used → 410 `INVITATION_CONSUMED` (so the visitor knows to ask for a fresh one).
6. Otherwise return the display fields **only**.

**Response (200):**
```ts
{
  invitation: {
    visitorName: string;
    host: string;
    unit: string;
    plate: string | null;
    expiresAt: string;
  };
}
```

**Critical:** This endpoint does **NOT** mark `is_used=true`. Consumption only happens at scan-time via `validateQrToken`.

## 7. Frontend

### Issue surface — Admin shell

A new card on the existing admin module (next to the Visitor Profiles panel): **"Invite a visitor"**. Form fields: visitor name, host, unit, plate (optional), TTL (preset: 24h / 3d / 7d). On submit:

1. Reducer dispatches `INVITATION_ISSUE_STARTED`.
2. API call. On success: `INVITATION_ISSUED` with the invitation payload.
3. UI shows a confirmation card with: the QR PNG (rendered client-side from the raw token), the pass URL with a copy button, and an explicit "This pass is single-use. The QR will not be shown again." note.
4. On failure: `INVITATION_ISSUE_FAILED` with the error code. Form stays open with destructive border on relevant field for 422; banner for 403.

### Visitor surface — Pass page

Route: `/pass/:token` (new public route).

On mount:
1. Call `GET /api/visitor-invitations/:token/preview`.
2. While loading: skeleton card with "Loading your pass…".
3. On 200: render a centered card with the QR PNG (client-side from the URL token), visitor name, host, unit, plate, "valid until {expiresAt}".
4. On 404: "This pass link is invalid. Ask the resident to issue a new invitation."
5. On 410 expired: "This pass has expired."
6. On 410 consumed: "This pass has already been used."

No login. No JS that mutates state. Pass page is read-only.

## 8. Audit Harness Scenarios

| ID | Scenario | Expected outcome | Why it matters |
|---|---|---|---|
| Q1 | Happy issue → preview → guard scan → entry created | Confirmation panel; entry logged; `is_used=true` after | Baseline |
| Q2 | Regular guard token attempts `POST /api/visitor-invitations` | 403 `AUTH_FORBIDDEN`; no row in `authorization_decisions` | Default-deny on issue |
| Q3 | Expired QR scan | `QR_EXPIRED` banner on guard view; no entry | Default-deny on stale credentials |
| Q4 | Replayed QR scan (used → re-scan) | `QR_REPLAYED` banner; no second entry | Default-deny on replay |
| Q5 | Tampered/malformed QR scan | `QR_NOT_FOUND` banner; no entry | Default-deny on forgery |
| Q6 | Pass page loads consumed token | 410 `INVITATION_CONSUMED` UI | Visitor-side honesty |

Q2, Q3, Q4, Q5, Q6 are **default-deny gates**. Q1 is the only happy path.

## 9. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Pass URL forwarded to an unintended visitor | Single-use enforcement at DB layer; first scan wins; subsequent scans → `QR_REPLAYED`. |
| Token leaked in logs | `qr-service.ts` already enforces "hash only" discipline; F6 service follows same pattern; new audit-log assertion in tests that raw token never appears. |
| Issuer over-issues → spam | Rate limit per-issuer on `POST /api/visitor-invitations`: target 50 per hour. Out of scope for slice 0; tracked as a follow-up. |
| Server clock skew → premature expiry | Server uses UTC throughout; client renders `expiresAt` in local TZ. Existing TZ pattern from Feature 1. |
| `MAX_INVITATION_TTL_HOURS` set too high in misconfigured env | Hard-coded ceiling of 168h in the Zod schema (not env-driven). Even if env says higher, service rejects. |

## 10. Definition of Done

- [ ] All 9 slices land with tests (target: ≥ 25 new server tests, ≥ 15 new frontend tests).
- [ ] `npm run lint` clean.
- [ ] `npm run typecheck` clean.
- [ ] Audit harness scenarios Q1–Q6 PASS in a recorded session.
- [ ] CodeRabbit review on PR shows no actionable comments.
- [ ] Existing 24-scenario cross-feature audit (S, S4–8, N, A, V, SH) still passes with F6 merged.
- [ ] Spec is committed alongside the code (this file).
- [ ] An ADR is filed for **any** deviation from this spec during implementation.
