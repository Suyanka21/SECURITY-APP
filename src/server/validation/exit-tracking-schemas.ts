/**
 * GatePass — Exit Tracking Validation Schemas
 *
 * Source: src/docs/specs/exit-tracking.md §6 (API surface)
 * Source: API-and-Interface-Design — validate at the boundary.
 */

import { z } from "zod";

// POST /api/entries/:entryId/exit — path param
export const ExitEntryIdSchema = z.object({
  entryId: z.string().uuid("entryId must be a valid UUID"),
});

// Response shapes (for type safety in route handlers)
export interface ExitRecordView {
  id: string;
  entryId: string;
  guardId: string;
  createdAt: string;
  traceId: string;
}

export interface RecordExitResponse {
  exit: ExitRecordView;
  traceId: string;
}

export interface OnPremiseEntryView {
  id: string;
  visitorName: string;
  host: string;
  unit: string;
  plate: string | null;
  method: string;
  guardId: string;
  createdAt: string;
  /** Guard notes attached to this entry (Feature 9). Empty when none. */
  notes: OnPremiseNoteView[];
}

/** A guard note as surfaced on an on-premise row (Feature 9). */
export interface OnPremiseNoteView {
  id: string;
  tag: string;
  text: string | null;
  guardId: string;
  createdAt: string;
}

export interface ListOnPremiseResponse {
  entries: OnPremiseEntryView[];
  count: number;
  traceId: string;
}

export const ExitTrackingErrorCodes = {
  EXIT_ENTRY_ID_INVALID: "EXIT_ENTRY_ID_INVALID",
} as const;
