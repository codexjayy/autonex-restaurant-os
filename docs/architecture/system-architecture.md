# System Architecture — AutoNex Restaurant OS (Milestone 1 Foundation)

> **Build • Order • Serve • Manage**  
> Cloud multi-tenant SaaS platform built with Turborepo, pnpm workspaces, Next.js App Router, NestJS, PostgreSQL + Prisma + RLS, and Redis + BullMQ.

## Monorepo Layout

```text
apps/
  web/                     Next.js 15 App Router, Tailwind CSS, shadcn/ui, Playwright E2E
  api/                     NestJS 10 REST API, Passport JWT, RBAC guards, Socket.IO, BullMQ
packages/
  types/                   Shared TypeScript contracts & enums (@autonex/types)
  permissions/             Canonical RBAC permission catalog & role matrix (@autonex/permissions)
  validation/              Shared Zod schemas for frontend & backend (@autonex/validation)
  auth/                    Argon2id hashing (@node-rs/argon2), scrypt verification, CSRF & AES-GCM QR (@autonex/auth)
  database/                PrismaClient & Layer 1 tenant isolation guard (@autonex/database)
  ui/                      Shared shadcn/ui Radix + CVA primitives (@autonex/ui)
  shared/                  Legacy domain DTOs, money paise helpers, KDS sync state machine (@autonex/shared)
prisma/
  schema.prisma            Multi-tenant PostgreSQL schema
  migrations/              Versioned Prisma SQL migrations
  rls-policies.sql         PostgreSQL Row-Level Security policies
  seed.ts                  Idempotent Argon2id & RBAC seeder
```

## Request Lifecycle (`@autonex/api`)

1. **Global Middleware & Security (`apps/api/src/main.ts`, `app.module.ts`)**:
   - `helmet()` security headers, `cookieParser()`, strict CORS (`credentials: true`), API prefix `/api/v1`.
   - `TenantContextMiddleware` binds an `AsyncLocalStorage` request scope (`requestId`, `ipAddress`, `userAgent`).
   - Global `ValidationPipe` (`whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`).
2. **Global Guard Pipeline (`APP_GUARD`)**:
   - `ThrottlerGuard` — rate-limiting (with stricter `@Throttle` overrides on `/auth/register`, `/auth/login`, `/auth/staff-pin`, `/auth/invitations/accept`).
   - `JwtAuthGuard` — verifies Bearer JWT using `JwtService` + NestJS Passport `JwtStrategy` (`passport-jwt`), rejects client `x-tenant-id` header spoofing for non-super-admins, populates `TenantContextService`.
   - `RolesGuard` — enforces `@Roles(...)`.
   - `PermissionsGuard` — enforces `@RequirePermissions(...)` against `@autonex/permissions`.
   - `TenantStatusGuard` — gates operational mutations cleanly across `PENDING_APPROVAL`, `TRIAL`, `ACTIVE`, `GRACE`, `LOCKED`, `SUSPENDED`.
3. **Background Queues (`apps/api/src/common/queue/`)**:
   - `QueueModule.register()` configures `@nestjs/bullmq` backed by Redis (`ioredis`) and `OnboardingJobsProcessor`.
   - `RedisHealthService` surfaces live dependency status at `GET /api/v1/health`.
4. **Realtime Foundation (`apps/api/src/modules/kitchen/kitchen.gateway.ts`)**:
   - Socket.IO `/kds` namespace enforcing tenant- and outlet-scoped rooms (`tenant:{tenantId}:outlet:{outletId}`).

