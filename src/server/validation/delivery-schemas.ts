/**
 * GatePass — Delivery Management Validation Schemas
 *
 * Source: src/docs/specs/delivery-management.md §4
 *
 * Extends the entry creation schema with delivery-specific fields:
 *   entryKind: 'visitor' | 'delivery' (default: 'visitor')
 *   deliveryCategory: required when entryKind = 'delivery'
 */

import { z } from "zod";

// ─── Constants ───────────────────────────────────────────────────────────────

const ENTRY_KINDS = ["visitor", "delivery"] as const;
const DELIVERY_CATEGORIES = [
  "parcel", "food", "ride", "gas",
  "water", "moving", "maintenance", "other",
] as const;

// ─── Error Codes ─────────────────────────────────────────────────────────────

export const DeliveryValidationErrorCodes = {
  DELIVERY_CATEGORY_REQUIRED: "DELIVERY_CATEGORY_REQUIRED",
  INVALID_ENTRY_KIND: "INVALID_ENTRY_KIND",
  CATEGORY_WITHOUT_DELIVERY_KIND: "CATEGORY_WITHOUT_DELIVERY_KIND",
} as const;

// ─── Schema ──────────────────────────────────────────────────────────────────

export const DeliveryEntrySchema = z
  .object({
    visitorName: z
      .string({ required_error: "Rider name is required" })
      .trim()
      .min(1, "Rider name is required"),

    host: z
      .string()
      .trim()
      .default("Reception"),

    unit: z
      .string({ required_error: "Unit is required" })
      .trim()
      .min(1, "Unit is required"),

    plate: z.string().max(20).nullable().optional().default(null),

    reason: z.string().default(""),

    method: z.enum(["qr", "walk-in", "override", "recognized"] as const, {
      errorMap: () => ({ message: "Method must be one of: qr, walk-in, override, recognized" }),
    }).default("walk-in"),

    createdAt: z
      .string({ required_error: "Device timestamp is required" })
      .datetime("createdAt must be a valid ISO 8601 timestamp"),

    preApprovalId: z.string().uuid().optional(),
    offlineId: z.string().uuid().optional(),

    entryKind: z.enum(ENTRY_KINDS, {
      errorMap: () => ({
        message: `Entry kind must be one of: ${ENTRY_KINDS.join(", ")}`,
      }),
    }),

    deliveryCategory: z.enum(DELIVERY_CATEGORIES, {
      errorMap: () => ({
        message: `Delivery category must be one of: ${DELIVERY_CATEGORIES.join(", ")}`,
      }),
    }).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.entryKind === "delivery" && !data.deliveryCategory) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Delivery entries require a category",
        path: ["deliveryCategory"],
      });
    }
    if (data.entryKind === "visitor" && data.deliveryCategory) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "deliveryCategory can only be set when entryKind is 'delivery'",
        path: ["deliveryCategory"],
      });
    }
  });

// ─── Types ───────────────────────────────────────────────────────────────────

export type DeliveryEntryInput = z.infer<typeof DeliveryEntrySchema>;

// ─── Validation Helper ───────────────────────────────────────────────────────

export function validateDeliveryEntry(
  body: unknown,
): { success: true; data: DeliveryEntryInput } | { success: false; code: string; message: string; field?: string } {
  const result = DeliveryEntrySchema.safeParse(body);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const firstError = result.error.issues[0];
  const field = firstError.path[0]?.toString();

  const code = mapFieldToErrorCode(field, firstError.message);

  return {
    success: false,
    code,
    message: firstError.message,
    field,
  };
}

function mapFieldToErrorCode(field: string | undefined, _message: string): string {
  if (!field) return "VALIDATION_ERROR";

  const fieldCodeMap: Record<string, string> = {
    entryKind: DeliveryValidationErrorCodes.INVALID_ENTRY_KIND,
    deliveryCategory: DeliveryValidationErrorCodes.DELIVERY_CATEGORY_REQUIRED,
    visitorName: "VISITOR_NAME_REQUIRED",
    unit: "UNIT_REQUIRED",
  };

  return fieldCodeMap[field] || "VALIDATION_ERROR";
}
