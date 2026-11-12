# AutoNex Restaurant OS — Local & Docker Setup Guide

Step-by-step setup guide for the **AutoNex Restaurant OS** monorepo (**Next.js + NestJS Modular Monolith + PostgreSQL + Prisma + RLS**).

---

## 1. Prerequisites

Ensure the following tools are installed on your machine:

| Tool | Minimum / Recommended Version | Check Command |
| :--- | :--- | :--- |
| **Node.js** | `v20.11+` (LTS) | `node -v` |
| **pnpm** *(recommended)* | `v9.x` (via Corepack) or `npm v10+` | `pnpm -v` |
| **PostgreSQL** | `16.x` (via Docker or local install) | `psql --version` |
| **Docker & Compose** | Docker `24+` & Compose `v2+` | `docker compose version` |
| **Git** | `2.40+` | `git --version` |

Enable `pnpm` via Node's built-in Corepack if not installed:

```bash
corepack enable
corepack prepare pnpm@9 --activate
```

---

## 2. Project Structure Overview

```text
autonex-restaurant-os/
├── apps/
│   ├── web/                          # Next.js (App Router + Tailwind)
│   │   └── src/app/
│   │       ├── (customer)/t/[token]/ # No-app QR Menu, Cart & UPI Checkout
│   │       ├── (staff)/pos/          # Waiter Assisted Ordering & Floor View
│   │       ├── (staff)/kds/          # Real-time Kitchen Display + Thermal Print
│   │       ├── (owner)/dashboard/    # Menu, Tables/QR, Daily Summary
│   │       └── (admin)/console/      # Super Admin & Subscriptions Console
│   └── api/                          # NestJS Modular Monolith
│       └── src/
│           ├── common/               # TenantContext (ALS), Prisma RLS, Guards, OutboxRelay
│           └── modules/              # 11 Isolated Domain Modules:
│               ├── identity/         # Phone/PIN Auth, JWT, RBAC
│               ├── tenancy/          # Outlet config, GST %, TenantContext
│               ├── menus/            # Categories, items, variants, stock toggle
│               ├── tables/           # Table floor & signed QR tokens
│               ├── sessions/         # Active dine-in sessions & multi-round binding
│               ├── ordering/         # Cart validation, Idempotency-Key, KOT trigger
│               ├── kitchen/          # KDS state machine & thermal KOT payloads
│               ├── billing/          # Consolidated bill, CGST/SGST, discounts
│               ├── payments/         # Razorpay UPI QR/webhooks & Cash fallback
│               ├── subscriptions/    # Trial, grace period & read-only enforcement
│               └── admin/            # Platform super-admin controls & audit logs
├── packages/
│   └── shared/                       # Shared TS types, enums, paise/GST helpers
├── prisma/
│   ├── schema.prisma                 # Shared-schema multi-tenant models
│   ├── migrations/                   # SQL migrations + PostgreSQL RLS policies
│   └── seed.ts                       # Demo Indian outlet, menu, tables & PINs
├── docker/
│   ├── Dockerfile.api
│   └── Dockerfile.web
├── docker-compose.yml
├── .env.example
└── package.json
```

---

## 3. Environment Variables (`.env.example`)

Copy `.env.example` to `.env` before running migrations or starting servers:

```bash
cp .env.example .env
```

Full `.env.example` reference:

```dotenv
# --- App & Network ---
NODE_ENV=development
API_PORT=4000
WEB_PORT=3000
APP_URL=http://localhost:3000
CORS_ORIGIN=http://localhost:3000
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_API_URL=http://localhost:4000/api
NEXT_PUBLIC_WS_URL=http://localhost:4000

# --- Database (Dual Roles for PostgreSQL RLS Safety) ---
# Admin/owner URL used ONLY by Prisma Migrate to create tables & RLS policies
DATABASE_MIGRATION_URL=postgresql://postgres:postgres@localhost:5432/autonex?schema=public

# Non-superuser app role (NO BYPASSRLS) used by NestJS at runtime so RLS is strictly enforced
DATABASE_URL=postgresql://autonex_app:autonex_app_pass@localhost:5432/autonex?schema=public

# --- Auth & Security ---
JWT_ACCESS_SECRET=replace_with_64_char_random_hex_access_secret
JWT_REFRESH_SECRET=replace_with_64_char_random_hex_refresh_secret
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d
QR_SIGNING_SECRET=replace_with_64_char_random_hex_qr_secret
RATE_LIMIT_TTL_SEC=60
RATE_LIMIT_MAX_REQ=30

# --- Payments (Razorpay UPI / Cards) ---
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxxxx
RAZORPAY_KEY_SECRET=replace_with_razorpay_test_secret
RAZORPAY_WEBHOOK_SECRET=replace_with_razorpay_webhook_secret

# --- Media Storage & CDN (S3 / Cloudflare R2 for WebP Menu Photos) ---
S3_ENDPOINT=https://your-account.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=autonex-menu-media
S3_ACCESS_KEY_ID=replace_with_s3_access_key
S3_SECRET_ACCESS_KEY=replace_with_s3_secret_key
CDN_BASE_URL=https://cdn.autonex.local

# --- Real-Time Outbox & Optional Redis (Stage 2+ Multi-Instance Scaling) ---
OUTBOX_POLL_INTERVAL_MS=250
OUTBOX_BATCH_SIZE=50
# REDIS_URL=redis://localhost:6379

# --- Initial Super Admin Bootstrap (Seed) ---
SUPER_ADMIN_PHONE=+919999999999
SUPER_ADMIN_PIN=123456
```

> **Important (RLS Safety):** Never put the `postgres` superuser inside `DATABASE_URL` in production or testing—PostgreSQL superusers automatically bypass Row-Level Security (`BYPASSRLS`). Always keep `DATABASE_URL` on the restricted `autonex_app` role.

---

## 4. Local Setup Steps (Without Dockerized App)

Use this workflow during active feature development (DB runs in Docker, Next.js + NestJS run natively with hot reload).

### Step 1: Clone & Install Dependencies

```bash
git clone https://github.com/<org>/autonex-restaurant-os.git
cd autonex-restaurant-os
pnpm install
```

### Step 2: Configure Environment

```bash
cp .env.example .env
```

### Step 3: Start PostgreSQL via Docker

```bash
docker compose up -d postgres
```

Wait until Postgres passes its healthcheck:

```bash
docker compose ps
```

### Step 4: Create Non-Superuser RLS Role (First-Time Only)

```bash
docker compose exec postgres psql -U postgres -d autonex -c "
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'autonex_app') THEN
    CREATE ROLE autonex_app WITH LOGIN PASSWORD 'autonex_app_pass' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
\$\$;
GRANT USAGE ON SCHEMA public TO autonex_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO autonex_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO autonex_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO autonex_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO autonex_app;
"
```

### Step 5: Generate Prisma Client, Run Migrations & Seed Demo Data

```bash
# Generate Prisma client
pnpm db:generate

# Run migrations (uses DATABASE_MIGRATION_URL) + applies RLS policies
pnpm db:migrate

# Seed demo restaurant ("Spice Junction", Tables 1-8, Veg/Non-Veg menu, Staff PINs)
pnpm db:seed
```

### Step 6: Start Development Servers

```bash
pnpm dev
```

- **Customer / Staff / Owner Web:** `http://localhost:3000`
- **NestJS REST API:** `http://localhost:4000/api`
- **Health Check:** `http://localhost:4000/api/health`

---

## 5. Run Commands Reference

```bash
# --- Development ---
pnpm dev                      # Start Next.js (web) + NestJS (api) in parallel
pnpm --filter web dev         # Start Next.js frontend only
pnpm --filter api dev         # Start NestJS API + Outbox Relay only

# --- Database (Prisma) ---
pnpm db:generate              # Regenerate Prisma Client after schema edits
pnpm db:migrate               # Run pending migrations in dev (prisma migrate dev)
pnpm db:deploy                # Apply migrations in staging/prod (prisma migrate deploy)
pnpm db:seed                  # Seed demo restaurant, tables, menu & staff
pnpm db:studio                # Open Prisma Studio UI

# --- Testing ---
pnpm test                     # Run all unit tests across workspace
pnpm --filter api test:e2e    # Run API end-to-end integration tests
pnpm --filter api test:rls    # Run PostgreSQL multi-tenant RLS isolation tests

# --- Linting, Typechecking & Production Build ---
pnpm lint                     # ESLint across web, api, and shared packages
pnpm typecheck                # TypeScript strict check across monorepo
pnpm build                    # Production build for shared, api, and web
pnpm start                    # Start compiled production builds
```

---

## 6. Docker Compose Setup (Full Stack: App + DB + Optional Redis)

Use Docker Compose to run the full containerized stack locally (mirrors staging/production).

### `docker-compose.yml`

```yaml
services:
  postgres:
    image: postgres:16-alpine
    container_name: autonex_postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-postgres}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-postgres}
      POSTGRES_DB: ${POSTGRES_DB:-autonex}
    ports:
      - "5432:5432"
    volumes:
      - pg_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d autonex"]
      interval: 5s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7-alpine
    container_name: autonex_redis
    profiles: ["scale"] # Optional: enable only for multi-replica WS / rate-limit testing
    restart: unless-stopped
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  api:
    build:
      context: .
      dockerfile: docker/Dockerfile.api
    container_name: autonex_api
    restart: unless-stopped
    env_file: .env
    environment:
      DATABASE_URL: postgresql://autonex_app:autonex_app_pass@postgres:5432/autonex?schema=public
      DATABASE_MIGRATION_URL: postgresql://postgres:postgres@postgres:5432/autonex?schema=public
    ports:
      - "4000:4000"
    depends_on:
      postgres:
        condition: service_healthy

  web:
    build:
      context: .
      dockerfile: docker/Dockerfile.web
    container_name: autonex_web
    restart: unless-stopped
    env_file: .env
    ports:
      - "3000:3000"
    depends_on:
      - api

volumes:
  pg_data:
  redis_data:
```

### Docker Compose Commands

```bash
# Start Postgres + API + Web (MVP single-instance setup)
docker compose up -d --build

# Start WITH optional Redis (multi-replica Socket.IO adapter testing)
docker compose --profile scale up -d --build

# Run Prisma migrations inside API container
docker compose exec api pnpm db:deploy

# Follow live logs
docker compose logs -f api web

# Stop containers (keep DB volume)
docker compose down

# Stop and wipe all local DB volumes (fresh reset)
docker compose down -v
```

---

## 7. Common Setup Errors & Fixes

- **Error 1: `P1001: Can't reach database server at localhost:5432` (or wrong password on Windows)**
  - *Cause:* A local Windows/Mac PostgreSQL installation is already occupying port `5432`, intercepting connections meant for Docker.
  - *Fix:* Stop the host Postgres service (`net stop postgresql-x64-16` in PowerShell Admin) or remap Docker's host port to `5433:5432` and update `DATABASE_URL` / `DATABASE_MIGRATION_URL` to `:5433`.

- **Error 2: Cross-tenant RLS tests pass unexpectedly (or RLS doesn't block leaked queries)**
  - *Cause:* `DATABASE_URL` uses the `postgres` superuser (`BYPASSRLS`) instead of `autonex_app`, or `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` / `FORCE ROW LEVEL SECURITY` wasn't applied.
  - *Fix:* Re-run Step 4 to ensure `autonex_app` has `NOSUPERUSER NOBYPASSRLS`, verify `DATABASE_URL` points to `autonex_app`, and run `pnpm --filter api test:rls`.

- **Error 3: `invalid input syntax for type uuid: ""` on Postgres RLS policy**
  - *Cause:* Calling `current_setting('app.current_tenant_id', true)::uuid` when `SET LOCAL` wasn't set or was reset to `''`.
  - *Fix:* Wrap the RLS expression with `NULLIF`: `NULLIF(current_setting('app.current_tenant_id', true), '')::uuid`, and run all tenant queries inside Prisma `$transaction`.

- **Error 4: Customer QR scan on mobile phone fails to load menu or connect WebSocket**
  - *Cause:* QR URLs point to `http://localhost:3000` / `:4000`, which resolves to the phone itself instead of your laptop.
  - *Fix:* Find your machine's LAN IP (`ipconfig` on Windows / `ifconfig` on macOS), start Next/Nest bound to `0.0.0.0`, and set `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL`, and `CORS_ORIGIN` to `http://<YOUR_LAN_IP>:3000` (and `:4000`).

- **Error 5: Razorpay webhook returns `400 Invalid Signature` locally**
  - *Cause:* NestJS JSON body parser modifies the raw payload before HMAC verification.
  - *Fix:* Enable `rawBody: true` in `NestFactory.create(AppModule, { rawBody: true })` and verify `req.rawBody` against `RAZORPAY_WEBHOOK_SECRET` using a public tunnel (`cloudflared tunnel --url http://localhost:4000`).

- **Error 6: `pnpm` blocked on Windows PowerShell (`running scripts is disabled`)**
  - *Cause:* Windows default PowerShell execution policy restricts `.ps1` shims.
  - *Fix:* Run once in PowerShell:
    ```powershell
    Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
    ```
