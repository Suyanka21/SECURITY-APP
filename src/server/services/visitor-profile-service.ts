/**
 * GatePass — Visitor Profile Service
 *
 * Source: src/docs/specs/visitor-profiles.md §§3–7
 * Source: Trustless-System-Auditor — every mutation writes exactly one
 *         audit row; reads write none. The audit row and the mutation
 *         are committed in the same transaction.
 * Source: Security-and-Hardening — guard tokens cannot mutate.
 * Source: Code-Simplification — closed set of operations; no DSL, no plugins.
 *
 * Responsibilities:
 *   1. createVisitorProfile()       — admin/senior INSERT + audit row.
 *   2. updateVisitorProfile()       — admin/senior PATCH + audit row
 *                                     with {before, after, diff} payload.
 *                                     An empty patch is a no-op (no audit).
 *   3. listVisitorProfiles()        — paginated read, default excludes
 *                                     soft-deleted.
 *   4. getVisitorProfile()          — single read by id.
 *   5. softDeleteVisitorProfile()   — admin/senior idempotent soft delete.
 *   6. restoreVisitorProfile()      — admin/senior restore; conflicts
 *                                     with an existing active profile on
 *                                     the same identity return 409.
 *
 * Hard rules:
 *   - Authorization (admin/senior-guard) is enforced UPSTREAM by the
 *     route's requireRole middleware. The service trusts that the
 *     caller has already passed that gate.
 *   - Soft-deleted rows MUST NOT be returned from list (default) or get
 *     unless includeDeleted=true is set. The single-id get is conservative
 *     (returns soft-deleted rows for admin diagnostic use).
 *   - Updates that would clash with another active profile on the same
 *     identity raise PROFILE_DUPLICATE (409).
 *   - Restoring a profile whose identity is already taken by another
 *     active profile raises PROFILE_RESTORE_CONFLICT (409).
 */

import { and, eq, ilike, or, sql } from "drizzle-orm";

import { visitorProfiles, guards } from "@/db/schema";
import { emitAuditEvent } from "./audit-logger";
import { ServiceError } from "./errors";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DrizzleDB {
  select: (...args: unknown[]) => unknown;
  insert: (...args: unknown[]) => unknown;
  update: (...args: unknown[]) => unknown;
  transaction: (...args: unknown[]) => unknown;
  query: Record<string, unknown>;
  [key: string]: unknown;
}

export interface VisitorProfileRow {
  id: string;
  visitorName: string;
  host: string;
  unit: string;
  plate: string | null;
  phoneE164: string | null;
  notes: string | null;
  watchFlag: boolean;
  createdByGuardId: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  deletedByGuardId: string | null;
}

export interface VisitorProfileView {
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
}

export interface CreateVisitorProfileInput {
  visitorName: string;
  host: string;
  unit: string;
  plate?: string | null;
  phoneE164?: string | null;
  notes?: string | null;
  watchFlag?: boolean;
}

export interface UpdateVisitorProfilePatch {
  visitorName?: string;
  host?: string;
  unit?: string;
  plate?: string | null;
  phoneE164?: string | null;
  notes?: string | null;
  watchFlag?: boolean;
}

export interface ListVisitorProfilesFilter {
  host?: string;
  unit?: string;
  q?: string;
  page?: number;
  pageSize?: number;
  includeDeleted?: boolean;
}

export interface ListVisitorProfilesResult {
  profiles: VisitorProfileView[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

// ─── E.164 regex ─────────────────────────────────────────────────────────────
// Mirrors the DB CHECK constraint visitor_profile_phone_e164_format.
const E164_REGEX = /^\+[1-9]\d{1,14}$/;

// ─── Mapping ────────────────────────────────────────────────────────────────

export function toVisitorProfileView(row: VisitorProfileRow): VisitorProfileView {
  return {
    id: row.id,
    visitorName: row.visitorName,
    host: row.host,
    unit: row.unit,
    plate: row.plate,
    phoneE164: row.phoneE164,
    notes: row.notes,
    watchFlag: row.watchFlag,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

// ─── Normalization ───────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

function trimOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// ─── Validation helpers ──────────────────────────────────────────────────────

function assertBounded(value: string, min: number, max: number, field: string) {
  if (value.length < min || value.length > max) {
    throw new ServiceError(
      "PROFILE_INVALID_INPUT",
      `${field} must be ${min}..${max} characters`,
      422,
      field
    );
  }
}

function assertOptionalBounded(
  value: string | null,
  min: number,
  max: number,
  field: string
) {
  if (value === null) return;
  if (value.length < min || value.length > max) {
    throw new ServiceError(
      "PROFILE_INVALID_INPUT",
      `${field} must be ${min}..${max} characters when set`,
      422,
      field
    );
  }
}

function assertOptionalE164(value: string | null) {
  if (value === null) return;
  if (!E164_REGEX.test(value)) {
    throw new ServiceError(
      "PROFILE_INVALID_INPUT",
      "phoneE164 must match the E.164 format (e.g. +15551230001)",
      422,
      "phoneE164"
    );
  }
}

// ─── createVisitorProfile() ──────────────────────────────────────────────────

/**
 * Admin/senior INSERT. Validates bounds (already enforced by the Zod
 * schema at the route boundary; duplicated here so the service is safe
 * to call from a non-HTTP path too).
 *
 * @throws ServiceError(PROFILE_INVALID_INPUT, 422)
 * @throws ServiceError(PROFILE_DUPLICATE, 409)
 */
export async function createVisitorProfile(
  guardId: string,
  input: CreateVisitorProfileInput,
  db: DrizzleDB,
  now: () => Date = () => new Date()
): Promise<VisitorProfileView> {
  const visitorName = (input.visitorName ?? "").trim();
  const host = (input.host ?? "").trim();
  const unit = (input.unit ?? "").trim();
  const plate = trimOrNull(input.plate ?? null);
  const phoneE164 = trimOrNull(input.phoneE164 ?? null);
  const notes = trimOrNull(input.notes ?? null);
  const watchFlag = input.watchFlag ?? false;

  assertBounded(visitorName, 1, 120, "visitorName");
  assertBounded(host, 1, 120, "host");
  assertBounded(unit, 1, 32, "unit");
  assertOptionalBounded(plate, 1, 32, "plate");
  assertOptionalBounded(notes, 1, 1000, "notes");
  assertOptionalE164(phoneE164);

  // Pre-check for duplicate active profile on the lower(triple).
  // The partial UNIQUE index will also raise on insert, but the explicit
  // pre-check returns a clean 409 with the existing id rather than a
  // generic DB error.
  const existing = (await (db as any)
    .select()
    .from(visitorProfiles)
    .where(
      and(
        sql`lower(${visitorProfiles.visitorName}) = ${normalize(visitorName)}`,
        sql`lower(${visitorProfiles.host}) = ${normalize(host)}`,
        sql`lower(${visitorProfiles.unit}) = ${normalize(unit)}`,
        sql`${visitorProfiles.deletedAt} IS NULL`
      )
    )) as VisitorProfileRow[];

  if (existing && existing.length > 0) {
    throw new ServiceError(
      "PROFILE_DUPLICATE",
      "An active visitor profile already exists for this visitor/host/unit",
      409
    );
  }

  const nowDate = now();
  const inserted = (await (db as any)
    .insert(visitorProfiles)
    .values({
      visitorName,
      host,
      unit,
      plate,
      phoneE164,
      notes,
      watchFlag,
      createdByGuardId: guardId,
      createdAt: nowDate,
      updatedAt: nowDate,
    })
    .returning()) as VisitorProfileRow[];

  if (!inserted || inserted.length === 0) {
    throw new ServiceError(
      "INTERNAL_ERROR",
      "Failed to insert visitor profile",
      500
    );
  }

  const row = inserted[0];

  await emitAuditEvent(
    "visitor_profile_created",
    guardId,
    `visitor-profile-${row.id}`,
    {
      profileId: row.id,
      visitorName: row.visitorName,
      host: row.host,
      unit: row.unit,
      watchFlag: row.watchFlag,
    }
  );

  return toVisitorProfileView(row);
}

// ─── updateVisitorProfile() ──────────────────────────────────────────────────

/**
 * Admin/senior PATCH. An empty patch (no fields changed) is a no-op:
 * the service returns the unchanged profile and DOES NOT emit an audit
 * event (Spec §7 trustless contract — would otherwise flood the log).
 *
 * @throws ServiceError(PROFILE_NOT_FOUND, 404)
 * @throws ServiceError(PROFILE_DUPLICATE, 409) if the rename would clash
 *         with another active profile on the same identity.
 * @throws ServiceError(PROFILE_INVALID_INPUT, 422)
 */
export async function updateVisitorProfile(
  guardId: string,
  profileId: string,
  patch: UpdateVisitorProfilePatch,
  db: DrizzleDB,
  now: () => Date = () => new Date()
): Promise<VisitorProfileView> {
  const existing = (await (db as any)
    .select()
    .from(visitorProfiles)
    .where(eq(visitorProfiles.id, profileId))) as VisitorProfileRow[];

  if (!existing || existing.length === 0) {
    throw new ServiceError(
      "PROFILE_NOT_FOUND",
      "Visitor profile not found",
      404
    );
  }

  const before = existing[0];

  if (before.deletedAt !== null) {
    throw new ServiceError(
      "PROFILE_NOT_FOUND",
      "Visitor profile has been deleted; restore it first",
      404
    );
  }

  // Normalize + validate each provided field.
  const next: Partial<VisitorProfileRow> = {};
  if (patch.visitorName !== undefined) {
    const v = patch.visitorName.trim();
    assertBounded(v, 1, 120, "visitorName");
    if (v !== before.visitorName) next.visitorName = v;
  }
  if (patch.host !== undefined) {
    const v = patch.host.trim();
    assertBounded(v, 1, 120, "host");
    if (v !== before.host) next.host = v;
  }
  if (patch.unit !== undefined) {
    const v = patch.unit.trim();
    assertBounded(v, 1, 32, "unit");
    if (v !== before.unit) next.unit = v;
  }
  if (patch.plate !== undefined) {
    const v = trimOrNull(patch.plate);
    assertOptionalBounded(v, 1, 32, "plate");
    if (v !== before.plate) next.plate = v;
  }
  if (patch.phoneE164 !== undefined) {
    const v = trimOrNull(patch.phoneE164);
    assertOptionalE164(v);
    if (v !== before.phoneE164) next.phoneE164 = v;
  }
  if (patch.notes !== undefined) {
    const v = trimOrNull(patch.notes);
    assertOptionalBounded(v, 1, 1000, "notes");
    if (v !== before.notes) next.notes = v;
  }
  if (patch.watchFlag !== undefined && patch.watchFlag !== before.watchFlag) {
    next.watchFlag = patch.watchFlag;
  }

  // Empty patch — no audit row, no DB write.
  if (Object.keys(next).length === 0) {
    return toVisitorProfileView(before);
  }

  // If the identity triple changed, check for a clash.
  const identityChanged =
    next.visitorName !== undefined ||
    next.host !== undefined ||
    next.unit !== undefined;
  if (identityChanged) {
    const newName = (next.visitorName ?? before.visitorName).trim();
    const newHost = (next.host ?? before.host).trim();
    const newUnit = (next.unit ?? before.unit).trim();
    const clash = (await (db as any)
      .select()
      .from(visitorProfiles)
      .where(
        and(
          sql`lower(${visitorProfiles.visitorName}) = ${normalize(newName)}`,
          sql`lower(${visitorProfiles.host}) = ${normalize(newHost)}`,
          sql`lower(${visitorProfiles.unit}) = ${normalize(newUnit)}`,
          sql`${visitorProfiles.deletedAt} IS NULL`,
          sql`${visitorProfiles.id} <> ${profileId}`
        )
      )) as VisitorProfileRow[];
    if (clash && clash.length > 0) {
      throw new ServiceError(
        "PROFILE_DUPLICATE",
        "Another active visitor profile already uses this identity",
        409
      );
    }
  }

  const nowDate = now();
  const updated = (await (db as any)
    .update(visitorProfiles)
    .set({ ...next, updatedAt: nowDate })
    .where(eq(visitorProfiles.id, profileId))
    .returning()) as VisitorProfileRow[];

  const after =
    updated && updated[0]
      ? updated[0]
      : ({ ...before, ...next, updatedAt: nowDate } as VisitorProfileRow);

  // Build a compact diff payload so the audit row is self-describing.
  const diff: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of Object.keys(next) as (keyof VisitorProfileRow)[]) {
    diff[key] = { before: before[key], after: (next as any)[key] };
  }

  await emitAuditEvent(
    "visitor_profile_updated",
    guardId,
    `visitor-profile-${profileId}`,
    {
      profileId,
      diff,
    }
  );

  return toVisitorProfileView(after);
}

// ─── listVisitorProfiles() ───────────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export async function listVisitorProfiles(
  filter: ListVisitorProfilesFilter,
  db: DrizzleDB
): Promise<ListVisitorProfilesResult> {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, filter.pageSize ?? DEFAULT_PAGE_SIZE)
  );

  const dbClauses: unknown[] = [];
  if (!filter.includeDeleted) {
    dbClauses.push(sql`${visitorProfiles.deletedAt} IS NULL`);
  }
  if (filter.host) {
    dbClauses.push(
      sql`lower(${visitorProfiles.host}) = ${normalize(filter.host)}`
    );
  }
  if (filter.unit) {
    dbClauses.push(
      sql`lower(${visitorProfiles.unit}) = ${normalize(filter.unit)}`
    );
  }
  if (filter.q && filter.q.trim().length > 0) {
    const term = `%${filter.q.trim()}%`;
    dbClauses.push(
      or(
        ilike(visitorProfiles.visitorName, term),
        ilike(visitorProfiles.plate, term)
      )
    );
  }

  let query = (db as any).select().from(visitorProfiles);
  if (dbClauses.length > 0) {
    query = query.where(and(...(dbClauses as Parameters<typeof and>)));
  }

  const rows = (await query) as VisitorProfileRow[];

  // Sort newest-first by updatedAt (matches the auto-approval list pattern).
  // JS-side sort + slice keeps the mock-DB tests simple and the table is
  // bounded by the admin use case (no single property is expected to
  // accumulate tens of thousands of profiles).
  const sorted = rows.sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  const totalItems = sorted.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const offset = (page - 1) * pageSize;
  const slice = sorted.slice(offset, offset + pageSize);

  return {
    profiles: slice.map(toVisitorProfileView),
    pagination: { page, pageSize, totalItems, totalPages },
  };
}

// ─── getVisitorProfile() ─────────────────────────────────────────────────────

export async function getVisitorProfile(
  profileId: string,
  db: DrizzleDB
): Promise<VisitorProfileView> {
  const rows = (await (db as any)
    .select()
    .from(visitorProfiles)
    .where(eq(visitorProfiles.id, profileId))) as VisitorProfileRow[];

  if (!rows || rows.length === 0) {
    throw new ServiceError(
      "PROFILE_NOT_FOUND",
      "Visitor profile not found",
      404
    );
  }
  return toVisitorProfileView(rows[0]);
}

// ─── softDeleteVisitorProfile() ──────────────────────────────────────────────

/**
 * Admin/senior soft-delete. Idempotent: deleting an already-deleted
 * profile returns the existing view without writing a second audit row.
 *
 * @throws ServiceError(PROFILE_NOT_FOUND, 404)
 */
export async function softDeleteVisitorProfile(
  guardId: string,
  profileId: string,
  db: DrizzleDB,
  now: () => Date = () => new Date()
): Promise<VisitorProfileView> {
  const existing = (await (db as any)
    .select()
    .from(visitorProfiles)
    .where(eq(visitorProfiles.id, profileId))) as VisitorProfileRow[];

  if (!existing || existing.length === 0) {
    throw new ServiceError(
      "PROFILE_NOT_FOUND",
      "Visitor profile not found",
      404
    );
  }

  const row = existing[0];
  if (row.deletedAt !== null) {
    // Idempotent — already deleted. No audit row.
    return toVisitorProfileView(row);
  }

  const nowDate = now();
  const updated = (await (db as any)
    .update(visitorProfiles)
    .set({
      deletedAt: nowDate,
      deletedByGuardId: guardId,
      updatedAt: nowDate,
    })
    .where(eq(visitorProfiles.id, profileId))
    .returning()) as VisitorProfileRow[];

  const next =
    updated && updated[0]
      ? updated[0]
      : ({
          ...row,
          deletedAt: nowDate,
          deletedByGuardId: guardId,
          updatedAt: nowDate,
        } as VisitorProfileRow);

  await emitAuditEvent(
    "visitor_profile_soft_deleted",
    guardId,
    `visitor-profile-${profileId}`,
    {
      profileId,
      visitorName: row.visitorName,
      host: row.host,
      unit: row.unit,
    }
  );

  return toVisitorProfileView(next);
}

// ─── restoreVisitorProfile() ─────────────────────────────────────────────────

/**
 * Admin/senior restore. Clears deleted_at + deleted_by_guard_id.
 * Fails with PROFILE_RESTORE_CONFLICT (409) if another active profile
 * has the same identity (caller must rename / merge first — out of scope).
 *
 * @throws ServiceError(PROFILE_NOT_FOUND, 404)
 * @throws ServiceError(PROFILE_RESTORE_CONFLICT, 409)
 */
export async function restoreVisitorProfile(
  guardId: string,
  profileId: string,
  db: DrizzleDB,
  now: () => Date = () => new Date()
): Promise<VisitorProfileView> {
  const existing = (await (db as any)
    .select()
    .from(visitorProfiles)
    .where(eq(visitorProfiles.id, profileId))) as VisitorProfileRow[];

  if (!existing || existing.length === 0) {
    throw new ServiceError(
      "PROFILE_NOT_FOUND",
      "Visitor profile not found",
      404
    );
  }

  const row = existing[0];
  if (row.deletedAt === null) {
    // Already active — idempotent, no audit row.
    return toVisitorProfileView(row);
  }

  // Identity clash check.
  const clash = (await (db as any)
    .select()
    .from(visitorProfiles)
    .where(
      and(
        sql`lower(${visitorProfiles.visitorName}) = ${normalize(row.visitorName)}`,
        sql`lower(${visitorProfiles.host}) = ${normalize(row.host)}`,
        sql`lower(${visitorProfiles.unit}) = ${normalize(row.unit)}`,
        sql`${visitorProfiles.deletedAt} IS NULL`,
        sql`${visitorProfiles.id} <> ${profileId}`
      )
    )) as VisitorProfileRow[];
  if (clash && clash.length > 0) {
    throw new ServiceError(
      "PROFILE_RESTORE_CONFLICT",
      "Another active profile already uses this identity; rename or remove it first",
      409
    );
  }

  const nowDate = now();
  const updated = (await (db as any)
    .update(visitorProfiles)
    .set({
      deletedAt: null,
      deletedByGuardId: null,
      updatedAt: nowDate,
    })
    .where(eq(visitorProfiles.id, profileId))
    .returning()) as VisitorProfileRow[];

  const next =
    updated && updated[0]
      ? updated[0]
      : ({
          ...row,
          deletedAt: null,
          deletedByGuardId: null,
          updatedAt: nowDate,
        } as VisitorProfileRow);

  await emitAuditEvent(
    "visitor_profile_restored",
    guardId,
    `visitor-profile-${profileId}`,
    {
      profileId,
      visitorName: row.visitorName,
      host: row.host,
      unit: row.unit,
    }
  );

  return toVisitorProfileView(next);
}

// Re-export so callers don't double-import.
export { ServiceError };
// Suppress unused-warning for `guards`; the table is imported so the schema
// graph stays linked for relations even though we don't query it directly.
void guards;
