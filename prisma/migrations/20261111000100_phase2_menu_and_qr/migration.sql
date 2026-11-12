-- CreateEnum
CREATE TYPE "DietaryType" AS ENUM ('VEG', 'NON_VEG', 'EGG');

-- CreateEnum
CREATE TYPE "SelectionType" AS ENUM ('SINGLE', 'MULTI');

-- CreateEnum
CREATE TYPE "TableStatus" AS ENUM ('AVAILABLE', 'OCCUPIED', 'BILL_REQUESTED');

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(280),
    "dietary_type" "DietaryType" NOT NULL DEFAULT 'VEG',
    "base_price_paise" INTEGER NOT NULL CHECK ("base_price_paise" >= 0),
    "image_url" TEXT,
    "in_stock" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modifier_groups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "menu_item_id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "selection_type" "SelectionType" NOT NULL DEFAULT 'SINGLE',
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "min_select" INTEGER NOT NULL DEFAULT 0,
    "max_select" INTEGER NOT NULL DEFAULT 1,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "modifier_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modifier_options" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "modifier_group_id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "price_delta_paise" INTEGER NOT NULL DEFAULT 0,
    "in_stock" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "modifier_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_tables" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "table_number" VARCHAR(20) NOT NULL,
    "label" VARCHAR(60),
    "capacity" INTEGER NOT NULL DEFAULT 4 CHECK ("capacity" > 0),
    "status" "TableStatus" NOT NULL DEFAULT 'AVAILABLE',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "table_qr_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "table_id" UUID NOT NULL,
    "token_hash" VARCHAR(128) NOT NULL,
    "token_enc" TEXT NOT NULL,
    "qr_version" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "expires_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "table_qr_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "categories_tenant_id_outlet_id_name_key" ON "categories"("tenant_id", "outlet_id", "name");
CREATE INDEX "categories_tenant_id_outlet_id_is_active_sort_order_idx" ON "categories"("tenant_id", "outlet_id", "is_active", "sort_order");
CREATE INDEX "menu_items_tenant_id_outlet_id_category_id_is_active_in_sto_idx" ON "menu_items"("tenant_id", "outlet_id", "category_id", "is_active", "in_stock", "sort_order");
CREATE INDEX "modifier_groups_tenant_id_menu_item_id_sort_order_idx" ON "modifier_groups"("tenant_id", "menu_item_id", "sort_order");
CREATE INDEX "modifier_options_tenant_id_modifier_group_id_sort_order_idx" ON "modifier_options"("tenant_id", "modifier_group_id", "sort_order");
CREATE UNIQUE INDEX "restaurant_tables_tenant_id_outlet_id_table_number_key" ON "restaurant_tables"("tenant_id", "outlet_id", "table_number");
CREATE INDEX "restaurant_tables_tenant_id_outlet_id_status_is_active_idx" ON "restaurant_tables"("tenant_id", "outlet_id", "status", "is_active");
CREATE UNIQUE INDEX "table_qr_tokens_token_hash_key" ON "table_qr_tokens"("token_hash");
CREATE INDEX "table_qr_tokens_table_id_is_active_idx" ON "table_qr_tokens"("table_id", "is_active");
CREATE INDEX "table_qr_tokens_tenant_id_outlet_id_table_id_idx" ON "table_qr_tokens"("tenant_id", "outlet_id", "table_id");
CREATE UNIQUE INDEX "uq_active_qr_per_table" ON "table_qr_tokens"("table_id") WHERE "is_active" = true AND "revoked_at" IS NULL;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "categories" ADD CONSTRAINT "categories_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_modifier_group_id_fkey" FOREIGN KEY ("modifier_group_id") REFERENCES "modifier_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_tables" ADD CONSTRAINT "restaurant_tables_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_tables" ADD CONSTRAINT "restaurant_tables_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "table_qr_tokens" ADD CONSTRAINT "table_qr_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "table_qr_tokens" ADD CONSTRAINT "table_qr_tokens_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "table_qr_tokens" ADD CONSTRAINT "table_qr_tokens_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "restaurant_tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- PostgreSQL RLS Enforcement for Phase 2 Tables
-- ============================================================================

DO $$
DECLARE
  tbl TEXT;
  phase2_tables TEXT[] := ARRAY[
    'categories',
    'menu_items',
    'modifier_groups',
    'modifier_options',
    'restaurant_tables',
    'table_qr_tokens'
  ];
BEGIN
  FOREACH tbl IN ARRAY phase2_tables LOOP
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

-- Secure QR Token Resolution Lookup (returns ONLY minimal restaurant/outlet/table metadata if active & valid)
CREATE OR REPLACE FUNCTION resolve_qr_token_hash(p_token_hash TEXT)
RETURNS TABLE (
  tenant_id UUID,
  tenant_name VARCHAR,
  tenant_status TEXT,
  outlet_id UUID,
  outlet_name VARCHAR,
  outlet_address VARCHAR,
  outlet_logo_url TEXT,
  table_id UUID,
  table_number VARCHAR,
  table_label VARCHAR,
  qr_version INT,
  require_waiter_approval BOOLEAN,
  table_pin_enabled BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    q.tenant_id,
    tn.name AS tenant_name,
    tn.status::TEXT AS tenant_status,
    q.outlet_id,
    o.name AS outlet_name,
    o.address AS outlet_address,
    o.logo_url AS outlet_logo_url,
    q.table_id,
    t.table_number,
    t.label AS table_label,
    q.qr_version,
    o.require_waiter_approval,
    o.table_pin_enabled
  FROM table_qr_tokens q
  JOIN restaurant_tables t ON t.id = q.table_id
  JOIN outlets o ON o.id = q.outlet_id
  JOIN tenants tn ON tn.id = q.tenant_id
  WHERE q.token_hash = p_token_hash
    AND q.is_active = TRUE
    AND q.revoked_at IS NULL
    AND (q.expires_at IS NULL OR q.expires_at > now())
    AND t.is_active = TRUE
    AND o.is_active = TRUE
    AND tn.status IN ('TRIAL', 'ACTIVE', 'GRACE');
$$;

REVOKE ALL ON FUNCTION resolve_qr_token_hash(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_qr_token_hash(TEXT) TO autonex_app;

