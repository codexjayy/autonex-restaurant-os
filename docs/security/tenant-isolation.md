# Multi-Tenant Data Isolation Architecture

AutoNex Restaurant OS uses **defense-in-depth multi-tenant isolation** so a bug in one layer cannot leak or mutate another restaurant's data.

## Layer 1: PostgreSQL Row-Level Security (`prisma/rls-policies.sql`)

- Least-privilege database role `autonex_app` runs normal API transactions inside `PrismaService.runInTenantTx(fn, tenantId)`.
- Every tenant transaction sets transaction-local session variable:
  ```sql
  SELECT set_config('app.current_tenant_id', <tenantId>, true);
  ```
- RLS policies enforce `tenant_id = current_tenant_id_or_null()` across all tenant-scoped tables, including Milestone 1 tables (`outlets`, `tenant_settings`, `outlet_settings`, `memberships`, `refresh_tokens`, `sessions`, `invitations`, `audit_logs`) and Phase 2–7 operational/billing tables.
- Cross-tenant reads return 0 rows and cross-tenant writes raise PostgreSQL policy violations.

## Layer 2: Application-Layer Prisma Query Guard (`@autonex/database`)

- `TENANT_SCOPED_MODELS` in `packages/database/src/tenant-guard.ts` covers all 29 tenant-owned Prisma models plus special rules for `Tenant` and `Role`.
- `createTenantScopedExtension(tenantId)` binds `applyTenantQueryGuard()` onto the transaction client inside `PrismaService.runInTenantTx()`:
  - Validates `tenantId` is a valid UUID (`TENANT_CONTEXT_MISSING`).
  - Automatically injects `tenantId` on scoped reads/updates/deletes and writes.
  - Throws `403 FORBIDDEN` (`ForbiddenException`) if any query, write payload, or `findUnique` result belongs to a different `tenantId`.

## Layer 3: HTTP Guard & Context Enforcement

- `JwtAuthGuard` derives `tenantId`, `outletId`, `role`, and `isSuperAdmin` exclusively from signed JWT claims — client `x-tenant-id` header spoofing is rejected with `403 FORBIDDEN`.
- `PermissionsGuard` enforces `@RequirePermissions(...)` per action; `RolesGuard` enforces `@Roles(...)`.
- `Outlet` switching (`POST /api/v1/auth/switch-outlet`) verifies an active, non-deleted `Membership` inside the caller's own `tenantId` before issuing updated outlet-scoped tokens.

