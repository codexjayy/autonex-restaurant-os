-- CreateEnum
CREATE TYPE "DiningSessionStatus" AS ENUM ('ACTIVE', 'BILL_REQUESTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "GuestJoinStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REVOKED');

-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('CUSTOMER_QR', 'STAFF_POS');

-- CreateEnum
CREATE TYPE "KitchenStatus" AS ENUM ('NEW', 'PREPARING', 'READY', 'SERVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderItemStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED');

-- AlterTable
ALTER TABLE "outlets" ADD COLUMN "kot_seq" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "dining_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "table_id" UUID NOT NULL,
    "status" "DiningSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "join_code" VARCHAR(6),
    "join_code_expires_at" TIMESTAMPTZ,
    "opened_by_membership_id" UUID,
    "opened_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bill_requested_at" TIMESTAMPTZ,
    "closed_at" TIMESTAMPTZ,

    CONSTRAINT "dining_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_guests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "guest_token_hash" VARCHAR(128) NOT NULL,
    "display_label" VARCHAR(40),
    "status" "GuestJoinStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "approved_by_membership_id" UUID,
    "joined_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_at" TIMESTAMPTZ,
    "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_guests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "guest_id" UUID,
    "placed_by_membership_id" UUID,
    "round_number" INTEGER NOT NULL DEFAULT 1,
    "kot_number" INTEGER NOT NULL,
    "is_add_on" BOOLEAN NOT NULL DEFAULT false,
    "source" "OrderSource" NOT NULL,
    "kitchen_status" "KitchenStatus" NOT NULL DEFAULT 'NEW',
    "idempotency_key" VARCHAR(120) NOT NULL,
    "subtotal_paise" INTEGER NOT NULL CHECK ("subtotal_paise" >= 0),
    "notes" VARCHAR(250),
    "accepted_at" TIMESTAMPTZ,
    "ready_at" TIMESTAMPTZ,
    "served_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "menu_item_id" UUID NOT NULL,
    "item_name_snapshot" VARCHAR(120) NOT NULL,
    "dietary_type_snapshot" "DietaryType" NOT NULL,
    "base_price_paise_snapshot" INTEGER NOT NULL CHECK ("base_price_paise_snapshot" >= 0),
    "modifiers_snapshot_json" JSONB NOT NULL DEFAULT '[]',
    "unit_price_paise" INTEGER NOT NULL CHECK ("unit_price_paise" >= 0),
    "quantity" INTEGER NOT NULL CHECK ("quantity" > 0),
    "line_total_paise" INTEGER NOT NULL CHECK ("line_total_paise" >= 0),
    "prep_notes" VARCHAR(200),
    "status" "OrderItemStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "event_type" VARCHAR(40) NOT NULL,
    "from_status" VARCHAR(20),
    "to_status" VARCHAR(20),
    "actor_type" VARCHAR(20) NOT NULL,
    "actor_id" UUID,
    "metadata_json" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "topic" VARCHAR(80) NOT NULL,
    "aggregate_type" VARCHAR(40) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "payload_json" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(500),
    "available_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dining_sessions_tenant_id_outlet_id_table_id_status_idx" ON "dining_sessions"("tenant_id", "outlet_id", "table_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_active_session_per_table" ON "dining_sessions"("tenant_id", "table_id") WHERE "status" <> 'CLOSED';

-- CreateIndex
CREATE UNIQUE INDEX "session_guests_guest_token_hash_key" ON "session_guests"("guest_token_hash");

-- CreateIndex
CREATE INDEX "session_guests_tenant_id_session_id_status_idx" ON "session_guests"("tenant_id", "session_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "orders_tenant_id_idempotency_key_key" ON "orders"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "orders_tenant_id_outlet_id_session_id_created_at_idx" ON "orders"("tenant_id", "outlet_id", "session_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_tenant_id_outlet_id_kitchen_status_created_at_idx" ON "orders"("tenant_id", "outlet_id", "kitchen_status", "created_at");

-- CreateIndex
CREATE INDEX "orders_tenant_id_outlet_id_updated_at_idx" ON "orders"("tenant_id", "outlet_id", "updated_at");

-- CreateIndex
CREATE INDEX "idx_orders_kds_active" ON "orders"("tenant_id", "outlet_id", "kitchen_status", "created_at") WHERE "kitchen_status" IN ('NEW', 'PREPARING', 'READY');

-- CreateIndex
CREATE INDEX "order_items_tenant_id_order_id_idx" ON "order_items"("tenant_id", "order_id");

-- CreateIndex
CREATE INDEX "order_events_tenant_id_order_id_created_at_idx" ON "order_events"("tenant_id", "order_id", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_status_available_at_created_at_idx" ON "outbox_events"("status", "available_at", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_tenant_id_created_at_idx" ON "outbox_events"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_outbox_pending" ON "outbox_events"("available_at", "created_at") WHERE "status" = 'PENDING';

-- AddForeignKey
ALTER TABLE "dining_sessions" ADD CONSTRAINT "dining_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dining_sessions" ADD CONSTRAINT "dining_sessions_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dining_sessions" ADD CONSTRAINT "dining_sessions_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "restaurant_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dining_sessions" ADD CONSTRAINT "dining_sessions_opened_by_membership_id_fkey" FOREIGN KEY ("opened_by_membership_id") REFERENCES "memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "session_guests" ADD CONSTRAINT "session_guests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "session_guests" ADD CONSTRAINT "session_guests_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "dining_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "session_guests" ADD CONSTRAINT "session_guests_approved_by_membership_id_fkey" FOREIGN KEY ("approved_by_membership_id") REFERENCES "memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "dining_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_guest_id_fkey" FOREIGN KEY ("guest_id") REFERENCES "session_guests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_placed_by_membership_id_fkey" FOREIGN KEY ("placed_by_membership_id") REFERENCES "memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "order_events" ADD CONSTRAINT "order_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Enforce PostgreSQL Row-Level Security (RLS) on all Phase 3 tables
DO $$
DECLARE
  tbl TEXT;
  phase3_tables TEXT[] := ARRAY[
    'dining_sessions',
    'session_guests',
    'orders',
    'order_items',
    'order_events',
    'outbox_events'
  ];
BEGIN
  FOREACH tbl IN ARRAY phase3_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I;', tbl, tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_%I ON %I
         FOR ALL TO autonex_app
         USING (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid);',
      tbl, tbl
    );
  END LOOP;
END
$$;

