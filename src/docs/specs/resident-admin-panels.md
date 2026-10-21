# R4a — Admin screens for the resident portal

Status: **DRAFT — awaiting owner approval. No code until approved.**

Related: [Resident portal spec](./resident-portal.md) (R1–R3, §11 binding decisions).

## 1. Problem

R1–R3 shipped admin-only server routes for units, claim codes, residents and
the staff block, but no frontend calls them. A resident can enter a claim code,
but an admin can only create a unit or issue that code by calling the API by
hand.

## 2. Scope (exactly four things)

| | Capability | Endpoint(s) | New server code? |
|---|---|---|---|
| a | Units: list, create, deactivate | `GET/POST /api/admin/units`, `POST /api/admin/units/:id/deactivate` | none |
| b | Issue a claim code: shown once, with a copy button | `POST /api/admin/units/:id/claim-codes` | none |
| c | Residents of a unit: list, deactivate | `GET /api/admin/residents?unitId=&includeInactive=`, `POST /api/admin/residents/:id/deactivate` | **yes: server-side phone masking** (S2) |
| d | A unit's registrations and rules: switch off with a reason, clear a block with a reason | **new** `GET /api/admin/units/:id/registrations`, `POST /api/auto-approval-rules/:id/deactivate`, `POST /api/auto-approval-rules/:id/clear-block` | **yes: one new read route** (S1) **and the reason rule for switching off** (S3) |

### New server code — the complete list

Nothing outside S1–S3 changes on the server. Details in §5.

| # | What | Files |
|---|---|---|
| S1 | New read route `GET /api/admin/units/:id/registrations` and the service function behind it | `src/server/routes/residents.ts` (`adminUnitsRouter`), `src/server/services/unit-registration-service.ts`, `src/server/validation/resident-schemas.ts` (param schema) |
| S2 | Resident phone numbers masked on the server in every admin response; the full number is never sent to an admin | `src/server/services/resident-service.ts` (new `AdminResidentView`, `maskPhoneE164`), `src/server/routes/residents.ts` (both admin resident handlers) |
| S3 | Switching off a resident-created rule without a reason returns `422 REASON_REQUIRED`, before any write | `src/server/services/auto-approval-service.ts` (`deactivateAutoApprovalRule`), `src/server/routes/auto-approval.ts` (error code constant) |

**Not changing:**
- No schema change, no migration, no new audit event types.
- Clearing a block already requires a reason on the server (`ClearRuleBlockBodySchema`: required, trimmed, 3–500 characters; a missing or short reason returns `422 RULE_INVALID_INPUT`, `field: "reason"`). R4a adds no server code for it, only tests that prove it (§6) and the panel's reason field.
- The unit label limit is already 32 on the server (`UNIT_LABEL_MAX = 32`) and in the database (`units_label_bounded`: `length(trim(label)) BETWEEN 1 AND 32`). The panel matches it.
- The resident's own routes (`/api/resident/me`, `/api/resident/claim`) keep returning the resident's own full number. They are not admin responses.

Out of scope: editing units or residents, issuing passes for residents,
resident search, bulk actions, notifications, anything for senior guards,
any change to the guard console's admin tab, and the R4b docs.

## 3. Where it lives

- **One new component, `src/features/admin/ResidentUnitsPanel.tsx`.** It is
  rendered in the existing `AdminDashboard` next to `AccountProvisioningPanel`
  and `WatchlistPanel`, spanning both grid columns (`md:col-span-2`).
- **Admin only.** `AdminDashboard` is reached only when the database role is
  `admin` (`src/pages/Index.tsx`), and every route it calls is
  `requireRole("admin")`:
  - `/api/admin/units/*` and `/api/admin/residents/*`: `requireAuth` +
    `strictLimiter` + `requireRole("admin")` (mounted in `app.ts`); S1 is
    mounted on the same router, so it inherits all three;
  - `POST /api/auto-approval-rules/:id/deactivate` and `/clear-block`:
    `requireRole("admin")`.

  Senior guards see nothing new, and no role rule is loosened.
- **Layout: a unit list with a detail view.**
  - **(a)** The left column lists units, with a create form, an "Include
    inactive" toggle, and each unit's active-resident count.
  - **Selecting a unit** opens its detail: **(b)** claim code, **(c)**
    residents and **(d)** registrations.
  - These are sections of one panel because (b)–(d) only make sense for a
    single unit.
- **API client:** a new `src/lib/api/resident-admin.ts` with the same
  `apiClient` + `ApiResult` pattern as `accounts.ts`, plus two methods on
  `auto-approval.ts`.

## 4. Behaviour

### (a) Units
- **Create:** a label input, **1–32 characters** after trimming, the same as
  the server's `CreateUnitSchema` and the database `CHECK`. The input has
  `maxLength={32}` and a character count. `409 UNIT_LABEL_TAKEN` is shown on
  the field.
- **Deactivate:** a two-step inline confirmation that names the unit. The
  confirmation text states what the server does in the same transaction: it
  deactivates the unit's residents, expires its open passes and switches off
  its rules. After success the panel shows the counts the server returns
  (`deactivatedResidentCount`, `expiredPassCount`, `disabledRuleCount`).
  Inactive units can't be selected for (b)–(d) actions; they are shown
  read-only.

### (b) Claim code
- **Issuing:** "Issue claim code" on an active unit, with the default TTL
  (72 h, set by the server). There is no TTL input, to keep the form small.
- **Display:** the response `code` (`XXXX-XXXX`) and `expiresAt` are shown in
  a highlighted box with a **Copy** button (`navigator.clipboard.writeText`)
  and the note "Shown once. Give it to the resident in person or by phone;
  it can't be shown again."
- **Shown once, enforced on the client:**
  - The code is held only in component state. It is never put in the
    reducer, localStorage or the URL, and never logged.
  - It is cleared on Dismiss, when another unit is selected, and when the
    panel unmounts.
  - It is not re-fetched after a reload, because the server only stores an
    HMAC.

### (c) Residents
- **List:** each row shows display name, the **masked phone exactly as the
  server sends it** (`phoneMasked`, e.g. `+254••••••678`), claimed date and
  status. "Include inactive" is a toggle.
- **The client never receives the full number,** so it cannot render, log or
  cache it. The client does no masking of its own.
- **Deactivate:** a two-step inline confirmation. It states that the
  resident's own rules are switched off in the same transaction. The response
  is also the masked view.

### (d) Registrations and rules
- **List:** comes from S1. Each row shows:
  - kind, label, plate and resident display name;
  - status: active, renew due, expired, disabled or removed;
  - the block state.
- **Switch off** (live rule only): a reason field, 3–500 characters, then
  confirm. The confirm button stays disabled until the trimmed reason is 3 or
  more characters. It calls `deactivate` with `{ reason }`. A
  `422 REASON_REQUIRED` from the server is shown on the reason field.
- **Clear block** (row with a standing block): a reason field, 3–500
  characters, then confirm, disabled the same way. It calls `clear-block`
  with `{ reason }`.
- **Block details shown:** who blocked it, when, the reason, and for a
  cleared block who cleared it and why.
- **Clearing does not turn the old rule back on.** The panel says so:
  "The resident can now register this again."

All errors render as `CODE — message`, the same as `PanelBody`. Every write
button is disabled while its request is in flight, so a double click sends
one request.

## 5. Server changes (S1–S3, nothing else)

### S1. New `GET /api/admin/units/:id/registrations`
- Mounted on `adminUnitsRouter`, so it inherits `requireAuth` +
  `strictLimiter` + `requireRole("admin")`.
- `:id` must be a UUID: otherwise `422 RESIDENT_INVALID_INPUT`, `field: "id"`,
  the same as the other `/:id` admin unit routes. Unknown unit → `404
  UNIT_NOT_FOUND`.
- **Rows returned:** every live registration of the unit, plus removed
  registrations that carry a block (standing or cleared). Removed rows that
  were never blocked are omitted.
- **Read-only, no audit row,** the same as the other admin lists.
- **No phone field.** The resident is identified by id and display name only.
```ts
interface AdminRegistrationView {
  id: string; kind: "person" | "vehicle"; label: string; plate: string | null;
  residentId: string; residentDisplayName: string;
  status: "active" | "renew_due" | "expired" | "disabled" | "removed";
  ruleId: string; ruleActive: boolean; expiresAt: string;
  createdAt: string; removedAt: string | null;
  block: null | {
    blockedAt: string; blockedBy: string /* guard display name */; reason: string | null;
    clearedAt: string | null; clearedBy: string | null; clearReason: string | null;
  };
}
// 200: { registrations: AdminRegistrationView[]; count: number }
```

### S2. Resident phone masked on the server
- **Today** `GET /api/admin/residents` and `POST /api/admin/residents/:id/deactivate`
  both return `ResidentView`, which carries the full `phoneE164`.
- **New `AdminResidentView`:** the same fields as `ResidentView` with
  `phoneE164` **removed** and `phoneMasked: string` added. `listResidents`
  and `deactivateResident` return it. Masking happens in the service, before
  the value reaches the route, so no admin handler can send the full number by
  mistake.
- **`maskPhoneE164(phone)`**, using the digits after `+`:
  - 12 or more digits: keep the first 3 and last 3, replace the rest with `•`
    (`+254712345678` → `+254••••••678`);
  - fewer than 12 digits: keep the first 1 and last 2;
  - so every number has at least half its digits hidden.
- **The resident's own view is unchanged:** `getResidentView` (claim, `/me`)
  still returns `phoneE164`, because it is the resident's own number.
- **Admin responses that touch residents, and what each carries:**

  | Response | Phone today | After R4a |
  |---|---|---|
  | `GET /api/admin/residents` | full | masked |
  | `POST /api/admin/residents/:id/deactivate` | full | masked |
  | `GET /api/admin/units/:id/registrations` (S1) | — | none |
  | `GET /api/admin/units`, unit create/deactivate, claim codes | none | none |
  | `GET /api/audit` (admin and senior guard) events for resident claim, deactivate and registrations | none | none (tested) |

### S3. A reason is required to switch off a resident-created rule
- **Rule:** in `deactivateAutoApprovalRule`, if the rule has
  `created_by_resident_id` and `reason` is null, throw
  `ServiceError("REASON_REQUIRED", "A reason is required to switch off a resident's rule", 422, "reason")`
  **before any write**: the rule stays live, no block is recorded, and no
  audit row is written.
- **Repeat calls need it too:** switching off an already-blocked resident
  rule also needs the reason, so the result doesn't depend on whether the
  rule is already blocked.
- **The minimum stays 3 characters** (`DeactivateRuleBodySchema`); a
  too-short reason still returns `422 RULE_INVALID_INPUT`.
- **Staff-created rules are unchanged:** the reason stays optional and the
  code path is the same.
- **No frontend breaks:** nothing calls this route today.

## 6. Tests

- **Server unit tests:**
  - S1 route: UUID validation, `404 UNIT_NOT_FOUND`, view mapping, no `phone`
    key in the response;
  - S2: `maskPhoneE164` for 8, 11, 12 and 15-digit numbers; at least half
    the digits hidden in every case;
  - S2: the admin resident list and deactivate handlers return `phoneMasked`
    and no `phoneE164` key;
  - S3: a resident rule with no reason → `422 REASON_REQUIRED`
    (`field: "reason"`) and the block function is not called; a staff rule
    with no reason → 200, as before;
  - clear-block with no reason, or a blank or 2-character reason → `422
    RULE_INVALID_INPUT`, `field: "reason"`, and the service is not called.
- **Real-Postgres integration:**
  - S1 returns `401` for anonymous callers, `403` for guard and senior-guard
    tokens, and `AUTH_NO_GUARD_LINK` or `401` for a resident token;
  - S1 returns only that unit's rows, includes a removed-but-blocked row, and
    omits a removed, never-blocked row;
  - **full number absent:** a resident is seeded with a known number. The
    raw JSON text of every admin response in the S2 table (list, deactivate,
    S1, units list, unit deactivate, and the audit list after claim,
    registration, block and deactivation) is searched for the full E.164
    number, the digits without `+`, and the national digits. None may be
    found;
  - S3: switch-off without a reason → 422 with **no** block, the rule still
    live and no audit row; with a reason → blocked;
  - clear-block without a reason → 422 and the block still standing.
- **Component tests (RTL, mocked API):**
  - create unit (label input limited to 32); deactivate needs the
    confirmation step;
  - claim code shown with Copy (clipboard mocked) and gone after Dismiss or
    after selecting another unit;
  - residents render the server's `phoneMasked` as given;
  - Switch off and Clear disabled until the reason is 3 or more characters;
    `REASON_REQUIRED` shown on the reason field;
  - Clear only offered on a standing block;
  - error codes rendered.
- **Gates:** the full set (lint, tsc, both Vitest configs, integration, prod
  build). No browser testing unless you ask.

## 7. Open questions

1. **Claim-code TTL:** use the server default only (72 h), or add a TTL input?
   *Proposed: default only.*
2. **Removed registrations in (d):** show only removed rows that were blocked
   (proposed), or all removed rows?
3. **Clear-block error code:** keep today's `422 RULE_INVALID_INPUT` for a
   missing reason (proposed: no server change), or also return
   `REASON_REQUIRED` there for consistency (one more small server change)?
4. **Found while checking, outside R4a:** `GET /api/notifications`
   (`requireAuth`, any guard role) returns the full `targetPhone` of each
   notification. That is the host phone a guard typed when sending an
   approval request, which is usually a resident's number. The guard console
   masks it on screen, but the response does not. It is not an admin
   resident screen, so R4a leaves it alone. Proposed: a separate small PR
   after R4a that masks it on the server the same way. Or fold it into R4a.
