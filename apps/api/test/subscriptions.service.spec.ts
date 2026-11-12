import { ConflictException, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ErrorCode,
  StaffRole,
  SubscriptionBillingCycle,
  SubscriptionStatus,
  SupportCaseCategory,
  SupportCasePriority,
  SYSTEM_ROLE_SUPER_ADMIN,
  TenantStatus,
} from '@autonex/shared';
import { TenantContextService } from '../src/common/context/tenant-context.service';
import { ALLOW_DURING_LOCK_KEY } from '../src/common/decorators/allow-during-lock.decorator';
import { ALLOW_PENDING_TENANT_KEY } from '../src/common/decorators/allow-pending-tenant.decorator';
import { TenantStatusGuard } from '../src/common/guards/tenant-status.guard';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { OrderingService } from '../src/modules/ordering/ordering.service';
import { SubscriptionsService } from '../src/modules/subscriptions/subscriptions.service';
import { SupportCasesService } from '../src/modules/subscriptions/support-cases.service';
import { TablesService } from '../src/modules/tables/tables.service';

describe('SubscriptionsService, SupportCasesService & Read-Only Lock Lifecycle (Phase 7)', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const outletId = '22222222-2222-4222-8222-222222222222';
  const ownerUserId = '33333333-3333-4333-8333-333333333333';
  const adminUserId = '44444444-4444-4444-8444-444444444444';
  const planId = '55555555-5555-4555-8555-555555555555';

  const ownerPrincipal = {
    userId: ownerUserId,
    tenantId,
    outletId,
    membershipId: 'mem-owner-1',
    role: StaffRole.OWNER,
    isSuperAdmin: false,
    tenantStatus: TenantStatus.ACTIVE,
  };

  const superAdminPrincipal = {
    userId: adminUserId,
    role: SYSTEM_ROLE_SUPER_ADMIN,
    isSuperAdmin: true,
  };

  it('transitions expired trial -> grace -> locked automatically during sweepExpiredSubscriptions and logs audit trail', async () => {
    const now = new Date('2026-11-20T10:00:00.000Z');
    const trialEndedYesterday = new Date('2026-11-19T09:00:00.000Z');
    const expiredGraceDate = new Date('2026-11-18T09:00:00.000Z');

    const auditCreates: Array<Record<string, unknown>> = [];

    // Scenario A: Trial expired 1 day ago (still within 3-day grace period) -> GRACE
    let subState = {
      id: 'sub-1',
      tenantId,
      planId,
      status: 'TRIAL',
      billingCycle: 'MONTHLY',
      startedAt: new Date('2026-11-05T09:00:00.000Z'),
      trialEndsAt: trialEndedYesterday,
      currentPeriodStart: new Date('2026-11-05T09:00:00.000Z'),
      currentPeriodEnd: trialEndedYesterday,
      graceEndsAt: new Date('2026-11-22T09:00:00.000Z'),
      suspendedAt: null,
      cancelledAt: null,
      autoRenew: true,
      plan: {
        id: planId,
        code: 'STARTER',
        name: 'Starter',
        description: 'Starter plan',
        monthlyPricePaise: 99900,
        yearlyPricePaise: 999000,
        maxOutlets: 1,
        maxTables: 20,
        maxStaff: 10,
        trialDays: 14,
        graceDays: 3,
        featuresJson: ['QR Ordering', 'KDS'],
        isActive: true,
        sortOrder: 1,
      },
    };
    let tenantState = {
      id: tenantId,
      status: 'TRIAL',
      pendingSuspensionAfterService: false,
    };

    const txMock = {
      subscription: {
        findMany: jest.fn(async () => [{ tenantId, status: subState.status }]),
        findUnique: jest.fn(async () => subState),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          subState = { ...subState, ...data } as typeof subState;
          return subState;
        }),
      },
      tenant: {
        findUnique: jest.fn(async () => tenantState),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          tenantState = { ...tenantState, ...data } as typeof tenantState;
          return tenantState;
        }),
      },
      diningSession: {
        count: jest.fn(async () => 0),
      },
      membership: {
        findFirst: jest.fn(async () => ({ userId: ownerUserId })),
      },
      auditLog: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          auditCreates.push(data);
          return data;
        }),
      },
    };
    const dbMock = {
      ...txMock,
      $transaction: jest.fn(async (cb: (tx: typeof txMock) => Promise<unknown>) => cb(txMock)),
    };

    const prismaMock = {
      runAsSystemAdmin: jest.fn(async (cb: (db: typeof dbMock) => Promise<unknown>) => cb(dbMock)),
    } as unknown as PrismaService;

    const service = new SubscriptionsService(prismaMock, new TenantContextService());

    const graceSweep = await service.sweepExpiredSubscriptions(now);
    expect(graceSweep.transitionedCount).toBe(1);
    expect(graceSweep.graceTenantIds).toEqual([tenantId]);
    expect(subState.status).toBe(SubscriptionStatus.GRACE);
    expect(tenantState.status).toBe(TenantStatus.GRACE);
    expect(auditCreates[0]?.action).toBe('SUBSCRIPTION_AUTO_TRANSITION');

    // Scenario B: Grace period also elapsed -> EXPIRED + Tenant LOCKED
    subState = {
      ...subState,
      trialEndsAt: new Date('2026-11-15T09:00:00.000Z'),
      graceEndsAt: expiredGraceDate,
    };
    const lockSweep = await service.sweepExpiredSubscriptions(now);
    expect(lockSweep.transitionedCount).toBe(1);
    expect(lockSweep.lockedTenantIds).toEqual([tenantId]);
    expect(subState.status).toBe(SubscriptionStatus.EXPIRED);
    expect(tenantState.status).toBe(TenantStatus.LOCKED);
    expect(auditCreates).toHaveLength(2);
  });

  it('allows KDS/billing/daily-summary routes when LOCKED while blocking new menus, tables, and orders', async () => {
    // 1. TenantStatusGuard tests on LOCKED tenant
    const metadataMap = new Map<string, unknown>();
    const reflector = {
      getAllAndOverride: (key: string) => metadataMap.get(key) ?? false,
    } as unknown as Reflector;
    const guard = new TenantStatusGuard(reflector);

    const makeCtx = (method: string) =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({
            method,
            user: { ...ownerPrincipal, tenantStatus: TenantStatus.LOCKED },
          }),
        }),
        getHandler: () => ({}),
        getClass: () => ({}),
      }) as unknown as ExecutionContext;

    // GET routes (including /subscriptions/daily-summary) allowed in LOCKED
    expect(guard.canActivate(makeCtx('GET'))).toBe(true);

    // Mutating non-settlement POST (e.g., creating a menu item or new table) blocked with SUBSCRIPTION_LOCKED
    try {
      guard.canActivate(makeCtx('POST'));
      fail('Expected ForbiddenException for mutating route on LOCKED tenant');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        code: ErrorCode.SUBSCRIPTION_LOCKED,
      });
    }

    // Settlement / KDS / Billing routes annotated with @AllowDuringLockOrSettlement allowed even via POST/PATCH
    metadataMap.set(ALLOW_DURING_LOCK_KEY, true);
    expect(guard.canActivate(makeCtx('POST'))).toBe(true);
    expect(guard.canActivate(makeCtx('PATCH'))).toBe(true);
    metadataMap.clear();
    metadataMap.set(ALLOW_PENDING_TENANT_KEY, true);
    expect(guard.canActivate(makeCtx('POST'))).toBe(true);

    // 2. OrderingService blocks new table opening, staff order, QR join & QR order when LOCKED
    const txOrderingMock = {
      tenant: { findUnique: jest.fn(async () => ({ status: TenantStatus.LOCKED })) },
    };
    const prismaOrderingMock = {
      runInTenantTx: jest.fn(async (cb: (tx: typeof txOrderingMock) => Promise<unknown>) =>
        cb(txOrderingMock),
      ),
    } as unknown as PrismaService;
    const tablesServiceMock = {
      verifyQrTokenAndGetTable: jest.fn(async () => ({
        tenant_id: tenantId,
        outlet_id: outletId,
        table_id: 'table-1',
        tenant_status: TenantStatus.LOCKED,
      })),
    } as unknown as TablesService;

    const orderingService = new OrderingService(
      prismaOrderingMock,
      new TenantContextService(),
      tablesServiceMock,
    );

    await expect(orderingService.openTableSession(ownerPrincipal, 'table-1')).rejects.toThrow(
      ForbiddenException,
    );
    await expect(
      orderingService.placeStaffOrder(
        ownerPrincipal,
        { tableId: 'table-1', items: [] } as never,
        'idem-staff-locked-1234',
      ),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      orderingService.joinSessionViaQr('raw-qr-token-valid-123456', {
        displayLabel: 'Aarav',
        joinCode: '1234',
      }),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      orderingService.placeCustomerOrder(
        'raw-qr-token-valid-123456',
        'valid-guest-token-greater-than-20-chars',
        { items: [] } as never,
        'idem-cust-locked-1234',
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('creates plans cleanly (rejecting duplicate codes), assigns paid subscription & computes 18% GST invoice in integer paise', async () => {
    let existingCode = false;
    const invoicesCreated: Array<Record<string, unknown>> = [];
    const auditLogs: Array<Record<string, unknown>> = [];

    const txPlanMock = {
      plan: {
        findUnique: jest.fn(async ({ where }: { where: { code?: string; id?: string } }) => {
          if (where.code && existingCode) return { id: planId, code: where.code };
          if (where.id === planId) {
            return {
              id: planId,
              code: 'GROWTH',
              name: 'Growth Plan',
              description: 'Full suite',
              monthlyPricePaise: 199900,
              yearlyPricePaise: 1999000,
              maxOutlets: 3,
              maxTables: 60,
              maxStaff: 35,
              trialDays: 14,
              graceDays: 3,
              featuresJson: ['KDS', 'GST Reports'],
              isActive: true,
              sortOrder: 2,
            };
          }
          return null;
        }),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: planId,
          ...data,
          isActive: true,
        })),
      },
      tenant: {
        findUnique: jest.fn(async () => ({
          id: tenantId,
          status: TenantStatus.LOCKED,
          pendingSuspensionAfterService: false,
        })),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => data),
      },
      subscription: {
        findUnique: jest.fn(async () => ({
          id: 'sub-1',
          tenantId,
          planId,
          status: 'ACTIVE',
          billingCycle: 'MONTHLY',
          startedAt: new Date(),
          trialEndsAt: null,
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
          graceEndsAt: new Date(Date.now() + 33 * 86400_000),
          suspendedAt: null,
          cancelledAt: null,
          autoRenew: true,
          plan: {
            id: planId,
            code: 'GROWTH',
            name: 'Growth Plan',
            description: 'Full suite',
            monthlyPricePaise: 199900,
            yearlyPricePaise: 1999000,
            maxOutlets: 3,
            maxTables: 60,
            maxStaff: 35,
            trialDays: 14,
            graceDays: 3,
            featuresJson: ['KDS'],
            isActive: true,
            sortOrder: 2,
          },
        })),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'sub-1',
          tenantId,
          startedAt: new Date(),
          trialEndsAt: null,
          autoRenew: true,
          ...data,
          plan: {
            id: planId,
            code: 'GROWTH',
            name: 'Growth Plan',
            description: 'Full suite',
            monthlyPricePaise: 199900,
            yearlyPricePaise: 1999000,
            maxOutlets: 3,
            maxTables: 60,
            maxStaff: 35,
            trialDays: 14,
            graceDays: 3,
            featuresJson: ['KDS'],
            isActive: true,
            sortOrder: 2,
          },
        })),
      },
      diningSession: { count: jest.fn(async () => 0) },
      subscriptionInvoice: {
        count: jest.fn(async () => 4),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const rec = {
            id: 'inv-5',
            createdAt: new Date(),
            ...data,
            plan: { name: 'Growth Plan' },
          };
          invoicesCreated.push(rec);
          return rec;
        }),
      },
      auditLog: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          auditLogs.push(data);
          return data;
        }),
      },
    };
    const dbMock = {
      ...txPlanMock,
      $transaction: jest.fn(async (cb: (tx: typeof txPlanMock) => Promise<unknown>) =>
        cb(txPlanMock),
      ),
    };

    const prismaMock = {
      runAsSystemAdmin: jest.fn(async (cb: (db: typeof dbMock) => Promise<unknown>) => cb(dbMock)),
    } as unknown as PrismaService;

    const service = new SubscriptionsService(prismaMock, new TenantContextService());

    const createdPlan = await service.createPlan(superAdminPrincipal, {
      code: 'growth',
      name: 'Growth Plan',
      monthlyPricePaise: 199900,
      yearlyPricePaise: 1999000,
      features: ['KDS', 'GST Reports'],
    });
    expect(createdPlan.code).toBe('GROWTH');
    expect(auditLogs[0]?.action).toBe('PLAN_CREATED');

    existingCode = true;
    await expect(
      service.createPlan(superAdminPrincipal, {
        code: 'GROWTH',
        name: 'Dup',
        monthlyPricePaise: 1000,
        yearlyPricePaise: 10000,
      }),
    ).rejects.toThrow(ConflictException);

    const assigned = await service.assignOrUpdateSubscription(superAdminPrincipal, tenantId, {
      planId,
      status: SubscriptionStatus.ACTIVE,
      billingCycle: SubscriptionBillingCycle.MONTHLY,
      paymentReference: 'UPI-HDFC-9988',
    });

    expect(assigned.invoice?.amountPaise).toBe(199900);
    expect(assigned.invoice?.taxPaise).toBe(35982); // exact Math.round(199900 * 0.18) integer paise
    expect(assigned.invoice?.totalPaise).toBe(235882);
    expect(auditLogs.some((a) => a.action === 'SUBSCRIPTION_UPDATED')).toBe(true);
  });

  it('strips internal admin notes from Owner support case queries while exposing them to Super Admin', async () => {
    const notesStore = [
      {
        id: 'note-public',
        tenantId,
        supportCaseId: 'case-1',
        authorUserId: adminUserId,
        authorRole: SYSTEM_ROLE_SUPER_ADMIN,
        body: 'We checked your GST template and updated it.',
        isInternal: false,
        createdAt: new Date(),
        authorUser: { name: 'Platform Support' },
      },
      {
        id: 'note-secret-internal',
        tenantId,
        supportCaseId: 'case-1',
        authorUserId: adminUserId,
        authorRole: SYSTEM_ROLE_SUPER_ADMIN,
        body: 'INTERNAL: Escalate high-churn risk account to L2 billing.',
        isInternal: true,
        createdAt: new Date(),
        authorUser: { name: 'Platform Support' },
      },
    ];

    const caseRow = {
      id: 'case-1',
      caseNumber: 'SUP-202611-0001',
      tenantId,
      outletId,
      category: SupportCaseCategory.BILLING,
      priority: SupportCasePriority.HIGH,
      status: 'IN_PROGRESS',
      subject: 'Need yearly invoice copy',
      description: 'Please share GST invoice copy.',
      resolutionNotes: null,
      resolvedAt: null,
      closedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      tenant: { name: 'Spice Junction' },
      notes: notesStore,
    };

    const txMock = {
      supportCase: {
        findMany: jest.fn(async ({ include }: { include: { notes: { where?: { isInternal?: boolean } } } }) => [
          {
            ...caseRow,
            notes:
              include.notes.where?.isInternal === false
                ? notesStore.filter((n) => !n.isInternal)
                : notesStore,
          },
        ]),
        findFirst: jest.fn(async () => caseRow),
        findUnique: jest.fn(async () => caseRow),
      },
    };

    const prismaMock = {
      runInTenantTx: jest.fn(async (cb: (tx: typeof txMock) => Promise<unknown>) => cb(txMock)),
      runAsSystemAdmin: jest.fn(async (cb: (db: typeof txMock) => Promise<unknown>) => cb(txMock)),
    } as unknown as PrismaService;

    const supportService = new SupportCasesService(prismaMock, new TenantContextService());

    // Owner view MUST exclude isInternal notes even if returned in raw array (belt-and-suspenders filter in mapCaseDto + query filter)
    const ownerList = await supportService.listTenantSupportCases(ownerPrincipal);
    expect(ownerList[0]?.notes).toHaveLength(1);
    expect(ownerList[0]?.notes?.[0]?.body).not.toContain('INTERNAL');

    const ownerDetail = await supportService.getTenantSupportCase(ownerPrincipal, 'case-1');
    expect(ownerDetail.notes).toHaveLength(1);

    // Super Admin view sees BOTH public and internal notes
    const adminDetail = await supportService.getAdminSupportCase('case-1');
    expect(adminDetail.notes).toHaveLength(2);
    expect(adminDetail.notes?.some((n) => n.isInternal)).toBe(true);
  });
});

