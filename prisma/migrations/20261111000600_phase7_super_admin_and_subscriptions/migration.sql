-- AutoNex Restaurant OS — Phase 7: Super Admin, Plans, Subscriptions, Support Cases & Graceful QR Resolution

CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIAL', 'ACTIVE', 'GRACE', 'EXPIRED', 'SUSPENDED');
CREATE TYPE "SubscriptionBillingCycle" AS ENUM ('MONTHLY', 'YEARLY');
CREATE TYPE "SubscriptionInvoiceStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'VOID');
CREATE TYPE "SupportCaseStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');
CREATE TYPE "SupportCasePriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE "SupportCaseCategory" AS ENUM ('ONBOARDING', 'BILLING', 'HARDWARE_QR', 'TECHNICAL', 'SUSPENSION_APPEAL');

ALTER TABLE "tenants"
  ADD COLUMN "pending_suspension_after_service" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "suspended_at" TIMESTAMPTZ,
  ADD COLUMN "offboarded_at" TIMESTAMPTZ;

CREATE TABLE "plans" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "code" VARCHAR(40) NOT NULL,
  "name" VARCHAR(80) NOT NULL,
  "description" VARCHAR(300),
  "monthly_price_paise" INTEGER NOT NULL,
  "yearly_price_paise" INTEGER NOT NULL,
  "max_outlets" INTEGER NOT NULL DEFAULT 1,
  "max_tables" INTEGER NOT NULL DEFAULT 30,
  "max_staff" INTEGER NOT NULL DEFAULT 15,
  "trial_days" INTEGER NOT NULL DEFAULT 14,
  "grace_days" INTEGER NOT NULL DEFAULT 3,
  "features_json" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");
CREATE INDEX "plans_is_active_sort_order_idx" ON "plans"("is_active", "sort_order");

CREATE TABLE "subscriptions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "plan_id" UUID NOT NULL,
  "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIAL',
  "billing_cycle" "SubscriptionBillingCycle" NOT NULL DEFAULT 'MONTHLY',
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "trial_ends_at" TIMESTAMPTZ,
  "current_period_start" TIMESTAMPTZ,
  "current_period_end" TIMESTAMPTZ,
  "grace_ends_at" TIMESTAMPTZ,
  "suspended_at" TIMESTAMPTZ,
  "cancelled_at" TIMESTAMPTZ,
  "auto_renew" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "subscriptions_tenant_id_key" ON "subscriptions"("tenant_id");
CREATE INDEX "subscriptions_status_trial_ends_at_idx" ON "subscriptions"("status", "trial_ends_at");
CREATE INDEX "subscriptions_status_current_period_end_idx" ON "subscriptions"("status", "current_period_end");
CREATE INDEX "subscriptions_status_grace_ends_at_idx" ON "subscriptions"("status", "grace_ends_at");

CREATE TABLE "subscription_invoices" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "subscription_id" UUID NOT NULL,
  "plan_id" UUID NOT NULL,
  "invoice_number" VARCHAR(40) NOT NULL,
  "billing_cycle" "SubscriptionBillingCycle" NOT NULL,
  "amount_paise" INTEGER NOT NULL,
  "tax_paise" INTEGER NOT NULL DEFAULT 0,
  "total_paise" INTEGER NOT NULL,
  "status" "SubscriptionInvoiceStatus" NOT NULL DEFAULT 'PENDING',
  "period_start" TIMESTAMPTZ NOT NULL,
  "period_end" TIMESTAMPTZ NOT NULL,
  "paid_at" TIMESTAMPTZ,
  "payment_ref" VARCHAR(120),
  "notes" VARCHAR(250),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "subscription_invoices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_invoices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "subscription_invoices_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE,
  CONSTRAINT "subscription_invoices_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "subscription_invoices_invoice_number_key" ON "subscription_invoices"("invoice_number");
CREATE INDEX "subscription_invoices_tenant_id_created_at_idx" ON "subscription_invoices"("tenant_id", "created_at" DESC);

CREATE TABLE "support_cases" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "case_number" VARCHAR(30) NOT NULL,
  "tenant_id" UUID NOT NULL,
  "outlet_id" UUID,
  "created_by_user_id" UUID NOT NULL,
  "assigned_to_user_id" UUID,
  "category" "SupportCaseCategory" NOT NULL DEFAULT 'TECHNICAL',
  "priority" "SupportCasePriority" NOT NULL DEFAULT 'MEDIUM',
  "status" "SupportCaseStatus" NOT NULL DEFAULT 'OPEN',
  "subject" VARCHAR(160) NOT NULL,
  "description" TEXT NOT NULL,
  "resolution_notes" VARCHAR(500),
  "resolved_at" TIMESTAMPTZ,
  "closed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "support_cases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_cases_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "support_cases_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE SET NULL,
  CONSTRAINT "support_cases_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "support_cases_assigned_to_user_id_fkey" FOREIGN KEY ("assigned_to_user_id") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX "support_cases_case_number_key" ON "support_cases"("case_number");
CREATE INDEX "support_cases_status_priority_created_at_idx" ON "support_cases"("status", "priority", "created_at" DESC);
CREATE INDEX "support_cases_tenant_id_created_at_idx" ON "support_cases"("tenant_id", "created_at" DESC);

CREATE TABLE "support_case_notes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "support_case_id" UUID NOT NULL,
  "author_user_id" UUID NOT NULL,
  "author_role" VARCHAR(20) NOT NULL,
  "body" TEXT NOT NULL,
  "is_internal" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "support_case_notes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_case_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "support_case_notes_support_case_id_fkey" FOREIGN KEY ("support_case_id") REFERENCES "support_cases"("id") ON DELETE CASCADE,
  CONSTRAINT "support_case_notes_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE RESTRICT
);

CREATE INDEX "support_case_notes_tenant_id_support_case_id_created_at_idx"
  ON "support_case_notes"("tenant_id", "support_case_id", "created_at");

-- Allow QR resolution for LOCKED/SUSPENDED outlets so already-seated diners mid-meal can still view bills & pay online,
-- while app layer rejects new joins / new order placements cleanly.
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
    AND tn.status IN ('TRIAL', 'ACTIVE', 'GRACE', 'LOCKED', 'SUSPENDED');
$$;

REVOKE ALL ON FUNCTION resolve_qr_token_hash(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_qr_token_hash(TEXT) TO autonex_app;

-- Enable strict tenant RLS on new tenant-owned subscription & support tables
DO $$
DECLARE
  tbl TEXT;
  phase7_tables TEXT[] := ARRAY[
    'subscriptions',
    'subscription_invoices',
    'support_cases',
    'support_case_notes'
  ];
BEGIN
  FOREACH tbl IN ARRAY phase7_tables LOOP
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

