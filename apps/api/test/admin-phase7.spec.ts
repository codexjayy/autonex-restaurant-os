import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  DiningSessionStatus,
  StaffRole,
  SYSTEM_ROLE_SUPER_ADMIN,
  TenantStatus,
} from '@autonex/shared';
import { TenantContextService } from '../src/common/context/tenant-context.service';
import { ALLOW_DURING_LOCK_KEY } from '../src/common/decorators/allow-during-lock.decorator';
import { ROLES_KEY } from '../src/common/decorators/roles.decorator';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { TenantStatusGuard } from '../src/common/guards/tenant-status.guard';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AdminController } from '../src/modules/admin/admin.controller';
import { AdminService } from '../src/modules/admin/admin.service';
import { SessionsService } from '../src/modules/sessions/sessions.service';
import { SubscriptionsService } from '../src/modules/subscriptions/subscriptions.service';
import { TablesService } from '../src/modules/tables/tables.service';

describe('Admin Phase 7 — Mid-Meal Safe Suspension Drain, On/Offboarding, RBAC & Telemetry', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const outletId = '22222222-2222-4222-8222-222222222222';
  const adminUserId = '99999999-9999-4999-8999-999999999999';
  const cashierUserId = '88888888-8888-4888-8888-888888888888';

  const superAdminPrincipal = {
    userId: adminUserId,
    role: SYSTEM_ROLE_SUPER_ADMIN,
    isSuperAdmin: true,
  };

  const cashierPrincipal = {
    userId: cashierUserId,
    tenantId,
    outletId,
    membershipId: 'mem-cashier-1',
    role: StaffRole.CASHIER,
    isSuperAdmin: false,
    tenantStatus: TenantStatus.LOCKED,
  };

  it('defers suspension during active open tables (entering LOCKED drain mode) and auto-completes SUSPENDED + revokes tokens when last table closes', async () => {
    let tenantStatus = TenantStatus.ACTIVE;
    let pendingSuspensionAfterService = false;
    let activeSessionsCount = 1;
    let sessionStatus = DiningSessionStatus.SETTLED;
    const revokedTokens: Array<Record<string, unknown>> = [];
    const auditLogs: Array<Record<string, unknown>> = [];

    const txMock = {
      tenant: {
        findUnique: jest.fn(async () => ({
          id: tenantId,
          status: tenantStatus,
          pendingSuspensionAfterService,
        })),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (typeof data.status === 'string') tenantStatus = data.status as TenantStatus;
          if (typeof data.pendingSuspensionAfterService === 'boolean') {
            pendingSuspensionAfterService = data.pendingSuspensionAfterService;
          }
          return {
            id: tenantId,
            status: tenantStatus,
            pendingSuspensionAfterService,
          };
        }),
      },
      diningSession: {
        count: jest.fn(async () => activeSessionsCount),
        findFirst: jest.fn(async () => ({
          id: 'session-open-1',
          outletId,
          tableId: 'table-1',
          status: sessionStatus,
          orders: [{ id: 'order-1', kitchenStatus: 'SERVED' }],
        })),
        update: jest.fn(async ({ data }: { data: { status: DiningSessionStatus } }) => {
          sessionStatus = data.status;
          activeSessionsCount = 0; // closed final active session
          return {
            id: 'session-open-1',
            tableId: 'table-1',
            status: sessionStatus,
            closedAt: new Date(),
          };
        }),
      },
      bill: {
        findFirst: jest.fn(async () => null),
      },
      sessionGuest: {
        updateMany: jest.fn(async () => ({ count: 2 })),
      },
      restaurantTable: {
        update: jest.fn(async () => ({ id: 'table-1', status: 'AVAILABLE' })),
      },
      outboxEvent: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => data),
      },
      refreshToken: {
        updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          revokedTokens.push(data);
          return { count: 2 };
        }),
      },
      auditLog: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          auditLogs.push(data);
          return data;
        }),
      },
    };
    const dbTxMock = {
      ...txMock,
      $transaction: jest.fn(async (cb: (tx: typeof txMock) => Promise<unknown>) => cb(txMock)),
    };

    const prismaMock = {
      runAsSystemAdmin: jest.fn(async (cb: (db: typeof dbTxMock) => Promise<unknown>) => cb(dbTxMock)),
      runInTenantTx: jest.fn(async (cb: (tx: typeof dbTxMock) => Promise<unknown>) => cb(dbTxMock)),
    } as unknown as PrismaService;

    const adminService = new AdminService(prismaMock, new TenantContextService());

    // Step 1: Super Admin clicks Suspend while Table 1 has active dining session
    const suspendResult = await adminService.suspendRestaurant(superAdminPrincipal, tenantId, {
      reason: 'Non-payment escalation',
    });

    expect(suspendResult.status).toBe(TenantStatus.LOCKED);
    expect(suspendResult.pendingSuspensionAfterService).toBe(true);
    expect(suspendResult.suspensionDeferredForLiveService).toBe(true);
    // CRITICAL: Refresh tokens MUST NOT be revoked mid-meal!
    expect(revokedTokens).toHaveLength(0);
    expect(auditLogs[0]?.action).toBe('RESTAURANT_SUSPENSION_SCHEDULED');

    // Step 2: Cashier closes final settled table session -> triggers auto-completion to SUSPENDED!
    const sessionsService = new SessionsService(
      prismaMock,
      new TenantContextService(),
      {} as TablesService,
    );

    const closeRes = await sessionsService.closeAndResetSession(cashierPrincipal, 'session-open-1', {
      reason: 'Party finished dining & settled bill',
    });

    expect(closeRes.status).toBe(DiningSessionStatus.CLOSED);
    expect(closeRes.suspensionAutoCompleted).toBe(true);
    expect(tenantStatus).toBe(TenantStatus.SUSPENDED);
    expect(pendingSuspensionAfterService).toBe(false);
    expect(revokedTokens).toHaveLength(1);
    expect(auditLogs.some((a) => a.action === 'RESTAURANT_SUSPENDED_COMPLETED')).toBe(true);
  });

  it('rejects non-SUPER_ADMIN roles (OWNER, MANAGER, KITCHEN) on AdminController via RolesGuard', () => {
    const reflector = new Reflector();
    const rolesGuard = new RolesGuard(reflector);
    const tenantStatusGuard = new TenantStatusGuard(reflector);

    const makeAdminCtx = (principal: Record<string, unknown>) =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({ user: principal, method: 'GET' }),
        }),
        getHandler: () => AdminController.prototype.listRestaurants,
        getClass: () => AdminController,
      }) as unknown as ExecutionContext;

    const requiredRoles = reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      AdminController.prototype.listRestaurants,
      AdminController,
    ]);
    expect(requiredRoles).toContain(SYSTEM_ROLE_SUPER_ADMIN);

    for (const deniedRole of [StaffRole.OWNER, StaffRole.MANAGER, StaffRole.KITCHEN, StaffRole.WAITER]) {
      expect(() =>
        rolesGuard.canActivate(
          makeAdminCtx({
            userId: 'user-staff-1',
            tenantId,
            role: deniedRole,
            isSuperAdmin: false,
          }),
        ),
      ).toThrow(ForbiddenException);
    }

    expect(rolesGuard.canActivate(makeAdminCtx(superAdminPrincipal))).toBe(true);
    // Super Admin operates across tenants without a tenantId in TenantStatusGuard
    expect(tenantStatusGuard.canActivate(makeAdminCtx(superAdminPrincipal))).toBe(true);
  });

  it('allows direct Admin onboarding, offboarding + reactivation, and computes platform MRR & telemetry', async () => {
    const auditLogs: Array<Record<string, unknown>> = [];

    const txPlatformMock = {
      user: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'owner-new-1',
          ...data,
        })),
      },
      plan: {
        findFirst: jest.fn(async () => ({
          id: 'plan-starter',
          code: 'STARTER',
          name: 'Starter',
          monthlyPricePaise: 99900,
          yearlyPricePaise: 999000,
          maxOutlets: 1,
          maxTables: 20,
          maxStaff: 10,
          trialDays: 14,
          graceDays: 3,
          featuresJson: [],
          isActive: true,
          sortOrder: 1,
        })),
        findUnique: jest.fn(),
      },
      tenant: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'tenant-new-1',
          ...data,
        })),
        findUnique: jest.fn(async () => ({
          id: 'tenant-new-1',
          status: TenantStatus.ACTIVE,
          pendingSuspensionAfterService: false,
          suspendedAt: null,
        })),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'tenant-new-1',
          ...data,
        })),
        findMany: jest.fn(async () => [
          { id: 'tenant-1', name: 'Spice Junction', status: TenantStatus.ACTIVE },
          { id: 'tenant-2', name: 'Cafe Kathiyawad', status: TenantStatus.TRIAL },
        ]),
      },
      outlet: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'outlet-new-1',
          ...data,
        })),
      },
      membership: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'mem-new-1',
          ...data,
        })),
        groupBy: jest.fn(async () => [
          { tenantId: 'tenant-1', _count: { _all: 6 } },
          { tenantId: 'tenant-2', _count: { _all: 3 } },
        ]),
      },
      subscription: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'sub-new-1',
          ...data,
        })),
        findUnique: jest.fn(async () => ({ id: 'sub-new-1', status: 'SUSPENDED' })),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => data),
        findMany: jest.fn(async () => [
          {
            tenantId: 'tenant-1',
            status: 'ACTIVE',
            billingCycle: 'MONTHLY',
            plan: {
              id: 'p1',
              code: 'GROWTH',
              name: 'Growth',
              monthlyPricePaise: 199900,
              yearlyPricePaise: 1999000,
              graceDays: 3,
            },
          },
          {
            tenantId: 'tenant-2',
            status: 'TRIAL',
            billingCycle: 'MONTHLY',
            plan: {
              id: 'p0',
              code: 'STARTER',
              name: 'Starter',
              monthlyPricePaise: 99900,
              yearlyPricePaise: 999000,
              graceDays: 3,
            },
          },
        ]),
      },
      diningSession: {
        count: jest.fn(async () => 0),
        groupBy: jest.fn(async () => [{ tenantId: 'tenant-1', _count: { _all: 42 } }]),
      },
      order: {
        groupBy: jest.fn(async () => [
          { tenantId: 'tenant-1', _count: { _all: 88 } },
          { tenantId: 'tenant-2', _count: { _all: 12 } },
        ]),
      },
      bill: {
        groupBy: jest.fn(async () => [
          { tenantId: 'tenant-1', _sum: { paidPaise: 2450000 } },
        ]),
      },
      restaurantTable: {
        groupBy: jest.fn(async () => [{ tenantId: 'tenant-1', _count: { _all: 16 } }]),
      },
      supportCase: {
        count: jest.fn(async () => 3),
      },
      refreshToken: {
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      auditLog: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          auditLogs.push(data);
          return data;
        }),
      },
    };
    const dbMock = {
      ...txPlatformMock,
      $transaction: jest.fn(async (cb: (tx: typeof txPlatformMock) => Promise<unknown>) =>
        cb(txPlatformMock),
      ),
    };

    const prismaMock = {
      runAsSystemAdmin: jest.fn(async (cb: (db: typeof dbMock) => Promise<unknown>) => cb(dbMock)),
    } as unknown as PrismaService;

    const adminService = new AdminService(prismaMock, new TenantContextService());
    const subsService = new SubscriptionsService(prismaMock, new TenantContextService());

    const onboarded = await adminService.onboardRestaurant(superAdminPrincipal, {
      restaurantName: 'Kathiyawad Rasoi',
      outletName: 'CG Road',
      ownerName: 'Ramesh Patel',
      ownerEmail: 'ramesh@rasoi.in',
      ownerPhone: '9876543210',
      password: 'Password@123',
      activateImmediately: true,
    });
    expect(onboarded.tenant.status).toBe(TenantStatus.TRIAL);
    expect(auditLogs.some((a) => a.action === 'RESTAURANT_ONBOARDED_BY_ADMIN')).toBe(true);

    const offboarded = await adminService.offboardRestaurant(superAdminPrincipal, 'tenant-new-1', {
      reason: 'Restaurant permanently closed',
    });
    expect(offboarded.status).toBe(TenantStatus.SUSPENDED);
    expect(auditLogs.some((a) => a.action === 'RESTAURANT_OFFBOARDED')).toBe(true);

    const reactivated = await adminService.reactivateRestaurant(superAdminPrincipal, 'tenant-new-1', {
      reason: 'Re-opened under new renewal',
    });
    expect(reactivated.status).toBe(TenantStatus.ACTIVE);
    expect(auditLogs.some((a) => a.action === 'RESTAURANT_REACTIVATED')).toBe(true);

    const { overview, restaurantsTelemetry } = await subsService.getPlatformOverview();
    expect(overview.totalRestaurants).toBe(2);
    expect(overview.mrrPaise).toBe(199900); // Only ACTIVE subscription contributes MRR
    expect(overview.platformOrdersLast30Days).toBe(100);
    expect(overview.platformRevenueLast30DaysPaise).toBe(2450000);
    expect(overview.openSupportCasesCount).toBe(3);
    expect(restaurantsTelemetry[0]?.telemetry.tablesCount).toBe(16);

    // Unused metadata import check to ensure decorator key constant stays aligned
    expect(ALLOW_DURING_LOCK_KEY).toBe('allowDuringLockOrSettlement');
  });
});

