-- GatePass Migration: Row-Level Security on the tables from before 0014
--
-- WHY: checklist A3 requires RLS on every public table. 0014 and 0015 enable
-- it on the tables they create; these 13 previously relied on an RLS script
-- kept outside the repository, so a database built from drizzle/*.sql alone
-- left them open to the Supabase REST anon/authenticated roles.
--
-- No policies: only the server's direct connection (table owner) reads these
-- tables. ENABLE ROW LEVEL SECURITY is idempotent, so this is a no-op on a
-- database that already has RLS on (e.g. the live project).
--
-- ROLLBACK: ALTER TABLE <t> DISABLE ROW LEVEL SECURITY (do not, in production).

ALTER TABLE "approval_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "authorization_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "auto_approval_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "entry_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "exit_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "guard_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "guards" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "override_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sync_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "visitor_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "watchlist_entries" ENABLE ROW LEVEL SECURITY;
