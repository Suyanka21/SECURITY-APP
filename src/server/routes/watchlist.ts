/**
 * GatePass — Watchlist Route Handlers (Feature 12 / Stage 5)
 *
 * Source: src/docs/specs/watchlist.md §3 (API surface), §7 (review model).
 * Source: API-and-Interface-Design — single error shape, validate at boundary.
 * Source: Security-and-Hardening — guardId from the verified JWT, never the
 *         body; authorisation (admin/senior-guard) is applied in app.ts via
 *         the existing requireRole middleware — no new role logic.
 *
 *   POST   /api/watchlist       create (reason mandatory)
 *   GET    /api/watchlist       list (?status=, ?needsReview=)
 *   PATCH  /api/watchlist/:id   re-confirm (resets the review clock)
 *   DELETE /api/watchlist/:id   soft remove (removedReason mandatory)
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "crypto";

import {
  CreateWatchlistEntrySchema,
  ListWatchlistQuerySchema,
  RemoveWatchlistEntrySchema,
  ReviewWatchlistEntrySchema,
  WatchlistErrorCodes,
  WatchlistParamsSchema,
  type ListWatchlistResponse,
  type WatchlistEntryResponse,
} from "../validation/watchlist-schemas";
import {
  createWatchlistEntry,
  listWatchlistEntries,
  removeWatchlistEntry,
  reviewWatchlistEntry,
} from "../services/watchlist-service";
import type { AuthenticatedRequest } from "../middleware/auth";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getDb(req: Request): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (req as any).db;
}

function invalidInput(
  res: Response,
  message: string,
  field: string | undefined,
): void {
  res.status(422).json({
    error: {
      code: WatchlistErrorCodes.WATCHLIST_INVALID_INPUT,
      message,
      ...(field && { field }),
      traceId: `trace-${randomUUID()}`,
    },
  });
}

// ─── POST /api/watchlist ─────────────────────────────────────────────────────

export async function handleCreateWatchlistEntry(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = CreateWatchlistEntrySchema.safeParse(req.body);
    if (!body.success) {
      const issue = body.error.issues[0];
      invalidInput(
        res,
        issue?.message ?? "Invalid watchlist entry",
        issue?.path?.[0]?.toString(),
      );
      return;
    }

    const guardId = (req as AuthenticatedRequest).guardId;
    const result = await createWatchlistEntry(body.data, guardId, getDb(req));

    const payload: WatchlistEntryResponse = {
      entry: result.entry,
      traceId: result.traceId,
    };
    res.status(201).json(payload);
  } catch (err) {
    next(err);
  }
}

// ─── GET /api/watchlist ──────────────────────────────────────────────────────

export async function handleListWatchlistEntries(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = ListWatchlistQuerySchema.safeParse(req.query ?? {});
    if (!query.success) {
      const issue = query.error.issues[0];
      invalidInput(
        res,
        issue?.message ?? "Invalid query",
        issue?.path?.[0]?.toString(),
      );
      return;
    }

    const result = await listWatchlistEntries(query.data, getDb(req));

    const payload: ListWatchlistResponse = {
      entries: result.entries,
      count: result.entries.length,
      overdueCount: result.overdueCount,
      traceId: result.traceId,
    };
    res.status(200).json(payload);
  } catch (err) {
    next(err);
  }
}

// ─── PATCH /api/watchlist/:id ────────────────────────────────────────────────

export async function handleReviewWatchlistEntry(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const params = WatchlistParamsSchema.safeParse(req.params);
    if (!params.success) {
      invalidInput(res, params.error.issues[0]?.message ?? "Invalid id", "id");
      return;
    }

    const body = ReviewWatchlistEntrySchema.safeParse(req.body ?? {});
    if (!body.success) {
      const issue = body.error.issues[0];
      invalidInput(
        res,
        issue?.message ?? "Invalid review",
        issue?.path?.[0]?.toString(),
      );
      return;
    }

    const guardId = (req as AuthenticatedRequest).guardId;
    const result = await reviewWatchlistEntry(
      params.data.id,
      body.data,
      guardId,
      getDb(req),
    );

    const payload: WatchlistEntryResponse = {
      entry: result.entry,
      traceId: result.traceId,
    };
    res.status(200).json(payload);
  } catch (err) {
    next(err);
  }
}

// ─── DELETE /api/watchlist/:id ───────────────────────────────────────────────

export async function handleRemoveWatchlistEntry(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const params = WatchlistParamsSchema.safeParse(req.params);
    if (!params.success) {
      invalidInput(res, params.error.issues[0]?.message ?? "Invalid id", "id");
      return;
    }

    const body = RemoveWatchlistEntrySchema.safeParse(req.body ?? {});
    if (!body.success) {
      const issue = body.error.issues[0];
      invalidInput(
        res,
        issue?.message ?? "A removal reason is required",
        issue?.path?.[0]?.toString() ?? "removedReason",
      );
      return;
    }

    const guardId = (req as AuthenticatedRequest).guardId;
    const result = await removeWatchlistEntry(
      params.data.id,
      body.data,
      guardId,
      getDb(req),
    );

    const payload: WatchlistEntryResponse = {
      entry: result.entry,
      traceId: result.traceId,
    };
    res.status(200).json(payload);
  } catch (err) {
    next(err);
  }
}

// ─── Router ──────────────────────────────────────────────────────────────────

export const watchlistRouter = Router();

watchlistRouter.post("/", handleCreateWatchlistEntry);
watchlistRouter.get("/", handleListWatchlistEntries);
watchlistRouter.patch("/:id", handleReviewWatchlistEntry);
watchlistRouter.delete("/:id", handleRemoveWatchlistEntry);
