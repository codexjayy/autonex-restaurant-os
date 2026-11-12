-- Add RESERVED status and floor_section column to restaurant_tables
ALTER TYPE "TableStatus" ADD VALUE IF NOT EXISTS 'RESERVED';

ALTER TABLE "restaurant_tables"
  ADD COLUMN IF NOT EXISTS "floor_section" VARCHAR(60);

