# Parked issues

Review flags that are **not** fixed inside the PR that raised them. The rule:

- flags about **login, permissions or personal data** are fixed in the PR;
- **style, test-coverage and wording** flags are parked here so nothing is lost.

One line each. Severity is the reviewer's (🔴 / 🟡 / flag). Remove a line in the
PR that fixes it.

| Date | PR | Severity | Issue |
|---|---|---|---|
| 2026-10-30 | [#56](https://github.com/Suyanka21/SECURITY-APP/pull/56) | flag | Twilio spec §8 test list: "webhook commits while the dispatcher's SID transaction is still open" cannot happen under the per-SID advisory lock; reword as "each path blocks on the lock until the other commits, in both orders". |
| 2026-11-04 | unit reactivation PR | flag | `useGatePassController.test.tsx` notification-polling tests are flaky locally (a different one of 88 fails about 1 run in 4, file untouched); pre-existing, needs a fake-timer audit. |
| 2026-11-04 | Twilio SMS PR | flag | `GET /api/audit/events?eventType=` filter list (`audit-schemas.ts`) has never included the notification_* event types, so they cannot be filtered; pre-existing, coverage. |
| 2026-11-04 | Twilio SMS PR | flag | A row Twilio accepted (`sent`) whose callback never arrives stays `sent` forever; no sweep moves it on. Guard sees "sent", not "failed". |
| 2026-11-04 | [#59](https://github.com/Suyanka21/SECURITY-APP/pull/59) | flag | `environment-configuration-checklist.md` does not list `NOTIFICATIONS_*` and `TWILIO_*` (they are in `.env.example` and checklist A10); wording. |
| 2026-11-04 | [#59](https://github.com/Suyanka21/SECURITY-APP/pull/59) | flag | If the server stops between committing a queued SMS fallback and dispatching it, nothing sends that row later (no startup sweep); coverage. |
