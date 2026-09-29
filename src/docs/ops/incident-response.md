# GatePass — Incident Response Guide (pilot)

For the supervisor on duty, the estate manager and the technical contact.
Each incident type has: **first 15 minutes**, **then**, **evidence to keep**,
**who decides it is closed**. Where a step needs a decision that belongs to
the estate or its legal reviewer, it is marked **[OPERATOR / LEGAL REVIEWER]**.

This guide describes how to use the software during an incident. It is not
legal advice and does not tell you what the law requires you to report.

Related: [Operations runbook](./operations-runbook.md) ·
[Admin & supervisor SOPs](./admin-sops.md) ·
[Privacy & data handling (DRAFT)](./privacy-data-handling-DRAFT.md)

## 0. Contacts and severity

| Role | Name / number | Reach within |
|---|---|---|
| Supervisor on duty | (fill in) | immediately |
| Estate manager | (fill in) | 1 hour |
| Technical contact | (fill in) | 1 hour |
| Legal / compliance reviewer | (fill in) | same day for §7 |

**Severity 1** — data of many people may be exposed, or the gate cannot
operate: §1 (if admin), §7, §8. Call the estate manager and technical contact
now. **Severity 2** — one account, one device, one visitor: everything else.
Handle, then report within the shift.

Every incident gets a number, a one-page record, and a closing signature.

## 1. Compromised guard / senior-guard / admin account

Signs: entries or admin actions the person denies making; logins at odd
hours; the person says someone knows their password.

**First 15 min**
- Technical contact: revoke the user's sessions and reset the password in
  Supabase Auth. If the account is an **admin**, or misuse is confirmed, set
  `is_active=false` instead — every request is refused from that moment.
- Do not delete the account: its history is evidence.

**Then**
- Pull the shift log and `audit_events` for the account for the suspect
  window. List every entry, override, exit and account action.
- If the account is an admin: list any accounts it **created** (audit type
  `account_provisioned`); treat each as suspect and reset or deactivate them.
- Ask the person how the password may have leaked (shared device, written
  down, phishing). Fix that cause.
- Verify each suspect entry against the host/resident. Wrongly admitted → §4.

**Evidence:** audit rows, shift log export, the person's statement, times of
revocation. **Closed by:** estate manager.

## 2. Lost or stolen guard device

**First 15 min**
- Technical contact: revoke sessions + reset password of the account signed
  in on it (SOP 8). Until then the device can still make entries.
- Supervisor: note the last known time the device was in the guard's hands.

**Then**
- Review every entry from that account after that time; unexplained → §4.
- Assume whatever was on screen could have been read: that shift's entries
  and any queued walk-ins. The device cannot reveal PINs, pass tokens or
  other guards' data. If queued entries existed and were not synced, record
  them as lost and re-create them from the paper log.
- **[OPERATOR / LEGAL REVIEWER]** whether the residents/visitors whose names
  were on that screen must be told.

**Evidence:** device ID, times, revocation confirmation, entries reviewed.
**Closed by:** supervisor + estate manager.

## 3. Misuse by staff (collusion, bogus overrides, sharing a login)

**First 15 min**
- Preserve: screenshot the shift log and note the entry IDs. Do not confront.
- If ongoing, revoke sessions / deactivate the account (SOP 2).

**Then**
- SOP 4 override review for the person's whole pilot period.
- Cross-check against the resident: did they really approve? The approval
  request rows show who decided and when.
- Interview per the security company's HR procedure. GatePass records are
  evidence, not the verdict.

**Evidence:** override rows, audit rows, approval rows, statements.
**Closed by:** security company management + estate manager.

## 4. Wrongly admitted visitor

Includes: admitted on a locked/used pass by override, admitted with no
approval, wrong person admitted against a real pass.

**First 15 min**
- Physical response per the estate's security procedure (locate, escort).
- Record an exit when they leave so the on-premise list is truthful.

**Then**
- Find the entry in the shift log. Identify: method, guard, reason if
  override, whether a resident approval existed and what it said.
- Tell the affected resident what happened, in person or by phone.
- Guard debrief; if the reason was dishonest → §3; if a process gap
  (e.g. resident unreachable) → update the runbook.

**Evidence:** entry + override + approval rows, statements, CCTV reference
if the estate has it. **Closed by:** estate manager.

## 5. Audit log appears incomplete

Signs: an override with no `override_authorized` event (or vice versa); an
`/api/audit` view that is empty or short; an account whose creation nobody
can find in the audit.

**First 15 min**
- Do not restart the server "to see if it helps" — the in-memory audit view
  is lost on restart. Note the time.

**Then**
- Technical contact queries the **database**, not the API:
  count `override_events` vs `audit_events where type='override_authorized'`
  for the window. These are written in one transaction, so a mismatch means
  a bug or direct database tampering — treat as Severity 1 until explained.
- If the API view is short but the table is complete: expected after a server
  restart (runbook §8) — record as a known limitation, not an incident.
- If a dashboard warned "account created but audit failed": create the
  missing record manually with the admin's written confirmation, and file the
  warning text.

**Evidence:** the SQL used and its output, server logs for the window.
**Closed by:** technical contact + estate manager.

## 6. Offline entries fail to sync / are lost

**First 15 min**
- Follow SOP 7 exactly. **Nobody clears browser data.**
- Guard writes the queued entries on paper now, from the console's pending
  list, in case recovery fails.

**Then**
- Recover per SOP 7. If entries remain rejected, technical contact reads the
  rejection reason from the console and server logs; fix and re-sync.
- If entries are genuinely lost (device wiped, browser data cleared, device
  lost): re-create them from the paper log as walk-ins with a guard note
  "re-entered after sync loss, original time HH:MM", and list them in the
  incident record. The re-created entries will carry the re-entry time.
- Report the root cause to the technical contact (this should not happen;
  the queue is designed to survive reloads, sleep and session expiry).

**Evidence:** pending list screenshot, rejection text, paper log.
**Closed by:** supervisor.

## 7. Suspected personal-data breach

Examples: a pass or approval page shows someone else's details; a database
credential or the service-role key appears in a chat/log/screenshot; a
laptop with `.env.local` is lost; Supabase reports unusual access; a public
page shows internal error text.

**First 15 min (Severity 1)**
- Technical contact: rotate in this order — service-role key, database
  password, then anon key; `PIN_PEPPER` only if it was exposed (this
  invalidates all live PINs — tell the gate). Redeploy.
- If a specific account or device is involved, §1 / §2 in parallel.
- Screenshot the page/log that revealed the problem, then remove access to it.

**Then**
- Establish **what** data, **whose**, **how many**, **for how long**, and
  **who could have seen it**. Write it down even if the answer is "unknown".
- **[OPERATOR / LEGAL REVIEWER]** decides whether, whom and how to notify
  (affected people, any regulator) and within what time. GatePass does not
  make these decisions or notifications.
- Technical contact fixes the cause (code fix, config, access change) and
  proves it with a test before closing.

**Evidence:** screenshots, rotation timestamps, list of data/people, the
notification decision and who made it. **Closed by:** estate manager +
legal/compliance reviewer.

## 8. Database or service outage

Signs: console shows offline banner while the device has internet; login
fails for everyone; `/support` page loads but entries never sync.

**First 15 min**
- Gate switches to the estate's **paper procedure** (pilot checklist D7).
  Guards already signed in keep queuing walk-ins on their devices — that is
  fine and they will sync later.
- Technical contact checks: Supabase status page, server process alive,
  server logs for `[FATAL]` (misconfiguration) or database connection errors.

**Then**
- Restore service. If the fix involves changing environment variables, the
  server refuses to start until they are all valid — read the `[FATAL]` list.
- After recovery: guards tap **Sync now**; supervisor confirms each queued
  entry appears once in the shift log; paper-log entries made by guards who
  were **not** signed in before the outage are entered as walk-ins with a
  note giving the original time.
- Note: the `/api/audit` view starts empty after a restart; the database
  table is intact.

**Evidence:** outage start/end, cause, entries re-created.
**Closed by:** technical contact + estate manager.

## 9. Resident disputes an approval

"I never approved that visitor" / "I denied and they were still let in".

**First 15 min**
- Take the resident's account of events; do not argue the record with them.

**Then**
- Senior guard opens the approval request: status, decided-at time, and the
  entry that followed. The link was one-off and expires; a decision recorded
  means **someone holding that link** decided.
- Possibilities to check in order: the resident's phone was used by someone
  else in the household; the link was forwarded; the guard used an override
  after expiry and wrote "approved" (→ §3); the request went to the wrong
  number (check `target_phone` on the notification).
- Tell the resident what the record shows in plain words, and what was
  changed as a result.

**Evidence:** approval row, notification row, entry row, resident statement.
**Closed by:** estate manager.

---

## After every incident

1. Record filed (one page: what, when, who, data affected, actions, closed by).
2. Any secret that was or might have been exposed has been rotated.
3. Any account involved is in the correct state (active/deactivated) and that
   state was verified by a test request.
4. Runbook / SOP updated if the incident exposed a process gap.
5. Counted in the pilot review metrics (checklist D8).
