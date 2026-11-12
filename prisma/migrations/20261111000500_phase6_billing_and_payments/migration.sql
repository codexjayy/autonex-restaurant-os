-- Phase 6: Final Billing, Payments, Allocations, Refunds & Webhooks

CREATE TYPE "TaxMode" AS ENUM ('EXCLUSIVE', 'INCLUSIVE', 'NONE');
CREATE TYPE "BillStatus" AS ENUM ('OPEN', 'PARTIALLY_PAID', 'PAID', 'VOID');
CREATE TYPE "BillLineType" AS ENUM ('ITEM', 'DISCOUNT', 'CGST', 'SGST', 'ROUND_OFF');
CREATE TYPE "PaymentMethod" AS ENUM ('UPI_GATEWAY', 'UPI_MANUAL', 'CASH', 'CARD');
CREATE TYPE "PaymentProvider" AS ENUM ('RAZORPAY', 'MANUAL');
CREATE TYPE "PaymentStatus" AS ENUM ('INITIATED', 'PENDING', 'SUCCEEDED', 'FAILED');
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

ALTER TABLE "outlets"
  ADD COLUMN "tax_mode" "TaxMode" NOT NULL DEFAULT 'EXCLUSIVE',
  ADD COLUMN "round_off_enabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "bills" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "outlet_id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "bill_number" VARCHAR(40) NOT NULL,
  "status" "BillStatus" NOT NULL DEFAULT 'OPEN',
  "subtotal_paise" INTEGER NOT NULL CHECK ("subtotal_paise" >= 0),
  "discount_paise" INTEGER NOT NULL DEFAULT 0 CHECK ("discount_paise" >= 0),
  "discount_reason" VARCHAR(200),
  "tax_mode" "TaxMode" NOT NULL DEFAULT 'EXCLUSIVE',
  "gst_rate_bps" INTEGER NOT NULL DEFAULT 500,
  "cgst_paise" INTEGER NOT NULL CHECK ("cgst_paise" >= 0),
  "sgst_paise" INTEGER NOT NULL CHECK ("sgst_paise" >= 0),
  "round_off_paise" INTEGER NOT NULL DEFAULT 0,
  "total_paise" INTEGER NOT NULL CHECK ("total_paise" >= 0),
  "paid_paise" INTEGER NOT NULL DEFAULT 0 CHECK ("paid_paise" >= 0),
  "refunded_paise" INTEGER NOT NULL DEFAULT 0 CHECK ("refunded_paise" >= 0),
  "gstin_snapshot" VARCHAR(20),
  "outlet_name_snapshot" VARCHAR(120) NOT NULL,
  "outlet_address_snapshot" VARCHAR(300),
  "bill_snapshot_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "void_reason" VARCHAR(200),
  "voided_by_membership_id" UUID,
  "voided_at" TIMESTAMPTZ,
  "finalized_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "paid_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "bills_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bills_tenant_id_outlet_id_bill_number_key" UNIQUE ("tenant_id", "outlet_id", "bill_number"),
  CONSTRAINT "bills_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "bills_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE CASCADE,
  CONSTRAINT "bills_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "dining_sessions"("id") ON DELETE RESTRICT,
  CONSTRAINT "bills_voided_by_membership_id_fkey" FOREIGN KEY ("voided_by_membership_id") REFERENCES "memberships"("id") ON DELETE SET NULL
);

CREATE INDEX "bills_tenant_id_outlet_id_status_created_at_idx" ON "bills"("tenant_id", "outlet_id", "status", "created_at" DESC);
CREATE INDEX "bills_tenant_id_session_id_idx" ON "bills"("tenant_id", "session_id");
CREATE UNIQUE INDEX "uq_active_bill_per_session" ON "bills"("tenant_id", "session_id") WHERE "status" <> 'VOID';

CREATE TABLE "bill_lines" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "bill_id" UUID NOT NULL,
  "order_item_id" UUID,
  "line_type" "BillLineType" NOT NULL,
  "description" VARCHAR(160) NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "unit_amount_paise" INTEGER NOT NULL,
  "line_amount_paise" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "bill_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bill_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "bill_lines_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE CASCADE,
  CONSTRAINT "bill_lines_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT
);

CREATE INDEX "bill_lines_tenant_id_bill_id_idx" ON "bill_lines"("tenant_id", "bill_id");

CREATE TABLE "payment_attempts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "outlet_id" UUID NOT NULL,
  "bill_id" UUID NOT NULL,
  "method" "PaymentMethod" NOT NULL,
  "provider" "PaymentProvider" NOT NULL,
  "amount_paise" INTEGER NOT NULL CHECK ("amount_paise" > 0),
  "status" "PaymentStatus" NOT NULL DEFAULT 'INITIATED',
  "idempotency_key" VARCHAR(120) NOT NULL,
  "gateway_order_id" VARCHAR(100),
  "gateway_payment_id" VARCHAR(100),
  "qr_payload_url" TEXT,
  "receipt_ref" VARCHAR(120),
  "confirmed_by_membership_id" UUID,
  "failure_reason" VARCHAR(250),
  "reconcile_attempts" INTEGER NOT NULL DEFAULT 0,
  "last_reconciled_at" TIMESTAMPTZ,
  "completed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_attempts_gateway_payment_id_key" UNIQUE ("gateway_payment_id"),
  CONSTRAINT "payment_attempts_tenant_id_idempotency_key_key" UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "payment_attempts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "payment_attempts_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE CASCADE,
  CONSTRAINT "payment_attempts_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE RESTRICT,
  CONSTRAINT "payment_attempts_confirmed_by_membership_id_fkey" FOREIGN KEY ("confirmed_by_membership_id") REFERENCES "memberships"("id") ON DELETE SET NULL
);

CREATE INDEX "payment_attempts_tenant_id_bill_id_created_at_idx" ON "payment_attempts"("tenant_id", "bill_id", "created_at");
CREATE INDEX "payment_attempts_status_created_at_idx" ON "payment_attempts"("status", "created_at");
CREATE INDEX "payment_attempts_gateway_order_id_idx" ON "payment_attempts"("gateway_order_id");
CREATE INDEX "idx_payment_attempts_pending" ON "payment_attempts"("created_at") WHERE "status" IN ('INITIATED', 'PENDING');

CREATE TABLE "payment_allocations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "payment_attempt_id" UUID NOT NULL,
  "bill_id" UUID NOT NULL,
  "allocated_paise" INTEGER NOT NULL CHECK ("allocated_paise" > 0),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_allocations_payment_attempt_id_bill_id_key" UNIQUE ("payment_attempt_id", "bill_id"),
  CONSTRAINT "payment_allocations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "payment_allocations_payment_attempt_id_fkey" FOREIGN KEY ("payment_attempt_id") REFERENCES "payment_attempts"("id") ON DELETE RESTRICT,
  CONSTRAINT "payment_allocations_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE RESTRICT
);

CREATE INDEX "payment_allocations_tenant_id_bill_id_idx" ON "payment_allocations"("tenant_id", "bill_id");

CREATE TABLE "refunds" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "payment_attempt_id" UUID NOT NULL,
  "bill_id" UUID NOT NULL,
  "amount_paise" INTEGER NOT NULL CHECK ("amount_paise" > 0),
  "reason" VARCHAR(200) NOT NULL,
  "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
  "gateway_refund_id" VARCHAR(100),
  "initiated_by_membership_id" UUID,
  "processed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "refunds_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "refunds_gateway_refund_id_key" UNIQUE ("gateway_refund_id"),
  CONSTRAINT "refunds_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "refunds_payment_attempt_id_fkey" FOREIGN KEY ("payment_attempt_id") REFERENCES "payment_attempts"("id") ON DELETE RESTRICT,
  CONSTRAINT "refunds_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE RESTRICT,
  CONSTRAINT "refunds_initiated_by_membership_id_fkey" FOREIGN KEY ("initiated_by_membership_id") REFERENCES "memberships"("id") ON DELETE SET NULL
);

CREATE INDEX "refunds_tenant_id_bill_id_created_at_idx" ON "refunds"("tenant_id", "bill_id", "created_at");

CREATE TABLE "webhook_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID,
  "provider" VARCHAR(30) NOT NULL,
  "provider_event_id" VARCHAR(120) NOT NULL,
  "event_type" VARCHAR(60) NOT NULL,
  "payload_json" JSONB NOT NULL,
  "signature_valid" BOOLEAN NOT NULL,
  "status" "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
  "error_message" VARCHAR(300),
  "processed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webhook_events_provider_provider_event_id_key" UNIQUE ("provider", "provider_event_id"),
  CONSTRAINT "webhook_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL
);

CREATE INDEX "webhook_events_tenant_id_created_at_idx" ON "webhook_events"("tenant_id", "created_at");

