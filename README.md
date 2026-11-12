# AutoNex Restaurant OS

Multi-tenant QR ordering, real-time Kitchen Display (KDS), and GST/UPI billing OS built for local Indian restaurants.

![Next.js](https://img.shields.io/badge/Next.js-App_Router-black?logo=next.js)
![NestJS](https://img.shields.io/badge/NestJS-Modular_Monolith-E0234E?logo=nestjs)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16_+_RLS-4169E1?logo=postgresql)
![Prisma](https://img.shields.io/badge/Prisma-ORM-2D3748?logo=prisma)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker)

## Quick Start

```bash
- cp .env.example .env && pnpm install
- docker compose up -d postgres redis
+ cp .env.example .env && pnpm install
+ docker compose up -d postgres redis
- pnpm db:generate && pnpm db:migrate && pnpm db:seed
+ pnpm db:generate && pnpm db:deploy && pnpm db:seed
  pnpm dev
```

For RLS role setup, Docker full-stack mode, and troubleshooting, see [setup.md](./setup.md) and [docs/architecture/system-architecture.md](./docs/architecture/system-architecture.md).

## Documentation

- [Product Requirements (PRD)](./prd.md) · [System Architecture](./docs/architecture/system-architecture.md) · [90-Day Execution Plan](./plan.md)
- [Database Design](./docs/database/schema.md) · [Authentication & Sessions](./docs/security/authentication.md) · [Tenant Isolation & RLS](./docs/security/tenant-isolation.md)
- [Milestone 1 Audit](./docs/audit/milestone-1-audit.md) · [Milestone 1 Completion Report](./docs/product/milestone-1-completion.md)
- [API Contract](./api.md) · [Local & Docker Setup](./setup.md) · [Prisma Schema](./prisma/schema.prisma) · [PostgreSQL RLS Policies](./prisma/rls-policies.sql)

## Project Structure

```text
autonex-restaurant-os/
├── apps/
│   ├── web/                # Next.js App Router (Auth, Onboarding, Team, Outlets, Settings, Floor/KDS)
│   └── api/                # NestJS Modular Monolith (REST API, RBAC, Auth, Outbox Relay)
├── packages/
│   ├── types/              # Shared API contracts, pagination & DTO interfaces
│   ├── permissions/        # Canonical RBAC permission catalog & role mappings
│   ├── validation/         # Shared Zod schemas (Indian phone, PIN, GSTIN, auth, tenants)
│   ├── auth/               # Argon2id password/PIN hashing, JWT, HMAC-SHA256 tokens
│   ├── database/           # Prisma singleton, tenant query guard & CLS context
│   ├── ui/                 # Shared Tailwind + Radix UI primitives
│   └── shared/             # Domain enums, paise/GST math helpers, legacy compat
├── prisma/                 # schema.prisma, migrations, rls-policies.sql, seed.ts
└── docs/                   # Architecture, database, security & milestone reports
```

## Contributing

- Fork or branch off `main` (`feat/<module>-<short-desc>` or `fix/<issue>`).
- Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm --filter @autonex/api test:rls` before opening a PR.
- Keep `prisma/schema.prisma`, `database.md`, and `api.md` updated with any schema or contract changes.

## License

Licensed under the [MIT License](https://opensource.org/licenses/MIT).
