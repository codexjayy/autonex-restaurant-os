# AutoNex Restaurant OS — Database Design

**Engine:** PostgreSQL 16+ · **ORM:** Prisma Migrate & Client  
**Tenancy:** Shared DB, Shared Schema (`tenant_id` + PostgreSQL RLS)  
**Money Precision:** Integer **paise** (`100` paise = ₹1, zero floating-point math)

---

## 1. Entity-Relationship (ER) Diagram

```text
+---------+     1:N     +---------+     1:N     +------------------+
| tenants |------------>| outlets |------------>| restaurant_tables|
+----+----+             +----+----+             +--------+---------+
     |                       |                           | 1:N
     | 1:N                   | 1:N                       v
     v                       v                  +------------------+
+-------------+       +------------+            | table_qr_tokens  |
| memberships |<------|   users    |            +------------------+
+------+------+  N:1  +------------+
       |                                        +------------------+
       |                                        | dining_sessions  |<--+
       | 1:N (via outlet/tenant)                +--------+---------+   |
       v                                                 | 1:N         | 1:N
+------------+  1:N  +------------+  1:N                 v             |
| categories |------>| menu_items |-------+     +----------------+     |
+------------+       +-----+------+       |     | session_guests |     |
                           | 1:N          |     +----------------+     |
                           v              |                            |
                   +-----------------+    |     +--------+             |
                   | modifier_groups |    +---->| orders |<------------+
                   +--------+--------+    N:1   +---+----+
                            | 1:N                   | 1:N
                            v                       +--> order_items
                   +------------------+             +--> order_events
                   | modifier_options |             +--> outbox_events
                   +------------------+
                                                +-------+  1:N  +------------+
[dining_sessions] 1:1 --> [bills] 1:N --------->| bills |------>| bill_lines |
                             |                  +---+---+       +------------+
                             | 1:N                  | 1:N
                             v                      v
                   +------------------+   +---------------------+   1:N   +---------+
                   | payment_attempts |-->| payment_allocations |-------->| refunds |
                   +--------+---------+   +---------------------+         +---------+
                            |
                            +--> webhook_events (idempotent PG log)

[tenants] 1:1 --> [subscriptions] N:1 --> [plans]
[tenants] 1:N --> [audit_logs]
```

---

## 2. Table Definitions (SQL-Style Columns & Constraints)

### 2.1 Identity, Tenancy & Outlets

```sql
CREATE TABLE tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(120) NOT NULL,
  slug        VARCHAR(80)  NOT NULL UNIQUE,
  status      VARCHAR(20)  NOT NULL DEFAULT 'TRIAL', -- TRIAL|ACTIVE|GRACE|LOCKED|SUSPENDED
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE outlets (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                    VARCHAR(120) NOT NULL,
  phone                   VARCHAR(20)  NOT NULL,
  address                 VARCHAR(300),
  gstin                   VARCHAR(20),
  gst_rate_bps            INTEGER NOT NULL DEFAULT 500 CHECK (gst_rate_bps >= 0 AND gst_rate_bps <= 2800), -- 500 bps = 5.00%
  require_waiter_approval BOOLEAN NOT NULL DEFAULT FALSE,
  table_pin_enabled       BOOLEAN NOT NULL DEFAULT FALSE,
  invoice_seq             INTEGER NOT NULL DEFAULT 0,
  is_active               BOOLEAN NOT NULL DEFAULT TRUE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone           VARCHAR(20)  NOT NULL UNIQUE,
  name            VARCHAR(100) NOT NULL,
  password_hash   VARCHAR(255), -- Used by Owner/SuperAdmin web login
  is_super_admin  BOOLEAN NOT NULL DEFAULT FALSE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  outlet_id       UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  role            VARCHAR(20) NOT NULL, -- OWNER|CASHIER|WAITER|KITCHEN
  staff_pin_hash  VARCHAR(255) NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, outlet_id, user_id)
);
```

### 2.2 Menu & Modifiers

```sql
CREATE TABLE categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  outlet_id   UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  name        VARCHAR(80) NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, outlet_id, name)
);

CREATE TABLE menu_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  outlet_id         UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  category_id       UUID NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  name              VARCHAR(120) NOT NULL,
  description       VARCHAR(280),
  dietary_type      VARCHAR(15) NOT NULL DEFAULT 'VEG', -- VEG|NON_VEG|EGG
  base_price_paise  INTEGER NOT NULL CHECK (base_price_paise >= 0),
  image_url         TEXT,
  in_stock          BOOLEAN NOT NULL DEFAULT TRUE,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE modifier_groups (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  menu_item_id    UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  name            VARCHAR(60) NOT NULL, -- e.g., Portion (Half/Full), Spice Level
  selection_type  VARCHAR(10) NOT NULL DEFAULT 'SINGLE', -- SINGLE|MULTI
  is_required     BOOLEAN NOT NULL DEFAULT FALSE,
  min_select      INTEGER NOT NULL DEFAULT 0,
  max_select      INTEGER NOT NULL DEFAULT 1,
  sort_order      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE modifier_options (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  modifier_group_id  UUID NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  name               VARCHAR(60) NOT NULL, -- e.g., Full, Extra Butter
  price_delta_paise  INTEGER NOT NULL DEFAULT 0,
  in_stock           BOOLEAN NOT NULL DEFAULT TRUE,
  is_default         BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order         INTEGER NOT NULL DEFAULT 0
);
```

### 2.3 Tables, QR Tokens & Dining Sessions

```sql
CREATE TABLE restaurant_tables (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  outlet_id     UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  table_number  VARCHAR(20) NOT NULL,
  label         VARCHAR(60),
  capacity      INTEGER NOT NULL DEFAULT 4 CHECK (capacity > 0),
  status        VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE', -- AVAILABLE|OCCUPIED|BILL_REQUESTED
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, outlet_id, table_number)
);

CREATE TABLE table_qr_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  outlet_id   UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  table_id    UUID NOT NULL REFERENCES restaurant_tables(id) ON DELETE CASCADE,
  token_hash  VARCHAR(128) NOT NULL UNIQUE,
  qr_version  INTEGER NOT NULL DEFAULT 1,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at  TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE dining_sessions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  outlet_id                UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  table_id                 UUID NOT NULL REFERENCES restaurant_tables(id) ON DELETE RESTRICT,
  status                   VARCHAR(20) NOT NULL DEFAULT 'ACTIVE', -- ACTIVE|BILL_REQUESTED|CLOSED
  table_pin                VARCHAR(6),
  is_approved              BOOLEAN NOT NULL DEFAULT TRUE,
  opened_by_membership_id  UUID REFERENCES memberships(id) ON DELETE SET NULL,
  opened_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  bill_requested_at        TIMESTAMPTZ,
  closed_at                TIMESTAMPTZ
);

CREATE TABLE session_guests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id        UUID NOT NULL REFERENCES dining_sessions(id) ON DELETE CASCADE,
  guest_token_hash  VARCHAR(128) NOT NULL UNIQUE,
  display_label     VARCHAR(40), -- e.g., Guest 1
  joined_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 2.4 Orders, Order Items, Events & Outbox

```sql
CREATE TABLE orders (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  outlet_id                UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  session_id               UUID NOT NULL REFERENCES dining_sessions(id) ON DELETE RESTRICT,
  guest_id                 UUID REFERENCES session_guests(id) ON DELETE SET NULL,
  placed_by_membership_id  UUID REFERENCES memberships(id) ON DELETE SET NULL,
  round_number             INTEGER NOT NULL DEFAULT 1,
  kot_number               INTEGER NOT NULL,
  is_add_on                BOOLEAN NOT NULL DEFAULT FALSE,
  source                   VARCHAR(20) NOT NULL, -- CUSTOMER_QR|STAFF_POS
  kitchen_status           VARCHAR(20) NOT NULL DEFAULT 'NEW', -- NEW|PREPARING|READY|SERVED|CANCELLED
  idempotency_key          VARCHAR(120) NOT NULL,
  subtotal_paise           INTEGER NOT NULL CHECK (subtotal_paise >= 0),
  notes                    VARCHAR(250),
  accepted_at              TIMESTAMPTZ,
  ready_at                 TIMESTAMPTZ,
  served_at                TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE order_items (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id                  UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id              UUID NOT NULL REFERENCES menu_items(id) ON DELETE RESTRICT,
  item_name_snapshot        VARCHAR(120) NOT NULL,
  dietary_type_snapshot     VARCHAR(15)  NOT NULL,
  base_price_paise_snapshot INTEGER      NOT NULL CHECK (base_price_paise_snapshot >= 0),
  modifiers_snapshot_json   JSONB        NOT NULL DEFAULT '[]',
  unit_price_paise          INTEGER      NOT NULL CHECK (unit_price_paise >= 0),
  quantity                  INTEGER      NOT NULL CHECK (quantity > 0),
  line_total_paise          INTEGER      NOT NULL CHECK (line_total_paise >= 0),
  prep_notes                VARCHAR(200),
  status                    VARCHAR(15)  NOT NULL DEFAULT 'ACTIVE', -- ACTIVE|CANCELLED
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE order_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id       UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  event_type     VARCHAR(40) NOT NULL, -- ORDER_PLACED|KOT_ACCEPTED|KOT_READY|ITEM_CANCELLED
  from_status    VARCHAR(20),
  to_status      VARCHAR(20),
  actor_type     VARCHAR(20) NOT NULL, -- CUSTOMER|STAFF|SYSTEM
  actor_id       UUID,
  metadata_json  JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE outbox_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  topic           VARCHAR(80) NOT NULL, -- order.created|kot.updated|session.closed
  aggregate_type  VARCHAR(40) NOT NULL,
  aggregate_id    UUID        NOT NULL,
  payload_json    JSONB       NOT NULL,
  status          VARCHAR(15) NOT NULL DEFAULT 'PENDING', -- PENDING|PROCESSING|SENT|FAILED
  retry_count     INTEGER     NOT NULL DEFAULT 0,
  last_error      VARCHAR(500),
  available_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 2.5 Billing, Payments, Allocations, Refunds & Webhooks

```sql
CREATE TABLE bills (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  outlet_id       UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  session_id      UUID NOT NULL UNIQUE REFERENCES dining_sessions(id) ON DELETE RESTRICT,
  bill_number     VARCHAR(40) NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'OPEN', -- OPEN|PARTIALLY_PAID|PAID|VOID
  subtotal_paise  INTEGER NOT NULL CHECK (subtotal_paise >= 0),
  discount_paise  INTEGER NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  cgst_paise      INTEGER NOT NULL CHECK (cgst_paise >= 0),
  sgst_paise      INTEGER NOT NULL CHECK (sgst_paise >= 0),
  total_paise     INTEGER NOT NULL CHECK (total_paise >= 0),
  paid_paise      INTEGER NOT NULL DEFAULT 0 CHECK (paid_paise >= 0),
  gstin_snapshot  VARCHAR(20),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, outlet_id, bill_number)
);

CREATE TABLE bill_lines (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bill_id           UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  order_item_id     UUID REFERENCES order_items(id) ON DELETE RESTRICT,
  line_type         VARCHAR(15)  NOT NULL, -- ITEM|DISCOUNT|CGST|SGST|ROUND_OFF
  description       VARCHAR(160) NOT NULL,
  quantity          INTEGER      NOT NULL DEFAULT 1,
  unit_amount_paise INTEGER      NOT NULL,
  line_amount_paise INTEGER      NOT NULL, -- Negative for DISCOUNT
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE payment_attempts (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  outlet_id                   UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  bill_id                     UUID NOT NULL REFERENCES bills(id) ON DELETE RESTRICT,
  method                      VARCHAR(20) NOT NULL, -- UPI_GATEWAY|UPI_MANUAL|CASH|CARD
  provider                    VARCHAR(20) NOT NULL, -- RAZORPAY|MANUAL
  amount_paise                INTEGER NOT NULL CHECK (amount_paise > 0),
  status                      VARCHAR(20) NOT NULL DEFAULT 'INITIATED', -- INITIATED|PENDING|SUCCEEDED|FAILED
  idempotency_key             VARCHAR(120) NOT NULL,
  gateway_order_id            VARCHAR(100),
  gateway_payment_id          VARCHAR(100) UNIQUE,
  qr_payload_url              TEXT,
  confirmed_by_membership_id  UUID REFERENCES memberships(id) ON DELETE SET NULL,
  failure_reason              VARCHAR(250),
  completed_at                TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE payment_allocations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payment_attempt_id  UUID NOT NULL REFERENCES payment_attempts(id) ON DELETE RESTRICT,
  bill_id             UUID NOT NULL REFERENCES bills(id) ON DELETE RESTRICT,
  allocated_paise     INTEGER NOT NULL CHECK (allocated_paise > 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payment_attempt_id, bill_id)
);

CREATE TABLE refunds (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payment_attempt_id          UUID NOT NULL REFERENCES payment_attempts(id) ON DELETE RESTRICT,
  bill_id                     UUID NOT NULL REFERENCES bills(id) ON DELETE RESTRICT,
  amount_paise                INTEGER NOT NULL CHECK (amount_paise > 0),
  reason                      VARCHAR(200) NOT NULL,
  status                      VARCHAR(15) NOT NULL DEFAULT 'PENDING', -- PENDING|SUCCEEDED|FAILED
  gateway_refund_id           VARCHAR(100) UNIQUE,
  initiated_by_membership_id  UUID REFERENCES memberships(id) ON DELETE SET NULL,
  processed_at                TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE webhook_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID REFERENCES tenants(id) ON DELETE SET NULL,
  provider           VARCHAR(30)  NOT NULL, -- RAZORPAY
  provider_event_id  VARCHAR(120) NOT NULL,
  event_type         VARCHAR(60)  NOT NULL,
  payload_json       JSONB        NOT NULL,
  signature_valid    BOOLEAN      NOT NULL,
  status             VARCHAR(20)  NOT NULL DEFAULT 'RECEIVED', -- RECEIVED|PROCESSED|IGNORED|FAILED
  error_message      VARCHAR(300),
  processed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);
```

### 2.6 Subscriptions, Plans & Audit Logs

```sql
CREATE TABLE plans (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 VARCHAR(40) NOT NULL UNIQUE, -- STARTER|GROWTH
  name                 VARCHAR(80) NOT NULL,
  price_paise_monthly  INTEGER NOT NULL CHECK (price_paise_monthly >= 0),
  max_outlets          INTEGER NOT NULL DEFAULT 1,
  max_tables           INTEGER NOT NULL DEFAULT 30,
  features_json        JSONB   NOT NULL DEFAULT '{}',
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id               UUID NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  status                VARCHAR(20) NOT NULL DEFAULT 'TRIAL', -- TRIAL|ACTIVE|GRACE|LOCKED|CANCELLED
  trial_ends_at         TIMESTAMPTZ,
  current_period_start  TIMESTAMPTZ NOT NULL,
  current_period_end    TIMESTAMPTZ NOT NULL,
  grace_ends_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID REFERENCES tenants(id) ON DELETE SET NULL, -- NULL only for platform SuperAdmin ops
  actor_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_role     VARCHAR(20) NOT NULL,
  action         VARCHAR(100) NOT NULL, -- MENU_PRICE_UPDATED|BILL_DISCOUNT_APPLIED|TENANT_LOCKED
  entity_type    VARCHAR(60)  NOT NULL,
  entity_id      UUID,
  before_json    JSONB,
  after_json     JSONB,
  ip_address     VARCHAR(45),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 3. Relationships Summary (Foreign Keys & Delete Rules)

- **Tenant Ownership (`ON DELETE CASCADE`):** Every tenant-scoped structural table (`outlets`, `memberships`, `categories`, `menu_items`, `restaurant_tables`, `table_qr_tokens`, `subscriptions`, `outbox_events`) references `tenants(id)`.
- **Financial & Operational Protection (`ON DELETE RESTRICT`):** Historical references (`menu_items` in `order_items`, `dining_sessions` in `orders`/`bills`, `bills` in `payment_attempts`/`payment_allocations`/`refunds`) use `RESTRICT` so active or billed records can never be orphaned or wiped mid-audit (deactivate items via `is_active = FALSE` instead of `DELETE`).
- **Actor Attribution (`ON DELETE SET NULL`):** Staff references (`opened_by_membership_id`, `confirmed_by_membership_id`, `placed_by_membership_id`) preserve operational records if a staff member leaves.

---

## 4. Performance-Critical Indexes

```sql
-- 1. Guarantee only ONE active dine-in session per table (prevents race-condition duplicates)
CREATE UNIQUE INDEX uq_active_session_per_table
  ON dining_sessions (tenant_id, table_id)
  WHERE status <> 'CLOSED';

-- 2. Partial index for ultra-fast Outbox Relay polling (ignores already SENT rows)
CREATE INDEX idx_outbox_pending
  ON outbox_events (available_at, created_at)
  WHERE status = 'PENDING';

-- 3. KDS hot-path: active kitchen tickets + 4s polling cursor catch-up
CREATE INDEX idx_orders_kds_active
  ON orders (tenant_id, outlet_id, kitchen_status, created_at)
  WHERE kitchen_status IN ('NEW', 'PREPARING', 'READY');

CREATE INDEX idx_orders_kds_since
  ON orders (tenant_id, outlet_id, updated_at);

-- 4. QR Menu load (< 2.5s 4G): category + stock filtering
CREATE INDEX idx_menu_items_lookup
  ON menu_items (tenant_id, outlet_id, category_id, is_active, in_stock, sort_order);

-- 5. Active QR lookup & Owner daily Cash/UPI revenue summary
CREATE INDEX idx_qr_active_lookup ON table_qr_tokens (table_id, is_active);
CREATE INDEX idx_payments_daily_summary ON payment_attempts (tenant_id, outlet_id, status, completed_at);
CREATE INDEX idx_audit_logs_tenant_time ON audit_logs (tenant_id, created_at DESC);
```

---

## 5. Multi-Tenant Isolation Strategy

- **Global vs. Tenant Tables:** `tenants`, `plans`, and `users` (global phone identity) are platform tables; **every** tenant-owned table (`outlets`, `memberships`, all menu, table, session, order, bill, payment, outbox, subscription tables) carries `tenant_id UUID NOT NULL`.
- **Two-Layer Defense:**
  1. **App Layer (Prisma Client Extension):** Middleware resolves `tenant_id` from JWT or signed QR/session token into `AsyncLocalStorage`, automatically injecting `WHERE tenant_id = ?` and `tenant_id` on inserts.
  2. **Database Layer (PostgreSQL RLS):** App connects as non-superuser role `autonex_app` (`NOSUPERUSER NOBYPASSRLS`). Inside every transaction, Prisma executes `SET LOCAL app.current_tenant_id = '<uuid>'`, enforced by:
     ```sql
     ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
     ALTER TABLE orders FORCE ROW LEVEL SECURITY;
     CREATE POLICY tenant_isolation_orders ON orders
       USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
       WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
     ```
- **Exception Handling:** `webhook_events` ingestion and `outbox_events` relay use narrow `SECURITY DEFINER` DB functions or scoped service roles (`autonex_relay`), never exposing unrestricted bypass to the NestJS API role.

---

## 6. Money Handling (Integer Paise, Zero Floats)

- All prices, modifiers, discounts, taxes, totals, and refunds are stored as signed/unsigned **`INTEGER` paise** (`₹249.50` = `24950`), eliminating IEEE-754 floating-point drift.
- Tax percentages are stored in **basis points (`bps`)** (`500` bps = `5.00%` GST → split cleanly into `250` bps CGST + `250` bps SGST).
- GST rounding uses deterministic **integer half-up division** in `packages/shared`: `Math.floor((amountPaise * rateBps + 5000) / 10000)`.
- `bills.total_paise = subtotal_paise - discount_paise + cgst_paise + sgst_paise`, cross-checked against summed `bill_lines`.

---

## 7. Snapshot Strategy

Menu names, prices, modifiers, and outlet GSTIN can change anytime. Historical orders and bills must remain immutable:
- **`order_items`:** Copies `item_name_snapshot`, `dietary_type_snapshot`, `base_price_paise_snapshot`, `modifiers_snapshot_json` (selected options + price deltas at order time), and locked `unit_price_paise` / `line_total_paise`.
- **`bills` & `bill_lines`:** Freezes `gstin_snapshot`, itemized `bill_lines`, discounts, and tax amounts at checkout so later menu/GST edits never mutate past GST records.

---

## 8. Audit Trail Tables

- **`order_events`:** Append-only lifecycle log for every order (`ORDER_PLACED`, `KOT_ACCEPTED`, `KOT_READY`, `ITEM_CANCELLED`), recording `from_status`, `to_status`, `actor_type`, and `actor_id`.
- **`webhook_events`:** Permanent inbound log of every Razorpay webhook (`provider_event_id`, `signature_valid`, raw `payload_json`, `status`) ensuring idempotency and payment dispute traceability.
- **`audit_logs`:** Immutable security/business log capturing `before_json` and `after_json` for sensitive actions (menu price changes, manager bill discounts, pre-prep cancellations, subscription locks, and Super Admin actions).

---

## 9. Migration Strategy (Prisma Migrate)

- **Dual Connection URLs:** `DATABASE_MIGRATION_URL` (schema owner) runs `prisma migrate dev` / `prisma migrate deploy`; `DATABASE_URL` (`autonex_app`) powers the runtime API with RLS enforced.
- **Custom SQL Migrations:** Prisma generates structural DDL; partial indexes (`uq_active_session_per_table`, `idx_outbox_pending`) and `ENABLE/FORCE ROW LEVEL SECURITY` policies are appended via `prisma migrate dev --create-only` before applying.
- **Zero-Downtime Expand & Contract:** Never run destructive column drops/renames in one deploy. Add nullable columns → deploy code dual-writing → backfill → enforce `NOT NULL` in the next release. Test migration rollback scripts in staging CI prior to production deploy.

---

## 10. Seed Data Strategy

`prisma/seed.ts` runs idempotently (`upsert` on natural keys) for local dev, staging, and pilot demos:
1. **Plans & Super Admin:** Upsert `STARTER` (`₹999/mo`) and `GROWTH` (`₹1,999/mo`) plans + initial `SUPER_ADMIN` user from `.env`.
2. **Demo Indian Outlet:** Upsert `"Spice Junction"` tenant (`TRIAL` subscription) and primary outlet (`gst_rate_bps = 500`).
3. **Staff Memberships:** Seed 4 roles (`OWNER`, `CASHIER`, `WAITER`, `KITCHEN`) with hashed demo PINs (dev-only).
4. **Menu & Modifiers:** Seed 4 categories (*Starters*, *Main Course*, *Breads*, *Beverages*), 12 Veg/Non-Veg/Egg dishes with realistic INR paise prices (e.g., *Paneer Tikka* `26000`, *Butter Naan* `5500`), and modifier groups (*Half/Full*, *Spice Level*).
5. **Tables & QR Tokens:** Seed 8 `restaurant_tables` (`T1`–`T8`) and pre-signed active `table_qr_tokens` ready for immediate QR testing.

