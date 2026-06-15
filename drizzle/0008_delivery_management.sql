-- Feature 8 — Delivery Management
-- Source: src/docs/specs/delivery-management.md §3
--
-- Adds entry_kind enum, delivery_category enum, and two new columns
-- to entry_records. All existing rows default to entry_kind='visitor'
-- with delivery_category=NULL — no backfill needed.
--
-- Also extends audit_event_type with delivery-specific events.

-- ─── Step 1: Create the entry_kind enum ──────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'entry_kind') THEN
    CREATE TYPE entry_kind AS ENUM ('visitor', 'delivery');
  END IF;
END $$;

-- ─── Step 2: Create the delivery_category enum ──────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'delivery_category') THEN
    CREATE TYPE delivery_category AS ENUM (
      'parcel',
      'food',
      'ride',
      'gas',
      'water',
      'moving',
      'maintenance',
      'other'
    );
  END IF;
END $$;

-- ─── Step 3: Add columns to entry_records ───────────────────────────────────
ALTER TABLE entry_records
  ADD COLUMN IF NOT EXISTS entry_kind entry_kind NOT NULL DEFAULT 'visitor';

ALTER TABLE entry_records
  ADD COLUMN IF NOT EXISTS delivery_category delivery_category;

-- ─── Step 4: CHECK constraint — delivery ↔ category coherence ───────────────
-- delivery_category must be NOT NULL when entry_kind='delivery',
-- and must be NULL when entry_kind='visitor'.
ALTER TABLE entry_records
  DROP CONSTRAINT IF EXISTS entry_delivery_category_coherence;
ALTER TABLE entry_records
  ADD CONSTRAINT entry_delivery_category_coherence CHECK (
    (entry_kind = 'visitor'  AND delivery_category IS NULL)
    OR
    (entry_kind = 'delivery' AND delivery_category IS NOT NULL)
  );

-- ─── Step 5: Index for delivery-specific queries ────────────────────────────
CREATE INDEX IF NOT EXISTS idx_entry_records_delivery
  ON entry_records (entry_kind, delivery_category)
  WHERE entry_kind = 'delivery';

-- ─── Step 6: Extend audit_event_type enum ───────────────────────────────────
ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS 'delivery_entry_logged';
ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS 'delivery_entry_blocked';
