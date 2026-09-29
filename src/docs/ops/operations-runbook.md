# GatePass — Operations Runbook (pilot)

Plain-English procedures for the security company and estate running GatePass.
Every statement below describes what the software **actually does today**
(checked against the code on the date of this document). Where the software
does not yet do something, this runbook says so instead of pretending.

Related: [Admin & supervisor SOPs](./admin-sops.md) ·
[Incident response](./incident-response.md) ·
[Pilot launch checklist](./pilot-launch-checklist.md) ·
[Privacy & data handling (DRAFT)](./privacy-data-handling-DRAFT.md)

## 1. Roles at a glance

| Role | Can do | Cannot do |
|---|---|---|
| **Guard** | Sign in on the gate console; log walk-ins, scan QR passes, enter PINs, record exits, request resident approval, add guard notes; work offline and sync later. | See the shift log, on-premise list, deliveries report, watchlist, audit log, or any account function. The console does not even show the admin tab to a guard. |
| **Senior guard** | Everything a guard can, plus: shift log, on-premise list, deliveries report, watchlist management, visitor-profile management, audit log review. | Create or deactivate accounts. |
| **Admin** | Everything above, plus create guard / senior-guard / admin accounts from the dashboard. | Reset passwords in-app or deactivate accounts in-app (see §3, §4 — done outside the app today). |
| **Resident** | Approve or deny a visitor from a one-off link sent to their phone. No login. | See anything other than the request addressed to them. |
| **Visitor** | Open their own pass page from the link they were sent. No login. | See anything else. |

Roles are read from the database on **every** request. Changing a role or
deactivating an account takes effect on the very next request; nothing needs to
be "logged out" first.

## 2. Who can create guard / admin accounts

**Only an admin**, from the admin dashboard (Accounts → Create). There is no
public signup. The very first admin on a fresh database is created once by the
deployer with the bootstrap script — see
[`deploy/first-admin-bootstrap.md`](../deploy/first-admin-bootstrap.md).

When an admin creates an account the system creates the login (Supabase Auth)
and the staff record together and writes an audit event. If the login was
created but the audit row could not be written, the dashboard shows a clear
warning; treat that as an incident (§10) and reconcile before the account is
used.

The temporary password is shown **once**, on screen, to the admin. Hand it to
the new staff member in person; do not send it by chat or SMS.

## 3. Who can deactivate a guard

Deactivation is **not yet available in the dashboard**. Today it is done by the
deployer / technical contact:

1. Set `is_active = false` on the staff member's row in the `guards` table.
   From that moment every API call they make is refused (`AUTH_FORBIDDEN`),
   even if they are still signed in.
2. Disable (or delete) the same user in Supabase Auth so they cannot obtain a
   new session.
3. Record who requested it and when in the estate's staff file.

Ask an **admin** to authorise the deactivation; the technical contact executes
it. This is a known operational gap tracked in the pilot checklist.

## 4. Password reset

There is **no in-app password reset**. Resets are done by the technical
contact in the Supabase dashboard (Authentication → Users → the user → send
recovery / set password). Verify the requester's identity in person or via
their supervisor before resetting. Never reset over an unverified phone call.

## 5. When a guard leaves the company

Same day, in this order:

1. Deactivate (§3) — this is the step that actually locks them out.
2. Confirm the device they used has no pending offline entries (§7). If it
   does, sync them first while **that guard's** session is still valid, or
   accept that those entries are lost and record it.
3. Sign the device out and clear browser data (Settings → Clear browsing data)
   so their cached identity and queue are removed.
4. Do **not** reuse their badge number; issue a new one to the replacement.

## 6. What happens when the internet is down

The gate console notices real connectivity changes from the browser. When
offline:

- The header shows an offline banner and, if the session cannot be
  re-checked with the server, an *"identity not re-verified"* marker.
- Walk-in entries and overrides are **queued on the device**, one queue per
  signed-in guard, and survive the page being closed or the tab sleeping.
- A guard who signed in earlier in the shift **stays signed in**. A guard who
  never signed in on that device cannot start — sign-in needs the network.
- QR scans and PIN checks **do not work offline** (they must be checked with
  the server). Use a manual walk-in entry with an override reason and let the
  resident/host confirm by other means.
- Resident approval requests cannot be sent offline.

When the connection returns the queue is sent automatically. Guards should not
sign out or clear the browser while the pending counter is above zero.

**Not supported:** reloading the page while offline. There is no offline
app-shell (no service worker), so a hard refresh with no network shows the
browser's own "no connection" page. Queued entries are still on the device and
appear again once the page loads with network.

## 7. When offline entries fail to sync

Symptoms: the pending counter does not go to zero after the network is back, or
the console reports a sync error.

1. Tap **Sync now**. A second attempt is safe — replays are de-duplicated by
   the server (an entry sent twice is stored once).
2. Still failing → check the device can reach the server at all (open
   `/support` in a new tab).
3. If the session has expired (401), the guard signs in again on the **same
   device and same account**; the queue is kept and can then be synced.
4. If a specific entry is rejected by the server (for example, an invalid
   field), the console shows which one. Note its details on paper, record it
   as an incident (§10), and escalate to the supervisor. Do **not** clear
   browser data to "fix" it — that destroys the queue.

## 8. Who can view audit logs

Senior guards and admins only, via the API (`/api/audit/...`). Guards are
refused (403) and the routes are never public (401 without a valid session).

Two honest limitations for the pilot:

- The audit **API** serves the in-memory log of the running server (last
  10,000 events since the process started). The **durable** record is the
  `audit_events` table in Postgres, which is only reachable with database
  access today. For any dispute, use the database table, not the API.
- Audit rows are append-only; there is no edit or delete route.

## 9. Who can export or review visitor history

- **Review:** senior guards and admins, via the shift log, the on-premise list
  and the deliveries report in the admin tab of the console or the admin
  dashboard.
- **Export:** there is **no export button**. Any export (for a dispute, a
  resident request or the estate committee) is a database query run by the
  technical contact, authorised in writing by an admin, and recorded in the
  incident/requests log. Exports must go only to the person entitled to them
  and be deleted when no longer needed.

## 10. Supervisor review of suspicious overrides

Every override (an entry allowed without a valid pass) requires a reason and is
recorded twice: as an `override_events` row and as an `override_authorized`
audit event **in the same database transaction** — one cannot exist without
the other.

Weekly, and after any complaint, a senior guard or admin should:

1. Open the shift log for the period and filter to entries with an override.
2. For each: does the reason make sense? Is the resident/host real? Did the
   visitor exit?
3. Cross-check against the audit trail by the entry's trace reference.
4. Speak to the guard concerned; record the outcome in the estate's staff file.
5. Anything that looks like misuse → [Incident response §3](./incident-response.md).

## 11. When a pass is locked

A pass locks after five wrong PIN attempts. Once locked:

- The visitor's pass page says **Locked**; the console refuses both PIN and QR
  for that pass.
- **Nobody can unlock it at the gate.** The host issues a new pass.
- If the guard is satisfied of the visitor's identity by other means, they may
  log a walk-in with an override reason — this is then reviewed under §10.

## 12. When a resident denies or does not respond

- **Denied:** the console shows the denial. The visitor is not admitted.
  Record nothing further unless the visitor causes an incident.
- **No response:** the approval request expires after its time limit and the
  console shows it as expired. The guard may call the resident directly
  (estate phone list). If still no answer, the visitor is **not** admitted; the
  guard may offer to have them wait outside. An override here must state the
  reason honestly ("resident confirmed by phone", not "approved").

## 13. Shift handover

1. Outgoing guard: make sure the pending counter is **0** (sync if not),
   then tap **Sign out**. The console returns to the login screen.
2. Incoming guard signs in with **their own** account. The header must show
   their own name and badge. Never continue a shift under someone else's login.
3. Verbal handover of anything open: visitors expected, visitors still on the
   premises (senior guard can check the on-premise list), any incident.

Signing out clears the cached identity for that guard on that device; it does
**not** delete a queue that still has pending entries — those reappear when
that same guard signs in again.

## 14. Lost or stolen guard device

Immediately, whoever discovers it:

1. Tell the supervisor and the technical contact.
2. Technical contact: deactivate the account that was signed in on the device
   (§3) **or**, if the same person keeps working, revoke their sessions in
   Supabase Auth and reset their password (§4). Either way the device can no
   longer make any server call.
3. Assume anything visible on the console screen at the time (recent entries
   for that shift, queued walk-ins) may have been seen. Nothing on the device
   can decrypt PINs or QR tokens, and the device holds no other guard's data.
4. Record it as an incident — [Incident response §2](./incident-response.md).
5. Issue a replacement device; the guard signs in afresh.

## 15. Contacts

| Need | Who |
|---|---|
| Account creation / role change | Estate admin (in dashboard) |
| Deactivation, password reset, export, database questions | Technical contact (fill in) |
| Security incident | Supervisor on duty, then estate manager (fill in) |
| Visitor / resident support | Configured in `VITE_SUPPORT_EMAIL` / `VITE_SUPPORT_PHONE`, shown on `/support` |

Fill in the blanks before go-live — see the pilot checklist.
