-- AutoNex Restaurant OS — Phase 5: Dining Session Lifecycle (SETTLED state & audit timestamps)

ALTER TYPE "DiningSessionStatus" ADD VALUE IF NOT EXISTS 'SETTLED' BEFORE 'CLOSED';

ALTER TABLE "dining_sessions"
  ADD COLUMN "settled_by_membership_id" UUID,
  ADD COLUMN "closed_by_membership_id" UUID,
  ADD COLUMN "settled_at" TIMESTAMPTZ;

ALTER TABLE "dining_sessions"
  ADD CONSTRAINT "dining_sessions_settled_by_membership_id_fkey"
  FOREIGN KEY ("settled_by_membership_id") REFERENCES "memberships"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "dining_sessions"
  ADD CONSTRAINT "dining_sessions_closed_by_membership_id_fkey"
  FOREIGN KEY ("closed_by_membership_id") REFERENCES "memberships"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

