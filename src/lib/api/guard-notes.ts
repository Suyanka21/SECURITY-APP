/**
 * GatePass — Guard notes API client (Feature 9).
 *
 * Source: src/docs/specs/guard-notes.md §4
 * Source: src/lib/api/exit-tracking.ts (pattern: typed `ApiResult<T>`).
 *
 *   addEntryNote(entryId, body) → POST /api/entries/:entryId/notes
 *   addExitNote(exitId, body)   → POST /api/exits/:exitId/notes
 *   listEntryNotes(entryId)     → GET  /api/entries/:entryId/notes
 *
 * guardId is never sent — the server derives it from the JWT.
 */

import { apiClient } from "./client";
import type {
  ApiResult,
  AddGuardNoteRequest,
  AddGuardNoteResponse,
  ListGuardNotesResponse,
} from "./types";

export const guardNotesApi = {
  addEntryNote(
    entryId: string,
    body: AddGuardNoteRequest,
    signal?: AbortSignal,
  ): Promise<ApiResult<AddGuardNoteResponse>> {
    return apiClient.post<AddGuardNoteResponse>(
      `/api/entries/${encodeURIComponent(entryId)}/notes`,
      body,
      { signal },
    );
  },

  addExitNote(
    exitId: string,
    body: AddGuardNoteRequest,
    signal?: AbortSignal,
  ): Promise<ApiResult<AddGuardNoteResponse>> {
    return apiClient.post<AddGuardNoteResponse>(
      `/api/exits/${encodeURIComponent(exitId)}/notes`,
      body,
      { signal },
    );
  },

  listEntryNotes(
    entryId: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<ListGuardNotesResponse>> {
    return apiClient.get<ListGuardNotesResponse>(
      `/api/entries/${encodeURIComponent(entryId)}/notes`,
      { signal },
    );
  },
};
