import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { createTenantScopedExtension } from '../src/common/prisma/prisma.service';

describe('PostgreSQL Live RLS Cross-Tenant Isolation', () => {
  const adminDb = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } },
  });
  const appDb = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
  });

  const tenantAId = randomUUID();
  const tenantBId = randomUUID();
  const outletAId = randomUUID();
  const outletBId = randomUUID();

  beforeAll(async () => {
    await adminDb.$connect();
    await appDb.$connect();

    await adminDb.tenant.createMany({
      data: [
        { id: tenantAId, name: 'RLS Tenant A', slug: `rls-a-${tenantAId.slice(0, 6)}`, status: 'ACTIVE' },
        { id: tenantBId, name: 'RLS Tenant B', slug: `rls-b-${tenantBId.slice(0, 6)}`, status: 'ACTIVE' },
      ],
    });
    await adminDb.outlet.createMany({
      data: [
        { id: outletAId, tenantId: tenantAId, name: 'Outlet A', contactPhone: '+919900000001' },
        { id: outletBId, tenantId: tenantBId, name: 'Outlet B', contactPhone: '+919900000002' },
      ],
    });
  });

  afterAll(async () => {
    await adminDb.outlet.deleteMany({ where: { id: { in: [outletAId, outletBId] } } });
    await adminDb.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
    await adminDb.$disconnect();
    await appDb.$disconnect();
  });

  it('returns 0 rows for autonex_app when app.current_tenant_id is not set', async () => {
    const rows = await appDb.outlet.findMany();
    expect(rows).toHaveLength(0);
  });

  it('isolates Tenant A and Tenant B rows strictly via SET LOCAL under RLS', async () => {
    const visibleToA = await appDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantAId}, true)`;
      return tx.outlet.findMany();
    });

    expect(visibleToA).toHaveLength(1);
    expect(visibleToA[0]?.id).toBe(outletAId);

    const crossRead = await appDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantAId}, true)`;
      return tx.outlet.findMany({ where: { tenantId: tenantBId } });
    });
    expect(crossRead).toHaveLength(0);
  });

  it('blocks autonex_app from inserting a row for Tenant B while scoped to Tenant A', async () => {
    await expect(
      appDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantAId}, true)`;
        return tx.outlet.create({
          data: {
            tenantId: tenantBId,
            name: 'Injected Outlet',
            contactPhone: '+919900000099',
          },
        });
      }),
    ).rejects.toThrow();
  });

  it('prevents cross-tenant reads on Milestone 1 tables (tenant_settings, outlet_settings, invitations, sessions)', async () => {
    const crossReads = await appDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantAId}, true)`;
      const [ts, os, inv, sess] = await Promise.all([
        tx.tenantSettings.findMany({ where: { tenantId: tenantBId } }),
        tx.outletSettings.findMany({ where: { tenantId: tenantBId } }),
        tx.invitation.findMany({ where: { tenantId: tenantBId } }),
        tx.session.findMany({ where: { tenantId: tenantBId } }),
      ]);
      return { ts, os, inv, sess };
    });

    expect(crossReads.ts).toHaveLength(0);
    expect(crossReads.os).toHaveLength(0);
    expect(crossReads.inv).toHaveLength(0);
    expect(crossReads.sess).toHaveLength(0);
  });

  it('enforces Layer 1 extension and Layer 2 PostgreSQL RLS together via client.$extends().$transaction()', async () => {
    const scopedClient = appDb.$extends(createTenantScopedExtension(tenantAId));

    const visibleToA = await scopedClient.$transaction(async (scopedTx) => {
      await scopedTx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantAId}, true)`;
      return scopedTx.outlet.findMany();
    });

    expect(visibleToA).toHaveLength(1);
    expect(visibleToA[0]?.id).toBe(outletAId);

    await expect(
      scopedClient.$transaction(async (scopedTx) => {
        await scopedTx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantAId}, true)`;
        return scopedTx.outlet.findMany({ where: { tenantId: tenantBId } });
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

