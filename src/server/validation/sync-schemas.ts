/**
 * GatePass — Sync Validation Schemas
 *
 * Source: gatepass-api-contract.md §3.3 — POST /api/entries/sync
 *
 * HARD RULES:
 * - entries array: non-empty, max 50
 * - offlineId: required per entry, UUID
 * - guardId: must match all entries (one guard per sync batch)
 * - each entry: same validation as POST /api/entries
 */

import { z } from "zod";

// ─── Timestamp Validation Constants ──────────────────────────────────────────
// Source: TRUSTLESS-AUDIT-REPORT [H4] — shared with entry-schemas.ts
const MAX_AGE_MS = 24 * 60 * 60 * 1000;      // 24 hours
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;   // 5 minutes

// ─── Error Codes ─────────────────────────────────────────────────────────────
// Source: contract §3.3 Error Responses table

export const SyncErrorCodes = {
  EMPTY_SYNC_BATCH: "EMPTY_SYNC_BATCH",
  BATCH_TOO_LARGE: "BATCH_TOO_LARGE",
  GUARD_ID_MISSING: "GUARD_ID_MISSING",
  GUARD_SESSION_EXPIRED: "GUARD_SESSION_EXPIRED",
  VALIDATION_ERROR: "VALIDATION_ERROR",
} as const;

// ─── Sync Entry Schema ──────────────────────────────────────────────────────
// Source: contract §3.3 SyncPendingRequest.entries[]

const ENTRY_METHODS = ["qr", "walk-in", "override", "recognized"] as const;

const SyncEntrySchema = z.object({
  // Source: contract §3.3 — "Required per entry, UUID format"
  offlineId: z
    .string({ required_error: "offlineId is required for each sync entry" })
    .uuid("offlineId must be a valid UUID"),

  // Same validation as POST /api/entries
  visitorName: z.string().trim().min(1, "Visitor name is required"),
  host: z.string().trim().min(1, "Host is required"),
  unit: z.string().trim().min(1, "Unit is required"),
  plate: z.string().max(20).nullable().optional().default(null),
  reason: z.string().default(""),
  method: z.enum(ENTRY_METHODS),

  // Source: contract §3.3 — "Original device timestamp"
  // [H4 FIX] Same 24-hour age + future check as entry schema
  createdAt: z
    .string()
    .datetime("createdAt must be valid ISO 8601")
    .superRefine((val, ctx) => {
      const ts = new Date(val).getTime();
      const now = Date.now();

      if (now - ts > MAX_AGE_MS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Device timestamp is older than 24 hours — entry rejected",
        });
      }

      if (ts - now > FUTURE_TOLERANCE_MS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Device timestamp is in the future — entry rejected",
        });
      }
    }),
});

export type SyncEntryInput = z.infer<typeof SyncEntrySchema>;

// ─── Sync Batch Schema ──────────────────────────────────────────────────────
// Source: contract §3.3 SyncPendingRequest

export const SyncBatchSchema = z
  .object({
    // [C3 FIX] guardId REMOVED from request body.
    // Guard identity now comes from verified JWT token (auth middleware).

    // Source: contract §3.3 — "Non-empty array, max 50 items"
    entries: z
      .array(SyncEntrySchema)
      .min(1, "Sync batch cannot be empty")
      .max(50, "Sync batch cannot exceed 50 entries"),
  })
  .superRefine((data, ctx) => {
    // Cross-field: override entries must have reason ≥ 8 chars
    data.entries.forEach((entry, index) => {
      if (entry.method === "override" && entry.reason.trim().length < 8) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Override reason must be at least 8 characters",
          path: ["entries", index, "reason"],
        });
      }
    });

    // Verify offlineIds are unique within the batch
    // Security: prevents client sending same offlineId twice in one request
    const offlineIds = new Set<string>();
    data.entries.forEach((entry, index) => {
      if (offlineIds.has(entry.offlineId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate offlineId within batch: ${entry.offlineId}`,
          path: ["entries", index, "offlineId"],
        });
      }
      offlineIds.add(entry.offlineId);
    });
  });

export type SyncBatchInput = z.infer<typeof SyncBatchSchema>;

// ─── Response Types ──────────────────────────────────────────────────────────
// Source: contract §3.3 SyncPendingResponse

export interface SyncEntryResult {
  offlineId: string;
  serverId: string;
  status: "synced" | "duplicate" | "rejected";
  error?: {
    code: string;
    message: string;
  };
}

export interface SyncBatchResponse {
  results: SyncEntryResult[];
  syncedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  traceId: string;
}

// ─── Validation Helper ───────────────────────────────────────────────────────

export function validateSyncBatch(
  body: unknown
): { success: true; data: SyncBatchInput } | { success: false; code: string; message: string; field?: string } {
  const result = SyncBatchSchema.safeParse(body);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const firstError = result.error.issues[0];
  const field = firstError.path[0]?.toString();

  // Map to contract error codes
  // [C3 FIX] guardId no longer in schema — handled by auth middleware
  let code = SyncErrorCodes.VALIDATION_ERROR;
  if (field === "entries") {
    const msg = firstError.message.toLowerCase();
    if (msg.includes("empty") || msg.includes("at least")) {
      code = SyncErrorCodes.EMPTY_SYNC_BATCH;
    } else if (msg.includes("exceed") || msg.includes("most")) {
      code = SyncErrorCodes.BATCH_TOO_LARGE;
    }
  }

  return {
    success: false,
    code,
    message: firstError.message,
    field,
  };
}
