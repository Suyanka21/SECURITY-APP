# SHIP READINESS REPORT — TRUSTLESS AUDIT v3.0

**System:** GatePass Backend  
**Audited:** 2026-05-13  
**Auditor Protocol:** Trustless System Auditor v3.0 + Code-Review-and-Quality  
**Evidence Base:** 7 services, 5 routes, 5 validation schemas, 1 middleware, 9 test files (109 tests), 1 DB schema (6 tables), 3 documentation files  

---

## CONTEXT SUMMARY

- **Primary user:** Security guard at a residential property gate — mobile-first, high-pressure, variable connectivity
- **Critical action that must never fail:** Entry logging — every visitor who enters MUST produce a traceable record
- **External dependencies:** PostgreSQL (Supabase), Express.js, Drizzle ORM, Zod validation
- **Real user testing completed:** No — 100% of testing is unit tests with mocked DB
- **Skills applied during build:** API-and-Interface-Design ✅, TDD ✅, Security-and-Hardening (partial), Source-Driven-Development ✅, Code-Review-and-Quality ✅
- **Skills NOT applied:** Frontend-UI-Engineering (backend only), Browser-Testing-with-DevTools (N/A), CI-CD-and-Automation ❌, Shipping-and-Launch ❌, Performance-Optimization ❌

---

## SYSTEM TRUST SCORE: MEDIUM

The backend has a **sound architectural foundation** — services are well-separated, validation is layered (Zod → service → DB CHECK constraints), and audit logging is pervasive. However, **critical infrastructure-layer gaps exist** that would allow bypass under real-world conditions.

---

## CRITICAL BLOCKERS

Do not ship until every item here is resolved.

---

### [C1] NO AUTHENTICATION MIDDLEWARE EXISTS

**Confidence:** CONFIRMED  
**What breaks:** Any HTTP client can call any endpoint. There is no JWT verification, no session token validation, no authentication middleware at all.  
**When it breaks:** Immediately upon deployment. Anyone who discovers the API URL can create, modify, or query entries.  
**What the user experiences:** A guard's identity is assumed based on a `guardId` field the caller provides — any value is accepted as long as it exists in the `guards` table. An attacker can impersonate any guard.  
**Why it matters:** The entire system's traceability depends on `guardId` being trustworthy. If anyone can claim to be any guard, the audit log is meaningless. This violates GATEPASS DEFINITION §Critical Actions #2: "Every override, approval, or bypass must be logged with guard ID."  
**What must be fixed:** Implement JWT or session-based authentication middleware that verifies the caller's identity BEFORE any route handler executes. The `guardId` must come from the verified token, NOT from the request body.

**Evidence:**  
- `app.ts` L22-30 — Only middleware is `express.json()` and DB attachment  
- `app.ts` L5 comment references "security headers, CORS, rate limiting" but none are implemented  
- Every route handler reads `guardId` from `req.body` or `req.query` — client-supplied, unverified  

---

### [C2] NO CORS, NO SECURITY HEADERS, NO RATE LIMITING

**Confidence:** CONFIRMED  
**What breaks:** The app.ts comments reference "Security-and-Hardening skill — security headers, CORS, rate limiting" (line 5), but none of these are implemented. Zero middleware for `helmet`, `cors`, or any rate limiter exists.  
**When it breaks:** On any public deployment.  
**What the user experiences:**  
- Without CORS: any website can make API calls to this server  
- Without security headers: XSS and clickjacking attacks are possible  
- Without rate limiting: an attacker can brute-force QR tokens or flood the entry endpoint  
**Why it matters:** A gate control system exposed without rate limiting means an attacker can send thousands of entry creation requests, overwhelming the guard's view and polluting the audit trail.  
**What must be fixed:** Add `helmet()`, `cors({ origin: allowlist })`, and `express-rate-limit` middleware to `app.ts` before any routes.

**Evidence:**  
- `grep` for "rate-limit" → 0 results  
- `grep` for "helmet" → 0 results  
- `grep` for "cors" → only the comment in `app.ts` L5  

---

### [C3] GUARD BYPASS VIA DIRECT `guardId` INJECTION

**Confidence:** CONFIRMED  
**What breaks:** Every endpoint accepts `guardId` as a client-provided field. The system only checks that the ID exists in the `guards` table and `isActive=true`. It does NOT verify that the caller IS that guard.  
**When it breaks:** Any request where `guardId` is set to a valid UUID from the guards table.  
**What the user experiences:** An unauthorized person creates entries attributed to a legitimate guard. The guard's shift log shows entries they never processed. Accountability is destroyed.  
**Why it matters:** This directly violates the GATEPASS DEFINITION core principle: "makes it accountable." Without verified identity, entries are attributable but not accountable.  
**What must be fixed:** `guardId` must be extracted from a verified authentication token, not from the request body. Remove `guardId` from all request schemas and inject it from middleware after auth verification.

**Evidence:**  
- `entry-schemas.ts` L70-72 — guardId accepted from body  
- `qr-schemas.ts` L34-36 — guardId accepted from body  
- `sync-schemas.ts` L57-59 — guardId accepted from body  
- `visitor-schemas.ts` L22-24 — guardId accepted from query  
- All 4 services verify guard exists but never verify caller IS that guard  

---

### [C4] AUDIT LOG DB PERSISTENCE IS FIRE-AND-FORGET

**Confidence:** CONFIRMED  
**What breaks:** `audit-logger.ts` L127-134 — DB persistence is async and non-blocking. If the database write fails, the error is caught and logged to console, but the operation continues as if it succeeded. The audit event exists only in volatile in-memory storage and stdout.  
**When it breaks:** Database connection drop, pool exhaustion, disk full, or any transient DB error during audit persistence.  
**What the user experiences:** Nothing — the API returns success. But the audit trail is incomplete in the database. If the server restarts, in-memory events are lost forever.  
**Why it matters:** The GATEPASS DEFINITION says "Every action is written to shift log." If DB persistence fails silently, entries exist without corresponding audit records. The system state becomes non-reconstructable, violating the hard rule: "Full system state can be rebuilt from events."  
**What must be fixed:** Audit event persistence must be synchronous to the operation. If the audit write fails, the entry creation should also fail — or at minimum, the failure must be surfaced, not swallowed.

**Evidence:**  
- `audit-logger.ts` L129-133 — `.catch()` swallows the error with only console.error  
- `audit-logger.ts` L97 — Comment says "non-blocking to avoid cascading failures" — this is backwards for an audit system  

---

## HIGH RISKS

Ship with active monitoring. Resolve in first patch.

---

### [H1] ENTRY AND OVERRIDE ARE NOT TRANSACTIONAL

**Confidence:** CONFIRMED  
**What breaks:** `entry-service.ts` L162-177 — Entry insertion and override event insertion are two separate DB operations with no transaction wrapper. If the override insert fails after the entry insert succeeds, you have an override entry with no override_events record.  
**When it breaks:** Database error between the two inserts (connection drop, FK violation, CHECK constraint failure).  
**What the user experiences:** An override entry appears in the system without its required justification record. The entry exists but the accountability metadata is missing.  
**Why it matters:** GATEPASS DEFINITION §2D requires "Entry logged with metadata." An override entry without its override_events record is an entry without accountability — exactly what the system exists to prevent.  
**Mitigation before ship:** Wrap entry + override insert in a database transaction using Drizzle's `db.transaction()`.

**Evidence:**  
- `entry-service.ts` L162 — `await (db as any).insert(entryRecords).values(entryRow)`  
- `entry-service.ts` L176 — `await (db as any).insert(overrideEvents).values(...)` — separate await, no transaction  
- Same pattern in `sync-service.ts` L186-196  

---

### [H2] SYNC SERVICE ENTRY-LEVEL FAILURES CAN SILENTLY LOSE SYNC EVENT RECORDS

**Confidence:** CONFIRMED  
**What breaks:** `sync-service.ts` L253-258 — If the sync_events insert fails for a rejected entry, the error is caught with an empty catch block. The rejection is still reported to the caller, but the sync_events audit record is lost.  
**When it breaks:** Any DB error during sync_events insertion for a rejected entry.  
**What the user experiences:** The sync response correctly shows the entry as "rejected," but no record of the rejection exists in the sync_events table. This creates a forensic blind spot.  
**Mitigation before ship:** At minimum, log the failure. Better: make the sync_events insert part of the rejection flow, or queue it for retry.

**Evidence:**  
- `sync-service.ts` L255 — `catch { }` — completely empty catch block  

---

### [H3] IN-MEMORY AUDIT LOG GROWS UNBOUNDED

**Confidence:** CONFIRMED  
**What breaks:** `audit-logger.ts` L59 — `const auditLog: AuditEvent[] = []` — this array grows forever. There is no eviction, no rotation, and no size cap.  
**When it breaks:** After prolonged operation under load. A busy gate with 500 entries/day would accumulate ~5,500 events/day (entries + overrides + audit events). Over weeks, this consumes significant memory.  
**What the user experiences:** Server slows down, then crashes with OOM. All in-memory audit events are lost on crash.  
**Mitigation before ship:** Add a size cap (e.g., most recent 10,000 events) and rely on DB as the authoritative source. Or implement log rotation.

**Evidence:**  
- `audit-logger.ts` L59 — unbounded array  
- `audit-logger.ts` L117 — `auditLog.push(event)` — never pruned  

---

### [H4] `createdAt` TIMESTAMP VALIDATION IS INCOMPLETE

**Confidence:** CONFIRMED  
**What breaks:** `entry-schemas.ts` L76-77 — The contract says `createdAt` must be "Valid ISO 8601, max 24 hours old," but the Zod schema only validates ISO 8601 format. It does NOT enforce the 24-hour age limit.  
**When it breaks:** An attacker or malfunctioning client sends entries with timestamps from weeks ago. These are accepted and stored.  
**What the user experiences:** Historical entries appear in the system with incorrect timestamps, corrupting shift reports and audit timelines.  
**Mitigation before ship:** Add a custom refinement to reject `createdAt` values older than 24 hours.

**Evidence:**  
- `entry-schemas.ts` L76-77 — `.datetime()` only, no age check  
- Contract §3.2 Validation Rules — "Valid ISO 8601, max 24 hours old"  
- `qr-schemas.ts` L72-82 — QR validation DOES check future limit (5 min) — inconsistency  

---

### [H5] SQL INJECTION VIA VISITOR SEARCH

**Confidence:** PROBABLE  
**What breaks:** `visitor-service.ts` L61-66 — The search term is embedded into an `ilike` filter as `%${q}%`. While Drizzle ORM's `ilike()` function parameterizes queries, the `sql` template tag used for the aggregation query (L70-87) interpolates the `searchFilter` variable. If the ORM does not properly parameterize the `ilike` within the `sql` tag context, the search term could be injected.  
**When it breaks:** A crafted search term containing SQL special characters.  
**What the user experiences:** Potential data exfiltration or denial of service.  
**Mitigation before ship:** Verify that Drizzle's `sql` template tag properly parameterizes the `ilike` filter when composed. Add an input sanitization layer to strip SQL metacharacters from search terms.

**Evidence:**  
- `visitor-service.ts` L61 — `const searchTerm = \`%${q}%\``  
- `visitor-service.ts` L81 — `${searchFilter ? sql\`WHERE ${searchFilter}\` : sql\`\`}` — composed SQL  

---

## SILENT FAILURE RISKS

These are invisible to the user. Highest trust damage potential.

---

### [S1] AUDIT DB WRITE FAILURE IS INVISIBLE TO CALLER

**Confidence:** CONFIRMED  
**What fails silently:** When `persistAuditEvent()` fails (L143-157), the `.catch()` handler at L129-133 only logs to console.error. The API caller receives a success response. The entry is created but has no persistent audit record.  
**Why it is dangerous:** The guard believes the entry is fully logged. The admin reviewing audit records later sees a gap. If this happens during a security incident, the gap destroys the system's forensic value.  
**How to make it visible:** Return a warning header or field in the response indicating audit persistence status. Or make the audit write synchronous and fail the operation if it fails.

---

### [S2] OVERRIDE ERROR CLASS MISMATCH IN ERROR HANDLER

**Confidence:** CONFIRMED  
**What fails silently:** `override-service.ts` throws `OverrideError` (its own class), but `error-handler.ts` L30 only catches `ServiceError`. If `createOverrideEvent` throws during entry creation and the `OverrideError` propagates to the error handler, it will be treated as an unknown error and return a generic 500 instead of the contract-defined error shape.  
**Why it is dangerous:** The guard sees "An unexpected error occurred" instead of "Override reason must be at least 8 characters." The specific error is hidden, and the guard has no idea what to fix.  
**How to make it visible:** Either have `OverrideError` extend `ServiceError`, or add an `OverrideError` catch clause to the error handler.

**Evidence:**  
- `override-service.ts` L59-68 — `OverrideError extends Error` (not ServiceError)  
- `error-handler.ts` L30 — `if (err instanceof ServiceError)` — OverrideError is NOT caught  
- `entry-service.ts` L169-176 — calls `createOverrideEvent` which throws `OverrideError`  

---

### [S3] `setAuditDB()` NEVER CALLED IN PRODUCTION PATH

**Confidence:** CONFIRMED  
**What fails silently:** `audit-logger.ts` exports `setAuditDB(db)` for connecting the audit logger to the database. But `index.ts` and `app.ts` never call it. The `auditDB` variable remains `null` in production, meaning ALL audit events go to in-memory only — never persisted to the database.  
**Why it is dangerous:** This is the most dangerous silent failure in the system. Every audit event appears to work (in-memory + console.log), but zero events are written to the database. A server restart erases the entire audit trail.  
**How to make it visible:** Call `setAuditDB(db)` in `index.ts` after creating the app, or wire it through `createApp()`.

**Evidence:**  
- `audit-logger.ts` L68 — `let auditDB: AuditDB | null = null`  
- `audit-logger.ts` L74-76 — `setAuditDB()` exported but…  
- `index.ts` L10-16 — imports `createApp` and `db`, but never calls `setAuditDB`  
- `app.ts` L19-58 — `createApp` receives `db` but never passes it to audit logger  
- `grep` for "setAuditDB" in non-test files → only the definition in audit-logger.ts  

---

## MISSING VALIDATION GATES

---

### Gate 1 — Input: PARTIAL

**Where present:** Zod schemas validate all fields at HTTP boundary ✅  
**Where missing:**  
- `createdAt` 24-hour age limit not enforced (entry-schemas.ts)  
- `guardId` is validated for format (UUID) but not for authentication  
- No input size limit on request body (no `express.json({ limit: '100kb' })`)  

### Gate 2 — Execution: PARTIAL

**Where present:** Guard existence verified ✅, offlineId dedup checked ✅, preApprovalId verified ✅  
**Where missing:**  
- Entry + override not transactional (can partially succeed)  
- Audit DB persistence is fire-and-forget (can silently fail)  

### Gate 3 — Output: PRESENT ✅

Structured responses follow contract schema. TraceIds attached to every response.

### Gate 4 — State: PARTIAL

**Where present:** QR marked as used after validation ✅, offlineId dedup prevents re-insertion ✅  
**Where missing:**  
- No verification that audit event was persisted before returning success  
- In-memory audit log is mutable (objects are shared references — see audit test L290-301)  

### Gate 5 — Recovery: ABSENT ❌

**Where missing:**  
- No retry mechanism for failed DB operations  
- No circuit breaker for database connection failures  
- No dead-letter queue for failed audit events  
- Error handler returns generic 500 for all unknown errors — no actionable recovery path for the guard  

---

## REAL USER FAILURE SCENARIOS

---

### Scenario 1: Guard scans same QR twice in quick succession (double-tap)

**What breaks:** First scan marks QR as used (`isUsed=true`). Second scan correctly returns `QR_REPLAYED` (409). ✅ Handled correctly.  
**Recovery path exists:** Yes — guard sees the rejection message.

### Scenario 2: Guard submits entry, network drops before response

**What breaks:** Entry is created server-side, but guard never receives confirmation. Guard retries.  
**If no offlineId:** Duplicate entry created. ❌ No protection.  
**If offlineId provided:** Server returns `DUPLICATE_ENTRY` (409). ✅ Safe retry.  
**Recovery path exists:** Only if frontend sends offlineId — this is not enforced by the backend.

### Scenario 3: Guard goes offline with 60 pending entries, comes back online

**What breaks:** Sync batch processes entries sequentially (not in parallel). Each entry involves 2-3 DB operations. 60 entries × ~50ms each = ~3 seconds minimum. No timeout on the HTTP request.  
**Recovery path exists:** Partial — per-entry results returned, so partial failures are reported. But no timeout protection.

### Scenario 4: Database goes down during entry creation

**What breaks:** Entry insert fails. ServiceError propagates through error handler. Guard sees 500 "An unexpected error occurred."  
**Recovery path exists:** No — the error message is generic. The guard has no idea if the entry was recorded or not. No retry guidance provided.

### Scenario 5: Attacker replays a captured QR token

**What breaks:** Nothing — QR replay protection works correctly. `isUsed` flag prevents reuse. ✅  
**Recovery path exists:** Yes — returns 409 QR_REPLAYED with audit event emitted.

### Scenario 6: Guard creates override entry, DB fails on override_events insert

**What breaks:** Entry is created (committed), but override_events insert fails. Entry exists as method="override" with no override_events record.  
**Recovery path exists:** No — the entry record is orphaned without its justification. No way to reconstruct what happened.

### Scenario 7: Server restarts after 8 hours of operation

**What breaks:** All in-memory audit events are lost. If `setAuditDB()` was never called (current state), ALL audit events from the session are gone permanently.  
**Recovery path exists:** No — events that were only in memory are unrecoverable.

---

## SKILL GAPS DETECTED

---

| Skill Not Applied | Where the Gap Exists | Risk Introduced |
|---|---|---|
| **CI-CD-and-Automation** | No quality gate pipeline, no deployment automation | Regressions can ship uncaught |
| **Shipping-and-Launch** | No staged rollout, no monitoring, no rollback plan | Cannot recover from production failures |
| **Performance-Optimization** | No load testing, no benchmarks, unbounded in-memory audit log | OOM crash under sustained load |
| **Security-and-Hardening** (partial) | No auth middleware, no CORS, no rate limiting, no helmet | System is open to all attackers |
| **Debugging-and-Error-Recovery** | No circuit breaker, no retry logic, generic 500 errors | Guards face opaque failures with no recovery path |
| **Deprecation-and-Migration** | No DB migration tooling visible (drizzle-kit not configured) | Schema changes will be manual and error-prone |
| **Browser-Testing-with-DevTools** | N/A for backend | — |

---

## TEST SKEPTICISM FINDINGS

---

### All tests use mocked DB — zero integration tests

**Confidence:** CONFIRMED  
All 9 test files mock the database entirely. The mock DB factory (`createMockDB()`) returns hardcoded results. This means:

- No test verifies that Drizzle ORM generates correct SQL
- No test verifies that CHECK constraints actually reject bad data
- No test verifies that FK constraints prevent orphaned records
- No test verifies that the connection pool handles load
- No test verifies that raw SQL in `visitor-service.ts` (L70-87) actually works against PostgreSQL

**Missing test categories:**

| Category | Status |
|---|---|
| Happy path | ✅ Covered |
| Validation failures | ✅ Covered |
| Empty state | ✅ Covered |
| Error state (service-level) | ✅ Covered |
| Error state (DB connection failure) | ❌ Not tested |
| Timeout behavior | ❌ Not tested |
| Concurrent duplicate actions | ❌ Not tested |
| Unauthenticated access | ❌ Not tested (no auth exists) |
| Integration (real DB) | ❌ Not tested |
| Load/stress | ❌ Not tested |

---

## BYPASS SCENARIOS

---

### Bypass 1: Impersonate any guard

**Attack vector:** Send any valid guard UUID as `guardId` in request body.  
**Prerequisite:** Know or guess a valid guard UUID.  
**Impact:** Create entries attributed to any guard. Destroy accountability.  
**Blocked by:** Nothing. No authentication exists.

### Bypass 2: Flood entry endpoint

**Attack vector:** Send thousands of POST /api/entries requests.  
**Prerequisite:** Know the API URL.  
**Impact:** Pollute the entry log with fake entries. Overwhelm the guard's view. Exhaust DB connections.  
**Blocked by:** Nothing. No rate limiting exists.

### Bypass 3: Override without meaningful reason (via error handler gap)

**Attack vector:** This is NOT currently possible — the Zod schema and override-service both enforce the 8-char minimum.  
**Blocked by:** 3 independent layers (Zod, override-service, DB CHECK constraint). ✅ Well defended.

### Bypass 4: Submit backdated entries

**Attack vector:** Send `createdAt` with a timestamp from weeks ago.  
**Prerequisite:** None — the 24-hour age limit is not enforced.  
**Impact:** Inject historical entries that appear to have occurred in the past.  
**Blocked by:** Nothing. Only ISO 8601 format is validated.

### Bypass 5: Access audit logs without authorization

**Attack vector:** GET /api/audit/events, /api/audit/shift/:guardId, /api/audit/reconstruct/:traceId  
**Prerequisite:** Know the API URL.  
**Impact:** Read all guard activity, entry history, and override justifications. Full reconnaissance of property security patterns.  
**Blocked by:** Nothing. No auth on any endpoint.

---

## DATA INTEGRITY ISSUES

---

| # | Issue | Location | Impact |
|---|---|---|---|
| 1 | Entry + override not transactional | `entry-service.ts` L162-176 | Orphaned override entries possible |
| 2 | Sync entry + sync_event not transactional | `sync-service.ts` L186-214 | Synced entries without audit records |
| 3 | `setAuditDB()` never called | `index.ts` — missing call | Zero DB-persisted audit events |
| 4 | In-memory audit mutable by reference | `audit-logger.ts` L117 push + shared refs | Audit events can be modified post-emit |
| 5 | `createdAt` age not validated | `entry-schemas.ts` L76-77 | Backdated entries accepted |
| 6 | `auditEvents.payload` stored as `text` not `jsonb` | `schema.ts` L526 | Cannot query audit payloads in PostgreSQL |

---

## PRE-LAUNCH CHECKLIST

Actions you can take yourself, no coding required.

- □ Have 3 real guards — not you — completed a full entry flow end-to-end on a real device?
- □ Does every error produce a message the guard can understand and act on?
- □ Have you tested on mobile, on a slow connection, and on a fresh guard account?
- □ Is there a visible way for guards or property managers to reach you if something breaks?
- □ Can you disable or roll back this feature if it breaks in production?
- □ Have all CRITICAL BLOCKERS been resolved before this goes live?
- □ Do you have a way to monitor whether entry logging is succeeding after launch, without waiting for guards to report failure?
- □ Have you called `setAuditDB(db)` in the server startup path?
- □ Have you added authentication middleware before any routes?
- □ Have you run at least one integration test against a real PostgreSQL database?

---

## OVERALL RISK LEVEL: HIGH — DO NOT SHIP

**PRIMARY REASON:** No authentication exists. Any person who discovers the API URL can create entries as any guard, read all audit data, and flood the system with fake records — destroying the traceability that is the system's entire reason for existing.

**SECONDARY REASON:** The audit logger's database persistence is never activated in production (`setAuditDB()` is never called), meaning every audit event is stored only in volatile memory and is lost on server restart.

**AUDITOR CONFIDENCE IN THIS VERDICT:** HIGH  

Every critical finding is traced to a specific file and line number. The authentication gap and audit persistence gap are independently verified through code analysis. No speculation was required — the code explicitly shows what is missing.

---

## REMEDIATION PRIORITY ORDER

1. **[S3] Call `setAuditDB(db)` in `index.ts`** — 1 line fix, highest impact
2. **[C1] Add authentication middleware** — required before any public exposure
3. **[C2] Add CORS, helmet, rate limiting** — required before any public exposure
4. **[C3] Extract `guardId` from auth token** — depends on C1
5. **[H1] Wrap entry+override in transaction** — data integrity fix
6. **[S2] Fix OverrideError→ServiceError class hierarchy** — silent failure fix
7. **[H4] Add `createdAt` 24-hour validation** — contract compliance
8. **[C4] Make audit persistence synchronous or add retry** — audit integrity
9. **[H3] Add in-memory audit log size cap** — stability fix
10. **[H2] Fix empty catch block in sync service** — observability fix
