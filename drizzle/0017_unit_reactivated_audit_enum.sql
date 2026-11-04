-- GatePass Migration: audit event type for unit reactivation
--
-- WHY: an admin can now reactivate a deactivated unit
-- (POST /api/admin/units/:id/reactivate). Reactivation restores only the
-- unit; its former residents, passes and rules stay off, and any unused
-- claim code issued before the deactivation is voided.
--
-- ADD VALUE IF NOT EXISTS is idempotent.
--
-- ROLLBACK: none needed; an unused enum value is harmless.

ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'unit_reactivated';
