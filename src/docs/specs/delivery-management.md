# Feature 8 — Delivery Management — Specification

> Status: **DRAFT v1** — assumptions open to revision until first code lands.
> After Slice 0 (this spec) is committed, changes require an ADR.
>
> Scope: Delivery-specific entry workflows on top of existing
> `entry_records` infrastructure. Adds `entry_kind` + `delivery_category`
> columns, a delivery-aware submission route, frontend reducer slice,
> and a delivery quick-entry tile for guards.

---

## 1. Problem Statement

Today every visitor entry is categorized only by **method** (walk-in, QR,
override, recognized, auto). The system treats a Jumia delivery rider
identically to a personal visitor — same form fields, same flow, same
data model.

This creates three operational gaps:

1. **No delivery categorization.** When a guard logs a delivery, there is
   no way to distinguish it from a social visit. Estate managers cannot
   answer: "How many deliveries came in today? How many were food vs
   parcels vs gas?"

2. **Slow guard workflow.** Delivery entries require the same full form
   (visitor name, host, unit, plate, reason) when in practice most
   deliveries need only: rider name, unit, and category. Guards fall
   back to the paper book because it is faster.

3. **No delivery analytics.** Security firms and estate managers cannot
   see delivery volume, peak hours, or common categories — data that
   informs staffing and gate traffic management.

---

## 2. Design Principles

1. **Extend, don't fork.** Deliveries are entries. They share the same
   `entry_records` table, the same audit log, the same exit tracking.
   No separate `delivery_records` table.

2. **Additive schema change.** New columns (`entry_kind`,
   `delivery_category`) are nullable with defaults so all existing
   entries remain valid without backfill.

3. **Guard speed.** The delivery tile must be faster than paper:
   rider name → unit → category (3 fields, 3 taps). Host auto-fills
   to "Reception" if not provided.

4. **Reuse visitor-profile infrastructure.** Known delivery riders
   (Jumia, Bolt, Uber Eats) can be pre-loaded as visitor profiles
   with `entryKind = 'delivery'` so guards see them in search.

5. **Default-deny on invalid kind/category.** If the server receives
   an unknown `entryKind` or `deliveryCategory`, it rejects with an
   explicit error code. No silent fallback to `'visitor'`.

---

## 3. Data Model

### 3.1 New Enums

```sql
-- entry_kind: what kind of entry this is
CREATE TYPE entry_kind AS ENUM ('visitor', 'delivery');

-- delivery_category: subcategory for deliveries
CREATE TYPE delivery_category AS ENUM (
  'parcel',       -- Jumia, Amazon, JKUAT parcels
  'food',         -- Uber Eats, Glovo, Bolt Food
  'ride',         -- Uber, Bolt, InDriver (driver waits at gate)
  'gas',          -- LPG / cooking gas
  'water',        -- Water delivery
  'moving',       -- Furniture / moving services
  'maintenance',  -- Plumber, electrician, etc.
  'other'         -- Catch-all
);
```

### 3.2 Column Additions to `entry_records`

| Column | Type | Default | Nullable | Constraint |
|---|---|---|---|---|
| `entry_kind` | `entry_kind` | `'visitor'` | NO | — |
| `delivery_category` | `delivery_category` | NULL | YES | NOT NULL when `entry_kind = 'delivery'` |

CHECK constraint:
```sql
CHECK (
  (entry_kind = 'visitor'  AND delivery_category IS NULL)
  OR
  (entry_kind = 'delivery' AND delivery_category IS NOT NULL)
)
```

### 3.3 Audit Events

Two new values in `audit_event_type`:
- `delivery_entry_logged` — successful delivery entry.
- `delivery_entry_blocked` — rejected delivery attempt.

---

## 4. API Changes

### 4.1 POST /api/entries (extended)

The existing `POST /api/entries` endpoint is extended with two optional
fields:

```typescript
interface CreateEntryRequest {
  // ... existing fields ...
  entryKind?: 'visitor' | 'delivery';       // default: 'visitor'
  deliveryCategory?: DeliveryCategory;       // required when entryKind='delivery'
}
```

Server validation:
- If `entryKind` is omitted or `'visitor'`: proceed as before.
  `deliveryCategory` must be absent or null.
- If `entryKind = 'delivery'`: `deliveryCategory` must be a valid
  enum value. If missing → 422 `DELIVERY_CATEGORY_REQUIRED`.
- If `entryKind` is any other string → 422 `INVALID_ENTRY_KIND`.
- If `deliveryCategory` is present but `entryKind` ≠ `'delivery'`
  → 422 `CATEGORY_WITHOUT_DELIVERY_KIND`.

### 4.2 GET /api/entries/on-premise (extended)

Response entries now include `entryKind` and `deliveryCategory` so the
admin panel can display delivery-specific badges.

### 4.3 New: GET /api/entries/deliveries (admin only)

Returns recent delivery entries for the admin dashboard:
```typescript
interface ListDeliveriesResponse {
  entries: DeliveryEntryView[];
  count: number;
  traceId: string;
}

interface DeliveryEntryView {
  id: string;
  visitorName: string;   // rider name
  host: string;          // receiving resident or "Reception"
  unit: string;
  plate: string | null;
  deliveryCategory: DeliveryCategory;
  method: EntryMethod;
  guardId: string;
  createdAt: string;
}
```

RBAC: `requireRole('admin', 'senior-guard')`.

---

## 5. Frontend Changes

### 5.1 Types

```typescript
type EntryKind = 'visitor' | 'delivery';
type DeliveryCategory =
  | 'parcel' | 'food' | 'ride' | 'gas'
  | 'water' | 'moving' | 'maintenance' | 'other';
```

### 5.2 Reducer Slice — `deliveryManagement`

```typescript
interface DeliveryManagementState {
  submitStatus: 'idle' | 'submitting' | 'succeeded' | 'failed';
  lastDelivery: DeliveryEntryView | null;
  error: GatePassError | null;
  // Admin: recent deliveries list
  recentDeliveries: DeliveryEntryView[];
  listStatus: 'idle' | 'loading' | 'loaded' | 'failed';
  listError: GatePassError | null;
  listTraceId: string | null;
}
```

Actions:
- `DELIVERY_SUBMIT_STARTED`
- `DELIVERY_SUBMIT_SUCCEEDED` → sets `lastDelivery`, clears error
- `DELIVERY_SUBMIT_FAILED` → sets error with explicit code
- `DELIVERY_LIST_STARTED`
- `DELIVERY_LIST_LOADED` → sets `recentDeliveries`
- `DELIVERY_LIST_FAILED` → sets `listError`
- `RESET_FLOW` → resets `submitStatus` to idle (matches existing pattern)

### 5.3 Controller Methods

```typescript
submitDelivery(draft: DeliveryDraft): Promise<void>
loadRecentDeliveries(): Promise<void>
```

### 5.4 UI Components

**DeliveryPanel** (guard-facing, on home module):
- Quick-entry tile: "Log Delivery" button on the home grid.
- Minimal form: rider name, unit, category dropdown, plate (optional).
- Host defaults to "Reception" (editable).
- Category selector: visual tiles for common categories (parcel, food,
  ride, gas, water) + "Other" with free text.
- Submit → confirmed panel with delivery badge + trace ID.

**DeliveryAdminPanel** (admin-facing):
- Recent deliveries table with category badge column.
- Filters by category (future: date range).
- Reuses the same table pattern as OnPremisePanel.

---

## 6. Entry-Kind Backward Compatibility

All existing entries have `entry_kind = 'visitor'` (column default).
No backfill migration needed. The `delivery_category` column is NULL
for all existing rows, satisfying the CHECK constraint.

The frontend `submitEntry` path remains unchanged — it sends
`entryKind: undefined` which the server treats as `'visitor'`.
Only the new `submitDelivery` controller method sends
`entryKind: 'delivery'`.

---

## 7. Default-Deny Gates

| Gate | Trigger | Expected Response |
|---|---|---|
| D-CATEGORY | `entryKind='delivery'` + missing `deliveryCategory` | 422 `DELIVERY_CATEGORY_REQUIRED` |
| D-KIND | Unknown `entryKind` value | 422 `INVALID_ENTRY_KIND` |
| D-MISMATCH | `deliveryCategory` sent without `entryKind='delivery'` | 422 `CATEGORY_WITHOUT_DELIVERY_KIND` |
| D-RBAC | Guard token on `GET /api/entries/deliveries` | 403 `AUTH_FORBIDDEN` |
| D-SERVER | Any 500 on delivery submit | 500 surfaces with `INTERNAL_ERROR` |

---

## 8. Audit Scenarios (D1–D5)

| ID | Name | Setup | Action | Expected Outcome |
|---|---|---|---|---|
| **D1** | Happy delivery | Select "Log Delivery", fill rider name + unit + "parcel" | Submit | Confirmed panel, delivery badge, `delivery_entry_logged` in audit, `Entries=1` in shift log |
| **D2** | Missing category (default-deny) | Select "Log Delivery", fill rider name + unit, omit category | Submit | Form error: `DELIVERY_CATEGORY_REQUIRED`, no entry created |
| **D3** | Invalid category value | Stub: server receives `deliveryCategory='weapons'` | Submit | Form error: explicit rejection, no entry created |
| **D4** | Admin list RBAC | Guard token attempts `GET /api/entries/deliveries` | Load | Banner: `AUTH_FORBIDDEN`, zero rows leak |
| **D5** | Server error on submit | Stub: `POST /api/entries` → 500 | Submit | Form error: `INTERNAL_ERROR` with traceId, no entry created |

---

## 9. Slice Plan

| Slice | What | Key Files | Tests |
|---|---|---|---|
| 0 | This spec + D1–D5 scenarios | `src/docs/specs/delivery-management.md` | — |
| 1 | DB migration: `entry_kind` enum, `delivery_category` enum, columns + CHECK | `drizzle/0008_delivery_management.sql`, `src/db/schema.ts` | — |
| 2 | Service: extend `createEntry` + `listDeliveries` + tests | `src/server/services/entry-service.ts` | ≥12 |
| 3 | Routes: extend POST /entries validation, add GET /deliveries + tests | `src/server/routes/entries.ts` | ≥8 |
| 4 | API client: extend `gatePassApi` + add `deliveryApi` + tests | `src/lib/api/gatepass.ts`, `src/lib/api/deliveries.ts` | ≥6 |
| 5 | Reducer: `deliveryManagement` slice + tests | `src/features/gatepass/gatepassReducer.ts` | ≥8 |
| 6 | Controller: `submitDelivery` + `loadRecentDeliveries` + tests | `src/features/gatepass/useGatePassController.ts` | ≥4 |
| 7 | UI: DeliveryPanel + DeliveryAdminPanel + RTL tests | `src/features/gatepass/components/GatePassPanels.tsx` | ≥8 |
| 8 | Audit harness: D1–D5 | `audit/main.tsx` | — |

---

## 10. Out of Scope

- Delivery tracking / ETA (requires rider-side app).
- Delivery photo capture (requires camera API).
- Delivery rating / feedback.
- Auto-matching rider to resident (future: based on frequent deliveries).
- `entryKind: 'service'` (maintenance workers) — deferred to F9+.
