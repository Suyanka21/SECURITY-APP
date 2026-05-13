GatePass Backend API Contract
Derived from: 
GATEPASS DEFINITION.md
, 
types.ts
, 
gatepassReducer.ts

Skills applied: API-and-Interface-Design, Idea-Refine, Trustless-system-auditor

1. Frontend Action → Backend Endpoint Mapping
Frontend Action	Reducer Type	HTTP Method	Endpoint	Purpose
Scan QR	SCAN_QR	POST	/api/entries/qr/validate	Validate QR token, return pre-approved visitor data
Submit Entry	SUBMIT_ENTRY	POST	/api/entries	Create audited entry record
Sync Pending	SYNC_PENDING	POST	/api/entries/sync	Reconcile offline-queued entries
Override	SUBMIT_ENTRY (method=override)	POST	/api/entries	Same endpoint, discriminated by method: "override"
Search Visitor	SELECT_VISITOR	GET	/api/visitors/recognized	Fetch recognized visitor list with recognition tags
IMPORTANT

Override is not a separate endpoint. It flows through POST /api/entries with method: "override" and stricter validation (reason ≥ 8 chars). This matches the frontend where SUBMIT_ENTRY handles all methods uniformly.

2. Shared Types
typescript
// ─── Enums ───
type EntryMethod = "qr" | "walk-in" | "override" | "recognized";
type EntryStatus = "draft" | "pending" | "approved" | "denied" | "logged" | "sync-pending" | "failed";
type SyncState = "synced" | "queued" | "failed";
type RecognitionTag = "pre-approved" | "frequent" | "watch";
// ─── Shared Error Shape (every endpoint, no exceptions) ───
interface APIError {
  error: {
    code: string;       // Machine-readable: "VALIDATION_ERROR" | "QR_INVALID" | etc.
    message: string;    // Human-readable explanation
    field?: string;     // Which field failed (validation errors only)
    traceId: string;    // Server-generated, for audit correlation
  };
}
3. Endpoint Contracts
3.1 POST /api/entries/qr/validate
Maps to: SCAN_QR action

Request
typescript
interface QrValidateRequest {
  qrToken: string;    // Raw QR payload scanned by device
  guardId: string;    // Authenticated guard identity
  scannedAt: string;  // ISO 8601 timestamp from device
}
Response — 200 OK
typescript
interface QrValidateResponse {
  outcome: "valid";
  visitor: {
    name: string;
    host: string;
    unit: string;
    plate: string | null;
    preApprovalId: string;   // Links to the approval record
  };
  expiresAt: string;         // ISO 8601 — QR validity window
  traceId: string;
}
Error Responses
Status	Code	When
400	QR_MALFORMED	Token cannot be parsed
404	QR_NOT_FOUND	Token does not match any approval
409	QR_REPLAYED	Token already used (replay attack)
410	QR_EXPIRED	Token past expiresAt window
422	VALIDATION_ERROR	Missing guardId or qrToken
Validation Rules
Field	Rule
qrToken	Non-empty string, max 512 chars
guardId	Non-empty, must resolve to active guard session
scannedAt	Valid ISO 8601, not more than 5 minutes in the future
Backend Event
EVENT: qr_scan_attempted
  { guardId, qrToken (hash), outcome, traceId, timestamp }
3.2 POST /api/entries
Maps to: SUBMIT_ENTRY action (all methods: walk-in, qr, override, recognized)

Request
typescript
interface CreateEntryRequest {
  visitorName: string;
  host: string;
  unit: string;
  plate: string | null;
  reason: string;
  method: EntryMethod;
  guardId: string;
  createdAt: string;        // Device timestamp (ISO 8601)
  preApprovalId?: string;   // Required when method = "qr"
  offlineId?: string;       // Client-generated ID for offline dedup
}
Response — 201 Created
typescript
interface CreateEntryResponse {
  entry: {
    id: string;              // Server-generated canonical ID
    visitorName: string;
    host: string;
    unit: string;
    plate: string | null;
    reason: string;
    method: EntryMethod;
    guardId: string;
    createdAt: string;
    status: "logged";
    syncState: "synced";
  };
  traceId: string;
}
Error Responses
Status	Code	When
422	VISITOR_NAME_REQUIRED	visitorName empty/whitespace
422	HOST_REQUIRED	host empty/whitespace
422	UNIT_REQUIRED	unit empty/whitespace
422	OVERRIDE_REASON_TOO_SHORT	method=override AND reason < 8 chars
422	GUARD_ID_MISSING	guardId empty
409	DUPLICATE_ENTRY	offlineId already exists (idempotency)
404	PRE_APPROVAL_NOT_FOUND	method=qr but preApprovalId invalid
403	GUARD_SESSION_EXPIRED	Guard auth token no longer valid
Validation Rules
Field	Rule
visitorName	Non-empty after trim
host	Non-empty after trim
unit	Non-empty after trim
plate	Optional, max 20 chars if provided
reason	When method=override: min 8 chars after trim
method	Must be one of: qr, walk-in, override, recognized
guardId	Must resolve to an active guard
createdAt	Valid ISO 8601, max 24 hours old
offlineId	Optional, UUID format, used for dedup
Backend Event
EVENT: entry_created
  { entryId, guardId, method, unit, status, syncState, traceId, timestamp }
WARNING

The frontend currently generates entry IDs client-side (entry-${index}). The backend MUST generate canonical IDs server-side. Client offlineId is only for deduplication, never used as the record ID.

3.3 POST /api/entries/sync
Maps to: SYNC_PENDING action

Request
typescript
interface SyncPendingRequest {
  guardId: string;
  entries: Array<{
    offlineId: string;       // Client-generated ID
    visitorName: string;
    host: string;
    unit: string;
    plate: string | null;
    reason: string;
    method: EntryMethod;
    createdAt: string;       // Original device timestamp
  }>;
}
Response — 200 OK
typescript
interface SyncPendingResponse {
  results: Array<{
    offlineId: string;
    serverId: string;         // Canonical server ID
    status: "synced" | "duplicate" | "rejected";
    error?: {
      code: string;
      message: string;
    };
  }>;
  syncedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  traceId: string;
}
Error Responses
Status	Code	When
422	EMPTY_SYNC_BATCH	entries array is empty
422	BATCH_TOO_LARGE	More than 50 entries in one sync
422	GUARD_ID_MISSING	Missing guardId
403	GUARD_SESSION_EXPIRED	Guard auth token invalid
207	(Multi-Status)	Partial success — some entries synced, some rejected
Validation Rules
Field	Rule
entries	Non-empty array, max 50 items
Each entry	Same validation as POST /api/entries
offlineId	Required per entry, UUID format
guardId	Must match all entries (one guard per sync batch)
Backend Event (per entry)
EVENT: entry_synced
  { offlineId, serverId, guardId, originalCreatedAt, syncedAt, traceId }
IMPORTANT

The frontend currently clears pendingSync to [] on success. The backend must return per-entry results so the frontend can handle partial failures instead of assuming all-or-nothing sync.

3.4 GET /api/visitors/recognized
Maps to: SELECT_VISITOR / Search panel

Request (Query Parameters)
GET /api/visitors/recognized?guardId={guardId}&q={searchTerm}&page=1&pageSize=20
typescript
interface RecognizedVisitorsParams {
  guardId: string;         // Required — scopes to guard's property
  q?: string;              // Optional fuzzy search on name/plate
  page?: number;           // Default: 1
  pageSize?: number;       // Default: 20, max: 50
}
Response — 200 OK
typescript
interface RecognizedVisitorsResponse {
  visitors: Array<{
    id: string;
    name: string;
    host: string;
    unit: string;
    plate: string | null;
    lastSeen: string;       // ISO 8601
    recognition: RecognitionTag;
  }>;
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
  traceId: string;
}
Error Responses
Status	Code	When
422	GUARD_ID_MISSING	No guardId param
403	GUARD_SESSION_EXPIRED	Guard auth invalid
Backend Event
EVENT: visitor_search
  { guardId, searchTerm, resultCount, traceId, timestamp }
4. Trustless System Audit — Mismatches Detected
CRITICAL RISKS
#	Risk	Location	Failure Scenario	Impact
1	No backend exists	Entire system	All state is client-side useReducer. A page refresh destroys all entries.	Catastrophic — entries lost, violates core principle of entry logging integrity
2	Client-side ID generation	createEntry() L46	entry-${index} is sequential and non-unique across devices/sessions	Duplicate IDs, data corruption on sync
3	Hardcoded QR data	SCAN_QR case L86	Valid QR always returns "QR Guest" / "12A" — no real validation	Any QR string would "pass" — zero security
4	Hardcoded guard identity	initialState L20	guardId: "guard-west-04" is static — no auth	Any user acts as guard-west-04
5	Sync is local-only	SYNC_PENDING L117-123	Just flips syncState flags — no network call	Entries marked "synced" are actually unsynced
MISSING VALIDATIONS
#	What's Missing	Where	Required By
1	QR token signature verification	SCAN_QR handler	GATEPASS DEFINITION §2A
2	QR expiry check	SCAN_QR handler	Replay prevention
3	Guard authentication	Entire app	GATEPASS DEFINITION §Critical Actions
4	Server-side entry deduplication	SUBMIT_ENTRY	Offline sync integrity
5	Reason length enforcement on server	POST /api/entries	Override accountability
SILENT FAILURE RISKS
#	Risk	Location
1	SYNC_PENDING while online claims success without any network call	Reducer L117-123
2	default case in reducer silently returns state — unknown actions are swallowed	Reducer L126-127
3	SUBMIT_ENTRY sets inFlight: false immediately — no async tracking	Reducer L107
EDGE CASE FAILURES
#	Scenario	Current Behavior	Required Behavior
1	Guard submits same entry on 2 devices	Both create entry-1	Backend dedup via offlineId
2	Network drops mid-submit	No retry logic exists	Entries must queue to pendingSync
3	100+ offline entries then sync	All cleared atomically	Per-entry results with partial failure handling
4	QR scanned after approval revoked	Always returns "valid"	Backend must check current approval status
OVERALL RISK LEVEL
HIGH — The frontend is a complete state machine prototype with zero backend integration. Every "success" is simulated. No entry survives a page refresh. No guard identity is verified. The reducer design is sound but operates in a vacuum.

5. Backend Event Traceability Matrix
Every frontend action MUST produce a traceable backend event:

Frontend Action	Backend Event	Audit Fields
START_CAMERA	camera_initialized	guardId, deviceId, timestamp
CAMERA_FAILED	camera_failure	guardId, deviceId, errorType, timestamp
SCAN_QR (valid)	qr_scan_succeeded	guardId, qrTokenHash, preApprovalId, traceId
SCAN_QR (invalid)	qr_scan_rejected	guardId, qrTokenHash, reason: "invalid", traceId
SCAN_QR (replayed)	qr_scan_rejected	guardId, qrTokenHash, reason: "replayed", traceId
SUBMIT_ENTRY (success)	entry_created	entryId, guardId, method, unit, traceId
SUBMIT_ENTRY (validation fail)	entry_blocked	guardId, method, failureReason, traceId
SYNC_PENDING	batch_sync_completed	guardId, syncedCount, failedCount, traceId
SELECT_VISITOR	visitor_selected	guardId, visitorId, recognitionTag, traceId
NAVIGATE (to override)	override_flow_entered	guardId, timestamp
RESET_FLOW	flow_reset	guardId, previousMode, timestamp
6. Idea-Refine: What the Backend Must NOT Do
Excluded	Reason
Resident approval flow	Not in current frontend scope — reducer has no APPROVE/DENY actions
WhatsApp/SMS notifications	Mentioned in DEFINITION but no frontend surface exists
Auto-approval engine	DEFINITION mentions it, frontend doesn't implement it
Shift log aggregation	Admin shell is view-only with no shift concept
Visitor profile CRUD	Visitors are read-only in frontend (recognizedVisitors is static)
NOTE

These features exist in the GATEPASS DEFINITION but are not represented in the current reducer or UI. The backend contract above covers only what the frontend currently dispatches. Adding these requires new reducer actions first.

7. Verification Checklist
Per API-and-Interface-Design skill:

 Every endpoint has typed input and output schemas
 Error responses follow a single consistent format (APIError)
 Validation happens at system boundaries only
 List endpoint (/api/visitors/recognized) supports pagination
 All fields are additive and optional where possible
 Naming follows consistent conventions (camelCase, plural nouns)
 API documentation committed alongside implementation (this document)
Per Trustless-system-auditor skill:

 System flow mapped (§1 mapping table)
 Failure points detected (§4 audit)
 Validation checks defined per endpoint (§3)
 Silent failure risks surfaced (§4)
 Edge case pressure test completed (§4)
 State integrity gaps identified (client-side ID, no auth)
Per Idea-Refine skill:

 "Not Doing" list explicit (§6)
 Assumptions surfaced (frontend is prototype-only)
 Scope bounded to current frontend behavior
