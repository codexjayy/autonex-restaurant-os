# AutoNex Restaurant OS — Milestone 1 Repository Audit Report

**Audit Date:** 2026-11-12  
**Auditor Role:** Architecture, Security, Database, Backend, Frontend & QA Audit  
**Repository Root:** `d:\AutoNex Restaurant OS`  
**Git Head:** `3a8d847` (`Initial commit: AutoNex Restaurant OS`, branch `main`, clean working tree)

---

## 1. Executive Summary

The repository currently contains an operational multi-tenant modular monolith implementing **Phases 1 through 7** across Next.js (`apps/web`), NestJS (`apps/api`), `@autonex/shared`, Prisma (`prisma/`), and Docker Compose (`docker-compose.yml`).

Baseline workspace checks confirm the existing codebase builds cleanly at the static/unit level (`pnpm db:validate`, `pnpm -r lint`, `pnpm -r typecheck`, and `pnpm -r test` — 74 API unit tests across 12 suites + 14 `@autonex/shared` tests — all exit `0`). However, **no live PostgreSQL, Docker daemon, or Redis instance is running on the local Windows host** (TCP ports `5432` and `6379` are unreachable; `docker`, `psql`, and `redis-cli` are unavailable on `PATH`), so live database migrations and `test:rls` cannot execute without provisioning PostgreSQL and Redis.

Measured strictly against **Milestone 1 Foundation Requirements**, the repository has strong existing primitives (AsyncLocalStorage `TenantContextService`, dual-role PostgreSQL RLS `autonex_app` / `autonex_admin`, Prisma `$extends` scoping, JWT + HttpOnly refresh token rotation with family reuse revocation, `AdminService` onboarding/approval, and `KitchenGateway` Socket.IO foundation), alongside **critical gaps, security discrepancies, and structural missing pieces** that must be fixed without breaking existing working modules.

---

## 2. Complete Repository Inventory

### 2.1 Monorepo Workspaces & Root Configuration
- **Workspace Manager:** `pnpm@12.9.1` (`package.json`, `pnpm-workspace.yaml` with `apps/*` and `packages/*`)
- **Turborepo:** **MISSING** — No `turbo.json` or `turbo` dependency; root scripts use sequential `pnpm --filter` and `pnpm -r`.
- **Root Documentation (currently ungrouped at root, no `docs/` tree):**
  - `README.md` (48 lines) — quick start, stack badges, root doc links
  - `prd.md` (106 lines) — Indian restaurant MVP product requirements
  - `architecture.md` (144 lines) — multi-tenant modular monolith, RLS, outbox design
  - `database.md` (535 lines) — ER diagram, SQL schema notes, RLS, paise & snapshot design
  - `api.md` (182 lines) — REST & Socket.IO contracts
  - `setup.md` (363 lines) — local, RLS role creation, Docker Compose, troubleshooting
  - `plan.md` (201 lines) — 90-day phased roadmap
- **CI / Containers:**
  - `.github/workflows/ci.yml` — Postgres 16 service (`postgres:16-alpine`), runs `db:validate`, `db:generate`, `db:deploy`, `db:seed`, `lint`, `typecheck`, `test`, `test:rls`, `build`. **Missing** Redis service and Playwright E2E steps.
  - `docker-compose.yml` — defines `postgres`, `redis` (gated behind `profiles: ["scale"]`), `api`, `web`.
  - `docker/Dockerfile.api` & `docker/Dockerfile.web` — multi-stage workspace builds referencing `packages/shared`, `prisma/`, `apps/api`, `apps/web`.
  - `.env` and `.env.example` — present; must never be overwritten.

### 2.2 Existing Packages
- `packages/shared/` (`@autonex/shared`):
  - `src/enums.ts`, `src/money.ts`, `src/kds.ts`, `src/kds-sync.ts`, `src/session.ts`, `src/billing.ts`, `src/subscriptions.ts`
  - **Missing Milestone 1 packages:** `packages/database`, `packages/auth`, `packages/permissions`, `packages/ui`, `packages/validation`, `packages/types`.

### 2.3 Backend (`apps/api`)
- **Entry & App Module:** `apps/api/src/main.ts` (`helmet`, `cookie-parser`, CORS with `credentials: true`, `ValidationPipe` with `whitelist` & `forbidNonWhitelisted`, global prefix `api/v1`, `rawBody: true`), `apps/api/src/app.module.ts` (`ConfigModule`, `ThrottlerModule`, global `HttpExceptionFilter`, `ThrottlerGuard`, `JwtAuthGuard`, `RolesGuard`, `TenantStatusGuard`, `TenantContextMiddleware`).
- **Common Infrastructure (`apps/api/src/common/`):**
  - `config/env.validation.ts` — validates DB, JWT, QR, S3, Razorpay vars. **Missing** Redis/BullMQ env vars.
  - `context/tenant-context.service.ts` & `tenant-context.middleware.ts` — `AsyncLocalStorage` per-request isolation (`requestId`, `ipAddress`, `userId`, `tenantId`, `outletId`, `membershipId`, `role`, `isSuperAdmin`, `tenantStatus`).
  - `prisma/prisma.service.ts` & `prisma.module.ts` — dual clients (`appClient` on `DATABASE_URL` non-superuser, `adminClient` on `DATABASE_ADMIN_URL`), `runInTenantTx` setting `SET LOCAL app.current_tenant_id` + `$extends` query guard, `runAsSystemAdmin`.
  - `guards/` — `JwtAuthGuard`, `RolesGuard`, `TenantStatusGuard` (supports `AllowPendingTenant`, `AllowDuringLockOrSettlement`, and `PENDING_APPROVAL`/`LOCKED`/`SUSPENDED` handling).
  - `security/crypto.util.ts` — uses Node `scryptSync`, `sha256Hex`, `generateOpaqueToken`, `aes-256-gcm` QR token encryption.
- **Modules (`apps/api/src/modules/`):**
  - Core Milestone 1 relevant: `health`, `auth` (`/auth/*`), `tenancy` (`/outlet/profile`, `/outlet/onboarding`), `admin` (`/admin/*`).
  - Future-milestone modules already present and preserved: `menus`, `tables`, `sessions`, `ordering`, `kitchen` (includes `KitchenGateway` Socket.IO `/kds` namespace & `OutboxRelayService`), `billing`, `payments`, `subscriptions`.

### 2.4 Database (`prisma/`)
- `prisma/schema.prisma` (949 lines): defines enums and 24 models across Phases 1–7 (`Tenant`, `Outlet`, `User`, `Membership`, `RefreshToken`, `AuditLog`, `Category`, `MenuItem`, `ModifierGroup`, `ModifierOption`, `RestaurantTable`, `TableQrToken`, `DiningSession`, `SessionGuest`, `Order`, `OrderItem`, `OrderEvent`, `OutboxEvent`, `Bill`, `BillLine`, `PaymentAttempt`, `PaymentAllocation`, `Refund`, `WebhookEvent`, `Plan`, `Subscription`, `SubscriptionInvoice`, `SupportCase`, `SupportCaseNote`).
- `prisma/migrations/`: 7 applied migration folders (`20261111000000_phase1_foundation` through `20261111000600_phase7_super_admin_and_subscriptions`).
- `prisma/rls-policies.sql`: creates `autonex_app` (`NOSUPERUSER NOBYPASSRLS`) and `autonex_admin` (`BYPASSRLS`), grants permissions, defines partial unique/hot-path indexes, and enforces `ENABLE` + `FORCE ROW LEVEL SECURITY` on `tenants` and tenant-owned tables.
- `prisma/seed.ts`: upserts Super Admin, demo tenant `"Spice Junction Family Restaurant"`, primary outlet, 4 staff users/memberships, categories/items/modifiers, 6 tables + encrypted QR tokens, 3 SaaS plans, subscription, invoice, and sample support case. Uses inline `scryptSync`.

### 2.5 Frontend (`apps/web`)
- Next.js 15 App Router + React 19 + Tailwind CSS 3 + `lucide-react`.
- **Routes (`apps/web/src/app/`):** `/`, `/login`, `/register`, `/admin`, `/t/[token]`, `/dashboard` (`menu`, `tables`, `floor`, `billing`, `staff-order`, `kds`, `plan`).
- **Components & Libs (`apps/web/src/components/`, `apps/web/src/lib/`):** `DashboardShell`, `SubscriptionBanner`, `DietaryBadge`, `KotPrintModal`, `MenuItemCustomizerModal`, `api-client.ts`, `cart-storage.ts`, `kds-i18n.ts`, `kds-sync.ts`.

### 2.6 Existing Tests (`apps/api/test/` & `packages/shared/src/*.spec.ts`)
- `@autonex/shared`: `billing.spec.ts`, `kds.spec.ts`, `money.spec.ts`, `session.spec.ts`, `subscriptions.spec.ts` (14 passing unit tests).
- `apps/api/test/`: 12 unit suites (`74` passing mocked tests: `auth.service.spec.ts` [6], `tenant-isolation.spec.ts` [8], `admin-phase7.spec.ts` [3], plus Phases 2–7 suites [57]) and 1 live DB RLS suite (`rls-integration.rls-spec.ts` [3 tests], skipped unless `test:rls` is run against live Postgres).
- **Playwright E2E tests:** **MISSING**.

---

## 3. Critical Bugs, Security Gaps & Milestone 1 Discrepancies

### 3.1 Critical Security & Isolation Bugs Found
1. **Incomplete `TENANT_SCOPED_MODELS` in `PrismaService` (`apps/api/src/common/prisma/prisma.service.ts:8-25`):**
   - `TENANT_SCOPED_MODELS` only lists 16 models (`Outlet` .. `OutboxEvent`). It omits 10 Phase 6/7 tenant-owned models (`Bill`, `BillLine`, `PaymentAttempt`, `PaymentAllocation`, `Refund`, `WebhookEvent`, `Subscription`, `SubscriptionInvoice`, `SupportCase`, `SupportCaseNote`).
   - While PostgreSQL RLS protects them at the DB layer, Layer 1 Prisma `$extends` fails to auto-inject `tenantId` or throw cross-tenant `ForbiddenException` on those models. Any new Milestone 1 tenant-owned models must also be included.
2. **Password & PIN Hashing Uses `scryptSync` Instead of Argon2id (`crypto.util.ts`, `prisma/seed.ts`):**
   - Requirement specifies **Argon2id**. Both `crypto.util.ts` and `prisma/seed.ts` use `scryptSync`.
   - Fix: Implement **Argon2id** hashing with legacy `scrypt:` transparent fallback verification so existing tests/data do not break while all new hashes use Argon2id.
3. **NestJS Passport Missing (`package.json`, `JwtAuthGuard`):**
   - `apps/api/package.json` does not install `@nestjs/passport`, `passport`, or `passport-jwt`. `JwtAuthGuard` verifies JWTs manually instead of using a Passport `JwtStrategy`.
   - Fix: Install `@nestjs/passport`, `passport`, `passport-jwt`, `@types/passport-jwt`, implement `JwtStrategy extends PassportStrategy(Strategy)`, and integrate with `JwtAuthGuard` while preserving unit-test compatibility.
4. **Missing CSRF Protection on Cookie-Based Refresh & Logout (`auth.controller.ts:61-90`):**
   - `POST /api/v1/auth/refresh` and `POST /api/v1/auth/logout` are `@Public()` and accept the `anx_refresh` `HttpOnly` cookie without verifying a double-submit CSRF token or strict `Origin` header.
   - Fix: Issue a readable `anx_csrf` cookie (`SameSite=Lax`, non-HttpOnly) alongside `anx_refresh`, enforce double-submit `x-csrf-token` validation (plus trusted `Origin` fallback/checks for browser cookie flows while remaining compatible with explicit JSON body `refreshToken` clients), and add stricter `@Throttle` limits on auth endpoints.
5. **Hardcoded Default/Weak Admin Secret Fallbacks in `seed.ts` & `env.validation.ts`:**
   - Ensure `env.validation.ts` rejects missing secrets outside `test` mode (already enforced for JWT/QR), and avoid hardcoded secret literals in runtime production paths.

### 3.2 Missing Database & Schema Foundation
1. **Missing Normalized Milestone 1 Tables in `prisma/schema.prisma`:**
   - `tenant_settings` (1:1 per tenant, `tenant_id` scoped)
   - `outlet_settings` (1:1 per outlet, `tenant_id` scoped)
   - `roles` & `permissions` & `role_permissions` (relational RBAC catalog alongside `StaffRole` enum for backward compatibility)
   - `invitations` (staff/outlet invites with hashed token, expiry, role, status, soft-delete)
   - `sessions` (persistent auth device/session audit records linked to refresh token `familyId`, IP, user-agent, revocation state)
   - Soft-deletion (`deleted_at`) support on core Milestone 1 models (`tenants`, `outlets`, `users`, `memberships`, `invitations`) without breaking unique indexes or Phase 2–7 behavior.
2. **Missing RLS Policies for New Tables:**
   - Must apply `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + tenant isolation policies in migration SQL and `prisma/rls-policies.sql` for all new tenant-owned tables (`tenant_settings`, `outlet_settings`, `invitations`, `sessions`).

### 3.3 Missing Backend Infrastructure & API Contracts
1. **Redis & BullMQ Foundation Absent (`docker-compose.yml`, `apps/api`):**
   - `redis` in `docker-compose.yml` is gated behind `profiles: ["scale"]`. `ioredis`, `bullmq`, and `@nestjs/bullmq` are not installed.
   - Fix: Enable `redis` in default `docker-compose.yml`, add `REDIS_URL` config validation, implement `RedisModule` + `QueueModule` (`BullModule`) with `onboarding-events` / `audit-events` foundation queues and graceful test/offline handling.
2. **Missing Milestone 1 REST Endpoints:**
   - `GET /api/v1/users/me` (and `PATCH /api/v1/users/me`) — currently only `GET /api/v1/auth/me` exists.
   - `GET /api/v1/tenants/current`, `PATCH /api/v1/tenants/current` (plus settings) — missing.
   - `POST /api/v1/outlets`, `GET /api/v1/outlets`, `GET /api/v1/outlets/:id`, `PATCH /api/v1/outlets/:id` (plus `POST /api/v1/auth/switch-outlet` and `invitations`/`roles` endpoints) — currently only single-outlet `/outlet/profile` exists!
   - All existing `/outlet/profile`, `/outlet/onboarding`, and Phase 2–7 routes must remain intact.
3. **Authorization Matrix (`@RequirePermissions` + `PermissionsGuard`):**
   - Currently only role-based checks (`@Roles`) exist. Add granular permission decorator & `PermissionsGuard` backed by `@autonex/permissions`.

### 3.4 Frontend, Package Structure & Testing Gaps
1. **No `shadcn/ui` or `@autonex/ui`:** Current frontend uses bespoke Tailwind markup with hardcoded colors (`bg-brand-600`). Must configure Tailwind CSS design tokens (CSS variables), `shadcn/ui` (`components.json`), and shared `@autonex/ui` primitives (`Button`, `Input`, `Label`, `Card`, `Badge`, `Alert`, `Select`, `Separator`).
2. **No Shared Zod Validation (`@autonex/validation`):** Login and Registration pages rely on browser HTML attributes (`required`, `minLength`) without structured Zod schema validation or shared DTO parity.
3. **Owner Dashboard Shell Scope (`apps/web/src/components/dashboard-shell.tsx`):**
   - Uses a single top horizontal bar cluttered with all Phase 2–7 navigation items and lacks a **sidebar + header + restaurant name + interactive outlet selector** and Milestone 1 **Outlets & Settings / Team & Roles** views (`/dashboard/outlets`, `/dashboard/settings`).
   - Homepage (`/`) currently advertises `"Phase 2 Active"`; update `/` cleanly to reflect the AutoNex Restaurant OS Milestone 1 entry experience while preserving sub-route accessibility.
4. **No Playwright E2E Suite:** Install `@playwright/test` and write Milestone 1 E2E flows (landing, registration Zod validation & submission, login, dashboard sidebar & outlet selector, API-backed outlet/tenant settings, logout).
5. **No Documentation Tree (`docs/`):** Must organize thorough documentation under `docs/audit/`, `docs/architecture/`, `docs/database/`, `docs/security/`, and `docs/product/`.

---

## 4. Preservation & Refactoring Strategy

1. **Preserve Existing Phase 2–7 Capabilities:** Keep `menus`, `tables`, `sessions`, `ordering`, `kitchen`, `billing`, `payments`, `subscriptions`, and `admin` API modules and database tables intact and passing all 74 unit tests and 14 shared tests.
2. **Non-Destructive Monorepo Expansion:**
   - Add `turbo.json` for orchestrated `build`, `lint`, `typecheck`, `test`.
   - Extract and wire `@autonex/types`, `@autonex/validation`, `@autonex/permissions`, `@autonex/auth`, `@autonex/database`, and `@autonex/ui` incrementally, updating `@autonex/shared` to re-export core types cleanly so existing imports continue working seamlessly.
3. **Additive Schema Evolution:** Add Milestone 1 normalized tables (`tenant_settings`, `outlet_settings`, `roles`, `permissions`, `role_permissions`, `invitations`, `sessions`) and nullable `deleted_at` columns via a clean additive migration (`20261112000000_milestone1_foundation`) plus full RLS policies and updated `seed.ts`.
4. **Checkpoint Discipline:** Commit/tag a clean Git checkpoint (`milestone-1-audit-baseline` or local checkpoint commit) before structural edits so rollback is instantaneous.

---

## 5. Baseline Verification Snapshot (Pre-Change)

| Check | Result | Notes |
| :--- | :--- | :--- |
| `pnpm db:validate` | PASS (`exit 0`) | `prisma/schema.prisma` valid |
| `pnpm -r lint` | PASS (`exit 0`) | `shared`, `web`, `api` clean |
| `pnpm -r typecheck` | PASS (`exit 0`) | `shared`, `web`, `api` clean |
| `pnpm -r test` | PASS (`exit 0`) | `@autonex/shared`: 14/14; `@autonex/api`: 74/74 across 12 suites |
| `pnpm --filter @autonex/api test:rls` | NOT EXECUTED | No local PostgreSQL running on `localhost:5432` |
| Playwright E2E | MISSING | `@playwright/test` not yet installed |

