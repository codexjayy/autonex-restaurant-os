# Milestone 1 Completion Report — AutoNex Restaurant OS

## Summary
Milestone 1 established the multi-tenant SaaS monorepo foundation for **AutoNex Restaurant OS** while preserving all existing Phase 1–7 operational modules (`menus`, `tables`, `sessions`, `ordering`, `kitchen`, `billing`, `payments`, `subscriptions`, `admin`).

## Implemented Scope

### 1. Monorepo & Shared Workspace Packages (`pnpm` + `Turborepo`)
- Added `turbo.json` task pipeline (`build`, `lint`, `typecheck`, `test`, `dev`, `clean`).
- Modular packages added alongside preserved `@autonex/shared`:
  - `packages/types` (`@autonex/types`): canonical enums and DTO contracts (`TenantStatus`, `StaffRole`, `InvitationStatus`, `TaxMode`, `UserMeDto`, `InvitationDto`, `RoleDefinitionDto`).
  - `packages/permissions` (`@autonex/permissions`): canonical `Permissions` catalog and `SYSTEM_ROLE_PERMISSIONS` / `SYSTEM_ROLE_DEFINITIONS`.
  - `packages/validation` (`@autonex/validation`): shared Zod schemas (`registerRestaurantSchema`, `loginSchema`, `staffPinLoginSchema`, `createOutletSchema`, `updateOutletSchema`, `createInvitationSchema`, `acceptInvitationSchema`, `updateTenantSchema`, `switchOutletSchema`).
  - `packages/auth` (`@autonex/auth`): **Argon2id** hashing (`@node-rs/argon2`, `algorithm: 2`, `memoryCost: 19456`, `timeCost: 2`, `parallelism: 1`) with transparent `scrypt:` verification and `needsRehash()` upgrade detection, CSRF token helpers, SHA-256 helpers, and AES-256-GCM QR token crypto.
  - `packages/database` (`@autonex/database`): exports `PrismaClient`, `TENANT_SCOPED_MODELS` (all 29 tenant-owned models plus `Tenant`/`Role`), `applyTenantQueryGuard()`, and `createTenantScopedExtension()` (hardened to preserve `Role` `where.OR`/`AND` filters, block cross-tenant `Role` `findUnique`/`findUniqueOrThrow` reads, and reject cross-tenant/system `Role` writes).
  - `packages/ui` (`@autonex/ui`): shadcn/ui style Radix + CVA + Tailwind components (`Button`, `Input`, `Label`, `Card`, `Badge`, `Alert`, `Select`, `Separator`) emitting compiled declarations and JS artifacts to `dist/`.

### 2. PostgreSQL Schema, Migrations, RLS & Seeding
- Updated `prisma/schema.prisma`: added `InvitationStatus`, soft-delete `deletedAt` on `Tenant`, `Outlet`, `User`, `Membership`, optional `Membership.roleId`, and models `TenantSettings`, `OutletSettings`, `Role`, `Permission`, `RolePermission`, `Invitation`, `Session`.
- Added migration `prisma/migrations/20261112000000_milestone1_foundation/migration.sql`.
- Updated `prisma/rls-policies.sql` with RLS isolation policies on `tenant_settings`, `outlet_settings`, `invitations`, `sessions`, and `roles`.
- Updated `prisma/seed.ts` to seed normalized `Permission`, `Role`, `RolePermission`, `TenantSettings`, `OutletSettings`, and Argon2id credential hashes.

### 3. Security, NestJS Backend & Queue Foundation
- Wired `apps/api/src/common/security/crypto.util.ts` to `@autonex/auth` (Argon2id) and `apps/api/src/common/prisma/prisma.service.ts` to `@autonex/database`.
- Added **NestJS Passport** `JwtStrategy` (`apps/api/src/modules/auth/strategies/jwt.strategy.ts`), integrated with `JwtAuthGuard`.
- Added `PermissionsGuard` (`APP_GUARD`) and `@RequirePermissions(...)`.
- Added double-submit **CSRF protection** (`anx_csrf` cookie + `X-CSRF-Token` validation) alongside HttpOnly `SameSite=Lax` `anx_refresh` cookie, `Session` tracking (`familyId`), and `@Throttle` brute-force protection on auth endpoints.
- Added **Redis + BullMQ** foundation (`apps/api/src/common/queue/`: `QueueModule`, `RedisHealthService`, `OnboardingJobsService`, `OnboardingJobsProcessor`) surfaced via `GET /api/v1/health`.
- Implemented Milestone 1 endpoints:
  - `GET/PATCH /api/v1/users/me`
  - `POST /api/v1/auth/switch-outlet`
  - `GET /api/v1/auth/sessions`, `POST /api/v1/auth/sessions/:sessionId/revoke`
  - `GET/POST /api/v1/auth/invitations`, `POST /api/v1/auth/invitations/:invitationId/revoke`, `POST /api/v1/auth/invitations/accept`
  - `GET/PATCH /api/v1/tenants/current`
  - `GET/POST /api/v1/outlets`, `GET/PATCH/DELETE /api/v1/outlets/:id`
  - `GET /api/v1/roles`

### 4. Frontend App Router Dashboard, shadcn/ui & Playwright E2E
- Configured `apps/web/tailwind.config.ts`, `apps/web/src/app/globals.css`, `apps/web/next.config.mjs`, and `apps/web/components.json`.
- Built/upgraded `/`, `/login`, `/register`, `/invite` (`acceptInvitationSchema` validation + `POST /api/v1/auth/invitations/accept` flow), `DashboardShell` (responsive sidebar + mobile drawer + restaurant status + live header outlet selector + CSRF header propagation), `/dashboard`, `/dashboard/outlets`, `/dashboard/settings` (personal profile via `GET/PATCH /users/me`, restaurant defaults, outlet settings, and active auth sessions), and `/dashboard/team` (invitation generation with `/invite?token=...` shareable link + clipboard copy, direct PIN staff creation via `POST /api/v1/auth/staff`, staff activation toggle, and RBAC matrix).
- Added `apps/web/playwright.config.ts` and `apps/web/e2e/milestone1.spec.ts`.
- Added root `.dockerignore`, synced `README.md` with workspace & `docs/` layout, updated `docker-compose.yml` (Redis enabled by default + wired to `api`), `docker/Dockerfile.api`, `docker/Dockerfile.web`, `.github/workflows/ci.yml` (including Chromium Playwright E2E job step), `.env.example`, and documentation under `docs/`.

## Verification Status (Post-Final-Edit)
- `pnpm build`: Passed (`9/9` packages built via Turborepo cleanly with zero warnings, including `nest build` and `next build` across `19` routes including `/invite`).
- `pnpm lint`: Passed (`16/16` Turborepo tasks succeeded).
- `pnpm typecheck`: Passed (`16/16` Turborepo tasks succeeded) + `tsc --noEmit` on `prisma/seed.ts` exited `0`.
- `pnpm test`: Passed (`16/16` Turborepo tasks succeeded):
  - `@autonex/api`: **14/14 Jest suites, 81/81 tests passed** (includes booted `INestApplication` HTTP integration suite `test/milestone1-http-integration.spec.ts` using an in-memory store wrapped with `@autonex/database` `applyTenantQueryGuard`, `test/milestone1-foundation.spec.ts`, and all Phase 1–7 specs; live DB & Redis disabled/mocked in test env).
  - `@autonex/shared`: **14/14 tests passed** (2 suites).
  - `@autonex/permissions`: **3/3 tests passed**.
  - `@autonex/auth`: **3/3 tests passed**.
  - `@autonex/validation`: **3/3 tests passed**.
  - `@autonex/database`: **3/3 tests passed** (covers `TENANT_SCOPED_MODELS`, `TenantSettings`/`OutletSettings` scoping, and `Role` `OR` filter preservation + cross-tenant/system `Role` guards).
  - `@autonex/ui`: `@autonex/ui primitives ready`.
- `pnpm db:validate`: Passed (`prisma validate`).
- `pnpm test:e2e`: Passed (**4/4 Chromium Playwright specs passed** in 7.8s against live `next start -p 3100`; landing/navigation and form validation specs hit unmocked Next routes, while onboarding, outlets, settings profile/brand updates, team invite link, and `/invite` acceptance specs use deterministic `page.route('**/api/v1/**')` fulfillment when `PLAYWRIGHT_REAL_API` is unset).

## Environment-Blocked Live Infrastructure Checks
Because `docker` CLI, PostgreSQL (`localhost:5432`), and Redis (`localhost:6379`) are not installed or running in this Windows environment:
- `pnpm db:deploy` (`prisma migrate deploy` + `prisma/rls-policies.sql`)
- `pnpm db:seed` (`prisma/seed.ts` execution against live PostgreSQL)
- `pnpm --filter @autonex/api test:rls` (`test/rls-integration.rls-spec.ts` live PostgreSQL RLS verification)
- Live Redis + BullMQ job consumption end-to-end and live-API E2E (`PLAYWRIGHT_REAL_API=1`)

have **not** yet executed against live PostgreSQL/Redis containers and must be run in Docker Compose or GitHub Actions CI before production sign-off.

