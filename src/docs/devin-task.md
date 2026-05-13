⚙️ STAGE 1 — ALIGN FRONTEND → BACKEND CONTRACT (CRITICAL FIRST STEP)

This is the step most people skip—and regret later.

ATTACH:
1. Full GatePass definition
2. gatepassReducer.ts
3. types.ts

Now define the backend API contract that matches the CURRENT frontend behavior.

Use API-AND-INTERFACE-DESIGN skill to create strict request/response contracts.

Use IDEA-REFINE skill to map frontend actions to backend endpoints.

Use TRUSTLESS-SYSTEM-AUDITOR skill to detect mismatches between frontend assumptions and backend reality.

Output must include:

- mapping of frontend actions → backend endpoints:
  (SCAN_QR, SUBMIT_ENTRY, SYNC_PENDING, OVERRIDE, SEARCH_VISITOR)

- exact API contracts:
  request schema
  response schema
  error schema (explicit, no generic errors)

- validation rules per endpoint

Hard constraints:
- backend must fully support current frontend flows
- no implicit success responses allowed
- every action must produce a traceable backend event
⚙️ STAGE 2 — DRIZZLE SCHEMA (REAL DATABASE)

Now we move to actual implementation.

ATTACH:
- GatePass definition
- API contracts from previous step

Define Drizzle ORM schema for GatePass.

Use API-AND-INTERFACE-DESIGN skill to enforce relational integrity.

Use SECURITY-AND-HARDENING skill to prevent invalid states.

Use SOURCE-DRIVEN-DEVELOPMENT skill to align with Postgres best practices.

Output must include:

- Drizzle schema for:
  EntryRecord
  Guard
  OverrideEvent
  AuthorizationDecision
  SyncEvent

- constraints:
  NOT NULL rules
  foreign keys
  unique constraints

Hard rules:
- entry cannot exist without guard_id
- override cannot exist without reason
- timestamps must be server-generated
- no nullable critical fields
⚙️ STAGE 3 — ENTRY API (FIRST REAL ENDPOINT)

Now we replace the most important action: SUBMIT_ENTRY

ATTACH:
- schema
- API contract

Implement POST /entries endpoint.

Use INCREMENTAL-IMPLEMENTATION skill to build only this endpoint.

Use TEST-DRIVEN-DEVELOPMENT skill to define tests first.

Use CODE-REVIEW-AND-QUALITY skill to ensure clean structure.

Use SECURITY-AND-HARDENING skill to validate all inputs.

Output must include:

- endpoint implementation
- validation logic
- error handling
- tests (must include failure cases)

Hard constraints:
- must reject incomplete entries
- must log every successful entry
- must return structured response (not raw DB object)
- no silent failure allowed
🔁 FRONTEND CHANGE (IMPORTANT)

After this step:

You modify frontend:

// BEFORE
dispatch({ type: "SUBMIT_ENTRY", payload })

// AFTER
await api.createEntry(payload)
dispatch({ type: "ENTRY_SUCCESS", data })
⚙️ STAGE 4 — OVERRIDE ENDPOINT
Implement POST /override endpoint.

Use SECURITY-AND-HARDENING skill to enforce traceability.

Use INCREMENTAL-IMPLEMENTATION skill to isolate this logic.

Use TEST-DRIVEN-DEVELOPMENT skill for failure scenarios.

Output must include:
- endpoint
- validation (reason required)
- audit logging

Hard constraints:
- no override without reason
- must attach guard_id
- must generate audit event
⚙️ STAGE 5 — QR VALIDATION ENDPOINT
Implement POST /validate-qr endpoint.

Use SECURITY-AND-HARDENING skill to prevent replay attacks.

Use API-AND-INTERFACE-DESIGN skill for strict validation contract.

Use TEST-DRIVEN-DEVELOPMENT skill to test edge cases.

Must handle:
- valid QR
- expired QR
- replayed QR
- invalid QR

Hard constraints:
- QR cannot be reused
- must return explicit failure reasons
⚙️ STAGE 6 — OFFLINE SYNC ENDPOINT
Implement POST /sync-entries endpoint.

Use INCREMENTAL-IMPLEMENTATION skill to build idempotent sync logic.

Use SECURITY-AND-HARDENING skill to prevent duplication.

Use TEST-DRIVEN-DEVELOPMENT skill to simulate failure.

Must handle:
- duplicate entries
- partial sync
- retry logic

Hard constraints:
- no duplicate entries allowed
- no data loss allowed
⚙️ STAGE 7 — TRUSTLESS AUDIT (MANDATORY)
Audit backend system.

Use TRUSTLESS-SYSTEM-AUDITOR skill.

Simulate:
- guard bypass
- duplicate entry attack
- offline corruption
- replay attack

Output:
- critical risks
- silent failure paths
- system trust score

Hard rule:
If any entry path is unlogged → system FAILS