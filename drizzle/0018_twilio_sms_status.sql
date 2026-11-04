-- GatePass Migration: Twilio SMS provider + delivery-status webhook
--
-- WHY (src/docs/specs/twilio-provider.md §3, option B / D1):
--   A Twilio 201 only means Twilio accepted the message. The row moves to the
--   new status 'sent' and waits for Twilio's status callback, which moves it
--   to 'delivered' or 'failed'. Callbacks are matched by the message SID, now
--   stored on the row, and every verified callback is stored first in
--   notification_callbacks so one that arrives before the SID is saved is
--   applied later, never lost.
--
-- ADD VALUE IF NOT EXISTS and IF NOT EXISTS make this idempotent.
--
-- ROLLBACK: DROP TABLE notification_callbacks; DROP INDEX
--   notifications_provider_message_id_unique; ALTER TABLE notifications DROP
--   COLUMN provider_message_id. The enum values are harmless if left unused.

ALTER TYPE "public"."notification_status" ADD VALUE IF NOT EXISTS 'sent';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'notification_delivered';--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "provider_message_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_provider_message_id_unique" ON "notifications" USING btree ("provider_message_id") WHERE "provider_message_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_callbacks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_sid" text NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"received_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_callbacks_sid_not_empty" CHECK (length(trim("message_sid")) > 0),
	CONSTRAINT "notification_callbacks_status_known" CHECK ("status" IN ('delivered','read','failed','undelivered'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_callbacks_sid_status_unique" ON "notification_callbacks" USING btree ("message_sid","status");--> statement-breakpoint
ALTER TABLE "notification_callbacks" ENABLE ROW LEVEL SECURITY;
