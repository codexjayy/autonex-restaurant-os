# AutoNex Restaurant OS

Multi-tenant QR ordering, real-time Kitchen Display (KDS), and GST/UPI billing OS built for local Indian restaurants.

![Next.js](https://img.shields.io/badge/Next.js-App_Router-black?logo=next.js)
![NestJS](https://img.shields.io/badge/NestJS-Modular_Monolith-E0234E?logo=nestjs)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16_+_RLS-4169E1?logo=postgresql)
![Prisma](https://img.shields.io/badge/Prisma-ORM-2D3748?logo=prisma)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker)

## Quick Start

```bash
cp .env.example .env && pnpm install
docker compose up -d postgres
pnpm db:generate && pnpm db:migrate && pnpm db:seed
pnpm dev
```

For RLS role setup, Docker full-stack mode, and troubleshooting, see [setup.md](./setup.md).

## Documentation

- [Product Requirements (PRD)](./prd.md) · [System Architecture](./architecture.md) · [90-Day Execution Plan](./plan.md)
- [Database Design](./database.md) · [API & WebSocket Contract](./api.md) · [Local & Docker Setup](./setup.md)
- [Prisma Schema](./prisma/schema.prisma) · [PostgreSQL RLS Policies](./prisma/rls-policies.sql)

## Project Structure

```text
autonex-restaurant-os/
├── apps/
│   ├── web/         # Next.js (Customer QR, Waiter POS, KDS, Owner, Admin)
│   └── api/         # NestJS Modular Monolith (11 domain modules + Outbox Relay)
├── packages/shared/ # Shared DTOs, enums, and paise/GST helpers
├── prisma/          # schema.prisma, rls-policies.sql, migrations, seed.ts
└── *.md             # PRD, architecture, plan, database, API & setup docs
```

## Contributing

- Fork or branch off `main` (`feat/<module>-<short-desc>` or `fix/<issue>`).
- Run `pnpm lint`, `pnpm typecheck`, and `pnpm --filter api test:rls` before opening a PR.
- Keep `prisma/schema.prisma`, `database.md`, and `api.md` updated with any schema or contract changes.

## License

Licensed under the [MIT License](https://opensource.org/licenses/MIT).
