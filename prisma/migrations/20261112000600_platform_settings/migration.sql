-- Platform governance settings table for Super Admin console
CREATE TABLE IF NOT EXISTS "platform_settings" (
  "id" VARCHAR(30) NOT NULL DEFAULT 'default',
  "platform_name" VARCHAR(120) NOT NULL DEFAULT 'AutoNex Restaurant OS',
  "support_email" VARCHAR(160) NOT NULL DEFAULT 'support@autonex.in',
  "support_phone" VARCHAR(20) NOT NULL DEFAULT '+919999999999',
  "default_trial_days" INTEGER NOT NULL DEFAULT 14,
  "default_grace_days" INTEGER NOT NULL DEFAULT 3,
  "saas_gst_rate_bps" INTEGER NOT NULL DEFAULT 1800,
  "auto_approve_registrations" BOOLEAN NOT NULL DEFAULT false,
  "maintenance_mode" BOOLEAN NOT NULL DEFAULT false,
  "maintenance_message" VARCHAR(300),
  "updated_by_user_id" UUID,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id")
);

INSERT INTO "platform_settings" ("id", "updated_at")
VALUES ('default', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

