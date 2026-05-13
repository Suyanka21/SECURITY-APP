PROJECT CONTEXT

System:
GatePass is a guard-first access control system for security firms that records, authorizes, and audits every entry into a property in real time—designed around real guard behavior rather than ideal workflows.

It replaces manual logbooks and fragmented WhatsApp approvals with a structured entry system that still allows flexibility (walk-ins, overrides, offline use), while ensuring every action is traceable.

Core principle:

The system does not enforce perfect behavior—it captures real behavior and makes it accountable.

USER FLOW
1. Entry Initialization
Guest arrives (with or without prior approval)
2. Guard Interaction (Primary Actor)

Guard chooses one path:

A. Pre-Approved Entry
Scan QR
System validates
Entry logged instantly
B. Walk-In Entry
Tap “New Entry”
Input:
Name (required)
Vehicle plate (optional)
Select host (suggested list or search)
System decides:
auto-approve OR
request approval OR
fallback call
C. Recognized Visitor
System suggests frequent visitor
One-tap selection
D. Manual Override
Guard selects “Allow”
Chooses reason
Entry logged with metadata
3. Authorization Layer
Pre-approved rules
Auto-approval engine
Real-time resident approval (if needed)
Guard override (always available but logged)
4. Entry Completion
Entry recorded
Linked to:
guard ID
time
method (QR / walk-in / override / auto)
5. Enforcement Logging (Always Active)
Every action is written to shift log
Aggregated per guard per shift
CORE DEPENDENCIES
System Infrastructure
Cloud backend (entry storage + sync)
Offline local storage on guard devices
Communication Layer
WhatsApp (for QR pass sharing + notifications)
SMS fallback (offline mode)
Identity Resolution
Lightweight resident/visitor database
Fuzzy search for names + repeat visitors
Device Layer
Mobile app for guards (primary interface)
Admin dashboard (web)
Notification System
Resident alerts (optional, rule-based)
Security firm alerts (exceptions only)
CRITICAL ACTIONS

These are system-breaking if they fail:

1. Entry Logging Integrity

Every entry MUST be recorded—even in offline mode.

2. Guard Action Capture

Every override, approval, or bypass must be logged with:

guard ID
timestamp
reason (if override)
3. Speed of Entry Flow

Walk-in entry must remain under friction threshold (~5–10 seconds)

4. Offline Continuity

System must function without connectivity and sync later safely

5. Identity Consistency

Repeated visitors must be correctly recognized or suggested

FAILURE SENSITIVITY
❌ Catastrophic Failures
Entries not logged (data loss)
Guards able to bypass system without trace
Duplicate or missing entry records
Sync corruption after offline mode
System slowdown that delays gate entry
⚠️ High Risk (Serious but recoverable)
Misidentification of visitor/host
Notification delays to residents
Poor suggestion accuracy for repeat visitors
Manual override overuse without visibility
🟡 Acceptable Failures
Occasional wrong name spelling
Missed optional vehicle plate data
Delayed analytics reporting
Minor UI friction adjustments
🟢 Non-Critical Issues
Resident rarely using app features
Low engagement with optional automation rules
Incomplete profile enrichment of visitors
KEY DESIGN INSIGHT

The system is not optimized for perfection.

It is optimized for:

capturing imperfect human behavior without breaking flow

Everything else is secondary to:

speed at gate
traceability of action
guard usability under pressure