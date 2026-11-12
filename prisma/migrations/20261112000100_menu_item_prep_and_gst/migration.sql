-- AlterTable: Add optional per-item preparation time and GST configuration overrides to menu_items
ALTER TABLE "menu_items"
  ADD COLUMN IF NOT EXISTS "prep_time_minutes" INTEGER,
  ADD COLUMN IF NOT EXISTS "gst_rate_bps" INTEGER,
  ADD COLUMN IF NOT EXISTS "tax_mode" "TaxMode";

