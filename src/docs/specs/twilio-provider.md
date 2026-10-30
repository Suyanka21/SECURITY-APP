# Spec — Real message provider (Twilio SMS + WhatsApp) for guard-initiated approvals

> Status: **proposal for owner approval. No code until approved.**
> Extends `notifications.md` §5–§6. Twilio facts below were checked against
> Twilio's docs (links in §10) on 2026-10-30; code facts against `main` @ `47282b5`.

## 1. Scope

A guard asks a resident to approve a visitor (`POST /api/approvals`). The
server queues a WhatsApp message with a single-use approve/deny link, and
falls back to SMS. Today **no real provider exists**. This spec covers:
Twilio for both channels, configuration, failure handling, re-running the
phone sweep against the real provider, and the owner's Twilio setup.

Out of scope: resident-portal messages, OTP login (Supabase Auth), marketing,
inbound replies.

## 2. The existing hook (unchanged unless listed in §8)

`src/server/services/notifications/provider.ts`:

```ts
interface NotificationProvider {
  readonly channel: "whatsapp" | "sms";
  send(input: { target: string /* E.164 */; body: string; idempotencyKey: string })
    : Promise<{ providerMessageId: string; responseCode: number; responseExcerpt: string /* ≤200 */ }>;
}
// failure = reject with NotificationError(code, message, responseCode, responseExcerpt)
type NotificationErrorCode = "PROVIDER_5XX" | "PROVIDER_4XX" | "PROVIDER_TIMEOUT"
  | "TRANSPORT_ERROR" | "INVALID_CREDENTIALS" | "RATE_LIMITED";
```

- `registry.ts` holds one provider per channel (`getNotificationProviders()` /
  `setNotificationProviders()`). Default: `MockNotificationProvider` in
  **default-deny** mode, where every send fails with `INVALID_CREDENTIALS`.
- `notification-service.ts` `dispatchNotification()`: row `queued → sending →
  delivered | failed | permanently_failed`. Max 3 attempts. A row stuck in
  `sending` for 30 s counts as failed. A guard can retry a `failed` row
  (`POST /api/notifications/:id/retry`, at most once per 30 s). If WhatsApp
  fails and attempts remain, one SMS row is queued. Every outcome is written
  to the row and the audit log. The idempotency key is
  `sha256(approvalId:channel:attemptNo)`.
- Message body (`renderApprovalMagicLinkBody`):
  `GatePass: {visitor} is at the gate for {host} (Unit {unit}).\nApprove or deny: {link}`.
  The link token is single-use (its hash is wiped on decision) and expires
  with the approval (`APPROVAL_TIMEOUT_SECONDS`, default 300 s).

### 2a. Gaps found in today's code (fixed by this work)

| # | Gap | Effect today |
|---|---|---|
| G1 | Nothing outside tests calls `setNotificationProviders()`. | Every real send fails with `INVALID_CREDENTIALS`. |
| G2 | The SMS fallback row is inserted as `queued`, but nothing dispatches it: `dispatchNotification` runs only from `approvals.ts` and the retry route, and retry accepts only `failed` rows. | The SMS fallback never goes out. |
| G3 | `NOTIFICATIONS_WHATSAPP_PROVIDER` / `NOTIFICATIONS_SMS_PROVIDER` (notifications.md §6) are documented but not implemented. | No way to configure a provider. |

## 3. Design

One new file, `src/server/services/notifications/twilio-provider.ts`, with
`TwilioSmsProvider` and `TwilioWhatsAppProvider`. Both call Twilio's Messages
API with `fetch`. No SDK: one form-encoded POST, matching how
`supabase-admin.ts` calls Supabase.

```
POST https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Messages.json
Authorization: Basic base64(TWILIO_API_KEY_SID:TWILIO_API_KEY_SECRET)
SMS:      To=+2547…  MessagingServiceSid=MG…  Body=<rendered body>  StatusCallback=…
WhatsApp: To=whatsapp:+2547…  From=whatsapp:+…  ContentSid=HX…  ContentVariables={"1":visitor,"2":host,"3":unit,"4":link}  StatusCallback=…
```

- **WhatsApp needs a pre-approved template.** A business-started WhatsApp
  message outside the 24-hour customer-service window must use a Content
  Template (`ContentSid` + `ContentVariables`); free text is not allowed. So
  `NotificationSendInput` gains an optional `template` field
  (`{ key, variables }`). The dispatcher fills it from the same values it
  renders into `body`, and the SMS provider ignores it.
- **Response mapping:**

  | Twilio outcome | Result |
  |---|---|
  | 201 | `providerMessageId` = message SID (`SM…`/`MM…`) |
  | 401 / 403 | `INVALID_CREDENTIALS` |
  | 429 | `RATE_LIMITED` |
  | other 4xx | `PROVIDER_4XX` |
  | 5xx | `PROVIDER_5XX` |
  | no response within 10 s (AbortController) | `PROVIDER_TIMEOUT` |
  | `fetch` throws | `TRANSPORT_ERROR` |

- **`responseExcerpt` holds only** `HTTP <status>`, Twilio's numeric error
  `code` and the message `status`. It never echoes Twilio's response body,
  which can contain the `To` number and our message body.
- **Duplicate sends.** Twilio's Messages API documents no idempotency key.
  As the interface already requires, the provider keeps an in-process map of
  `idempotencyKey → result` for 10 minutes, and returns the stored result
  instead of sending again. This is enough for one server instance; a second
  instance would need the check moved to the database (out of scope for the
  pilot).
- **Delivery status.** A 201 only means Twilio accepted the message; it can
  still fail later as `failed` or `undelivered`. For example, a number may have
  no WhatsApp account. Two options (**decision D1**):
  - **A (minimal):** treat 201 as `delivered`. The guard screen would say
    "Sent" when the message has only reached Twilio. A later WhatsApp failure
    would never trigger the SMS fallback.
  - **B (proposed):** add a Twilio status webhook.
    - New public route: `POST /api/notifications/twilio-status`.
    - It rejects any request whose `X-Twilio-Signature` does not verify
      against `TWILIO_AUTH_TOKEN` (`403`), and logs nothing from the request
      body.
    - A 201 moves the row to a new status, `sent`.
    - A `delivered` or `read` callback moves it to `delivered`.
    - A `failed` or `undelivered` callback moves it to `failed` and runs the
      same fallback and attempt logic as a send error.
    - A `sent` row is excluded from the 30 s stale rule.
    - **Matching a callback to its row.** Today the message SID is written
      only to the audit event. On a 201 the dispatcher also writes it to a
      new column, `notifications.provider_message_id`.
    - **Callbacks are stored before they are applied.** A callback can arrive
      before the dispatcher has saved the SID. So every callback that passes
      the signature check is first inserted into a new table,
      `notification_callbacks` (`message_sid`, `status`, `received_at`;
      unique on `message_sid` + `status`; RLS on). The webhook then returns
      `200`.
    - **Applying a stored callback.** The callback is applied to its row if
      the SID is already known. If not, the dispatcher applies it in the same
      transaction that saves the SID. Nothing is lost.
    - **No double transitions.** A repeat callback hits the unique index and
      is ignored. A transition applies only from `sending` or `sent`, so a
      replayed or late callback cannot change a finished row. The fallback
      runs only on the transition into `failed`.
    - Needs a migration:
      - `ALTER TYPE notification_status ADD VALUE 'sent'`;
      - `provider_message_id text` (nullable) with a unique index;
      - the `notification_callbacks` table.
- **Wiring (fixes G1, G3).** `createApp()` builds the registry from
  environment variables (§4) once, at boot.
- **SMS fallback (fixes G2).** `maybeEnqueueSmsFallback()` returns the new row,
  and `dispatchNotification()` dispatches it straight away with the same
  options.

## 4. Environment variables

| Variable | Value / format | Notes |
|---|---|---|
| `NOTIFICATIONS_WHATSAPP_PROVIDER` | `twilio` \| `disabled` \| `mock` | `disabled`: decision D2 |
| `NOTIFICATIONS_SMS_PROVIDER` | `twilio` \| `mock` | |
| `TWILIO_ACCOUNT_SID` | `AC` + 32 hex | the (sub)account that sends |
| `TWILIO_API_KEY_SID` | `SK` + 32 hex | Standard API key; used for sending |
| `TWILIO_API_KEY_SECRET` | secret | server-only, never logged |
| `TWILIO_AUTH_TOKEN` | secret | only for verifying webhook signatures (option B) |
| `TWILIO_SMS_MESSAGING_SERVICE_SID` | `MG` + 32 hex | the SMS sender pool |
| `TWILIO_WHATSAPP_FROM` | `whatsapp:+<E.164>` | the approved WhatsApp sender |
| `TWILIO_WHATSAPP_CONTENT_SID` | `HX` + 32 hex | the approved approval template |

The status-callback URL is derived as `APP_PUBLIC_ORIGIN` +
`/api/notifications/twilio-status`; it is not a separate setting.

**Startup checks** (in `collectProductionConfigProblems`, so production refuses
to start on a bad value):
- `mock` is refused when `NODE_ENV=production`.
- When `twilio` is chosen, every variable it needs must be set, with the right
  prefix and length.
- Unknown values are refused.

Outside production, unset means `mock` (today's behaviour). `.env.example`
and environment checklist §2 get the same table.

## 5. When delivery fails

| Situation | What happens |
|---|---|
| WhatsApp send error or (option B) `failed`/`undelivered` callback, attempts left | Row → `failed`, audit `notification_failed`. One SMS row is queued **and dispatched** (G2). The guard sees both rows. |
| SMS send error, attempts left | Row → `failed`. The guard can press **Resend** (once per 30 s). |
| 3rd failure on a row | Row → `permanently_failed`, audit `notification_permanently_failed`. No more retries. The guard uses the existing fallback (call the resident or use the intercom) and decides by the existing manual flow. |
| `INVALID_CREDENTIALS` / `RATE_LIMITED` | Same states. The server also logs a single stdout line `[NOTIFICATION] provider=twilio channel=… code=… twilioCode=…` with no number and no body, so the technical contact sees it. |
| Twilio down at boot | Nothing happens at boot: the providers are created without calling Twilio. |
| Approval decided or expired before delivery | The link refuses the decision; the existing behaviour is unchanged. |

**No silent success:** each row's status is persisted, and the guard screen
already polls and shows it.

## 6. Personal data

- Twilio receives the resident's phone number and the message body, so it
  becomes a processor. This is added to the privacy notice's "Needs legal
  review" list (`/legal/privacy`, "Who can see it").
- The body holds a single-use, 5-minute approval link. Twilio keeps message
  bodies in its logs. The owner turns on Twilio **Message redaction** for the
  account (§7, step 7), and the link stays useless after its first use or
  once it expires.
- Our logs and `provider_response_excerpt` never contain the number, the body
  or the link. The live sweep (§7a) checks this.

## 7. What the owner sets up in Twilio

Do this **twice**: in a **dev** subaccount (its keys come to me) and in a
**production** subaccount (its keys never leave you).

1. Create or upgrade a paid Twilio account. A trial account can only send to
   numbers you have verified, and adds a trial notice to every message.
2. Create two subaccounts, `gatepass-dev` and `gatepass-prod`.
3. In **Messaging → Geo permissions**, allow only Kenya (+254).
4. **SMS sender.** Ask Twilio which sender type is allowed for Kenya (an
   alphanumeric sender ID or a number) and complete any registration it
   requires. This can take days. Create a **Messaging Service**, add the
   sender, and note its `MG…` SID.
5. **WhatsApp sender.** Register a WhatsApp sender in Twilio. This needs a
   Meta Business account, business verification, a display name, and a phone
   number that is not already in the WhatsApp app. Note the `whatsapp:+…`
   address.
6. **WhatsApp template.** Create a Content Template that matches the body in
   §2, with variables {{1}} visitor, {{2}} host, {{3}} unit and {{4}} link.
   Submit it for WhatsApp approval and note its `HX…` SID.
7. Turn on **Message redaction** for the subaccount, if your plan offers it.
8. Create a **Standard API key** (`SK…` and its secret). Note the
   subaccount's `AC…` SID and Auth Token.
9. Set a monthly spend limit and a usage alert.

**What I need from you (dev subaccount only, entered as Devin secrets, never
in chat):**
- the `AC…` SID;
- the `SK…` SID and its secret;
- the Auth Token;
- the `MG…` SID;
- the `whatsapp:+…` sender;
- the `HX…` SID;
- **one phone number** that may receive the test messages.

You set the production values on the host yourself.

### 7a. Re-running the phone sweep with the real provider

Today `phone-exposure.integration.test.ts` uses the mock provider. A new opt-in
script, `npm run test:phone-sweep:live`:

- **Setup:** it runs the same sweep on local Docker Postgres, with
  made-up resident data except the recipient. The recipient number comes from
  `LIVE_SWEEP_TO`, so it reaches a real phone.
- **Providers:** the real Twilio providers, set up from the dev subaccount's
  values.
- **What it checks:**
  - Twilio returns a message SID on each channel used.
  - None of the 18 staff responses contains the number in any of its 3 forms
    (with `+`, without `+`, and the national number).
  - `provider_response_excerpt` doesn't contain the number either.
  - Neither does the server's captured stdout/stderr.
  - With option B, a signed status callback moves the row to `delivered`.
- **By hand:** the message arrives on the phone, and the Twilio console log
  shows the body redacted.
- **When it runs:** never in CI, because it needs secrets and costs money. I
  run it once on dev. You run it once on production before go-live, and paste
  its output into gate A-Twilio (the item-5 Twilio checklist).

## 8. All new server code (complete)

| # | Change | Files |
|---|---|---|
| T1 | Twilio SMS + WhatsApp providers (fetch, mapping, dedup) | `services/notifications/twilio-provider.ts` (new) |
| T2 | Optional `template` field on `NotificationSendInput`; dispatcher fills it | `provider.ts`, `notification-service.ts` |
| T3 | Registry built from environment variables at boot | `registry.ts`, `app.ts` |
| T4 | Production config checks for §4 | `config/production-config.ts`, `.env.example` |
| T5 | Dispatch the SMS fallback row immediately (G2) | `notification-service.ts` |
| T6 (option B) | Status webhook + signature check; new `sent` status, `provider_message_id` column, `notification_callbacks` table and migration | `routes/notifications.ts`, `app.ts`, `drizzle/00xx_notification_sent.sql`, `src/db/schema.ts` |
| T7 | Opt-in live sweep script | `scripts/` or `src/server/__tests__/live/` (excluded from CI) |
| T8 (D2) | The first notification row's channel comes from configuration: `sms` when `NOTIFICATIONS_WHATSAPP_PROVIDER=disabled`, otherwise `whatsapp`. The `enqueuedNotification.channel` type widens from `"whatsapp"` to the channel union. | `services/approval-service.ts` |

No change to the link format, the routes guards call, or the guard screen
(except the status label `sent` under option B). The only approval-flow
change is T8, which picks the first channel.

**Tests:**
- unit tests for the provider mapping with a mocked `fetch`: every status
  code, the timeout, the excerpt containing no number, dedup;
- config tests;
- signature-check tests: a valid signature, a bad one and a missing one;
- webhook tests (integration):
  - a callback that arrives before the SID is saved is still applied;
  - a repeated or late callback changes nothing;
  - a `failed` callback queues the SMS fallback exactly once;
- an integration test that the SMS fallback is dispatched (G2), in the CI
  integration job.

## 9. Decisions for the owner

- **D1:** delivery status by webhook (option B, proposed) or treating
  Twilio's 201 as delivered (option A)?
- **D2:** WhatsApp approval can take weeks. Pilot with
  `NOTIFICATIONS_WHATSAPP_PROVIDER=disabled`, so the approval goes **straight
  to SMS** with no wasted WhatsApp attempt (proposed), or wait for WhatsApp?
- **D3:** one server instance for the pilot, so dedup stays in-process
  (proposed)?

## 10. References

- Twilio Message resource (senders, `Body`/`ContentSid`, `StatusCallback`,
  status values): https://www.twilio.com/docs/messaging/api/message-resource
- WhatsApp templates and the 24-hour window:
  https://www.twilio.com/docs/whatsapp/tutorial/send-whatsapp-notification-messages-templates
- Webhook signatures (`X-Twilio-Signature`):
  https://www.twilio.com/docs/usage/webhooks/webhooks-security
