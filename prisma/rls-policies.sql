-- AutoNex Restaurant OS — PostgreSQL Row-Level Security (RLS) (Phase 1 + Phase 2)
-- Enforces strict tenant isolation at the database level for runtime role `autonex_app`.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autonex_app') THEN
    CREATE ROLE autonex_app
      WITH LOGIN PASSWORD 'autonex_app_pass'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autonex_admin') THEN
    CREATE ROLE autonex_admin
      WITH LOGIN PASSWORD 'autonex_admin_pass'
      NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO autonex_app, autonex_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO autonex_app, autonex_admin;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO autonex_app, autonex_admin;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO autonex_app, autonex_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO autonex_app, autonex_admin;

-- Enforce only one active unrevoked QR token per table
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_qr_per_table
  ON table_qr_tokens (table_id)
  WHERE is_active = true AND revoked_at IS NULL;

-- Enforce only one non-closed dining session per table
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_session_per_table
  ON dining_sessions (tenant_id, table_id)
  WHERE status <> 'CLOSED';

-- Partial index for pending transactional outbox relay
CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbox_events (available_at, created_at)
  WHERE status = 'PENDING';

-- KDS hot-path partial index
CREATE INDEX IF NOT EXISTS idx_orders_kds_active
  ON orders (tenant_id, outlet_id, kitchen_status, created_at)
  WHERE kitchen_status IN ('NEW', 'PREPARING', 'READY');

-- KDS unacknowledged alert hot-path index
CREATE INDEX IF NOT EXISTS idx_orders_kds_unacked
  ON orders (tenant_id, outlet_id, created_at)
  WHERE kitchen_status = 'NEW' AND acknowledged_at IS NULL;

-- Enforce only one active (non-VOID) bill per dining session
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_bill_per_session
  ON bills (tenant_id, session_id)
  WHERE status <> 'VOID';

-- Partial index for pending gateway payment reconciliation
CREATE INDEX IF NOT EXISTS idx_payment_attempts_pending
  ON payment_attempts (created_at)
  WHERE status IN ('INITIATED', 'PENDING');

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_tenants ON tenants;
CREATE POLICY tenant_isolation_tenants ON tenants
  FOR ALL TO autonex_app
  USING (id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DO $$
DECLARE
  tbl TEXT;
  strict_tenant_tables TEXT[] := ARRAY[
    'outlets',
    'tenant_settings',
    'outlet_settings',
    'invitations',
    'memberships',
    'categories',
    'menu_items',
    'modifier_groups',
    'modifier_options',
    'restaurant_tables',
    'table_qr_tokens',
    'dining_sessions',
    'session_guests',
    'orders',
    'order_items',
    'order_events',
    'outbox_events',
    'bills',
    'bill_lines',
    'payment_attempts',
    'payment_allocations',
    'refunds',
    'subscriptions',
    'subscription_invoices',
    'support_cases',
    'support_case_notes'
  ];
BEGIN
  FOREACH tbl IN ARRAY strict_tenant_tables LOOP
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

DO $$
DECLARE
  tbl TEXT;
  nullable_tenant_tables TEXT[] := ARRAY['refresh_tokens', 'sessions', 'audit_logs', 'webhook_events'];
BEGIN
  FOREACH tbl IN ARRAY nullable_tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON %I;', tbl, tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_%I ON %I
         FOR ALL TO autonex_app
         USING (
           tenant_id IS NOT NULL
           AND tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid
         )
         WITH CHECK (
           tenant_id IS NOT NULL
           AND tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid
         );',
      tbl, tbl
    );
  END LOOP;
END
$$;

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_roles ON roles;
DROP POLICY IF EXISTS tenant_isolation_roles_write ON roles;
CREATE POLICY tenant_isolation_roles ON roles
  FOR SELECT TO autonex_app
  USING (
    tenant_id IS NULL
    OR tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  );
CREATE POLICY tenant_isolation_roles_write ON roles
  FOR ALL TO autonex_app
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
