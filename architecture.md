# AutoNex Restaurant OS — System Architecture

**Architecture:** Multi-Tenant Modular Monolith (No Microservices)  
**Stack:** Next.js · NestJS · PostgreSQL · Prisma · Docker  
**Core Guarantees:** Layered tenant isolation (App + PostgreSQL RLS), idempotent writes, and transactional outbox for reliable real-time updates.

---

## 1. High-Level Architecture

```text
  [Customer QR Web]   [Waiter/Cashier POS]   [Kitchen KDS]   [Super Admin]
          |                    |                   |               |
          +--------------------+-------------------+---------------+
                               | HTTPS / WSS
                               v
         [Cloudflare CDN + Reverse Proxy (TLS, Image Cache, Rate Limit)]
                 |                                      |
                 v                                      v
      [Next.js Frontend]                     [NestJS Modular Monolith]
      - SSR/ISR QR Menu                      - REST API + Guards (RBAC/Rate)
      - POS / KDS / Admin                    - Socket.IO WS + Outbox Relay
                                             - 11 Isolated Domain Modules
                                                        |
                        +-------------------------------+-------------------+
                        v                                                   v
        [Managed PostgreSQL + PgBouncer]                        [External Services]
        - Shared DB/Schema + RLS + outbox_events                - Razorpay UPI / PG
                                                                - S3/R2 + Print
```

---

## 2. Tech Stack Justification

- **Next.js (Frontend):** SSR/ISR + CDN caching delivers `< 2.5s` QR menu loads on Indian 4G. One React codebase serves Customer Web, Waiter/Cashier POS, KDS, and Admin dashboards.
- **NestJS (Backend Modular Monolith):** Enforces strict module boundaries via DI, built-in Guards (RBAC, tenancy, throttling), and native `Socket.IO` gateways—providing modularity without microservice ops/network overhead.
- **PostgreSQL (Database):** ACID transactions guarantee atomic `Order + KOT + OutboxEvent` writes. Native Row-Level Security (RLS) provides DB-level tenant isolation; `JSONB` holds modifier/price snapshots cleanly.
- **Prisma (ORM):** End-to-end TypeScript safety, declarative migrations, and `$extends` client hooks to enforce `tenant_id` scoping and Postgres session variables automatically.

---

## 3. Multi-Tenant Model (Shared DB, Shared Schema)

All restaurants share one PostgreSQL database and schema (`public`). Tenant tables (`menus`, `tables`, `sessions`, `orders`, `kots`, `bills`, `payments`, `outbox_events`) include `tenant_id UUID NOT NULL` with composite indexes `(tenant_id, ...)`.

### Layered Tenant Isolation (App Logic + PostgreSQL RLS)
- **Layer 1 — App Context (NestJS + Prisma):** Auth middleware extracts `tenant_id` from staff JWT or signed customer `table_session_token` into `AsyncLocalStorage`. A Prisma Client Extension auto-injects `tenant_id` into every `WHERE` and `CREATE`.
- **Layer 2 — DB Enforcement (PostgreSQL RLS):** Inside every tenant transaction, Prisma executes `SET LOCAL app.current_tenant_id = '<uuid>'`. RLS policies (`USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)`) block cross-tenant reads/writes even if an app query misses a filter.
- **Admin Bypass:** Only audited `SUPER_ADMIN` endpoints (`admin`, `subscriptions`) use a dedicated system DB role.

---

## 4. Module Breakdown (NestJS Modular Monolith)

Modules interact strictly through exported NestJS services or domain events (no cross-module direct table queries):

- **`identity`:** Phone + PIN/OTP auth, JWT/refresh tokens, RBAC (`OWNER`, `CASHIER`, `WAITER`, `KITCHEN`, `SUPER_ADMIN`).
- **`tenancy`:** Outlet profile, GST % config, active status, and `TenantContext` resolution.
- **`menus`:** Categories, items, Veg/Non-Veg/Egg flags, variants/modifiers, and instant `in_stock` toggles.
- **`tables`:** Table registry, signed QR token generation/rotation, floor status (`AVAILABLE`, `OCCUPIED`, `BILL_REQUESTED`).
- **`sessions`:** Binds customer QR scans and waiter entries into one running table session until bill settlement.
- **`ordering`:** Validates cart/prices, enforces `Idempotency-Key`, writes `Order` + `KOT` + `OutboxEvent` atomically.
- **`kitchen`:** KDS queue, `ADD-ON` round tagging, status transitions (`NEW` → `PREPARING` → `READY` → `SERVED`), thermal KOT formatting.
- **`billing`:** Consolidates session rounds, calculates CGST/SGST, applies manager discounts, generates receipts.
- **`payments`:** Payment Gateway UPI dynamic QR/intent, HMAC webhook verification, cashier fallback (`CASH`, `CARD`, `UPI_MANUAL`).
- **`subscriptions`:** SaaS plan status, trial expiry, and read-only lock enforcement on overdue outlets.
- **`admin`:** Platform super-admin APIs for tenant onboarding, usage metrics, and support audit logs.

---

## 5. Data Flow Diagrams

### 5.1 Order Placement (Idempotent + Outbox)
```text
Customer/Waiter    NestJS (ordering)       PostgreSQL (RLS)       Outbox Relay
      |-- POST /orders ->|                       |                     |
      | (Idempotency-Key)|-- TX: INSERT order, ->|                     |
      |                  |   kot, outbox_event   |                     |
      |<-- 201 Order ----|<-- COMMIT ------------|                     |
      |                  |                       |<-- Poll SKIP LOCKED-|
      |<=============== WS: order.created (KDS & Staff Rooms) =========|
```

### 5.2 KDS Update (Kitchen Sync)
```text
Kitchen Tablet     NestJS (kitchen)        PostgreSQL (RLS)     Waiter/Customer
      |-- PATCH /kots/:id ->|                    |                     |
      |  status=READY       |-- TX: UPDATE kot,->|                     |
      |                     |   INSERT outbox    |                     |
      |<-- 200 OK ----------|<-- COMMIT ---------|                     |
      |                     |====== WS: kot.ready (or 4s Polling) ====>|
```

### 5.3 Payment & Settlement
```text
Cashier/Customer   NestJS (billing/payments)  PostgreSQL (RLS)    Payment Gateway
      |-- POST /checkout ->|-- Create UPI QR ----|------------------>|
      |<-- Dynamic QR -----|                     |                   |
      | [Pays UPI / Cash]  |<-- HMAC Webhook ----|-------------------|
      |                    |-- TX: Paid, Session=|                   |
      |                    |   CLOSED, Table=FREE|                   |
      |<== WS: closed =====|<-- COMMIT ----------|                   |
```

---

## 6. Real-Time Strategy (WebSocket + Polling Fallback + Outbox)

- **Transactional Outbox:** Mutations never emit WS events before DB commit (preventing phantom KOTs). State changes write an `outbox_events` row (`id`, `tenant_id`, `topic`, `payload`, `status`) inside the **same ACID transaction**.
- **Outbox Relay Worker:** Polls `outbox_events` every ~250ms (`SELECT ... FOR UPDATE SKIP LOCKED`, batch 50), pushes to Socket.IO rooms (`tenant:{id}:kitchen`, `tenant:{id}:staff`, `session:{id}`), and marks `SENT` with retry backoff.
- **WebSocket + Polling Fallback:** Clients deduplicate via `event_id`. If restaurant Wi-Fi drops WS (> 5s missed heartbeat), KDS and Customer UI switch automatically to cursor-based HTTP polling (`GET /kds/orders?since=<ts>`) every 4s and display an offline/reconnecting indicator.

---

## 7. Deployment Architecture

```text
[Clients] -> [Cloudflare CDN + WAF] -> [Docker: Next.js] + [Docker: NestJS Monolith]
                 (Assets/Images)                                   |
                                                                   v
                                           [Managed PostgreSQL (ap-south-1) + PgBouncer]
```

- **Docker Compute (Mumbai `ap-south-1`):** Immutable Next.js and NestJS Docker containers keep regional latency `< 40ms`. Outbox Relay runs in-process initially or as a separate worker container from the same image.
- **Managed DB:** Managed PostgreSQL with `PgBouncer` transaction pooling, daily backups, and 7-day PITR.
- **CDN & Storage:** Compressed `WebP` menu photos live in S3/R2 behind Cloudflare CDN caching.

---

## 8. Security Architecture

- **Authentication:** Staff/Owners log in via phone + PIN/OTP (`15m` JWT + `HttpOnly` refresh cookie). Customer QR scans receive a signed `table_session_token` scoped to one `tenant_id` and `table_id`.
- **Authorization & RLS:** NestJS `TenantGuard` + `RolesGuard` enforce permissions per endpoint, backed unconditionally by PostgreSQL RLS (`SET LOCAL app.current_tenant_id`).
- **Idempotency & Rate Limiting:** `POST /orders` enforces a `24h` client `Idempotency-Key` per tenant so 4G retries never create duplicate KOTs. Cloudflare + NestJS `ThrottlerGuard` cap QR endpoint bursts (e.g., 15 req/min/session).
- **Secrets & Webhooks:** DB credentials, JWT keys, and PG secrets live in platform Secrets Manager. Payment webhooks validate `HMAC-SHA256` signatures and deduplicate by `gateway_payment_id`.

---

## 9. Scalability Path (100 → 500 → 1,000 Restaurants)

- **100 Restaurants (~6k orders/day):** 1 Next.js + 1 NestJS container (2 vCPU / 4 GB) + 1 Managed Postgres (2 vCPU + PgBouncer). In-memory Socket.IO and in-process Outbox Relay suffice.
- **500 Restaurants (~30k orders/day):** Scale NestJS to 2–4 replicas behind Load Balancer; add **Managed Redis** only for Socket.IO Redis Adapter & distributed rate limits; run Outbox Relay as a dedicated worker pod (`SKIP LOCKED`); add a **Postgres Read Replica** for Owner/Admin reporting.
- **1,000+ Restaurants (~60k+ orders/day):** Partition high-write tables (`outbox_events`, `orders`, `kots`) monthly and archive closed sessions > 90 days; optionally extract `kitchen` WS dispatch or `payments` webhook ingestion as standalone worker processes directly from NestJS module boundaries without schema rewrites.
