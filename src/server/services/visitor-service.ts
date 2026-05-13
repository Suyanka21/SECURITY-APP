/**
 * GatePass — Visitor Service
 *
 * Source: gatepass-api-contract.md §3.4 — GET /api/visitors/recognized
 * Queries entry history to build recognized visitor list with recognition tags.
 */

import { eq, ilike, or, sql, desc } from "drizzle-orm";
import { randomUUID } from "crypto";
import { guards, entryRecords } from "@/db/schema";
import { ServiceError } from "./entry-service";
import { VisitorErrorCodes } from "../validation/visitor-schemas";
import type {
  RecognizedVisitorsInput,
  RecognizedVisitorsResponse,
  RecognizedVisitorItem,
} from "../validation/visitor-schemas";
import type { DrizzleDB } from "./entry-service";

/**
 * Fetches recognized visitors with pagination and optional search.
 *
 * Source: contract §3.4
 * Recognition tags assigned by visit frequency:
 * - "frequent": 3+ visits
 * - "pre-approved": has at least one QR entry
 * - "watch": flagged visitors (future extension)
 */
export async function getRecognizedVisitors(
  input: RecognizedVisitorsInput,
  db: DrizzleDB
): Promise<{ response: RecognizedVisitorsResponse; statusCode: number }> {
  const traceId = `trace-${randomUUID()}`;

  // Step 1: Verify guard exists and is active
  // Source: contract §3.4 — "403 GUARD_SESSION_EXPIRED"
  const guard = await (db as any)
    .select({ id: guards.id, isActive: guards.isActive })
    .from(guards)
    .where(eq(guards.id, input.guardId))
    .limit(1);

  if (!guard || guard.length === 0 || !guard[0].isActive) {
    throw new ServiceError(
      VisitorErrorCodes.GUARD_SESSION_EXPIRED,
      "Guard identity not found or session expired",
      403,
      "guardId"
    );
  }

  // Step 2: Query entry_records for unique visitors
  // Aggregate by visitor name to build recognized list
  // Source: contract §3.4 — "Optional fuzzy search on name/plate"
  const { page, pageSize, q } = input;
  const offset = (page - 1) * pageSize;

  // Build search filter
  let searchFilter: any = undefined;
  if (q && q.length > 0) {
    const searchTerm = `%${q}%`;
    searchFilter = or(
      ilike(entryRecords.visitorName, searchTerm),
      ilike(entryRecords.plate, searchTerm)
    );
  }

  // Get aggregated visitors with visit count and last seen
  // This uses raw SQL for GROUP BY aggregation
  const visitorsQuery = await (db as any).execute(
    sql`
      SELECT
        ${entryRecords.visitorName} as name,
        ${entryRecords.host} as host,
        ${entryRecords.unit} as unit,
        ${entryRecords.plate} as plate,
        MAX(${entryRecords.createdAt}) as last_seen,
        COUNT(*)::int as visit_count,
        BOOL_OR(${entryRecords.method} = 'qr') as has_qr_entry
      FROM ${entryRecords}
      ${searchFilter ? sql`WHERE ${searchFilter}` : sql``}
      GROUP BY ${entryRecords.visitorName}, ${entryRecords.host}, ${entryRecords.unit}, ${entryRecords.plate}
      ORDER BY last_seen DESC
      LIMIT ${pageSize}
      OFFSET ${offset}
    `
  );

  // Get total count for pagination
  const countQuery = await (db as any).execute(
    sql`
      SELECT COUNT(DISTINCT (${entryRecords.visitorName}, ${entryRecords.host}, ${entryRecords.unit}))::int as total
      FROM ${entryRecords}
      ${searchFilter ? sql`WHERE ${searchFilter}` : sql``}
    `
  );

  const totalItems = countQuery?.rows?.[0]?.total ?? 0;
  const totalPages = Math.ceil(totalItems / pageSize);

  // Map to response shape with recognition tags
  const visitors: RecognizedVisitorItem[] = (visitorsQuery?.rows ?? []).map(
    (row: any, index: number) => ({
      id: `visitor-${randomUUID()}`,
      name: row.name,
      host: row.host,
      unit: row.unit,
      plate: row.plate ?? null,
      lastSeen: new Date(row.last_seen).toISOString(),
      recognition: assignRecognitionTag(row.visit_count, row.has_qr_entry),
    })
  );

  const response: RecognizedVisitorsResponse = {
    visitors,
    pagination: {
      page,
      pageSize,
      totalItems,
      totalPages,
    },
    traceId,
  };

  return { response, statusCode: 200 };
}

/**
 * Assigns a recognition tag based on visit history.
 * Source: contract §2 — RecognitionTag: "pre-approved" | "frequent" | "watch"
 */
function assignRecognitionTag(
  visitCount: number,
  hasQrEntry: boolean
): "pre-approved" | "frequent" | "watch" {
  if (hasQrEntry) return "pre-approved";
  if (visitCount >= 3) return "frequent";
  return "watch";
}
