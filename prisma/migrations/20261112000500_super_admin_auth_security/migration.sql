-- Super Admin auth lockout fields + password reset tokens (safe additive migration)
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "locked_until" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "last_login_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "password_changed_at" TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "token_hash" VARCHAR(128) NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "used_at" TIMESTAMPTZ,
  "ip_address" VARCHAR(45),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "password_reset_tokens_token_hash_key" UNIQUE ("token_hash"),
  CONSTRAINT "password_reset_tokens_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "password_reset_tokens_user_id_expires_at_idx"
  ON "password_reset_tokens"("user_id", "expires_at");

