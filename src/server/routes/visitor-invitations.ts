/**
 * GatePass — Visitor Invitation Route Handlers (Feature 6 / Guest QR Ticket)
 *
 * Source: src/docs/specs/guest-qr-ticket.md §6 (Backend — Endpoints).
 * Source: API-and-Interface-Design — single error shape, validation
 *         at the boundary, additive responses.
 * Source: Security-and-Hardening — admin/senior role required at the
 *         middleware layer (requireRole), never trusted at the body layer.
 *
 * Two handlers (wired in app.ts):
 *
 *   POST /api/visitor-invitations
 *     requireAuth + requireRole('admin', 'senior-guard')
 *     Issues a single-use QR pass. Raw token returned exactly once.
 *
 *   GET  /api/visitor-invitations/:token/preview
 *     PUBLIC (no requireAuth). The token IN the URL is the auth.
 *     Read-only. Returns ONLY safe display fields. Does NOT mark
 *     is_used (consumption happens at scan-time via qr-service).
 */

import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

import {
  IssueInvitationSchema,
  PreviewTokenSchema,
  VisitorInvitationErrorCodes,
  type IssueInvitationResponse,
  type PreviewInvitationResponse,
} from "../validation/visitor-invitation-schemas";
import {
  issueVisitorInvitation,
  previewVisitorInvitation,
} from "../services/visitor-invitation-service";
import { ServiceError } from "../services/errors";
import type { AuthenticatedRequest } from "../middleware/auth";

// ─── 422 helper ──────────────────────────────────────────────────────────────

function send422(
  res: Response,
  message: string,
  field: string | undefined,
  traceId: string,
): void {
  res.status(422).json({
    error: {
      code: VisitorInvitationErrorCodes.INVITATION_INVALID_INPUT,
      message,
      field,
      traceId,
    },
  });
}

// ─── POST /api/visitor-invitations ───────────────────────────────────────────

export async function handleIssueVisitorInvitation(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const traceId = `trace-${randomUUID()}`;

    // Validate body at the boundary.
    const parsed = IssueInvitationSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path?.[0]?.toString();
      send422(
        res,
        issue?.message ?? "Invalid invitation input",
        field,
        traceId,
      );
      return;
    }

    const guardId = (req as AuthenticatedRequest).guardId;
    if (!guardId) {
      // Belt + braces — requireAuth runs upstream, but if this handler is
      // ever wired without it, fail closed.
      res.status(401).json({
        error: {
          code: VisitorInvitationErrorCodes.AUTH_REQUIRED,
          message: "Authentication required",
          traceId,
        },
      });
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (req as any).db;

    const { response, statusCode } = await issueVisitorInvitation(
      {
        visitorName: parsed.data.visitorName,
        host: parsed.data.host,
        unit: parsed.data.unit,
        plate: parsed.data.plate ?? null,
        ttlHours: parsed.data.ttlHours,
      },
      guardId,
      db,
    );

    // The service stamped its own traceId on the audit row; pass it
    // through to the client so the two records are correlatable.
    const body: IssueInvitationResponse = {
      invitation: response.invitation,
      traceId: response.traceId,
    };
    res.status(statusCode).json(body);
  } catch (err) {
    next(err);
  }
}

// ─── GET /api/visitor-invitations/:token/preview ─────────────────────────────

export async function handlePreviewVisitorInvitation(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const traceId = `trace-${randomUUID()}`;

    // The token comes from the URL path. We validate its shape with Zod —
    // anything that fails this check is treated as 404 INVITATION_NOT_FOUND
    // so the response shape does NOT leak "format invalid" vs. "no match"
    // (an attacker probing the endpoint should see one response shape).
    const token = req.params.token;
    const parsed = PreviewTokenSchema.safeParse(token);
    if (!parsed.success) {
      res.status(404).json({
        error: {
          code: VisitorInvitationErrorCodes.INVITATION_NOT_FOUND,
          message: "No invitation matches this pass link",
          traceId,
        },
      });
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (req as any).db;

    try {
      const { response, statusCode } = await previewVisitorInvitation(
        parsed.data,
        db,
      );
      const body: PreviewInvitationResponse = response;
      res.status(statusCode).json(body);
    } catch (err) {
      // ServiceError from the service maps to the contract error shape.
      // For preview we add the traceId at the route layer so the client
      // can correlate this preview attempt with later guard-side scans.
      if (err instanceof ServiceError) {
        res.status(err.statusCode).json({
          error: {
            code: err.code,
            message: err.message,
            ...(err.field && { field: err.field }),
            traceId,
          },
        });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
}
