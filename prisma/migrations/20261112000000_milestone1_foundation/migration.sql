-- AutoNex Restaurant OS — Milestone 1 Foundation Normalization
-- Adds soft-delete timestamps, tenant_settings, outlet_settings, roles, permissions, role_permissions, invitations, sessions, and PostgreSQL RLS policies.

CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

ALTER TABLE "tenants" ADD COLUMN "deleted_at" TIMESTAMPTZ;
ALTER TABLE "outlets" ADD COLUMN "deleted_at" TIMESTAMPTZ;
ALTER TABLE "users" ADD COLUMN "deleted_at" TIMESTAMPTZ;
ALTER TABLE "memberships"
  ADD COLUMN "role_id" UUID,
  ADD COLUMN "deleted_at" TIMESTAMPTZ;

CREATE TABLE "tenant_settings" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "currency" VARCHAR(10) NOT NULL DEFAULT 'INR',
  "locale" VARCHAR(20) NOT NULL DEFAULT 'en-IN',
  "default_timezone" VARCHAR(60) NOT NULL DEFAULT 'Asia/Kolkata',
  "onboarding_completed" BOOLEAN NOT NULL DEFAULT false,
  "onboarding_step" INTEGER NOT NULL DEFAULT 1,
  "metadata_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tenant_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "tenant_settings_tenant_id_key" ON "tenant_settings"("tenant_id");

CREATE TABLE "outlet_settings" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "outlet_id" UUID NOT NULL,
  "tax_mode" "TaxMode" NOT NULL DEFAULT 'EXCLUSIVE',
  "gst_rate_bps" INTEGER NOT NULL DEFAULT 500,
  "round_off_enabled" BOOLEAN NOT NULL DEFAULT false,
  "require_waiter_approval" BOOLEAN NOT NULL DEFAULT false,
  "table_pin_enabled" BOOLEAN NOT NULL DEFAULT false,
  "kds_language" VARCHAR(10) NOT NULL DEFAULT 'en',
  "receipt_footer" VARCHAR(240),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "outlet_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outlet_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "outlet_settings_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "outlet_settings_outlet_id_key" ON "outlet_settings"("outlet_id");
CREATE INDEX "outlet_settings_tenant_id_outlet_id_idx" ON "outlet_settings"("tenant_id", "outlet_id");

CREATE TABLE "roles" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID,
  "code" VARCHAR(40) NOT NULL,
  "name" VARCHAR(80) NOT NULL,
  "description" VARCHAR(240),
  "is_system" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "roles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "roles_tenant_id_code_key" ON "roles"("tenant_id", "code");
CREATE UNIQUE INDEX "uq_system_role_code" ON "roles"("code") WHERE "tenant_id" IS NULL;
CREATE INDEX "roles_is_system_code_idx" ON "roles"("is_system", "code");

CREATE TABLE "permissions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "code" VARCHAR(80) NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "module" VARCHAR(40) NOT NULL,
  "description" VARCHAR(240),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

CREATE TABLE "role_permissions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "role_id" UUID NOT NULL,
  "permission_id" UUID NOT NULL,
  CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "role_permissions_role_id_permission_id_key" ON "role_permissions"("role_id", "permission_id");

ALTER TABLE "memberships"
  ADD CONSTRAINT "memberships_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "invitations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "outlet_id" UUID NOT NULL,
  "invited_by_user_id" UUID NOT NULL,
  "email" VARCHAR(160),
  "phone" VARCHAR(20) NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "role" "StaffRole" NOT NULL,
  "token_hash" VARCHAR(128) NOT NULL,
  "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
  "expires_at" TIMESTAMPTZ NOT NULL,
  "accepted_at" TIMESTAMPTZ,
  "revoked_at" TIMESTAMPTZ,
  "deleted_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "invitations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "invitations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "invitations_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "invitations_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");
CREATE INDEX "invitations_tenant_id_outlet_id_status_idx" ON "invitations"("tenant_id", "outlet_id", "status");

CREATE TABLE "sessions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID,
  "outlet_id" UUID,
  "user_id" UUID NOT NULL,
  "family_id" UUID NOT NULL,
  "ip_address" VARCHAR(45),
  "user_agent" VARCHAR(300),
  "last_active_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "expires_at" TIMESTAMPTZ NOT NULL,
  "revoked_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sessions_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "sessions_family_id_key" ON "sessions"("family_id");
CREATE INDEX "sessions_tenant_id_user_id_revoked_at_idx" ON "sessions"("tenant_id", "user_id", "revoked_at");
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- Backfill tenant_settings and outlet_settings for any existing tenants/outlets
INSERT INTO "tenant_settings" ("tenant_id")
SELECT "id" FROM "tenants"
ON CONFLICT ("tenant_id") DO NOTHING;

INSERT INTO "outlet_settings" ("tenant_id", "outlet_id", "tax_mode", "gst_rate_bps", "round_off_enabled", "require_waiter_approval", "table_pin_enabled")
SELECT "tenant_id", "id", "tax_mode", "gst_rate_bps", "round_off_enabled", "require_waiter_approval", "table_pin_enabled"
FROM "outlets"
ON CONFLICT ("outlet_id") DO NOTHING;

-- PostgreSQL Row-Level Security (RLS) for Milestone 1 Tenant Tables
DO $$
DECLARE
  tbl TEXT;
  strict_tables TEXT[] := ARRAY['tenant_settings', 'outlet_settings', 'invitations'];
BEGIN
  FOREACH tbl IN ARRAY strict_tables LOOP
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

ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_sessions ON "sessions";
CREATE POLICY tenant_isolation_sessions ON "sessions"
  FOR ALL TO autonex_app
  USING (
    tenant_id IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  );

ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_roles ON "roles";
CREATE POLICY tenant_isolation_roles ON "roles"
  FOR SELECT TO autonex_app
  USING (
    tenant_id IS NULL
    OR tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  );
CREATE POLICY tenant_isolation_roles_write ON "roles"
  FOR ALL TO autonex_app
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

