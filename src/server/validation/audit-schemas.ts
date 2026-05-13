/**
 * GatePass — Audit Query Validation Schemas
 *
 * Source: gatepass-api-contract.md §5 — Backend Event Traceability Matrix
 *
 * Query schemas for the audit system's read-only API.
 * No mutation operations exist — this is append-only.
 */

import { z } from "zod";

// ─── Query Schemas ───────────────────────────────────────────────────────────

const AUDIT_EVENT_TYPES = [
  "entry_created",
  "entry_blocked",
  "qr_scan_succeeded",
  "qr_scan_rejected",
  "override_authorized",
  "override_rejected",
  "visitor_selected",
  "visitor_search",
  "batch_sync_completed",
  "override_flow_entered",
  "flow_reset",
  "camera_initialized",
  "camera_failure",
] as const;

/**
 * GET /api/audit/events query params
 * Supports filtering by guardId, eventType, traceId, and time range.
 */
export const AuditQuerySchema = z.object({
  guardId: z.string().uuid().optional(),
  eventType: z.enum(AUDIT_EVENT_TYPES).optional(),
  traceId: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type AuditQuery = z.infer<typeof AuditQuerySchema>;

/**
 * GET /api/audit/reconstruct/:traceId
 * Reconstructs event chain for a given traceId.
 */
export const ReconstructQuerySchema = z.object({
  traceId: z.string().min(1, "traceId is required"),
});

/**
 * GET /api/audit/shift/:guardId
 * Reconstructs guard shift summary.
 */
export const ShiftQuerySchema = z.object({
  guardId: z.string().uuid("guardId must be a valid UUID"),
});

// ─── Response Types ──────────────────────────────────────────────────────────

export interface AuditQueryResponse {
  events: Array<{
    id: string;
    type: string;
    timestamp: string;
    guardId: string;
    traceId: string;
    payload: Record<string, unknown>;
  }>;
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
  traceId: string;
}

export interface ReconstructResponse {
  traceId: string;
  events: Array<{
    id: string;
    type: string;
    timestamp: string;
    guardId: string;
    payload: Record<string, unknown>;
  }>;
  timeline: Array<{
    timestamp: string;
    action: string;
    detail: string;
  }>;
}

export interface ShiftSummaryResponse {
  guardId: string;
  totalEvents: number;
  entriesCreated: number;
  qrScansSucceeded: number;
  qrScansRejected: number;
  overridesAuthorized: number;
  overridesRejected: number;
  syncBatches: number;
  traceId: string;
}

// ─── Validation Helpers ──────────────────────────────────────────────────────

export function validateAuditQuery(
  params: unknown
): { success: true; data: AuditQuery } | { success: false; message: string } {
  const result = AuditQuerySchema.safeParse(params);
  if (result.success) return { success: true, data: result.data };
  return { success: false, message: result.error.issues[0].message };
}
