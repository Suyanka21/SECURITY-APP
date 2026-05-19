/**
 * GatePass — Visitor Profile Validation Schemas
 *
 * Source: src/docs/specs/visitor-profiles.md §4 (API surface), §2 (data model).
 * Source: API-and-Interface-Design — "validate at the boundary".
 * Source: Security-and-Hardening — "validate all external input".
 *
 * Endpoints validated:
 *   1. POST   /api/visitor-profiles                — admin/senior create
 *   2. PATCH  /api/visitor-profiles/:id            — admin/senior update
 *   3. GET    /api/visitor-profiles                — any auth list
 *   4. GET    /api/visitor-profiles/:id            — any auth get
 *   5. DELETE /api/visitor-profiles/:id            — admin/senior soft-delete
 *   6. POST   /api/visitor-profiles/:id/restore    — admin/senior restore
 */

import { z } from "zod";

// ─── Error codes ─────────────────────────────────────────────────────────────
// Closed set; never re-numbered. New codes are additive.

export const VisitorProfileErrorCodes = {
  PROFILE_INVALID_INPUT: "PROFILE_INVALID_INPUT",
  PROFILE_DUPLICATE: "PROFILE_DUPLICATE",
  PROFILE_NOT_FOUND: "PROFILE_NOT_FOUND",
  PROFILE_RESTORE_CONFLICT: "PROFILE_RESTORE_CONFLICT",
  GUARD_CANNOT_MUTATE_PROFILES: "GUARD_CANNOT_MUTATE_PROFILES",
  AUTH_FORBIDDEN: "AUTH_FORBIDDEN",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type VisitorProfileErrorCode =
  (typeof VisitorProfileErrorCodes)[keyof typeof VisitorProfileErrorCodes];

// ─── E.164 regex ─────────────────────────────────────────────────────────────
// Mirrors the DB CHECK constraint visitor_profile_phone_e164_format.
// Source: spec §2.
const E164_REGEX = /^\+[1-9]\d{1,14}$/;

// ─── Reusable field schemas ──────────────────────────────────────────────────

const visitorNameSchema = z
  .string()
  .trim()
  .min(1, "visitorName must be 1..120 characters")
  .max(120, "visitorName must be 1..120 characters");

const hostSchema = z
  .string()
  .trim()
  .min(1, "host must be 1..120 characters")
  .max(120, "host must be 1..120 characters");

const unitSchema = z
  .string()
  .trim()
  .min(1, "unit must be 1..32 characters")
  .max(32, "unit must be 1..32 characters");

const plateSchema = z
  .string()
  .trim()
  .min(1, "plate must be 1..32 characters")
  .max(32, "plate must be 1..32 characters");

const phoneE164Schema = z
  .string()
  .trim()
  .regex(E164_REGEX, "phoneE164 must match the E.164 format (e.g. +15551230001)");

const notesSchema = z
  .string()
  .trim()
  .min(1, "notes must be 1..1000 characters")
  .max(1000, "notes must be 1..1000 characters");

// ─── POST /api/visitor-profiles body ─────────────────────────────────────────

export const CreateVisitorProfileSchema = z
  .object({
    visitorName: visitorNameSchema,
    host: hostSchema,
    unit: unitSchema,
    plate: plateSchema.optional().nullable(),
    phoneE164: phoneE164Schema.optional().nullable(),
    notes: notesSchema.optional().nullable(),
    watchFlag: z.boolean().optional(),
  })
  .strict();

export type CreateVisitorProfileBody = z.infer<typeof CreateVisitorProfileSchema>;

// ─── PATCH /api/visitor-profiles/:id body ────────────────────────────────────
// All fields optional — empty patch is a no-op (service returns 200 with the
// unchanged profile and writes NO audit row; see spec §7).

export const UpdateVisitorProfileSchema = z
  .object({
    visitorName: visitorNameSchema.optional(),
    host: hostSchema.optional(),
    unit: unitSchema.optional(),
    plate: plateSchema.optional().nullable(),
    phoneE164: phoneE164Schema.optional().nullable(),
    notes: notesSchema.optional().nullable(),
    watchFlag: z.boolean().optional(),
  })
  .strict();

export type UpdateVisitorProfileBody = z.infer<typeof UpdateVisitorProfileSchema>;

// ─── GET /api/visitor-profiles query ─────────────────────────────────────────

export const ListVisitorProfilesQuerySchema = z
  .object({
    host: z.string().trim().min(1).max(120).optional(),
    unit: z.string().trim().min(1).max(32).optional(),
    q: z.string().trim().min(1).max(120).optional(),
    page: z
      .string()
      .regex(/^\d+$/, "page must be a positive integer")
      .transform((s) => Math.max(1, parseInt(s, 10)))
      .optional(),
    pageSize: z
      .string()
      .regex(/^\d+$/, "pageSize must be a positive integer")
      .transform((s) => Math.min(100, Math.max(1, parseInt(s, 10))))
      .optional(),
    includeDeleted: z
      .union([z.literal("true"), z.literal("false")])
      .optional()
      .transform((s) => s === "true"),
  })
  .partial();

export type ListVisitorProfilesQuery = z.infer<
  typeof ListVisitorProfilesQuerySchema
>;

// ─── :id param ───────────────────────────────────────────────────────────────

export const VisitorProfileIdParamSchema = z
  .object({
    id: z.string().uuid("id must be a UUID"),
  })
  .strict();

// ─── Response shapes (wire format) ───────────────────────────────────────────

export interface VisitorProfileResponse {
  profile: {
    id: string;
    visitorName: string;
    host: string;
    unit: string;
    plate: string | null;
    phoneE164: string | null;
    notes: string | null;
    watchFlag: boolean;
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
  };
  traceId: string;
}

export interface ListVisitorProfilesResponse {
  profiles: VisitorProfileResponse["profile"][];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
  traceId: string;
}
