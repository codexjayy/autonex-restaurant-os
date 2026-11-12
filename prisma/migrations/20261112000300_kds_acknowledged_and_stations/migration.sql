-- Add ACKNOWLEDGED to KitchenStatus and KitchenStation routing to menu_items & order_items
ALTER TYPE "KitchenStatus" ADD VALUE IF NOT EXISTS 'ACKNOWLEDGED';

DO $$ BEGIN
  CREATE TYPE "KitchenStation" AS ENUM ('MAIN_KITCHEN', 'BAR', 'BAKERY', 'DESSERTS');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "menu_items"
  ADD COLUMN IF NOT EXISTS "kitchen_station" "KitchenStation" NOT NULL DEFAULT 'MAIN_KITCHEN';

ALTER TABLE "order_items"
  ADD COLUMN IF NOT EXISTS "kitchen_station_snapshot" "KitchenStation" NOT NULL DEFAULT 'MAIN_KITCHEN';

