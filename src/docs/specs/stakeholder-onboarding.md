# Stakeholder Onboarding — Specification

## 1. Objective

The next deliverable is **confidence**, not another screen.

Every stakeholder must understand how GatePass works before using it
in production. The onboarding system ensures:

- No guard requires external training to begin using the system
- Residents immediately understand the approval/deny lifecycle
- Administrators understand how the system protects accountability
- Every stakeholder understands offline operation
- Every stakeholder understands why GatePass behaves the way it does

The onboarding feels like an interactive product walkthrough, not documentation.

---

## 2. Guiding Principle

Do not explain screens. **Explain workflows.**

The user should leave onboarding understanding:

> "I know exactly what I need to do when someone arrives at the gate."

---

## 3. Architecture

### 3.1 First Launch — Role Selection

On first launch, before GatePassApp mounts, a full-screen role selector asks:

**"Who are you?"**

Three roles:

1. **Security Guard** — records entries, scans QR, handles approvals
2. **Resident / Host** — approves or denies visitors, manages auto-rules
3. **Security Company Administrator** — audits all activity, manages profiles

Selection is stored in `localStorage` key `gatepass_role`.
Onboarding completion is stored in `gatepass_onboarding_complete`.

The onboarding appears only on first launch. It can be replayed from
Help (accessible via a `?` icon in the nav bar).

### 3.2 Onboarding Engine

A step-based walkthrough framework shared by all three roles:

- Progress bar at top showing current step / total steps
- Each step: explanation → interactive demonstration → success confirmation
- Steps cannot be skipped (must complete action to proceed)
- Back button available for re-reading (but action not required again)
- "Knowledge check" steps use practical tasks, not quizzes

### 3.3 State

```ts
type OnboardingState = {
  role: 'guard' | 'resident' | 'admin' | null;
  completed: boolean;
  currentStep: number;
  totalSteps: number;
};
```

Persisted to localStorage. Resumable if browser closes mid-onboarding.

---

## 4. Guard Onboarding — 7 Scenarios

The guard onboarding simulates an actual shift. Instead of reading
instructions, the guard performs them.

### Welcome

> "You are responsible for recording every entry into the estate.
> GatePass helps you make every decision traceable."

### Scenario 1 — Walk-in Entry (F1: Resident Approval)

Walk the guard through:

1. A visitor arrives on foot
2. Navigate to Walk-In
3. Fill in visitor name, host, unit
4. Request resident approval
5. Wait for response (simulated)
6. Confirm entry once approved

Explain: What each screen means. Why the resident must decide.

### Scenario 2 — QR Code Entry (F6: Guest QR Ticket)

Teach:

1. Resident has pre-approved the visitor via QR pass
2. Visitor shows QR code at gate
3. Guard opens QR scanner
4. Scan succeeds → entry confirmed automatically
5. No phone calls needed

Explain: Why QR entry is fastest. How the QR was generated.

### Scenario 3 — Override Entry

Teach:

1. Emergency or urgent situations
2. Guard selects Override
3. Must provide a written reason
4. Entry is logged with "override" method
5. Override is flagged in the audit log

Explain: Why overrides exist. Why a reason is mandatory.
Why overrides should be rare and are reviewed by administrators.

### Scenario 4 — Delivery Entry (F8: Delivery Management)

Teach:

1. Delivery rider arrives (Jumia, Uber Eats, gas, water, etc.)
2. Guard selects the delivery workflow
3. Enters rider name, unit, category (parcel/food/gas/water/service/other)
4. Optionally records plate number
5. Entry logged as "delivery" kind

Explain: Why deliveries are tracked separately from visitors.
Common delivery categories. How administrators review delivery logs.

### Scenario 5 — Exit Tracking (F7: Exit Tracking)

Teach:

1. Visitor or delivery rider is leaving
2. Admin panel shows "Currently on-premise" list
3. Guard (or admin) clicks "Record exit"
4. Entry-to-exit lifecycle is closed
5. Duration is now traceable

Explain: Why knowing who is still on-premise matters for security.
What happens if someone never exits (investigation workflow).

### Scenario 6 — Offline Mode

Teach:

1. Internet goes down
2. Everything still works
3. Entries are stored locally (offline queue)
4. Sync status shows pending count
5. When internet returns, synchronization happens automatically
6. Nothing is lost

Explain: The offline queue. The sync status indicator.
Why "Pending sync: 3" means 3 entries are safe and waiting.

### Scenario 7 — Errors and Edge Cases

Show examples and teach what the guard should do:

| Error | What the guard sees | What to do |
|---|---|---|
| Approval expired | "EXPIRED" status | Ask resident to re-approve or use Override |
| Resident denied | "DENIED" with reason | Inform visitor, do NOT allow entry |
| Duplicate visitor | 409 error | Visitor already has active entry |
| QR already used (replay) | "QR_CONSUMED" | QR is single-use; visitor needs a new one |
| QR expired | "QR_EXPIRED" | Ask resident to issue a new QR pass |
| Invalid/tampered QR | "QR_INVALID" | Do NOT allow entry. Report to administrator |
| Server unavailable | 500 error | Entry saved offline, will sync later |

Explain: Never assume technical knowledge. Every error has a
clear next action.

### Guard Completion

> "You are ready to begin your shift."

---

## 5. Resident Onboarding — 5 Topics

Teach the resident from their perspective.

### Topic 1 — Why Approvals Exist

Explain: Every visitor must be authorized by a resident before entry.
This protects your home and creates a record.

### Topic 2 — Receiving Notifications and Deciding (F2: Notifications)

1. When a visitor arrives, you receive a WhatsApp or SMS notification
2. The notification contains a link
3. Click the link to see visitor details
4. Choose: Approve or Deny
5. If denying, provide a brief reason

Explain: The guard cannot override your decision (unless it's an
emergency override, which is flagged and audited).

### Topic 3 — Auto-Approval Rules (F3: Auto-Approval Engine)

1. For frequent visitors (cleaners, tutors, family)
2. Create a rule: "Allow [name] visiting [unit] until [date]"
3. When the visitor arrives, entry is approved automatically
4. Guard sees AUTO badge — no phone call needed
5. Rules expire on the date you set

Explain: Why auto-approval is safe (it's logged and auditable).
Why rules expire (security hygiene).

### Topic 4 — QR Passes for Guests (F6: Guest QR Ticket)

1. Expecting a visitor? Issue a QR pass from the admin panel
2. Share the QR code or link with your visitor
3. At the gate, visitor shows QR → guard scans → entry confirmed
4. QR is single-use and time-limited
5. Expired or reused QR codes are rejected

Explain: This is the fastest entry method. Best for planned visits.

### Topic 5 — Privacy

1. Only your approved visitors are visible to you
2. Guards cannot see other residents' approval history
3. Administrators see aggregated logs, not private messages
4. All data is stored securely with audit trails

Explain: Your data is yours. The system records accountability,
not surveillance.

### Resident Completion

> "You are now set up to manage visitor access to your home."

---

## 6. Administrator Onboarding — 6 Topics

Focus on operations and accountability.

### Topic 1 — Dashboard Overview

1. The Admin panel shows operational counters
2. Entries logged, pending sync, override flags, auto-approved
3. Rolling audit log shows every system event

Explain: This is your command center. Every action is recorded here.

### Topic 2 — Shift Log Aggregation (F5: Shift Log)

1. Shift log shows per-guard entry summaries
2. Filter by date range or specific guard
3. Method counters: QR, Walk-in, Override, Auto, Denied, Expired
4. Invariant: total entries = sum of all method counters

Explain: Use this to review guard performance and detect anomalies
(e.g. excessive overrides, many denials).

### Topic 3 — Visitor Profile Management (F4: Visitor Profiles)

1. Create and manage visitor profiles
2. Flag visitors with WATCH status
3. Soft-delete profiles (recoverable)
4. Restore deleted profiles
5. RBAC: only admin tokens can modify profiles

Explain: Visitor profiles enable recognition. WATCH flags alert
guards to individuals requiring extra scrutiny.

### Topic 4 — Currently On-Premise (F7: Exit Tracking)

1. View all visitors currently inside the estate
2. See entry time, method, visitor details
3. Record exits as visitors leave
4. Useful during emergencies: know who is on-site

Explain: This is your real-time estate occupancy view.
Critical for security incidents and emergency response.

### Topic 5 — Delivery Logs (F8: Delivery Management)

1. View all delivery entries (parcels, food, services)
2. Filter by category
3. Track delivery patterns per unit

Explain: Deliveries are the most frequent gate interactions.
Separate tracking prevents them from cluttering visitor logs.

### Topic 6 — Accountability and Audit

1. Every action has a Trace ID
2. Audit history is append-only (nothing can be deleted)
3. Error codes are explicit — no silent failures
4. Override entries are flagged for review

Explain: GatePass never silently accepts failures. Every error
surfaces with a code and trace ID. This is by design.
Administrators can trace any incident back to the exact guard,
time, and decision.

### Topic 7 — Issuing QR Passes (F6: Guest QR Ticket)

1. Admins can issue QR passes on behalf of residents
2. Fill in visitor name, host, unit
3. System generates a single-use, time-limited QR
4. Share with the visitor via link or QR image
5. Expired/consumed/tampered QR codes are rejected

Explain: This lets administrators facilitate planned visits
(e.g. estate events, maintenance contractors).

### Administrator Completion

> "You now understand how GatePass protects accountability across
> every entry, exit, and decision."

---

## 7. Help Center

After onboarding finishes, a permanent Help Center is accessible
from the nav bar (`?` icon).

### Sections

- Guard Guide
- Resident Guide
- Administrator Guide
- Offline Mode
- Notifications
- QR Entry
- Approvals
- Override Entry
- Delivery Management
- Exit Tracking
- Visitor Profiles
- Troubleshooting (error codes + what to do)
- Replay Tutorials (re-launch the role onboarding)

---

## 8. Technical Architecture

### File Structure

```
src/features/onboarding/
  OnboardingGate.tsx        # Wraps App — shows onboarding or main app
  RoleSelection.tsx         # "Who are you?" screen
  OnboardingWalkthrough.tsx # Step engine (shared by all roles)
  steps/
    guardSteps.ts           # Guard scenario definitions
    residentSteps.ts        # Resident topic definitions
    adminSteps.ts           # Admin topic definitions
  HelpCenter.tsx            # Permanent reference hub
  types.ts                  # OnboardingStep, OnboardingState types
  useOnboarding.ts          # Hook: localStorage persistence + step navigation
```

### Integration Point

In `App.tsx`, the root route wraps `Index` with `OnboardingGate`:

```tsx
<Route path="/" element={<OnboardingGate><Index /></OnboardingGate>} />
```

OnboardingGate checks localStorage. If role is null or onboarding
incomplete, renders the onboarding flow instead of the children.

### Step Definition Shape

```ts
type OnboardingStep = {
  id: string;
  title: string;
  explanation: string;         // What the user needs to understand
  demonstration?: string;      // Visual or interactive demo description
  practicePrompt?: string;     // "Now you try:" task
  successMessage?: string;     // Shown after completing the practice
  icon?: LucideIcon;
};
```

### Persistence

- `localStorage.gatepass_role`: `'guard' | 'resident' | 'admin'`
- `localStorage.gatepass_onboarding_complete`: `'true'`
- `localStorage.gatepass_onboarding_step`: current step number (for resume)

---

## 9. Acceptance Criteria

### Guard

- [ ] Record a walk-in visitor entry (approval flow)
- [ ] Handle QR scan entry
- [ ] Use override with reason
- [ ] Log a delivery entry
- [ ] Record an exit
- [ ] Understand offline mode
- [ ] Resolve common errors

### Resident

- [ ] Approve a visitor
- [ ] Deny a visitor with reason
- [ ] Understand notifications
- [ ] Create an auto-approval rule
- [ ] Understand QR passes

### Administrator

- [ ] Navigate the dashboard
- [ ] Review shift logs
- [ ] Manage visitor profiles
- [ ] View on-premise occupancy
- [ ] Review delivery logs
- [ ] Understand audit accountability
- [ ] Issue QR passes

Only when all three stakeholders can complete their workflows
without assistance should onboarding be considered complete.

---

## 10. Gaps Filled (vs. Original Plan)

The user's original plan was enriched with:

| Missing item | Where added | Feature |
|---|---|---|
| Override entry workflow | Guard Scenario 3 | Core |
| Delivery management | Guard Scenario 4, Admin Topic 5 | F8 |
| Exit tracking | Guard Scenario 5, Admin Topic 4 | F7 |
| QR code details (guard side) | Guard Scenario 2 | F6 |
| Admin QR issuance | Admin Topic 7 | F6 |
| Recognized visitor flow | Covered implicitly in QR/auto-approval | F3/F6 |
| Error table for guard | Guard Scenario 7 | All |
