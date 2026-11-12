import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  DietaryType,
  DiningSessionStatus,
  ErrorCode,
  GuestJoinStatus,
  KitchenStatus,
  OrderSource,
  OutboxStatus,
  SelectionType,
  StaffRole,
  TableStatus,
  TenantStatus,
} from '@autonex/shared';
import { TenantContextService } from '../src/common/context/tenant-context.service';
import { AuthenticatedPrincipal } from '../src/common/decorators/current-user.decorator';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { sha256Hex } from '../src/common/security/crypto.util';
import { OrderingService } from '../src/modules/ordering/ordering.service';
import { TablesService } from '../src/modules/tables/tables.service';

describe('OrderingService — QR Join, Idempotent Ordering, Repeat Orders & Staff POS (Phase 3)', () => {
  const tenantId = '22222222-2222-4222-8222-222222222222';
  const outletId = '33333333-3333-4333-8333-333333333333';
  const tableId = '44444444-4444-4444-8444-444444444444';
  const rawQrToken = 'qr_opaque_table_token_12345678901234567890123';

  const waiterPrincipal: AuthenticatedPrincipal = {
    userId: '11111111-1111-4111-8111-111111111111',
    tenantId,
    outletId,
    membershipId: '55555555-5555-4555-8555-555555555555',
    role: StaffRole.WAITER,
    isSuperAdmin: false,
    tenantStatus: TenantStatus.ACTIVE,
  };

  function makeMenuFixture() {
    return {
      id: 'item-paneer-tikka',
      outletId,
      name: 'Paneer Tikka Masala',
      dietaryType: DietaryType.VEG,
      basePricePaise: 26000, // ₹260
      isActive: true,
      inStock: true,
      category: { id: 'cat-mains', name: 'Main Course', isActive: true },
      modifierGroups: [
        {
          id: 'grp-spice',
          name: 'Spice Level',
          selectionType: SelectionType.SINGLE,
          isRequired: true,
          minSelect: 1,
          maxSelect: 1,
          sortOrder: 0,
          options: [
            {
              id: 'opt-medium',
              name: 'Medium Spice',
              priceDeltaPaise: 0,
              inStock: true,
              sortOrder: 0,
            },
            {
              id: 'opt-extra-spicy',
              name: 'Extra Spicy',
              priceDeltaPaise: 1000, // +₹10
              inStock: true,
              sortOrder: 1,
            },
          ],
        },
        {
          id: 'grp-addons',
          name: 'Add-Ons',
          selectionType: SelectionType.MULTI,
          isRequired: false,
          minSelect: 0,
          maxSelect: 2,
          sortOrder: 1,
          options: [
            {
              id: 'opt-cheese',
              name: 'Extra Cheese',
              priceDeltaPaise: 4000, // +₹40
              inStock: true,
              sortOrder: 0,
            },
            {
              id: 'opt-butter',
              name: 'Amul Butter Top-Up',
              priceDeltaPaise: 2500, // +₹25
              inStock: true,
              sortOrder: 1,
            },
            {
              id: 'opt-truffle-oos',
              name: 'Truffle Oil',
              priceDeltaPaise: 9000,
              inStock: false,
              sortOrder: 2,
            },
          ],
        },
      ],
    };
  }

  function createHarness() {
    const state = {
      kotSeq: 100,
      tables: new Map<string, Record<string, unknown>>([
        [
          tableId,
          {
            id: tableId,
            tenantId,
            outletId,
            tableNumber: 4,
            label: 'Window Table 4',
            capacity: 4,
            isActive: true,
            status: TableStatus.AVAILABLE,
          },
        ],
      ]),
      sessions: [] as Array<Record<string, unknown>>,
      guests: [] as Array<Record<string, unknown>>,
      orders: [] as Array<Record<string, unknown> & { items: Array<Record<string, unknown>> }>,
      menuItems: [makeMenuFixture()],
      outboxEvents: [] as Array<Record<string, unknown>>,
      auditLogs: [] as Array<Record<string, unknown>>,
    };

    const resolvedQr = {
      tenant_id: tenantId,
      tenant_name: 'Gujju Spice Kitchen',
      tenant_status: TenantStatus.ACTIVE,
      outlet_id: outletId,
      outlet_name: 'Navrangpura Flagship',
      outlet_address: 'CG Road, Ahmedabad',
      outlet_logo_url: null,
      table_id: tableId,
      table_number: 4,
      table_label: 'Window Table 4',
      qr_version: 1,
      require_waiter_approval: true,
      table_pin_enabled: true,
    };

    const mockTx = {
      restaurantTable: {
        findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          const t = state.tables.get(String(where.id));
          if (!t) return null;
          if (where.outletId && t.outletId !== where.outletId) return null;
          if (where.isActive !== undefined && t.isActive !== where.isActive) return null;
          return t;
        }),
        update: jest.fn(
          async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const existing = state.tables.get(where.id);
            if (!existing) throw new Error('Table not found');
            const updated = { ...existing, ...data };
            state.tables.set(where.id, updated);
            return updated;
          },
        ),
      },
      diningSession: {
        findFirst: jest.fn(
          async ({
            where,
            include,
          }: {
            where: Record<string, unknown>;
            include?: Record<string, unknown>;
          }) => {
            const found = state.sessions.find((s) => {
              if (where.id && s.id !== where.id) return false;
              if (where.tableId && s.tableId !== where.tableId) return false;
              if (where.outletId && s.outletId !== where.outletId) return false;
              if (typeof where.status === 'string' && s.status !== where.status) return false;
              if (
                where.status &&
                typeof where.status === 'object' &&
                'not' in where.status &&
                s.status === (where.status as { not: string }).not
              ) {
                return false;
              }
              return true;
            });
            if (!found) return null;
            if (include) {
              return {
                ...found,
                table: state.tables.get(String(found.tableId)) ?? null,
                orders: state.orders.filter((o) => o.sessionId === found.id),
              };
            }
            return found;
          },
        ),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const created = {
            id: `sess-${state.sessions.length + 1}`,
            joinCodeExpiresAt: null,
            openedAt: new Date(),
            ...data,
          };
          state.sessions.push(created);
          return created;
        }),
        update: jest.fn(
          async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const idx = state.sessions.findIndex((s) => s.id === where.id);
            state.sessions[idx] = { ...state.sessions[idx], ...data };
            return state.sessions[idx]!;
          },
        ),
      },
      sessionGuest: {
        count: jest.fn(async ({ where }: { where: { sessionId: string } }) =>
          state.guests.filter((g) => g.sessionId === where.sessionId).length,
        ),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const created = {
            id: `guest-${state.guests.length + 1}`,
            createdAt: new Date(),
            lastSeenAt: new Date(),
            approvedAt: null,
            ...data,
          };
          state.guests.push(created);
          return created;
        }),
        findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          return (
            state.guests.find((g) => {
              if (where.id && g.id !== where.id) return false;
              if (where.sessionId && g.sessionId !== where.sessionId) return false;
              if (where.guestTokenHash && g.guestTokenHash !== where.guestTokenHash) return false;
              if (where.session && typeof where.session === 'object') {
                const sFilter = where.session as Record<string, unknown>;
                const sess = state.sessions.find((s) => s.id === g.sessionId);
                if (!sess) return false;
                if (sFilter.outletId && sess.outletId !== sFilter.outletId) return false;
                if (sFilter.status && sess.status !== sFilter.status) return false;
              }
              return true;
            }) ?? null
          );
        }),
        update: jest.fn(
          async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const idx = state.guests.findIndex((g) => g.id === where.id);
            state.guests[idx] = { ...state.guests[idx], ...data };
            return state.guests[idx]!;
          },
        ),
      },
      menuItem: {
        findMany: jest.fn(async ({ where }: { where: { id: { in: string[] }; outletId: string } }) => {
          return state.menuItems.filter(
            (m) => where.id.in.includes(m.id) && m.outletId === where.outletId,
          );
        }),
      },
      outlet: {
        update: jest.fn(async () => {
          state.kotSeq += 1;
          return { kotSeq: state.kotSeq };
        }),
      },
      order: {
        findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          return (
            state.orders.find((o) => {
              if (where.id && o.id !== where.id) return false;
              if (where.idempotencyKey && o.idempotencyKey !== where.idempotencyKey) return false;
              if (where.outletId && o.outletId !== where.outletId) return false;
              return true;
            }) ?? null
          );
        }),
        findMany: jest.fn(async ({ where }: { where: { sessionId: string } }) =>
          state.orders.filter((o) => o.sessionId === where.sessionId),
        ),
        count: jest.fn(async ({ where }: { where: { sessionId: string } }) =>
          state.orders.filter(
            (o) =>
              o.sessionId === where.sessionId && o.kitchenStatus !== KitchenStatus.CANCELLED,
          ).length,
        ),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const itemsData = (data.items as { create: Array<Record<string, unknown>> })?.create ?? [];
          const orderId = `order-${state.orders.length + 1}`;
          const created = {
            id: orderId,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...data,
            items: itemsData.map((line, i) => ({
              id: `${orderId}-item-${i + 1}`,
              createdAt: new Date(),
              ...line,
            })),
          };
          state.orders.push(created);
          return created;
        }),
      },
      outboxEvent: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `outbox-${state.outboxEvents.length + 1}`, ...data };
          state.outboxEvents.push(row);
          return row;
        }),
      },
      auditLog: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `audit-${state.auditLogs.length + 1}`, ...data };
          state.auditLogs.push(row);
          return row;
        }),
      },
    };

    const mockPrisma = {
      runInTenantTx: jest.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
    } as unknown as PrismaService;

    const mockContext = {
      get: jest.fn(() => ({ ipAddress: '127.0.0.1' })),
    } as unknown as TenantContextService;

    const mockTablesService = {
      verifyQrTokenAndGetTable: jest.fn(async () => resolvedQr),
    } as unknown as TablesService;

    const service = new OrderingService(mockPrisma, mockContext, mockTablesService);

    return {
      service,
      state,
      mockTx,
      mockPrisma,
      mockTablesService,
    };
  }

  describe('QR Entry & Session Join Flow', () => {
    it('rejects QR join when staff has not activated the table session', async () => {
      const { service } = createHarness();

      await expect(
        service.joinSessionViaQr(rawQrToken, { joinCode: '1234', displayLabel: 'Aarav' }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCode.SESSION_NOT_ACTIVE }),
      });
    });

    it('rejects wrong or expired join codes and approves valid 4-digit join code immediately', async () => {
      const { service, state } = createHarness();
      const { session } = await service.openTableSession(waiterPrincipal, tableId);

      // Wrong join code
      await expect(
        service.joinSessionViaQr(rawQrToken, { joinCode: '0000' }),
      ).rejects.toThrow(ForbiddenException);

      // Valid join code -> APPROVED + stores hashed token only
      const joined = await service.joinSessionViaQr(rawQrToken, {
        joinCode: session.joinCode!,
        displayLabel: 'Riya',
      });

      expect(joined.status).toBe(GuestJoinStatus.APPROVED);
      expect(joined.guestToken).toBeTruthy();
      expect(state.guests[0]?.guestTokenHash).toBe(sha256Hex(joined.guestToken));
      expect(state.guests[0]?.guestTokenHash).not.toBe(joined.guestToken);

      // Expired join code -> rejected
      state.sessions[0]!.joinCodeExpiresAt = new Date(Date.now() - 10_000);
      await expect(
        service.joinSessionViaQr(rawQrToken, { joinCode: session.joinCode! }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('creates PENDING_APPROVAL guest without code, withholds orders until staff approves, and blocks revoked guests', async () => {
      const { service, state } = createHarness();
      const { session } = await service.openTableSession(waiterPrincipal, tableId);

      // Staff already placed Round 1 order before customer joined
      await service.placeStaffOrder(
        waiterPrincipal,
        {
          tableId,
          items: [{ menuItemId: 'item-paneer-tikka', selectedOptionIds: ['opt-medium'], quantity: 1 }],
        },
        'staff-order-initial-001',
      );

      // Guest scans QR without PIN
      const pending = await service.joinSessionViaQr(rawQrToken, { displayLabel: 'Phone-B' });
      expect(pending.status).toBe(GuestJoinStatus.PENDING_APPROVAL);

      // While pending, orders are withheld and ordering fails
      const pendingState = await service.getCustomerSessionState(rawQrToken, pending.guestToken);
      expect(pendingState.guestStatus).toBe(GuestJoinStatus.PENDING_APPROVAL);
      expect(pendingState.orders).toEqual([]);
      expect(pendingState.runningTotalPaise).toBe(0);

      await expect(
        service.placeCustomerOrder(
          rawQrToken,
          pending.guestToken,
          {
            items: [
              { menuItemId: 'item-paneer-tikka', selectedOptionIds: ['opt-medium'], quantity: 1 },
            ],
          },
          'cust-while-pending-001',
        ),
      ).rejects.toThrow(ForbiddenException);

      // Waiter approves guest
      await service.updateGuestJoinStatus(
        waiterPrincipal,
        session.id,
        pending.guestId,
        GuestJoinStatus.APPROVED,
      );

      const approvedState = await service.getCustomerSessionState(rawQrToken, pending.guestToken);
      expect(approvedState.guestStatus).toBe(GuestJoinStatus.APPROVED);
      expect(approvedState.orders).toHaveLength(1);
      expect(approvedState.runningTotalPaise).toBe(26000);

      // Waiter revokes guest -> access revoked
      await service.updateGuestJoinStatus(
        waiterPrincipal,
        session.id,
        pending.guestId,
        GuestJoinStatus.REVOKED,
      );
      expect(state.guests[0]?.status).toBe(GuestJoinStatus.REVOKED);

      const revokedState = await service.getCustomerSessionState(rawQrToken, pending.guestToken);
      expect(revokedState.guestStatus).toBe(GuestJoinStatus.REVOKED);
      expect(revokedState.orders).toEqual([]);
    });

    it('rejects missing/malformed guest session token on status poll', async () => {
      const { service } = createHarness();
      await expect(service.getCustomerSessionState(rawQrToken, 'short')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('Server-Side Pricing, Modifiers, Stock & Stale Cart Validation', () => {
    it('computes authoritative integer paise totals, increments KOT, and writes snapshot + outbox in one TX', async () => {
      const { service, state } = createHarness();
      const { session } = await service.openTableSession(waiterPrincipal, tableId);
      const guest = await service.joinSessionViaQr(rawQrToken, { joinCode: session.joinCode! });

      // Paneer Tikka (26000) + Extra Spicy (1000) + Extra Cheese (4000) = 31000 * 2 = 62000 paise
      const res = await service.placeCustomerOrder(
        rawQrToken,
        guest.guestToken,
        {
          items: [
            {
              menuItemId: 'item-paneer-tikka',
              selectedOptionIds: ['opt-extra-spicy', 'opt-cheese'],
              quantity: 2,
              prepNotes: 'No onion please',
            },
          ],
          expectedSubtotalPaise: 62000,
          notes: 'Serve hot',
        },
        'cust-order-valid-0001',
      );

      expect(res.idempotentReplay).toBe(false);
      expect(res.order.roundNumber).toBe(1);
      expect(res.order.kotNumber).toBe(101);
      expect(res.order.isAddOn).toBe(false);
      expect(res.order.subtotalPaise).toBe(62000);
      expect(res.order.items[0]).toMatchObject({
        itemNameSnapshot: 'Paneer Tikka Masala',
        basePricePaiseSnapshot: 26000,
        unitPricePaise: 31000,
        quantity: 2,
        lineTotalPaise: 62000,
        prepNotes: 'No onion please',
      });
      const orderOutbox = state.outboxEvents.filter((e) => e.topic === 'order.created');
      expect(orderOutbox).toHaveLength(1);
      expect(orderOutbox[0]).toMatchObject({
        topic: 'order.created',
        aggregateType: 'Order',
        status: OutboxStatus.PENDING,
      });
    });

    it('rejects out-of-stock menu items and out-of-stock modifier options', async () => {
      const { service, state } = createHarness();
      const { session } = await service.openTableSession(waiterPrincipal, tableId);
      const guest = await service.joinSessionViaQr(rawQrToken, { joinCode: session.joinCode! });

      // Out-of-stock add-on option
      await expect(
        service.placeCustomerOrder(
          rawQrToken,
          guest.guestToken,
          {
            items: [
              {
                menuItemId: 'item-paneer-tikka',
                selectedOptionIds: ['opt-medium', 'opt-truffle-oos'],
                quantity: 1,
              },
            ],
          },
          'cust-order-oos-mod-001',
        ),
      ).rejects.toThrow(ConflictException);

      // Out-of-stock item
      state.menuItems[0]!.inStock = false;
      await expect(
        service.placeCustomerOrder(
          rawQrToken,
          guest.guestToken,
          {
            items: [
              {
                menuItemId: 'item-paneer-tikka',
                selectedOptionIds: ['opt-medium'],
                quantity: 1,
              },
            ],
          },
          'cust-order-oos-item-001',
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCode.OUT_OF_STOCK }),
      });
    });

    it('enforces required modifier bounds and blocks cross-item/invalid modifier options', async () => {
      const { service } = createHarness();
      const { session } = await service.openTableSession(waiterPrincipal, tableId);
      const guest = await service.joinSessionViaQr(rawQrToken, { joinCode: session.joinCode! });

      // Missing required SINGLE spice level
      await expect(
        service.placeCustomerOrder(
          rawQrToken,
          guest.guestToken,
          {
            items: [{ menuItemId: 'item-paneer-tikka', selectedOptionIds: [], quantity: 1 }],
          },
          'cust-mod-missing-req-001',
        ),
      ).rejects.toThrow(BadRequestException);

      // Trying to pick 2 from SINGLE group
      await expect(
        service.placeCustomerOrder(
          rawQrToken,
          guest.guestToken,
          {
            items: [
              {
                menuItemId: 'item-paneer-tikka',
                selectedOptionIds: ['opt-medium', 'opt-extra-spicy'],
                quantity: 1,
              },
            ],
          },
          'cust-mod-single-multi-001',
        ),
      ).rejects.toThrow(BadRequestException);

      // Foreign/invalid modifier option ID injection
      await expect(
        service.placeCustomerOrder(
          rawQrToken,
          guest.guestToken,
          {
            items: [
              {
                menuItemId: 'item-paneer-tikka',
                selectedOptionIds: ['opt-medium', 'opt-foreign-hack'],
                quantity: 1,
              },
            ],
          },
          'cust-mod-foreign-001',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('detects stale browser menu prices via expectedSubtotalPaise mismatch', async () => {
      const { service, state } = createHarness();
      const { session } = await service.openTableSession(waiterPrincipal, tableId);
      const guest = await service.joinSessionViaQr(rawQrToken, { joinCode: session.joinCode! });

      // Price changed server-side while diner was browsing
      state.menuItems[0]!.basePricePaise = 29000;

      await expect(
        service.placeCustomerOrder(
          rawQrToken,
          guest.guestToken,
          {
            items: [
              {
                menuItemId: 'item-paneer-tikka',
                selectedOptionIds: ['opt-medium'],
                quantity: 1,
              },
            ],
            expectedSubtotalPaise: 26000,
          },
          'cust-stale-price-001',
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: ErrorCode.STALE_MENU_PRICE,
          details: {
            expectedSubtotalPaise: 26000,
            currentSubtotalPaise: 29000,
          },
        }),
      });
    });
  });

  describe('Idempotency & Concurrency Protection', () => {
    it('requires a valid Idempotency-Key header', async () => {
      const { service } = createHarness();
      await service.openTableSession(waiterPrincipal, tableId);

      await expect(
        service.placeStaffOrder(
          waiterPrincipal,
          {
            tableId,
            items: [{ menuItemId: 'item-paneer-tikka', selectedOptionIds: ['opt-medium'], quantity: 1 }],
          },
          'short',
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCode.IDEMPOTENCY_KEY_REQUIRED }),
      });
    });

    it('deduplicates sequential retries and rejects key reuse across different sessions', async () => {
      const { service, state, mockTx } = createHarness();
      const { session } = await service.openTableSession(waiterPrincipal, tableId);
      const guest = await service.joinSessionViaQr(rawQrToken, { joinCode: session.joinCode! });

      const first = await service.placeCustomerOrder(
        rawQrToken,
        guest.guestToken,
        {
          items: [{ menuItemId: 'item-paneer-tikka', selectedOptionIds: ['opt-medium'], quantity: 1 }],
        },
        'retry-safe-key-0001',
      );
      expect(first.idempotentReplay).toBe(false);

      const replay = await service.placeCustomerOrder(
        rawQrToken,
        guest.guestToken,
        {
          items: [{ menuItemId: 'item-paneer-tikka', selectedOptionIds: ['opt-medium'], quantity: 1 }],
        },
        'retry-safe-key-0001',
      );
      expect(replay.idempotentReplay).toBe(true);
      expect(replay.order.id).toBe(first.order.id);
      expect(state.orders).toHaveLength(1);
      expect(mockTx.outlet.update).toHaveBeenCalledTimes(1);

      // Reusing same key on a second session/table raises ConflictException
      state.tables.set('table-2', {
        id: 'table-2',
        tenantId,
        outletId,
        tableNumber: 5,
        label: 'Table 5',
        capacity: 4,
        isActive: true,
        status: TableStatus.AVAILABLE,
      });

      await expect(
        service.placeStaffOrder(
          waiterPrincipal,
          {
            tableId: 'table-2',
            items: [{ menuItemId: 'item-paneer-tikka', selectedOptionIds: ['opt-medium'], quantity: 1 }],
          },
          'retry-safe-key-0001',
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('recovers cleanly outside aborted TX when concurrent P2002 idempotency race occurs', async () => {
      const { service, state, mockTx } = createHarness();
      const { session } = await service.openTableSession(waiterPrincipal, tableId);
      const guest = await service.joinSessionViaQr(rawQrToken, { joinCode: session.joinCode! });

      // Simulate winning transaction already committed concurrently while second TX hits P2002
      const committedWinner = {
        id: 'order-winner-1',
        tenantId,
        outletId,
        sessionId: session.id,
        roundNumber: 1,
        kotNumber: 101,
        subtotalPaise: 26000,
        kitchenStatus: KitchenStatus.NEW,
        idempotencyKey: 'race-idem-key-0001',
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [],
      };
      mockTx.order.findFirst
        .mockResolvedValueOnce(null) // before create
        .mockResolvedValueOnce(committedWinner) // post-P2002 lookup
        .mockResolvedValueOnce(committedWinner); // loadOrderSnapshot

      mockTx.order.create.mockRejectedValueOnce(
        Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
      );

      const res = await service.placeCustomerOrder(
        rawQrToken,
        guest.guestToken,
        {
          items: [{ menuItemId: 'item-paneer-tikka', selectedOptionIds: ['opt-medium'], quantity: 1 }],
        },
        'race-idem-key-0001',
      );

      expect(res.idempotentReplay).toBe(true);
      expect(res.order.id).toBe('order-winner-1');
      expect(state.outboxEvents.filter((e) => e.topic === 'order.created')).toHaveLength(0);
    });
  });

  describe('Repeat Orders & Snapshot Immutability', () => {
    it('supports Round 2+ repeat orders and preserves historical prices after owner edits menu', async () => {
      const { service, state } = createHarness();
      const { session } = await service.openTableSession(waiterPrincipal, tableId);
      const guest = await service.joinSessionViaQr(rawQrToken, { joinCode: session.joinCode! });

      // Round 1 at ₹260
      const round1 = await service.placeCustomerOrder(
        rawQrToken,
        guest.guestToken,
        {
          items: [{ menuItemId: 'item-paneer-tikka', selectedOptionIds: ['opt-medium'], quantity: 1 }],
        },
        'round-1-order-key-001',
      );
      expect(round1.order.roundNumber).toBe(1);
      expect(round1.order.isAddOn).toBe(false);
      expect(round1.order.kotNumber).toBe(101);

      // Owner updates menu price & name between rounds
      state.menuItems[0]!.basePricePaise = 32000;
      state.menuItems[0]!.name = 'Royal Paneer Tikka Masala';

      // Round 2 at ₹320
      const round2 = await service.placeCustomerOrder(
        rawQrToken,
        guest.guestToken,
        {
          items: [{ menuItemId: 'item-paneer-tikka', selectedOptionIds: ['opt-medium'], quantity: 1 }],
        },
        'round-2-order-key-002',
      );
      expect(round2.order.roundNumber).toBe(2);
      expect(round2.order.isAddOn).toBe(true);
      expect(round2.order.kotNumber).toBe(102);

      // Verify Round 1 kept immutable ₹260 snapshot while Round 2 uses ₹320
      const sessionState = await service.getCustomerSessionState(rawQrToken, guest.guestToken);
      expect(sessionState.orders).toHaveLength(2);
      expect(sessionState.orders[0]?.items[0]?.itemNameSnapshot).toBe('Paneer Tikka Masala');
      expect(sessionState.orders[0]?.items[0]?.unitPricePaise).toBe(26000);
      expect(sessionState.orders[1]?.items[0]?.itemNameSnapshot).toBe('Royal Paneer Tikka Masala');
      expect(sessionState.orders[1]?.items[0]?.unitPricePaise).toBe(32000);
      expect(sessionState.runningTotalPaise).toBe(58000);
    });
  });

  describe('Staff-Assisted Ordering', () => {
    it('auto-opens an AVAILABLE table session when placing a staff order and records STAFF_POS', async () => {
      const { service, state } = createHarness();

      const res = await service.placeStaffOrder(
        waiterPrincipal,
        {
          tableId,
          openIfAvailable: true,
          items: [
            { menuItemId: 'item-paneer-tikka', selectedOptionIds: ['opt-medium'], quantity: 2 },
          ],
        },
        'staff-auto-open-0001',
      );

      expect(res.order.source).toBe(OrderSource.STAFF_POS);
      expect(res.order.placedByMembershipId).toBe(waiterPrincipal.membershipId);
      expect(res.order.subtotalPaise).toBe(52000);
      expect(state.sessions).toHaveLength(1);
      expect(state.tables.get(tableId)?.status).toBe(TableStatus.OCCUPIED);
    });

    it('rejects staff order when openIfAvailable is false on an idle table or when session is locked for bill', async () => {
      const { service, state } = createHarness();

      await expect(
        service.placeStaffOrder(
          waiterPrincipal,
          {
            tableId,
            openIfAvailable: false,
            items: [{ menuItemId: 'item-paneer-tikka', selectedOptionIds: ['opt-medium'], quantity: 1 }],
          },
          'staff-no-auto-open-001',
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCode.SESSION_NOT_ACTIVE }),
      });

      const { session } = await service.openTableSession(waiterPrincipal, tableId);
      expect(session.status).toBe(DiningSessionStatus.ACTIVE);
      state.sessions[0]!.status = DiningSessionStatus.BILL_REQUESTED;

      await expect(
        service.placeStaffOrder(
          waiterPrincipal,
          {
            tableId,
            items: [{ menuItemId: 'item-paneer-tikka', selectedOptionIds: ['opt-medium'], quantity: 1 }],
          },
          'staff-locked-bill-001',
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCode.SESSION_NOT_ACTIVE }),
      });
    });
  });
});
