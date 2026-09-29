# GatePass — Admin & Supervisor Standard Operating Procedures

Step-by-step procedures for admins and senior guards. Each SOP says who may
run it, what to click, what "done" looks like, and what to write down.
"Dashboard" = the admin web dashboard (admins). "Admin tab" = the admin tab in
the gate console (senior guards and admins).

Procedures marked **(outside the app)** are not yet built into GatePass and
are executed by the technical contact on an admin's written instruction.

Related: [Operations runbook](./operations-runbook.md) ·
[Incident response](./incident-response.md)

---

## SOP 1 — Create a guard, senior guard or admin account

**Who:** admin only.

1. Get the new staff member's full name, work email and badge number from HR.
   The badge number must be unique and must not be a reused one.
2. Dashboard → **Accounts** → **Create account**. Enter name, email, badge,
   and choose the role. Give `senior-guard` only to shift supervisors;
   `admin` only to people who may create other accounts.
3. Submit. The temporary password appears **once**. Write it on paper, hand
   it to the person face-to-face, and have them sign in immediately on a
   console device so it is used and can be changed.
4. Check the header of their console shows *their* name and badge.
5. If the dashboard warns that the account was created but the audit record
   failed, stop: record the warning text and time, and follow
   [Incident response §5](./incident-response.md) before the account is used.

**Record:** name, badge, role, date, admin who created it — in the staff file.

## SOP 2 — Deactivate a guard **(outside the app)**

**Who:** admin authorises in writing; technical contact executes.

1. Admin sends the technical contact: name, badge, reason, effective time.
2. Technical contact sets `is_active = false` on the `guards` row and disables
   the user in Supabase Auth. From that moment every request from that
   account is refused, even mid-session.
3. Technical contact replies "done" with the time. Admin files both messages.
4. Supervisor collects the device, checks the pending counter (SOP 7 if not
   zero), signs out, clears browser data.

## SOP 3 — Review a shift log

**Who:** senior guard or admin.

1. Admin tab (or dashboard) → **Shift log**. Choose the guard and the window.
2. Read down the list. For each entry check: visitor name plausible, host and
   unit exist, method (QR / PIN / walk-in / delivery) matches the situation,
   exit recorded where expected.
3. Flag: overrides (→ SOP 4), entries with no exit older than a day (→ SOP 5),
   bursts of entries in seconds, entries outside the guard's rostered hours.
4. Sign the paper shift-review sheet: date, guard, entries reviewed, flags.

## SOP 4 — Review override activity

**Who:** senior guard or admin, at least weekly and after any complaint.

1. From the shift log, list every entry marked as an override.
2. For each: read the **reason**. Acceptable reasons name a person and a
   means ("host Mrs X confirmed by phone", "resident approval expired, host
   met visitor at gate"). Unacceptable: blank-ish reasons, "ok", "let in".
3. Cross-check the override's trace reference in the audit trail
   (`/api/audit/reconstruct/:traceId`, or the `audit_events` table for
   anything older than the last server restart — see runbook §8). There must
   be exactly one `override_authorized` event per override; if the counts do
   not match, → [Incident response §5](./incident-response.md).
4. Speak to the guard. Record the explanation and your decision.
5. Pattern of poor reasons → retraining; suspected collusion →
   [Incident response §3](./incident-response.md).

## SOP 5 — Review visitors currently on the premises

**Who:** senior guard or admin; at shift start and end.

1. Admin tab / dashboard → **Currently on premise**.
2. Anyone listed longer than plausible for their visit type (deliveries:
   under an hour; contractors: same day) → radio/call the gate to confirm
   whether they left without an exit being recorded.
3. If they left: the senior guard records the exit with **Record exit** and
   notes "exit recorded late by <name>" in the guard note.
4. If they are still inside and should not be → escalate per the estate's
   physical-security procedure, then
   [Incident response §4](./incident-response.md) if they were wrongly admitted.

## SOP 6 — Handle a locked pass

**Who:** guard reports; senior guard decides.

1. A pass locks after 5 wrong PINs. The console and the visitor's own pass
   page both say **Locked**. It cannot be unlocked at the gate — by anyone.
2. Ask the visitor to contact their host. The host issues a **new** pass.
3. If the host cannot be reached and the visitor must be dealt with now, the
   senior guard may authorise a walk-in entry with an override reason stating
   exactly what was verified. This override is reviewed under SOP 4.
4. Repeated lockouts on passes from the same host → tell the host their
   visitors are guessing PINs; consider whether the pass was forwarded.

## SOP 7 — Respond to a failed sync

**Who:** guard reports; senior guard handles; technical contact if step 4.

1. Ask the guard for the pending count and the exact message shown. Do
   **not** let anyone clear browser data — that destroys the queue.
2. Confirm the device is online (open `/support` in a new tab). Tap
   **Sync now**. Re-sending is safe: duplicates are rejected server-side.
3. If the console says the session expired, the **same guard** signs in
   again on the **same device**; the queue is preserved and can be synced.
4. If specific entries are rejected, copy their details to the shift-review
   sheet and send the message text to the technical contact. Entries stay in
   the queue; they are not lost unless the browser data is cleared.
5. Once the counter is 0, open the shift log and confirm each queued entry
   appears exactly once.
6. Record it: time offline, number of entries, outcome →
   [Incident response §6](./incident-response.md) if any entry could not be recovered.

## SOP 8 — Respond to a lost or stolen device

**Who:** anyone reports; supervisor + technical contact act. Same day.

1. Identify which account was signed in on the device (ask the guard; check
   the shift log for the last entry from that device's guard).
2. Technical contact: revoke that user's sessions and reset their password in
   Supabase Auth (or deactivate per SOP 2 if the person is also leaving).
   Until this is done the device can still log entries.
3. Check the shift log for entries after the time the device was lost; any
   unexplained entry → [Incident response §2](./incident-response.md).
4. Issue a replacement device; the guard signs in with the new password.
5. Record: device, guard, time lost, time revoked, entries reviewed.

## SOP 9 — Respond to suspicious access activity

**Who:** senior guard or admin; technical contact for step 3.

Suspicious means, for example: entries logged while the named guard was off
duty; a plain guard's account calling admin endpoints (403s in server logs);
account-creation events nobody remembers; a burst of wrong-PIN lockouts;
resident approvals decided seconds after being sent from an unexpected device.

1. Do not confront anyone yet. Capture what you see (screenshot, time,
   account, entry IDs).
2. If a staff account is involved, have it deactivated (SOP 2) or its
   sessions revoked **now**; investigation can proceed afterwards.
3. Technical contact pulls the relevant `audit_events` and server log lines
   for the window into a file kept with the incident record.
4. Follow [Incident response §1](./incident-response.md) (compromised
   account) or §3 (misuse by staff).
5. Report outcome to the estate manager in writing.

---

## Record-keeping

Every SOP ends with a written record. Keep them in one place (a locked
folder or a restricted shared drive), retain them for the period the legal
reviewer sets, and never paste GatePass data into group chats.
