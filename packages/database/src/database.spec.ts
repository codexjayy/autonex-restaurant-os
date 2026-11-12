import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TENANT_SCOPED_MODELS,
  TenantIsolationError,
  applyTenantQueryGuard,
} from './tenant-guard';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

test('TENANT_SCOPED_MODELS covers Milestone 1 and Phase 1-7 tenant-owned tables', () => {
  for (const model of [
    'Outlet',
    'TenantSettings',
    'OutletSettings',
    'Membership',
    'Session',
    'Invitation',
    'Bill',
    'PaymentAttempt',
    'Subscription',
    'SupportCase',
  ]) {
    assert.equal(TENANT_SCOPED_MODELS.has(model), true, `Missing ${model}`);
  }
});

test('applyTenantQueryGuard blocks cross-tenant access on TenantSettings and OutletSettings', async () => {
  await assert.rejects(
    () =>
      applyTenantQueryGuard({
        tenantId: TENANT_A,
        model: 'TenantSettings',
        operation: 'findFirst',
        args: { where: { tenantId: TENANT_B } },
        query: async (a) => a,
      }),
    TenantIsolationError,
  );

  const scoped = (await applyTenantQueryGuard({
    tenantId: TENANT_A,
    model: 'OutletSettings',
    operation: 'findMany',
    args: { where: {} },
    query: async (a) => a,
  })) as { where: Record<string, unknown> };

  assert.equal(scoped.where.tenantId, TENANT_A);
});

test('applyTenantQueryGuard preserves Role OR filters and blocks cross-tenant or system Role abuse', async () => {
  const scopedWithOr = (await applyTenantQueryGuard({
    tenantId: TENANT_A,
    model: 'Role',
    operation: 'findMany',
    args: { where: { OR: [{ name: 'Owner' }, { name: 'Cashier' }] } },
    query: async (a) => a,
  })) as { where: { AND?: unknown[] } };

  assert.equal(Array.isArray(scopedWithOr.where.AND), true);
  assert.equal(scopedWithOr.where.AND?.length, 2);

  await assert.rejects(
    () =>
      applyTenantQueryGuard({
        tenantId: TENANT_A,
        model: 'Role',
        operation: 'findUnique',
        args: { where: { id: 'role-b' } },
        query: async () => ({ id: 'role-b', tenantId: TENANT_B, name: 'Custom B' }),
      }),
    TenantIsolationError,
  );

  const systemRole = (await applyTenantQueryGuard({
    tenantId: TENANT_A,
    model: 'Role',
    operation: 'findUnique',
    args: { where: { id: 'role-sys' } },
    query: async () => ({ id: 'role-sys', tenantId: null, name: 'Owner' }),
  })) as { id: string; tenantId: null };
  assert.equal(systemRole.tenantId, null);

  await assert.rejects(
    () =>
      applyTenantQueryGuard({
        tenantId: TENANT_A,
        model: 'Role',
        operation: 'updateMany',
        args: { where: { tenantId: TENANT_B }, data: { name: 'Hijacked' } },
        query: async (a) => a,
      }),
    TenantIsolationError,
  );

  await assert.rejects(
    () =>
      applyTenantQueryGuard({
        tenantId: TENANT_A,
        model: 'Role',
        operation: 'create',
        args: { data: { name: 'System Spoof', tenantId: null } },
        query: async (a) => a,
      }),
    TenantIsolationError,
  );
});

