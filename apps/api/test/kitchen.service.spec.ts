import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  DietaryType,
  ErrorCode,
  KitchenStatus,
  OrderSource,
  OutboxStatus,
  StaffRole,
  TenantStatus,
} from '@autonex/shared';
import { TenantContextService } from '../src/common/context/tenant-context.service';
import { AuthenticatedPrincipal } from '../src/common/decorators/current-user.decorator';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { KitchenService } from '../src/modules/kitchen/kitchen.service';

describe('KitchenService — KDS Ticket Board, Acknowledgement & Transitions (Phase 4)', () => {
  const tenantId = '22222222-2222-4222-8222-222222222222';
  const outletId = '33333333-3333-4333-8333-333333333333';
  const otherOutletId = '99999999-9999-4999-8999-999999999999';

  const chefPrincipal: AuthenticatedPrincipal = {
    userId: '11111111-1111-4111-8111-111111111111',
    tenantId,
    outletId,
    membershipId: '55555555-5555-4555-8555-555555555555',
    role: StaffRole.KITCHEN,
    isSuperAdmin: false,
    tenantStatus: TenantStatus.ACTIVE,
  };

  const waiterPrincipal: AuthenticatedPrincipal = {
    userId: '66666666-6666-4666-8666-666666666666',
    tenantId,
    outletId,
    membershipId: '77777777-7777-4777-8777-777777777777',
    role: StaffRole.WAITER,
    isSuperAdmin: false,
    tenantStatus: TenantStatus.ACTIVE,
  };

  function createHarness() {
    const t0 = new Date(Date.now() - 10_000);
    const orders = [
      {
        id: 'order-1',
        tenantId,
        outletId,
        sessionId: 'sess-1',
        roundNumber: 1,
        kotNumber: 101,
        isAddOn: false,
        source: OrderSource.CUSTOMER_QR,
        kitchenStatus: KitchenStatus.NEW,
        subtotalPaise: 31000,
        notes: 'Make fast',
        acknowledgedAt: null as Date | null,
        acknowledgedByMembershipId: null as string | null,
        acknowledgedByMembership: null as { id: string; user: { name: string } } | null,
        acceptedAt: null as Date | null,
        readyAt: null as Date | null,
        servedAt: null as Date | null,
        createdAt: t0,
        updatedAt: t0,
        session: {
          id: 'sess-1',
          table: { id: 'table-4', tableNumber: '4', label: 'Patio 4' },
        },
        items: [
          {
            id: 'item-1',
            menuItemId: 'menu-1',
            itemNameSnapshot: 'Paneer Tikka Masala',
            dietaryTypeSnapshot: DietaryType.VEG,
            quantity: 1,
            modifiersSnapshotJson: [],
            prepNotes: 'Jain',
            status: 'ACTIVE',
          },
        ],
      },
      {
        id: 'order-other-outlet',
        tenantId,
        outletId: otherOutletId,
        sessionId: 'sess-9',
        roundNumber: 1,
        kotNumber: 201,
        isAddOn: false,
        source: OrderSource.CUSTOMER_QR,
        kitchenStatus: KitchenStatus.NEW,
        subtotalPaise: 20000,
        notes: null,
        acknowledgedAt: null as Date | null,
        acknowledgedByMembershipId: null as string | null,
        acknowledgedByMembership: null as { id: string; user: { name: string } } | null,
        acceptedAt: null as Date | null,
        readyAt: null as Date | null,
        servedAt: null as Date | null,
        createdAt: t0,
        updatedAt: t0,
        session: {
          id: 'sess-9',
          table: { id: 'table-9', tableNumber: '9', label: null as string | null },
        },
        items: [] as Array<{
          id: string;
          menuItemId: string;
          itemNameSnapshot: string;
          dietaryTypeSnapshot: DietaryType;
          quantity: number;
          modifiersSnapshotJson: unknown[];
          prepNotes: string | null;
          status: string;
        }>,
      },
    ];

    const orderEvents: Array<Record<string, unknown>> = [];
    const outboxEvents: Array<Record<string, unknown>> = [];
    const auditLogs: Array<Record<string, unknown>> = [];
    let tickMs = t0.getTime();

    const mockTx = {
      order: {
        findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          return orders.filter((o) => {
            if (where.outletId && o.outletId !== where.outletId) return false;
            if (where.updatedAt && typeof where.updatedAt === 'object') {
              const gte = (where.updatedAt as { gte?: Date }).gte;
              if (gte && o.updatedAt < gte) return false;
            }
            if (where.kitchenStatus && typeof where.kitchenStatus === 'object') {
              const inList = (where.kitchenStatus as { in?: string[] }).in;
              if (inList && !inList.includes(o.kitchenStatus)) return false;
            }
            return true;
          });
        }),
        findFirst: jest.fn(async ({ where }: { where: { id: string; outletId: string } }) => {
          return orders.find((o) => o.id === where.id && o.outletId === where.outletId) ?? null;
        }),
        update: jest.fn(
          async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const idx = orders.findIndex((o) => o.id === where.id);
            if (idx === -1) throw new Error('Order not found');
            const prev = orders[idx]!;
            tickMs = Math.max(Date.now(), tickMs) + 1000;

            let nextAckById = prev.acknowledgedByMembershipId;
            let nextAckByObj = prev.acknowledgedByMembership;

            if (typeof data.acknowledgedByMembershipId === 'string') {
              nextAckById = data.acknowledgedByMembershipId;
              nextAckByObj = { id: nextAckById, user: { name: 'Chef Ramesh' } };
            } else if (
              data.acknowledgedByMembership &&
              typeof data.acknowledgedByMembership === 'object' &&
              'connect' in data.acknowledgedByMembership
            ) {
              const connectObj = data.acknowledgedByMembership as { connect: { id: string } };
              nextAckById = connectObj.connect.id;
              nextAckByObj = { id: nextAckById, user: { name: 'Chef Ramesh' } };
            }

            const updated = {
              ...prev,
              ...(data.kitchenStatus ? { kitchenStatus: data.kitchenStatus as KitchenStatus } : {}),
              ...(data.acknowledgedAt ? { acknowledgedAt: data.acknowledgedAt as Date } : {}),
              ...(data.acceptedAt ? { acceptedAt: data.acceptedAt as Date } : {}),
              ...(data.readyAt ? { readyAt: data.readyAt as Date } : {}),
              ...(data.servedAt ? { servedAt: data.servedAt as Date } : {}),
              acknowledgedByMembershipId: nextAckById,
              acknowledgedByMembership: nextAckByObj,
              updatedAt: new Date(tickMs),
            };
            orders[idx] = updated;
            return updated;
          },
        ),
      },
      orderEvent: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          orderEvents.push(data);
          return data;
        }),
      },
      outboxEvent: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          outboxEvents.push(data);
          return data;
        }),
      },
      auditLog: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          auditLogs.push(data);
          return data;
        }),
      },
    };

    const mockPrisma = {
      runInTenantTx: jest.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
    } as unknown as PrismaService;

    const mockContext = {
      get: jest.fn(() => ({ ipAddress: '10.0.0.5' })),
    } as unknown as TenantContextService;

    const service = new KitchenService(mockPrisma, mockContext);
    return { service, orders, orderEvents, outboxEvents, auditLogs };
  }

  it('tracks explicit kitchen acknowledgement cleanly and stays idempotent on repeat taps', async () => {
    const { service, orderEvents, outboxEvents } = createHarness();

    const firstAck = await service.acknowledgeOrder(chefPrincipal, 'order-1');
    expect(firstAck.alreadyAcknowledged).toBe(false);
    expect(firstAck.order.acknowledgedAt).toBeTruthy();
    expect(firstAck.order.acknowledgedByName).toBe('Chef Ramesh');
    expect(orderEvents).toHaveLength(1);
    expect(orderEvents[0]?.eventType).toBe('KOT_ACKNOWLEDGED');
    expect(outboxEvents).toHaveLength(1);
    expect(outboxEvents[0]).toMatchObject({
      topic: 'kot.acknowledged',
      status: OutboxStatus.PENDING,
    });

    // Repeat tap does NOT duplicate events or outbox rows
    const secondAck = await service.acknowledgeOrder(chefPrincipal, 'order-1');
    expect(secondAck.alreadyAcknowledged).toBe(true);
    expect(secondAck.order.acknowledgedAt).toBe(firstAck.order.acknowledgedAt);
    expect(orderEvents).toHaveLength(1);
    expect(outboxEvents).toHaveLength(1);
  });

  it('enforces full NEW -> PREPARING -> READY -> SERVED lifecycle, Waiter RBAC, and idempotent retries', async () => {
    const { service, outboxEvents } = createHarness();

    // Waiter cannot move NEW -> PREPARING
    await expect(
      service.transitionOrderStatus(waiterPrincipal, 'order-1', {
        status: KitchenStatus.PREPARING,
      }),
    ).rejects.toThrow(ForbiddenException);

    // Kitchen jumps NEW -> PREPARING (backfills acknowledgedAt cleanly if skipped)
    const prep = await service.transitionOrderStatus(chefPrincipal, 'order-1', {
      status: KitchenStatus.PREPARING,
    });
    expect(prep.idempotentReplay).toBe(false);
    expect(prep.order.kitchenStatus).toBe(KitchenStatus.PREPARING);
    expect(prep.order.acceptedAt).toBeTruthy();
    expect(prep.order.acknowledgedAt).toBeTruthy();

    // Double-tap PREPARING succeeds idempotently
    const prepReplay = await service.transitionOrderStatus(chefPrincipal, 'order-1', {
      status: KitchenStatus.PREPARING,
    });
    expect(prepReplay.idempotentReplay).toBe(true);
    expect(outboxEvents).toHaveLength(1);

    // Cannot skip straight from PREPARING -> SERVED
    await expect(
      service.transitionOrderStatus(chefPrincipal, 'order-1', {
        status: KitchenStatus.SERVED,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: ErrorCode.INVALID_KDS_TRANSITION }),
    });

    // PREPARING -> READY
    const ready = await service.transitionOrderStatus(chefPrincipal, 'order-1', {
      status: KitchenStatus.READY,
    });
    expect(ready.order.kitchenStatus).toBe(KitchenStatus.READY);
    expect(ready.order.readyAt).toBeTruthy();

    // Waiter CAN mark READY -> SERVED
    const served = await service.transitionOrderStatus(waiterPrincipal, 'order-1', {
      status: KitchenStatus.SERVED,
    });
    expect(served.order.kitchenStatus).toBe(KitchenStatus.SERVED);
    expect(served.order.servedAt).toBeTruthy();

    // Backward transition SERVED -> READY blocked
    await expect(
      service.transitionOrderStatus(chefPrincipal, 'order-1', {
        status: KitchenStatus.READY,
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('isolates tickets by outletId and supports cursor polling (?since=) recovery', async () => {
    const { service } = createHarness();

    const initialBoard = await service.getKdsBoard(chefPrincipal);
    expect(initialBoard.orders).toHaveLength(1);
    expect(initialBoard.orders[0]?.id).toBe('order-1');
    expect(initialBoard.unacknowledgedCount).toBe(1);
    expect(initialBoard.incremental).toBe(false);

    // Cross-outlet order access throws NotFoundException
    await expect(service.acknowledgeOrder(chefPrincipal, 'order-other-outlet')).rejects.toThrow(
      NotFoundException,
    );

    const beforeAckCursor = new Date(Date.parse(initialBoard.serverTime) + 100).toISOString();
    const emptyDelta = await service.getKdsBoard(chefPrincipal, { since: beforeAckCursor });
    expect(emptyDelta.incremental).toBe(true);
    expect(emptyDelta.orders).toHaveLength(0);

    await service.acknowledgeOrder(chefPrincipal, 'order-1');
    const caughtUpDelta = await service.getKdsBoard(chefPrincipal, { since: beforeAckCursor });
    expect(caughtUpDelta.orders).toHaveLength(1);
    expect(caughtUpDelta.orders[0]?.acknowledgedAt).toBeTruthy();
  });
});

