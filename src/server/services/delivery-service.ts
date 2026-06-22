/**
 * GatePass — Delivery Management Service
 *
 * Source: src/docs/specs/delivery-management.md §§3–4
 *
 * Extends the entry creation path with delivery-specific validation:
 *   - entryKind = 'delivery' requires deliveryCategory
 *   - deliveryCategory without entryKind = 'delivery' is rejected
 *   - Audit events: delivery_entry_logged / delivery_entry_blocked
 *
 * Also provides listDeliveries for admin dashboard.
 */

import { eq, sql, desc } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  entryRecords,
  guards,
  authorizationDecisions,
  overrideEvents,
} from "@/db/schema";
import { createOverrideEvent, toOverrideRow } from "./override-service";
import { emitAuditEvent } from "./audit-logger";
import { ServiceError } from "./errors";
import { EntryErrorCodes } from "../validation/entry-schemas";

// ─── Delivery-specific Error Codes ──────────────────────────────────────────

export const DeliveryErrorCodes = {
  DELIVERY_CATEGORY_REQUIRED: "DELIVERY_CATEGORY_REQUIRED",
  INVALID_ENTRY_KIND: "INVALID_ENTRY_KIND",
  CATEGORY_WITHOUT_DELIVERY_KIND: "CATEGORY_WITHOUT_DELIVERY_KIND",
} as const;

// ─── Valid Enum Values ──────────────────────────────────────────────────────

const VALID_ENTRY_KINDS = ["delivery"] as const;
const VALID_DELIVERY_CATEGORIES = [
  "parcel", "food", "ride", "gas",
  "water", "moving", "maintenance", "other",
] as const;

export type EntryKind = (typeof VALID_ENTRY_KINDS)[number];
export type DeliveryCategory = (typeof VALID_DELIVERY_CATEGORIES)[number];

// ─── DB Type ────────────────────────────────────────────────────────────────

export interface DrizzleDB {
  select: (...args: unknown[]) => unknown;
  insert: (...args: unknown[]) => unknown;
  query: Record<string, unknown>;
  execute: (...args: unknown[]) => unknown;
  [key: string]: unknown;
}

// ─── Input / Response Types ─────────────────────────────────────────────────

export interface CreateDeliveryEntryInput {
  visitorName: string;
  host: string;
  unit: string;
  plate: string | null;
  reason: string;
  method: "qr" | "walk-in" | "override" | "recognized";
  guardId: string;
  createdAt: string;
  preApprovalId?: string;
  offlineId?: string;
  entryKind: string;
  deliveryCategory: string;
}

export interface DeliveryEntryView {
  id: string;
  visitorName: string;
  host: string;
  unit: string;
  plate: string | null;
  deliveryCategory: DeliveryCategory;
  method: string;
  guardId: string;
  createdAt: string;
}

export interface CreateDeliveryEntryResponse {
  entry: {
    id: string;
    visitorName: string;
    host: string;
    unit: string;
    plate: string | null;
    reason: string;
    method: string;
    guardId: string;
    createdAt: string;
    status: "logged";
    syncState: "synced";
    entryKind: EntryKind;
    deliveryCategory: DeliveryCategory;
  };
  traceId: string;
}

export interface ListDeliveriesResponse {
  entries: DeliveryEntryView[];
  count: number;
  traceId: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function generateTraceId(): string {
  return `trace-${randomUUID()}`;
}

// ─── Service: createDeliveryEntry ───────────────────────────────────────────

export async function createDeliveryEntry(
  input: CreateDeliveryEntryInput,
  db: DrizzleDB,
): Promise<{ response: CreateDeliveryEntryResponse; statusCode: number }> {
  const traceId = generateTraceId();

  // ── Gate 1: Validate entryKind ──
  if (!VALID_ENTRY_KINDS.includes(input.entryKind as EntryKind)) {
    await emitAuditEvent("delivery_entry_blocked", input.guardId, traceId, {
      reason: "INVALID_ENTRY_KIND",
      entryKind: input.entryKind,
    });
    throw new ServiceError(
      DeliveryErrorCodes.INVALID_ENTRY_KIND,
      `Invalid entry kind: '${input.entryKind}'. Must be one of: ${VALID_ENTRY_KINDS.join(", ")}`,
      422,
      "entryKind",
    );
  }

  // ── Gate 2: Delivery requires category ──
  if (input.entryKind === "delivery") {
    if (
      !input.deliveryCategory ||
      !VALID_DELIVERY_CATEGORIES.includes(input.deliveryCategory as DeliveryCategory)
    ) {
      await emitAuditEvent("delivery_entry_blocked", input.guardId, traceId, {
        reason: "DELIVERY_CATEGORY_REQUIRED",
        entryKind: input.entryKind,
        deliveryCategory: input.deliveryCategory ?? null,
      });
      throw new ServiceError(
        DeliveryErrorCodes.DELIVERY_CATEGORY_REQUIRED,
        `Delivery entries require a valid category. Must be one of: ${VALID_DELIVERY_CATEGORIES.join(", ")}`,
        422,
        "deliveryCategory",
      );
    }
  }

  // ── Gate 3: Category without delivery kind is rejected ──
  if (
    input.entryKind === "visitor" &&
    input.deliveryCategory
  ) {
    await emitAuditEvent("delivery_entry_blocked", input.guardId, traceId, {
      reason: "CATEGORY_WITHOUT_DELIVERY_KIND",
      entryKind: input.entryKind,
      deliveryCategory: input.deliveryCategory,
    });
    throw new ServiceError(
      DeliveryErrorCodes.CATEGORY_WITHOUT_DELIVERY_KIND,
      "deliveryCategory can only be set when entryKind is 'delivery'",
      422,
      "deliveryCategory",
    );
  }

  // ── Gate 4: Verify guard exists and is active ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const guard = await (db as any)
    .select({ id: guards.id, isActive: guards.isActive })
    .from(guards)
    .where(eq(guards.id, input.guardId))
    .limit(1);

  if (!guard || guard.length === 0) {
    await emitAuditEvent("delivery_entry_blocked", input.guardId, traceId, {
      reason: EntryErrorCodes.GUARD_SESSION_EXPIRED,
      detail: "guard not found",
    });
    throw new ServiceError(
      EntryErrorCodes.GUARD_SESSION_EXPIRED,
      "Guard identity not found or session expired",
      403,
      "guardId",
    );
  }
  if (!guard[0].isActive) {
    await emitAuditEvent("delivery_entry_blocked", input.guardId, traceId, {
      reason: EntryErrorCodes.GUARD_SESSION_EXPIRED,
      detail: "guard inactive",
    });
    throw new ServiceError(
      EntryErrorCodes.GUARD_SESSION_EXPIRED,
      "Guard session is no longer active",
      403,
      "guardId",
    );
  }

  // ── Gate 5: Check offlineId uniqueness ──
  if (input.offlineId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existing = await (db as any)
      .select({ id: entryRecords.id })
      .from(entryRecords)
      .where(eq(entryRecords.offlineId, input.offlineId))
      .limit(1);

    if (existing && existing.length > 0) {
      await emitAuditEvent("delivery_entry_blocked", input.guardId, traceId, {
        reason: EntryErrorCodes.DUPLICATE_ENTRY,
        offlineId: input.offlineId,
      });
      throw new ServiceError(
        EntryErrorCodes.DUPLICATE_ENTRY,
        "An entry with this offlineId already exists",
        409,
        "offlineId",
      );
    }
  }

  // ── Gate 6: Validate preApprovalId for QR entries ──
  // Default-deny: QR method REQUIRES a preApprovalId.
  if (input.method === "qr" && !input.preApprovalId) {
    await emitAuditEvent("delivery_entry_blocked", input.guardId, traceId, {
      reason: EntryErrorCodes.PRE_APPROVAL_NOT_FOUND,
      detail: "QR method requires preApprovalId",
    });
    throw new ServiceError(
      EntryErrorCodes.PRE_APPROVAL_NOT_FOUND,
      "QR entries require a pre-approval ID",
      422,
      "preApprovalId",
    );
  }

  if (input.method === "qr" && input.preApprovalId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const approval = await (db as any)
      .select({ id: authorizationDecisions.id })
      .from(authorizationDecisions)
      .where(eq(authorizationDecisions.id, input.preApprovalId))
      .limit(1);

    if (!approval || approval.length === 0) {
      await emitAuditEvent("delivery_entry_blocked", input.guardId, traceId, {
        reason: EntryErrorCodes.PRE_APPROVAL_NOT_FOUND,
        preApprovalId: input.preApprovalId,
      });
      throw new ServiceError(
        EntryErrorCodes.PRE_APPROVAL_NOT_FOUND,
        "Pre-approval record not found for the provided ID",
        404,
        "preApprovalId",
      );
    }
  }

  // ── Insert entry ──
  const entryId = randomUUID();
  const now = new Date();

  const entryRow = {
    id: entryId,
    visitorName: input.visitorName,
    host: input.host,
    unit: input.unit,
    plate: input.plate ?? null,
    reason: input.reason || "",
    method: input.method,
    guardId: input.guardId,
    status: "logged" as const,
    syncState: "synced" as const,
    offlineId: input.offlineId ?? null,
    preApprovalId: input.preApprovalId ?? null,
    deviceCreatedAt: new Date(input.createdAt),
    createdAt: now,
    traceId,
    entryKind: input.entryKind as EntryKind,
    deliveryCategory: input.deliveryCategory as DeliveryCategory,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).transaction(async (tx: any) => {
    await tx.insert(entryRecords).values(entryRow);

    if (input.method === "override") {
      const overrideResult = await createOverrideEvent({
        entryId,
        guardId: input.guardId,
        reason: input.reason,
        traceId,
      });
      await tx.insert(overrideEvents).values(toOverrideRow(overrideResult));
    }
  });

  await emitAuditEvent("delivery_entry_logged", input.guardId, traceId, {
    entryId,
    method: input.method,
    unit: input.unit,
    status: "logged",
    entryKind: input.entryKind,
    deliveryCategory: input.deliveryCategory,
  });

  const response: CreateDeliveryEntryResponse = {
    entry: {
      id: entryId,
      visitorName: input.visitorName,
      host: input.host,
      unit: input.unit,
      plate: input.plate ?? null,
      reason: input.reason || "",
      method: input.method,
      guardId: input.guardId,
      createdAt: now.toISOString(),
      status: "logged",
      syncState: "synced",
      entryKind: input.entryKind as EntryKind,
      deliveryCategory: input.deliveryCategory as DeliveryCategory,
    },
    traceId,
  };

  return { response, statusCode: 201 };
}

// ─── Service: listDeliveries ────────────────────────────────────────────────

export async function listDeliveries(
  db: DrizzleDB,
): Promise<ListDeliveriesResponse> {
  const traceId = generateTraceId();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await (db as any).execute(
    sql`SELECT id, visitor_name, host, unit, plate, delivery_category,
               method, guard_id, created_at
        FROM entry_records
        WHERE entry_kind = 'delivery'
        ORDER BY created_at DESC
        LIMIT 100`,
  );

  // PostgreSQL drivers return { rows: [...] }, not a raw array.
  const rows: unknown[] =
    Array.isArray(raw) ? raw : Array.isArray((raw as Record<string, unknown>)?.rows) ? (raw as Record<string, unknown>).rows as unknown[] : [];

  const entries: DeliveryEntryView[] = rows.map((r: unknown) => {
    const row = r as Record<string, unknown>;
    return {
      id: row.id as string,
      visitorName: row.visitor_name as string,
      host: row.host as string,
      unit: row.unit as string,
      plate: (row.plate as string | null) ?? null,
      deliveryCategory: row.delivery_category as DeliveryCategory,
      method: row.method as string,
      guardId: row.guard_id as string,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
    };
  });

  return { entries, count: entries.length, traceId };
}
