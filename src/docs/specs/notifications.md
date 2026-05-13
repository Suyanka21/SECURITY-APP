# Feature 2 — Notifications (WhatsApp / SMS) — Specification

> Status: **DRAFT** — pending review before code lands.
> Source skill: Spec-Driven-Development. Companion: API-and-Interface-Design,
> Security-and-Hardening, Source-Driven-Development, Trustless-System-Auditor.

---

## 1. Purpose and Scope

GatePass currently asks a guard to share an approval magic link with the
resident **by hand** (copy-paste into WhatsApp or read it over the phone).
That works in slice 1 because every link is also visible on the guard's
screen — nothing is silently lost. But it is friction the user feels every
single walk-in, and it is the bottleneck called out in
`GATEPASS DEFINITION.md` lines 59 and 67.

This feature wires GatePass to a notification channel so the magic link
(and other resident-facing messages in future features) is delivered to
the resident automatically, with **explicit delivery status surfaced to
the guard**.

### In scope

- A single, generic `notification` model + delivery pipeline.
- WhatsApp as the primary channel, SMS as the fallback (per
  `GATEPASS DEFINITION.md` lines 59–60).
- Hook into the approval-create path so a successful `POST /api/approvals`
  fires off a delivery without blocking the HTTP response.
- An endpoint that lets the guard's UI inspect delivery status so the
  awaiting-approval panel can surface "Sent · pending · failed" — no
  silent success.
- A retry mechanism: bounded, idempotent, observable.

### Out of scope (deferred)

- Inbound message routing (resident replies via WhatsApp). This needs a
  webhook + signature verification + intent recognition, and is its own
  spec.
- Resident-side notification preferences (opt-out, quiet hours).
- Push notifications to a future resident mobile app.
- Email — not in the definition.

---

## 2. Assumptions (open to revision before code)

| # | Assumption | Rationale | If wrong → |
|---|---|---|---|
| B1 | The guard's deployment will provide credentials for **one** WhatsApp Cloud API account and **one** SMS provider account via env. | Per Source-Driven: do not bundle multiple providers we don't have docs for. | Add provider registry; out of scope here. |
| B2 | Delivery is **best-effort, retryable**, NOT a blocking part of the approval transaction. | The approval row exists regardless. Notification failure must NOT roll back the approval — that would couple security to messaging uptime. | Drop best-effort, lock approval write to delivery success; massively reduces availability. |
| B3 | The magic link delivered via WA/SMS is the **same** URL surfaced to the guard's UI. | Single source of truth, no per-channel link generation. | Generate channel-specific tokens; doubles security surface for no win. |
| B4 | The resident's phone number lives on the **approval row's `host_phone_e164`** (set when the guard requests approval), NOT a separate visitor record. | Feature 4 (Visitor CRUD) is not yet built. We don't want to block Feature 2 on it. | Migrate to visitor model in Feature 4. |
| B5 | Delivery state machine: `queued → sending → delivered \| failed → (retry up to 3x)`. After 3 attempts the row is `permanently_failed`. | Bounded retry prevents infinite spend; explicit terminal state forces the UI to surface failure. | More attempts: change the const, no schema change needed. |
| B6 | Webhook delivery confirmations (provider → us) are **post-MVP**. For now the row stays `sending` until our outbound call resolves, at which point it flips to `delivered` (provider 2xx) or `failed` (provider non-2xx / transport error). | Webhooks need signature verification and idempotency keys; they're own spec. | Add webhook handler in a follow-up. |
| B7 | The provider client is **abstracted behind a `NotificationProvider` interface** in the codebase. Tests + audit harness use an in-memory provider. Production wires the real WhatsApp + SMS clients via env-driven factory. | Source-Driven: we cannot guess third-party API shapes without docs. We will validate against vendor docs at wire-up time. | The interface stays the same; only the factory changes. |
| B8 | PII discipline: message bodies are **template-rendered**, never free-form. Templates live in code, are reviewed in PRs, and never include the resident's name in the URL. | Per Security-and-Hardening: PII in URL query strings ends up in third-party access logs. | Add a per-channel templating system; out of scope here. |

---

## 3. Threat Model (Security-and-Hardening checklist)

| Threat | Mitigation |
|---|---|
| Provider credentials in source / logs | Read from env only. Never logged. The notification row stores `last_provider_response_code` (number) and `last_provider_response_excerpt` (≤ 200 chars, scrubbed), never the raw body. |
| PII leak via message body | Template-only (no free-form). The body says e.g. *"GatePass: <visitor name> is at the gate. Approve → {link}"*. The resident's phone number is NEVER included in the body. |
| Replay / duplicate delivery | Each notification row has an `idempotency_key = sha256(approval_id || channel || attempt_no)`. The provider call sends this in the provider's idempotency header where supported (WA Cloud API: `Idempotency-Key`). |
| Outbound rate-limit abuse | Per-resident-phone limiter (10/hour by default, configurable) AND a per-approval cap of 2 deliveries (one initial + one user-triggered retry). |
| Magic link reused after delivery | Already enforced by Feature 1's token (single-use, SHA-256 hashed, 5-min TTL). |
| Provider 5xx silently swallowed | NO silent failure. Every non-2xx flips status to `failed`, increments `attempts`, surfaces a code + traceId to the controller. The awaiting-approval panel shows a "Resend" button when delivery failed. |
| Phone number tampering | The `host_phone_e164` is validated server-side at approval creation (E.164 format, country code allow-list). |

---

## 4. Data Model

New table `notifications`:

```sql
CREATE TABLE notifications (
  id              TEXT PRIMARY KEY,                  -- ulid / uuid v4
  approval_id     TEXT NOT NULL
                    REFERENCES approval_requests(id) ON DELETE CASCADE,
  channel         TEXT NOT NULL
                    CHECK (channel IN ('whatsapp', 'sms')),
  target_phone    TEXT NOT NULL,                     -- E.164
  template_key    TEXT NOT NULL,                     -- 'approval.magic_link'
  rendered_body   TEXT NOT NULL,                     -- template output, stored for audit
  status          TEXT NOT NULL
                    CHECK (status IN ('queued','sending','delivered','failed','permanently_failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL UNIQUE,
  last_provider_response_code     INTEGER,
  last_provider_response_excerpt  TEXT,              -- ≤200 chars, scrubbed
  last_error_code TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at    TIMESTAMPTZ,
  failed_at       TIMESTAMPTZ
);

CREATE INDEX idx_notifications_approval ON notifications(approval_id);
CREATE INDEX idx_notifications_status_updated ON notifications(status, updated_at)
  WHERE status IN ('queued','sending','failed');

-- A row's terminal state requires a timestamp.
ALTER TABLE notifications ADD CONSTRAINT notification_terminal_requires_ts
  CHECK (
    (status = 'delivered' AND delivered_at IS NOT NULL)
    OR (status IN ('failed','permanently_failed') AND failed_at IS NOT NULL)
    OR (status IN ('queued','sending'))
  );
```

The approval row gains one field:

```sql
ALTER TABLE approval_requests
  ADD COLUMN host_phone_e164 TEXT;  -- nullable: legacy / manual links still work
```

`host_phone_e164` is nullable so existing approvals don't break. When
present, the approval-create handler enqueues a notification.

A new enum value joins the audit log: `NOTIFICATION_SENT`,
`NOTIFICATION_FAILED`, `NOTIFICATION_PERMANENTLY_FAILED`.

---

## 5. Service Architecture

```
┌────────────────────────────┐
│  POST /api/approvals       │
│  (Feature 1, existing)     │
└────────────┬───────────────┘
             │ (1) inside the txn: insert approval_requests
             │ (2) inside the txn: insert notifications(channel='whatsapp', status='queued')
             │ (3) commit txn
             │ (4) AFTER COMMIT: enqueue delivery in-process worker
             ▼
┌────────────────────────────┐         ┌──────────────────────────────┐
│  notificationDispatcher    │ ──────▶ │  NotificationProvider iface  │
│  (in-proc, debounced)      │ ◀────── │  ├─ whatsappProvider          │
└────────────┬───────────────┘         │  └─ smsProvider (fallback)    │
             │                          └──────────────────────────────┘
             │ 2xx → delivered
             │ 5xx / transport → failed, attempts++
             │ if WA failed AND attempts<3: enqueue SMS fallback
             │ if all attempts exhausted: permanently_failed + audit row
             ▼
┌────────────────────────────┐
│  GET /api/notifications    │
│    ?approvalId=…           │
│  (guard auth)              │
└────────────────────────────┘
```

**Key properties:**

1. The delivery dispatcher is **in-process** (a JS Promise enqueued
   `setImmediate` after the HTTP response is sent). No Redis, no
   external queue. Production scale concern is filed as future-work
   but not blocking — at MVP we send ≤ 100 messages/day per deployment.
2. The dispatcher is **debounced + idempotent**: two enqueues for the
   same `idempotency_key` collapse into one outbound call.
3. WhatsApp is tried first; on failure (5xx, transport error, or
   provider-returned `unreachable`), an SMS row is enqueued. The
   approval ends up with up to **two** notification rows (WA failed,
   SMS attempting / delivered). The UI surfaces the latest non-failed
   row.
4. The HTTP response to `POST /api/approvals` is **not** blocked on
   delivery. Per B2, delivery is best-effort.

---

## 6. Provider Interface

```ts
// src/server/services/notifications/provider.ts
export interface NotificationProvider {
  readonly channel: 'whatsapp' | 'sms';

  /**
   * Send one message. Implementations MUST be idempotent on
   * `idempotencyKey` — i.e., calling twice with the same key MUST NOT
   * result in two messages reaching the user.
   *
   * Resolves with the provider's response on 2xx. Rejects (throws)
   * with a NotificationError on any failure (non-2xx, transport error,
   * timeout). The dispatcher catches and records.
   */
  send(input: {
    target: string;            // E.164
    body: string;              // rendered template
    idempotencyKey: string;    // SHA-256-hash-based, see §3
  }): Promise<{
    providerMessageId: string;
    responseCode: number;
    responseExcerpt: string;
  }>;
}

export class NotificationError extends Error {
  constructor(
    public readonly code:
      | 'PROVIDER_5XX'
      | 'PROVIDER_4XX'
      | 'PROVIDER_TIMEOUT'
      | 'TRANSPORT_ERROR'
      | 'INVALID_CREDENTIALS'
      | 'RATE_LIMITED',
    message: string,
    public readonly responseCode: number,
    public readonly responseExcerpt: string
  ) { super(message); }
}
```

A `MockNotificationProvider` is supplied for tests + the audit harness.
The real `WhatsAppCloudProvider` + `SmsProvider` are wired in a follow-up
once the deployment provides credentials.

The factory is env-driven:

```
NOTIFICATIONS_WHATSAPP_PROVIDER = "mock" | "whatsapp_cloud"
NOTIFICATIONS_SMS_PROVIDER       = "mock" | "twilio" | "africastalking"
```

In tests and the audit harness, both default to `mock`. In production
they default to the corresponding real provider; if the env value is
unrecognized the server logs a startup error and refuses to send
(default-deny per Security-and-Hardening).

---

## 7. Endpoints

### 7.1 — `POST /api/approvals` (existing — extended)

Request body gains an optional `hostPhoneE164` field. If present and
valid (regex `^\+[1-9]\d{6,14}$`), the handler:

1. Validates the phone format. On failure, returns 422 with
   `code: "HOST_PHONE_INVALID"`.
2. Inserts the approval row with `host_phone_e164` set.
3. Inserts a `notifications` row with `channel='whatsapp'`,
   `status='queued'`, `idempotency_key=sha256(approvalId || 'whatsapp' || '0')`.
4. Commits the transaction.
5. After commit, fires `notificationDispatcher.enqueue(notificationId)`.

If `hostPhoneE164` is absent, the legacy behavior is preserved (no
delivery; guard hand-copies the link).

### 7.2 — `GET /api/notifications?approvalId=:id` (new, guard auth)

Returns the list of notification rows for a given approval. Used by the
awaiting-approval panel to show delivery status:

```json
{
  "notifications": [
    {
      "id": "n_01J…",
      "approvalId": "a_01J…",
      "channel": "whatsapp",
      "status": "failed",
      "attempts": 1,
      "lastErrorCode": "PROVIDER_5XX",
      "createdAt": "2026-05-13T22:00:00Z",
      "updatedAt": "2026-05-13T22:00:03Z"
    },
    {
      "id": "n_01J…",
      "approvalId": "a_01J…",
      "channel": "sms",
      "status": "delivered",
      "attempts": 1,
      "createdAt": "2026-05-13T22:00:03Z",
      "updatedAt": "2026-05-13T22:00:04Z",
      "deliveredAt": "2026-05-13T22:00:04Z"
    }
  ],
  "traceId": "t_…"
}
```

Errors: 401 (no JWT), 403 (guard does not own this approval), 404
(approval not found).

### 7.3 — `POST /api/notifications/:id/retry` (new, guard auth)

Manual retry button surface for the guard. Constraints:

- Only allowed when the row is in `failed` AND has `attempts < 3` AND
  the approval is still `pending`.
- Rate limited per approval to 1 retry per 30 s.
- Resets `last_error_code`, increments `attempts`, sets `status='queued'`.

Errors: 409 `NOTIFICATION_NOT_RETRYABLE`, 429 `RETRY_RATE_LIMITED`, 410
`APPROVAL_TERMINAL`.

---

## 8. Frontend Surface

The guard's `AwaitingApprovalPanel` (built in Feature 1 slice 7) gains
a small delivery-status block beside the magic link:

```
┌──────────────────────────────────────────┐
│  Magic link                              │
│  https://gatepass.example/approve/…?…    │
│  [ Copy ]  [ Open ]                      │
│  ───────────────────────────────────     │
│  Sent via WhatsApp 22:00:01 — pending    │
│  (or)                                    │
│  WhatsApp failed (PROVIDER_5XX) →        │
│   SMS delivered 22:00:04                 │
│  (or)                                    │
│  Delivery failed.  [ Resend via SMS ]    │
└──────────────────────────────────────────┘
```

Status is polled in the same controller loop as `GET /status` (Feature 1
slice 6) — one extra request every 2 s while the approval is `pending`
and the latest notification is non-terminal. No new polling effect.

The walk-in form (Feature 1 slice 7) gains an **optional** "Resident's
phone (WhatsApp)" field. Empty → legacy hand-copy flow. Filled → real
delivery. The field is validated client-side against E.164.

---

## 9. State Machine

```
queued ─────────────► sending ─────────► delivered ✓
   ▲                     │                       
   │ retry button        │ 5xx / transport       
   │                     ▼                       
   └────── failed ◄──────┘                       
              │ attempts >= 3                    
              ▼                                  
       permanently_failed ✗                      
```

Lazy server-side: a row in `sending` for > 30 s is flipped to `failed`
on next read (covers crashed dispatcher). Same pattern as Feature 1's
lazy expiry.

---

## 10. Reducer & Controller (frontend)

New reducer actions:

- `NOTIFICATIONS_LOADED` (approvalId, notifications[])
- `NOTIFICATIONS_RETRY_STARTED`
- `NOTIFICATIONS_RETRY_SUCCEEDED`
- `NOTIFICATIONS_RETRY_FAILED` (code, message)

The controller's existing approval polling effect is extended to also
fetch `/notifications?approvalId=…` on the same tick (one extra request
every 2 s while pending). The two responses dispatch independently —
notifications status is **never** allowed to mask the approval status
or vice versa.

---

## 11. Trustless Audit Scenarios

Added to `audit/main.tsx`:

| # | Scenario | Asserts |
|---|---|---|
| N1 | `notify-whatsapp-ok` | WA returns 2xx → row flips to `delivered`; UI shows "Sent via WhatsApp · delivered". |
| N2 | `notify-whatsapp-5xx-then-sms-ok` | WA 5xx → SMS enqueued → 2xx → UI shows "WA failed · SMS delivered". |
| N3 | `notify-both-fail` | WA 5xx + SMS 5xx after 3 attempts → row `permanently_failed`. UI shows explicit failure + Resend button disabled. **The approval itself remains usable** — the guard can still hand-copy the link. |
| N4 | `notify-rate-limited` | 4th approval in 1h for the same phone → outbound returns `RATE_LIMITED`, UI surfaces it, the approval row is still created (per B2). |
| N5 | `notify-missing-phone` | Approval created without `hostPhoneE164` → no notification row → UI shows "Hand-copy the link" hint. Proves the absence of a phone is treated as a deliberate choice, not a silent failure. |

---

## 12. Test Plan (TDD)

For each slice, the failing test ladders down:

1. **DB migration** — schema test asserts the new table + constraints.
2. **Service** — unit tests with `MockNotificationProvider` cover:
   queued→sending→delivered, WA-fail→SMS-fallback, 3-attempt cap,
   idempotency-key uniqueness, lazy `sending`→`failed` flip.
3. **Route handlers** — supertest covers all 401/403/404/409/422/429
   error codes; the audit log enum write is verified per outcome.
4. **API client** — `ApiResult<NotificationListResponse>` discriminated
   union, JWT injection, retry endpoint contract.
5. **Reducer + controller** — extended polling effect dispatches both
   approval-status and notifications-status independently; failure of
   one does not cancel the other.
6. **UI** — delivery status block renders for each terminal state;
   Resend button only enabled when allowed; hand-copy hint shown when
   no phone field was filled.
7. **Audit harness** — N1–N5 scenarios pass under the same `controller.*Api`
   injection seam as Feature 1.

---

## 13. References

- `GATEPASS DEFINITION.md` lines 58–60, 67, 106 (WhatsApp + SMS layer,
  notification system).
- `src/docs/remaining-features-rollout.md` Feature 2 — risks + audit
  scenarios.
- Feature 1 spec: `src/docs/specs/resident-approval-flow.md` — defines
  the approval row this feature attaches to.
- Source-Driven-Development: WhatsApp Cloud API + chosen SMS provider
  docs MUST be fetched and cited at wire-up time (slice 6+).
- Security-and-Hardening: PII discipline (§3, §8), default-deny on
  unknown env (§6), webhook deferred (Assumption B6).
- Trustless-System-Auditor: every failure path is observable; N3 is
  the canonical no-silent-success case for this feature.
