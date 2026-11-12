# Database Schema & Multi-Tenant Model — Milestone 1

Schema source of truth: `prisma/schema.prisma`, versioned migration `prisma/migrations/20261112000000_milestone1_foundation/migration.sql`, and Row-Level Security rules in `prisma/rls-policies.sql`.

## Core Milestone 1 Models

| Model | Table | Scope | Purpose |
| :--- | :--- | :--- | :--- |
| `Tenant` | `tenants` | Root SaaS Tenant | Restaurant brand (`name`, `slug`, `status`, `approvedAt`, `deletedAt`) |
| `TenantSettings` | `tenant_settings` | Tenant-scoped (`tenantId`) | Brand defaults (`currency`, `locale`, `defaultTimezone`, `onboardingCompleted`, `onboardingStep`) |
| `Outlet` | `outlets` | Tenant-scoped (`tenantId`) | Restaurant branches (`name`, `contactPhone`, `address`, `timezone`, `gstin`, `gstRateBps`, `taxMode`, `isActive`, `deletedAt`) |
| `OutletSettings` | `outlet_settings` | Tenant + Outlet scoped | Branch configuration (`taxMode`, `gstRateBps`, `roundOffEnabled`, `requireWaiterApproval`, `tablePinEnabled`, `kdsLanguage`, `receiptFooter`) |
| `User` | `users` | Platform Identity | Staff/owner credentials (`name`, `email`, `phone`, `passwordHash` Argon2id, `isSuperAdmin`, `mfaEnabled`, `deletedAt`) |
| `Role` | `roles` | System (`tenantId IS NULL`) or Tenant | Named RBAC roles (`OWNER`, `MANAGER`, `CASHIER`, `WAITER`, `KITCHEN`) |
| `Permission` | `permissions` | Global Catalog | Normalized capability codes (`tenant:update`, `outlet:create`, `staff:manage`, etc.) |
| `RolePermission` | `role_permissions` | Join Table | Maps `Role` -> `Permission` |
| `Membership` | `memberships` | Tenant + Outlet + User | Per-outlet assignment (`role`, `roleId`, `staffPinHash`, lockout fields, `deletedAt`) |
| `Session` | `sessions` | Tenant + User | Active device login sessions linked by `familyId` (`ipAddress`, `userAgent`, `expiresAt`, `revokedAt`) |
| `RefreshToken` | `refresh_tokens` | Tenant + User | SHA-256 hashed rotating tokens sharing `familyId` for reuse detection |
| `Invitation` | `invitations` | Tenant + Outlet | SHA-256 hashed single-use staff onboarding invites (`status`, `expiresAt`, `acceptedAt`, `revokedAt`) |
| `AuditLog` | `audit_logs` | Tenant-scoped (`tenantId`) | Immutable trail of tenant/outlet/staff/invitation/billing/admin mutations |

## Preserved Phase 2–7 Tables

Menus (`categories`, `menu_items`, `modifier_groups`, `modifier_options`), Dining Tables & QR (`restaurant_tables`, `table_qr_tokens`), Dining Sessions (`dining_sessions`, `session_guests`, `orders`, `order_items`, `order_events`, `outbox_events`), Billing & Payments (`bills`, `bill_lines`, `payment_attempts`, `payment_allocations`, `refunds`, `webhook_events`), and SaaS Admin (`plans`, `subscriptions`, `subscription_invoices`, `support_cases`, `support_case_notes`).

