CREATE TYPE "public"."entry_method" AS ENUM('qr', 'walk-in', 'override', 'recognized');--> statement-breakpoint
CREATE TYPE "public"."entry_status" AS ENUM('draft', 'pending', 'approved', 'denied', 'logged', 'sync-pending', 'failed');--> statement-breakpoint
CREATE TYPE "public"."recognition_tag" AS ENUM('pre-approved', 'frequent', 'watch');--> statement-breakpoint
CREATE TYPE "public"."sync_result_status" AS ENUM('synced', 'duplicate', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."sync_state" AS ENUM('synced', 'queued', 'failed');--> statement-breakpoint
CREATE TABLE "authorization_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visitor_name" text NOT NULL,
	"host" text NOT NULL,
	"unit" text NOT NULL,
	"plate" text,
	"qr_token_hash" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"is_used" boolean DEFAULT false NOT NULL,
	"used_at" timestamp (3) with time zone,
	"used_by_guard_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authorization_decisions_qr_token_hash_unique" UNIQUE("qr_token_hash"),
	CONSTRAINT "authorization_visitor_name_not_empty" CHECK (length(trim("authorization_decisions"."visitor_name")) > 0),
	CONSTRAINT "authorization_host_not_empty" CHECK (length(trim("authorization_decisions"."host")) > 0),
	CONSTRAINT "authorization_unit_not_empty" CHECK (length(trim("authorization_decisions"."unit")) > 0)
);
--> statement-breakpoint
CREATE TABLE "entry_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visitor_name" text NOT NULL,
	"host" text NOT NULL,
	"unit" text NOT NULL,
	"plate" text,
	"reason" text DEFAULT '' NOT NULL,
	"method" "entry_method" NOT NULL,
	"guard_id" uuid NOT NULL,
	"status" "entry_status" DEFAULT 'logged' NOT NULL,
	"sync_state" "sync_state" DEFAULT 'synced' NOT NULL,
	"offline_id" uuid,
	"pre_approval_id" uuid,
	"device_created_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"trace_id" text NOT NULL,
	CONSTRAINT "entry_records_offline_id_unique" UNIQUE("offline_id"),
	CONSTRAINT "entry_override_reason_length" CHECK ("entry_records"."method" != 'override' OR length(trim("entry_records"."reason")) >= 8),
	CONSTRAINT "entry_plate_max_length" CHECK ("entry_records"."plate" IS NULL OR length("entry_records"."plate") <= 20),
	CONSTRAINT "entry_visitor_name_not_empty" CHECK (length(trim("entry_records"."visitor_name")) > 0),
	CONSTRAINT "entry_host_not_empty" CHECK (length(trim("entry_records"."host")) > 0),
	CONSTRAINT "entry_unit_not_empty" CHECK (length(trim("entry_records"."unit")) > 0)
);
--> statement-breakpoint
CREATE TABLE "guards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"badge_number" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guards_badge_number_unique" UNIQUE("badge_number")
);
--> statement-breakpoint
CREATE TABLE "override_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"guard_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"trace_id" text NOT NULL,
	CONSTRAINT "override_events_entry_id_unique" UNIQUE("entry_id"),
	CONSTRAINT "override_reason_length" CHECK (length(trim("override_events"."reason")) >= 8)
);
--> statement-breakpoint
CREATE TABLE "sync_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guard_id" uuid NOT NULL,
	"offline_id" uuid NOT NULL,
	"entry_id" uuid,
	"status" "sync_result_status" NOT NULL,
	"error_code" text,
	"error_message" text,
	"original_created_at" timestamp (3) with time zone NOT NULL,
	"synced_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"trace_id" text NOT NULL,
	CONSTRAINT "sync_synced_requires_entry" CHECK ("sync_events"."status" != 'synced' OR "sync_events"."entry_id" IS NOT NULL),
	CONSTRAINT "sync_rejected_requires_error" CHECK ("sync_events"."status" != 'rejected' OR "sync_events"."error_code" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "authorization_decisions" ADD CONSTRAINT "authorization_decisions_used_by_guard_id_guards_id_fk" FOREIGN KEY ("used_by_guard_id") REFERENCES "public"."guards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_records" ADD CONSTRAINT "entry_records_guard_id_guards_id_fk" FOREIGN KEY ("guard_id") REFERENCES "public"."guards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_records" ADD CONSTRAINT "entry_records_pre_approval_id_authorization_decisions_id_fk" FOREIGN KEY ("pre_approval_id") REFERENCES "public"."authorization_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "override_events" ADD CONSTRAINT "override_events_entry_id_entry_records_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entry_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "override_events" ADD CONSTRAINT "override_events_guard_id_guards_id_fk" FOREIGN KEY ("guard_id") REFERENCES "public"."guards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_events" ADD CONSTRAINT "sync_events_guard_id_guards_id_fk" FOREIGN KEY ("guard_id") REFERENCES "public"."guards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_events" ADD CONSTRAINT "sync_events_entry_id_entry_records_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entry_records"("id") ON DELETE no action ON UPDATE no action;