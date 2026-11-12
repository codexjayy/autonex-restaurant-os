-- Super Admin rejected tenant status + rejection metadata (safe additive migration)
ALTER TYPE "TenantStatus" ADD VALUE IF NOT EXISTS 'REJECTED';

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "rejected_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "rejected_by_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "rejection_reason" VARCHAR(300);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tenants_rejected_by_user_id_fkey'
  ) THEN
    ALTER TABLE "tenants"
      ADD CONSTRAINT "tenants_rejected_by_user_id_fkey"
      FOREIGN KEY ("rejected_by_user_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

