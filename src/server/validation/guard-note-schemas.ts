/**
 * GatePass — Guard Notes Validation Schemas (Feature 9 / Stage 2)
 *
 * Source: src/docs/specs/guard-notes.md §4 (API surface)
 * Source: API-and-Interface-Design — validate at the boundary, single error shape.
 */

import { z } from "zod";

/** Standardised guard-note tags. MUST match the `guard_note_tag` DB enum
 *  (src/db/schema.ts §guardNoteTagEnum). */
export const GUARD_NOTE_TAGS = [
  "delivered_parcel",
  "left_id_at_gate",
  "escorted_by_resident",
  "other",
] as const;

export type GuardNoteTag = (typeof GUARD_NOTE_TAGS)[number];

/** Max length of the free-text field (mirrors the DB CHECK constraint). */
export const GUARD_NOTE_TEXT_MAX = 280;

// POST /api/entries/:entryId/notes — path param
export const EntryNoteParamsSchema = z.object({
  entryId: z.string().uuid("entryId must be a valid UUID"),
});

// POST /api/exits/:exitId/notes — path param
export const ExitNoteParamsSchema = z.object({
  exitId: z.string().uuid("exitId must be a valid UUID"),
});

/**
 * Request body. `text` is required (1..MAX after trim) only when tag='other',
 * and must be absent/empty for every other tag — mirrors the DB CHECK so the
 * boundary rejects bad input before it reaches Postgres.
 */
export const AddGuardNoteSchema = z
  .object({
    tag: z.enum(GUARD_NOTE_TAGS),
    text: z
      .string()
      .trim()
      .max(GUARD_NOTE_TEXT_MAX, `text must be at most ${GUARD_NOTE_TEXT_MAX} characters`)
      .optional(),
  })
  .superRefine((val, ctx) => {
    if (val.tag === "other") {
      if (!val.text || val.text.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "text is required when tag is 'other'",
          path: ["text"],
        });
      }
    } else if (val.text && val.text.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "text is only allowed when tag is 'other'",
        path: ["text"],
      });
    }
  });

export type AddGuardNoteInput = z.infer<typeof AddGuardNoteSchema>;

/** Response view of a stored guard note. */
export interface GuardNoteView {
  id: string;
  entryId: string | null;
  exitId: string | null;
  guardId: string;
  tag: GuardNoteTag;
  text: string | null;
  createdAt: string;
  traceId: string;
}

export interface AddGuardNoteResponse {
  note: GuardNoteView;
  traceId: string;
}

export interface ListGuardNotesResponse {
  notes: GuardNoteView[];
  count: number;
  traceId: string;
}

export const GuardNoteErrorCodes = {
  GUARD_NOTE_INVALID_INPUT: "GUARD_NOTE_INVALID_INPUT",
  GUARD_NOTE_TARGET_NOT_FOUND: "GUARD_NOTE_TARGET_NOT_FOUND",
} as const;
