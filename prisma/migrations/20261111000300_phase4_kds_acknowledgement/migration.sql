-- AutoNex Restaurant OS — Phase 4: KDS Acknowledgement Tracking & Unacknowledged Index

ALTER TABLE "orders"
  ADD COLUMN "acknowledged_at" TIMESTAMPTZ,
  ADD COLUMN "acknowledged_by_membership_id" UUID;

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_acknowledged_by_membership_id_fkey"
  FOREIGN KEY ("acknowledged_by_membership_id") REFERENCES "memberships"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "orders_tenant_id_outlet_id_acknowledged_at_idx"
  ON "orders"("tenant_id", "outlet_id", "acknowledged_at");

CREATE INDEX "idx_orders_kds_unacked"
  ON "orders"("tenant_id", "outlet_id", "created_at")
  WHERE "kitchen_status" = 'NEW' AND "acknowledged_at" IS NULL;

