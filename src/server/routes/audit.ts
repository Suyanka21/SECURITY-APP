/**
 * GatePass — Audit Routes (Read-Only)
 *
 * Source: gatepass-api-contract.md §5
 *
 * HARD RULES:
 * - All endpoints are READ-ONLY (GET only)
 * - No mutation endpoints exist (no POST, PUT, DELETE)
 * - Audit data is IMMUTABLE — cannot be modified through any API
 */

import { Router } from "express";
import { randomUUID } from "crypto";
import {
  validateAuditQuery,
  type AuditQueryResponse,
  type ReconstructResponse,
  type ShiftSummaryResponse,
} from "../validation/audit-schemas";
import {
  getAuditLog,
  getAuditEventsByGuard,
  getAuditEventsByType,
  getAuditEventsByTraceId,
  getAuditEventsByTimeRange,
  reconstructEntryHistory,
  reconstructGuardShift,
  type AuditEvent,
  type AuditEventType,
} from "../services/audit-logger";

export const auditRouter = Router();

/**
 * GET /api/audit/events
 *
 * Query audit events with optional filtering.
 * Source: contract §5 — Backend Event Traceability Matrix
 *
 * HARD RULE: Read-only. No mutation possible.
 */
auditRouter.get("/events", (req, res) => {
  const traceId = `trace-${randomUUID()}`;

  const validation = validateAuditQuery(req.query);
  if (!validation.success) {
    res.status(422).json({
      error: {
        code: "VALIDATION_ERROR",
        message: validation.message,
        traceId,
      },
    });
    return;
  }

  const { guardId, eventType, traceId: filterTraceId, from, to, page, pageSize } = validation.data;

  // Apply filters progressively
  let events: AuditEvent[] = getAuditLog() as AuditEvent[];

  if (guardId) {
    events = events.filter((e) => e.guardId === guardId);
  }
  if (eventType) {
    events = events.filter((e) => e.type === eventType);
  }
  if (filterTraceId) {
    events = events.filter((e) => e.traceId === filterTraceId);
  }
  if (from) {
    const fromDate = new Date(from);
    events = events.filter((e) => new Date(e.timestamp) >= fromDate);
  }
  if (to) {
    const toDate = new Date(to);
    events = events.filter((e) => new Date(e.timestamp) <= toDate);
  }

  // Sort by timestamp descending (most recent first)
  events.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  // Paginate
  const totalItems = events.length;
  const totalPages = Math.ceil(totalItems / pageSize);
  const start = (page - 1) * pageSize;
  const paginatedEvents = events.slice(start, start + pageSize);

  const response: AuditQueryResponse = {
    events: paginatedEvents.map((e) => ({
      id: e.id,
      type: e.type,
      timestamp: e.timestamp,
      guardId: e.guardId,
      traceId: e.traceId,
      payload: e.payload,
    })),
    pagination: {
      page,
      pageSize,
      totalItems,
      totalPages,
    },
    traceId,
  };

  res.json(response);
});

/**
 * GET /api/audit/reconstruct/:traceId
 *
 * Reconstructs the complete event chain for a given traceId.
 * Used for forensic analysis and dispute resolution.
 *
 * Source: event-sourcing principle — "full system must be reconstructable"
 */
auditRouter.get("/reconstruct/:traceId", (req, res) => {
  const { traceId } = req.params;

  if (!traceId) {
    res.status(422).json({
      error: {
        code: "TRACE_ID_REQUIRED",
        message: "traceId parameter is required",
        traceId: `trace-${randomUUID()}`,
      },
    });
    return;
  }

  const { events, timeline } = reconstructEntryHistory(traceId);

  const response: ReconstructResponse = {
    traceId,
    events: events.map((e) => ({
      id: e.id,
      type: e.type,
      timestamp: e.timestamp,
      guardId: e.guardId,
      payload: e.payload,
    })),
    timeline,
  };

  res.json(response);
});

/**
 * GET /api/audit/shift/:guardId
 *
 * Reconstructs a guard's shift summary from audit events.
 * Source: DEFINITION §5 — "Aggregated per guard per shift"
 */
auditRouter.get("/shift/:guardId", (req, res) => {
  const { guardId } = req.params;
  const responseTraceId = `trace-${randomUUID()}`;

  if (!guardId) {
    res.status(422).json({
      error: {
        code: "GUARD_ID_REQUIRED",
        message: "guardId parameter is required",
        traceId: responseTraceId,
      },
    });
    return;
  }

  const summary = reconstructGuardShift(guardId);

  const response: ShiftSummaryResponse = {
    ...summary,
    traceId: responseTraceId,
  };

  // Don't include raw events in shift summary response (too large)
  const { events: _, ...summaryWithoutEvents } = response as any;
  res.json(summaryWithoutEvents);
});
