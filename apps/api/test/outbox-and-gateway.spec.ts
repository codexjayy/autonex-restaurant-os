import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  DietaryType,
  KdsEventEnvelope,
  KitchenStatus,
  OrderSource,
  StaffRole,
  TenantStatus,
  kdsKitchenRoom,
  kdsStaffRoom,
} from '@autonex/shared';
import type { Socket } from 'socket.io';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { KitchenGateway } from '../src/modules/kitchen/kitchen.gateway';
import { ClaimedOutboxRow, OutboxRelayService } from '../src/modules/kitchen/outbox-relay.service';

describe('OutboxRelayService & KitchenGateway — Transactional Outbox, SKIP LOCKED & Tenant WS Auth (Phase 4)', () => {
  const jwtSecret = 'test_access_secret_min_32_characters_long_001';
  const tenantA = '11111111-1111-4111-8111-111111111111';
  const outletA = '33333333-3333-4333-8333-333333333333';
  const tenantB = '22222222-2222-4222-8222-222222222222';
  const outletB = '44444444-4444-4444-8444-444444444444';

  function makeSampleOutboxRow(overrides: Partial<ClaimedOutboxRow> = {}): ClaimedOutboxRow {
    return {
      id: 'outbox-evt-1',
      tenantId: tenantA,
      topic: 'order.created',
      aggregateType: 'Order',
      aggregateId: 'order-1',
      retryCount: 0,
      createdAt: new Date('2026-11-11T10:00:00.000Z'),
      payloadJson: {
        ticket: {
          id: 'order-1',
          tenantId: tenantA,
          outletId: outletA,
          sessionId: 'sess-1',
          tableId: 'table-4',
          tableNumber: '4',
          tableLabel: 'Table 4',
          roundNumber: 1,
          kotNumber: 101,
          isAddOn: false,
          source: OrderSource.CUSTOMER_QR,
          kitchenStatus: KitchenStatus.NEW,
          subtotalPaise: 26000,
          notes: null,
          acknowledgedAt: null,
          acknowledgedByMembershipId: null,
          acknowledgedByName: null,
          acceptedAt: null,
          readyAt: null,
          servedAt: null,
          createdAt: '2026-11-11T10:00:00.000Z',
          updatedAt: '2026-11-11T10:00:00.000Z',
          items: [
            {
              id: 'item-1',
              menuItemId: 'menu-1',
              itemNameSnapshot: 'Paneer Tikka Masala',
              dietaryTypeSnapshot: DietaryType.VEG,
              quantity: 1,
              modifiersSnapshotJson: [],
              prepNotes: null,
              status: 'ACTIVE',
            },
          ],
        },
      },
      ...overrides,
    };
  }

  function createOutboxHarness(initialQueue: ClaimedOutboxRow[] = []) {
    const queue = initialQueue.map((row) => ({ ...row, status: 'PENDING', sentAt: null as Date | null, lastError: null as string | null }));
    const executedRawSqlStrings: string[] = [];
    const emittedEnvelopes: KdsEventEnvelope[] = [];
    let failEmitCount = 0;

    const adminDb = {
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const rawTx = {
          $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
            executedRawSqlStrings.push(strings.join(' '));
            // Simulate Postgres FOR UPDATE SKIP LOCKED picking only currently PENDING rows and transitioning to PROCESSING
            const claimed = queue.filter((r) => r.status === 'PENDING');
            for (const row of claimed) {
              row.status = 'PROCESSING';
            }
            return claimed;
          }),
        };
        return fn(rawTx);
      }),
      $executeRaw: jest.fn(async (strings: TemplateStringsArray) => {
        executedRawSqlStrings.push(strings.join(' '));
        const stuck = queue.filter((r) => r.status === 'PROCESSING');
        for (const r of stuck) {
          r.status = 'PENDING';
        }
        return stuck.length;
      }),
      outboxEvent: {
        update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = queue.find((r) => r.id === where.id);
          if (row) {
            Object.assign(row, data);
          }
          return row;
        }),
      },
    };

    const mockPrisma = {
      runAsSystemAdmin: jest.fn(async (fn: (db: typeof adminDb) => Promise<unknown>) => fn(adminDb)),
    } as unknown as PrismaService;

    const mockGateway = {
      emitKdsEvent: jest.fn((envelope: KdsEventEnvelope) => {
        if (failEmitCount > 0) {
          failEmitCount -= 1;
          throw new Error('Socket transport transient failure');
        }
        emittedEnvelopes.push(envelope);
      }),
    } as unknown as KitchenGateway;

    const relay = new OutboxRelayService(mockPrisma, mockGateway);

    return {
      relay,
      queue,
      executedRawSqlStrings,
      emittedEnvelopes,
      setFailEmitCount: (n: number) => {
        failEmitCount = n;
      },
    };
  }

  describe('OutboxRelayService (AT-LEAST-ONCE & SKIP LOCKED)', () => {
    it('uses FOR UPDATE SKIP LOCKED to claim committed outbox rows once and emits after TX', async () => {
      const { relay, queue, executedRawSqlStrings, emittedEnvelopes } = createOutboxHarness([
        makeSampleOutboxRow(),
      ]);

      const result = await relay.processPendingBatch(50);

      expect(result).toEqual({ claimed: 1, dispatched: 1, failed: 0 });
      expect(executedRawSqlStrings[0]).toContain('FOR UPDATE SKIP LOCKED');
      expect(emittedEnvelopes).toHaveLength(1);
      expect(emittedEnvelopes[0]?.eventId).toBe('outbox-evt-1');
      expect(emittedEnvelopes[0]?.ticket.kotNumber).toBe(101);
      expect(queue[0]?.status).toBe('SENT');
      expect(queue[0]?.sentAt).toBeInstanceOf(Date);

      // Second tick when nothing is PENDING emits zero duplicates (and rolled-back order TX = empty queue -> 0 emits)
      const second = await relay.processPendingBatch(50);
      expect(second).toEqual({ claimed: 0, dispatched: 0, failed: 0 });
      expect(emittedEnvelopes).toHaveLength(1);
    });

    it('re-queues with exponential backoff on dispatch failure and dead-letters after max retries', async () => {
      const { relay, queue, emittedEnvelopes, setFailEmitCount } = createOutboxHarness([
        makeSampleOutboxRow({ retryCount: 0 }),
      ]);

      setFailEmitCount(1);
      const failedAttempt = await relay.processPendingBatch();
      expect(failedAttempt).toEqual({ claimed: 1, dispatched: 0, failed: 1 });
      expect(queue[0]?.status).toBe('PENDING');
      expect(queue[0]?.retryCount).toBe(1);
      expect(queue[0]?.lastError).toContain('Socket transport transient failure');
      expect(emittedEnvelopes).toHaveLength(0);

      // Retry succeeds cleanly
      const recoveryAttempt = await relay.processPendingBatch();
      expect(recoveryAttempt).toEqual({ claimed: 1, dispatched: 1, failed: 0 });
      expect(queue[0]?.status).toBe('SENT');

      // Exhausted retries -> marks FAILED
      const exhaustedHarness = createOutboxHarness([
        makeSampleOutboxRow({ id: 'outbox-exhaust', retryCount: 9 }),
      ]);
      exhaustedHarness.setFailEmitCount(1);
      await exhaustedHarness.relay.processPendingBatch();
      expect(exhaustedHarness.queue[0]?.status).toBe('FAILED');
      expect(exhaustedHarness.queue[0]?.retryCount).toBe(10);
    });

    it('reclaims interrupted PROCESSING rows so crashed workers never lose events', async () => {
      const row = makeSampleOutboxRow();
      const { relay, queue } = createOutboxHarness([row]);
      queue[0]!.status = 'PROCESSING';

      const reclaimed = await relay.reclaimStuckProcessing(30_000);
      expect(reclaimed).toBe(1);
      expect(queue[0]?.status).toBe('PENDING');
    });
  });

  describe('KitchenGateway Multi-Tenant Authentication & Room Isolation', () => {
    function createGatewayHarness() {
      const jwtService = new JwtService({ secret: jwtSecret });
      const configService = {
        get: jest.fn((key: string) => (key === 'JWT_ACCESS_SECRET' ? jwtSecret : undefined)),
      } as unknown as ConfigService;

      const gateway = new KitchenGateway(jwtService, configService);
      const roomEmits: Array<{ room: string; event: string; payload: unknown }> = [];
      gateway.server = {
        to: jest.fn((room: string) => ({
          emit: jest.fn((event: string, payload: unknown) => {
            roomEmits.push({ room, event, payload });
          }),
        })),
      } as unknown as KitchenGateway['server'];

      return { gateway, jwtService, roomEmits };
    }

    function makeMockSocket(token?: string) {
      const joinedRooms: string[] = [];
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const socket = {
        handshake: {
          auth: token ? { token } : {},
          headers: {},
        },
        data: {},
        join: jest.fn(async (room: string) => {
          joinedRooms.push(room);
        }),
        emit: jest.fn((event: string, payload: unknown) => {
          emitted.push({ event, payload });
        }),
        disconnect: jest.fn(),
      } as unknown as Socket;

      return { socket, joinedRooms, emitted };
    }

    it('disconnects unauthenticated, invalid, or suspended clients without joining any room', async () => {
      const { gateway, jwtService } = createGatewayHarness();

      // Missing token
      const anon = makeMockSocket();
      await gateway.handleConnection(anon.socket);
      expect(anon.socket.disconnect).toHaveBeenCalledWith(true);
      expect(anon.joinedRooms).toHaveLength(0);

      // Suspended tenant
      const suspendedToken = await jwtService.signAsync({
        sub: 'u-susp',
        tenantId: tenantA,
        outletId: outletA,
        role: StaffRole.KITCHEN,
        isSuperAdmin: false,
        tenantStatus: TenantStatus.SUSPENDED,
      });
      const susp = makeMockSocket(suspendedToken);
      await gateway.handleConnection(susp.socket);
      expect(susp.socket.disconnect).toHaveBeenCalledWith(true);
      expect(susp.joinedRooms).toHaveLength(0);
    });

    it('binds verified staff sockets strictly to their JWT tenant/outlet room and isolates broadcasts', async () => {
      const { gateway, jwtService, roomEmits } = createGatewayHarness();

      const tokenA = await jwtService.signAsync({
        sub: 'chef-a',
        tenantId: tenantA,
        outletId: outletA,
        role: StaffRole.KITCHEN,
        isSuperAdmin: false,
        tenantStatus: TenantStatus.ACTIVE,
      });

      const clientA = makeMockSocket(tokenA);
      await gateway.handleConnection(clientA.socket);

      expect(clientA.joinedRooms).toEqual([
        kdsStaffRoom(tenantA, outletA),
        kdsKitchenRoom(tenantA, outletA),
      ]);
      expect(clientA.socket.disconnect).not.toHaveBeenCalled();

      // Emit Tenant B ticket -> routed ONLY to Tenant B room, never Tenant A room
      gateway.emitKdsEvent({
        eventId: 'evt-b',
        topic: 'order.created',
        tenantId: tenantB,
        outletId: outletB,
        aggregateId: 'ord-b',
        createdAt: '2026-11-11T10:00:00.000Z',
        ticket: {
          ...((makeSampleOutboxRow().payloadJson as unknown as {
            ticket: KdsEventEnvelope['ticket'];
          }).ticket),
          tenantId: tenantB,
          outletId: outletB,
        },
      });

      expect(roomEmits).toHaveLength(1);
      expect(roomEmits[0]?.room).toBe(kdsKitchenRoom(tenantB, outletB));
      expect(roomEmits[0]?.room).not.toBe(kdsKitchenRoom(tenantA, outletA));
    });
  });
});

