# GatePass — Privacy & Data-Handling Draft

> **DRAFT — NOT A LEGAL DOCUMENT. NOT LEGAL ADVICE.**
> This document has **not** been reviewed by a lawyer or compliance
> professional. It was written by an engineer to describe, accurately and in
> plain English, what the GatePass software does with personal data so that a
> **Kenyan lawyer or compliance professional** can review it and turn it into
> a real privacy notice and data-handling policy before commercial rollout.
> Nothing here creates rights, obligations or guarantees. Wherever a decision
> belongs to the operator or the legal reviewer it is marked
> **[OPERATOR / LEGAL REVIEWER TO DECIDE]**. Do not publish this text as-is.

The short public version of this draft is rendered at `/legal/privacy`
(`src/features/public-info/pages/PrivacyNotice.tsx`), with the same banner.

## 1. Who operates GatePass

**[OPERATOR / LEGAL REVIEWER TO DECIDE]** — legal name of the estate or
security company that decides why and how the data is used, and their contact
details. The software itself is not the operator.

## 2. What is stored, and why

Everything below is taken from the database schema (`src/db/schema.ts`).
"Stored" means written to the operator's Postgres database hosted on Supabase.

### 2.1 Visitors

| Data | Why it is recorded | Table(s) |
|---|---|---|
| Name given at the gate or on the invitation | Identify who entered | `entry_records`, `authorization_decisions` (pre-approvals / QR passes), `visitor_profiles`, `approval_requests` |
| Host name and unit visited | Know who authorised the visit | same |
| Vehicle plate (optional) | Match vehicle to visit; flag mismatches | same, `watchlist_entries` |
| Phone number (optional) | Reach a regular visitor; the pass link itself is shared by the host | `visitor_profiles` |
| Entry time, exit time, guard on duty, delivery category where relevant | Record of who was on the premises and when | `entry_records`, `exit_records`, `sync_events` (offline replays) |
| Pass token **hash**, PIN **hash** and short pass reference (never the PIN or token itself) | Check a pass without being able to reveal it | `authorization_decisions` |
| Guard notes (short, tagged) | Context for the entry, e.g. "delivery", "no ID shown" | `guard_notes` |
| Watchlist entry (name, optional plate, mandatory reason) | Warn — never block — the guard | `watchlist_entries` |

### 2.2 Residents / hosts

| Data | Why | Table(s) |
|---|---|---|
| Name and unit | Address approval requests | `approval_requests`, entry tables |
| Phone number (E.164) | Send the one-off approval link | `approval_requests.host_phone_e164`, `notifications.target_phone` |
| Approve / deny decision and time | Evidence that the resident authorised (or refused) the visit | `approval_requests` |
| Auto-approval rules the resident set up | Skip the request for regular visitors | `auto_approval_rules` |
| The text of messages sent to them | Delivery troubleshooting | `notifications.rendered_body` |

### 2.3 Guards, senior guards, admins

| Data | Why | Table(s) |
|---|---|---|
| Name, badge number, role, active flag | Identify staff and decide what they may do | `guards` |
| Login email and password (password held **only** by Supabase Auth as a hash) | Sign in | Supabase Auth |
| Every entry, override, exit, account action they perform, with time | Accountability | `audit_events`, `override_events`, all entry tables |

### 2.4 Technical records

| Data | Why |
|---|---|
| Audit events (`audit_events`): type, time, guard, trace reference, structured payload with **no** raw PINs, tokens or passwords | Reconstruct what happened; detect misuse |
| Server logs (stdout of the API process) | Operations. **[OPERATOR TO DECIDE]** where these go and for how long. |
| On the guard's device: cached identity of the signed-in guard and the queue of entries made while offline | Keep working without network; removed on sign-out / browser data clear |

**Not collected:** ID numbers, photographs, biometrics, location of phones,
resident login accounts (residents do not have accounts).

## 3. Who can see what

| Data | Guard | Senior guard | Admin | Resident | Visitor | Public |
|---|---|---|---|---|---|---|
| Own shift's entries (on device) | yes | yes | yes | — | — | — |
| Shift log, on-premise list, deliveries (all guards) | **no** | yes | yes | — | — | — |
| Watchlist, visitor profiles | **no** | yes | yes | — | — | — |
| Audit log (`/api/audit`) | **no** | yes | yes | — | — | — |
| Staff accounts (create) | no | no | yes | — | — | — |
| One approval request addressed to them | — | — | — | yes (via link) | — | — |
| Their own pass | — | — | — | — | yes (via link) | — |
| Anything | — | — | — | — | — | **nothing** |

Enforced server-side on every request by the database role; the browser's
choices are never trusted. Proven by `src/server/__tests__/access-boundaries.test.ts`.

Third parties with technical access: the hosting/database provider
(Supabase), and any SMS/WhatsApp provider the operator connects (**none is
connected today** — the notification channel is a default-deny mock).
**[LEGAL REVIEWER]** — processor terms for these.

## 4. How long data is kept

**Today the software deletes nothing automatically.** Every record listed
above stays until someone with database access removes it.

**[OPERATOR / LEGAL REVIEWER TO DECIDE]** retention periods, e.g. separately
for: visitor entry/exit records; expired or used passes; approval requests
and notification bodies; audit events; watchlist entries (the software asks
for re-confirmation of a watchlist entry after 90 days but does not delete
it); deactivated staff accounts. Until decided, the public notice must say
that a period has not yet been set.

## 5. When data is deleted

Today: only by a manual database operation run by the technical contact on an
admin's written instruction, recorded in the requests log. Audit events are
append-only by design; **[LEGAL REVIEWER]** whether and how audit rows about a
person may be deleted or must be kept.

## 6. How visitor records and audit logs are protected

- Access requires a signed-in staff account whose role is checked in the
  database on every request; plain guards cannot read other guards' records.
- PINs and pass tokens are stored only as hashes with a server-side pepper.
- Resident approval links are one-off, expire, and are useless after use.
- Public pages (`/pass/:token`, `/approve/:id`) show only the one record the
  link belongs to, in plain language, with no internal error codes.
- Overrides and their audit events are written in the same database
  transaction, so the audit trail cannot claim something that did not happen.
- Row-Level Security is to be enabled on every table (deployment checklist).
- Transport is HTTPS only; the service-role key never leaves the server.
- Guard devices hold only the signed-in guard's own cached identity and queue.

**Known limits:** no encryption of names/plates at rest beyond the hosting
provider's disk encryption; server logs and the in-memory audit view are not
access-controlled beyond host access; no automatic retention.

## 7. What must never be public

Names, phone numbers, units, plates, entry/exit times, approval decisions,
staff names and badges, audit events, PINs, pass tokens, any key or secret,
internal error codes, stack traces or database messages. The public pages and
the API tests check the last group; the first group is protected by the role
checks in §3.

## 8. If someone's data is wrong

A visitor, resident or staff member who believes a record about them is wrong
should contact the estate support desk (shown on `/support`). Today a
correction is a manual database change made by the technical contact on an
admin's written instruction; the original audit events are **not** altered.
**[LEGAL REVIEWER]** — response time, verification of the requester, and
whether the person is told what was changed.

## 9. If a data breach is suspected

Follow [Incident response §7](./incident-response.md): contain (rotate keys,
deactivate accounts), establish what data and whose, record it, and
**[LEGAL REVIEWER TO DECIDE]** who must be notified, within what time, and in
what form. The software cannot make those notifications for you.

## 10. Items the legal reviewer must decide before publication

1. Identity and contact of the operator (data controller).
2. Lawful basis / purpose wording for each data category in §2.
3. Retention periods (§4) and deletion procedure (§5).
4. Whether audit records are exempt from deletion requests.
5. Rights of visitors, residents and staff, and how to exercise them.
6. Processor terms with Supabase and any messaging provider.
7. Breach-notification obligations, recipients and deadlines (§9).
8. Whether the estate must display a notice at the gate itself.
9. Governing law, liability and dispute terms for the Terms of Use.
10. Any children's-data, CCTV-adjacent or employment-law considerations for guards.
