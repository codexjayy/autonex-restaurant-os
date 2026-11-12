import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import {
  DietaryType,
  DiningSessionStatus,
  ErrorCode,
  GuestJoinStatus,
  JOIN_CODE_TTL_MS,
  KitchenStatus,
  SelectionType,
  StaffRole,
  TenantStatus,
} from '@autonex/shared';
import { OrderingService } from '../src/modules/ordering/ordering.service';
import { SessionsService } from '../src/modules/sessions/sessions.service';
import { OutboxRelayService } from '../src/modules/kitchen/outbox-relay.service';

describe('SessionsService & OrderingService — Phase 5 Dining Session Lifecycle & Next-Party Privacy', () => {
  const tenantId = '22222222-2222-4222-8222-222222222222';
  const outletId = '33333333-3333-4333-8333-333333333333';
  const tableId = '44444444-4444-4444-8444-444444444444';
  const rawQrToken = 'qr-permanent-table-4-token-xyz-99999999';

  const makePrincipal = (role: StaffRole, userId: string, membershipId: string) => ({
    userId,
    tenantId,
    outletId,
    membershipId,
    role,
    tenantStatus: TenantStatus.ACTIVE,
    isSuperAdmin: false,
    mfaVerified: false,
  });

  const waiterPrincipal = makePrincipal(StaffRole.WAITER, 'user-waiter-1', 'mem-waiter-1');
  const managerPrincipal = makePrincipal(StaffRole.MANAGER, 'user-mgr-1', 'mem-mgr-1');
  const cashierPrincipal = makePrincipal(StaffRole.CASHIER, 'user-cashier-1', 'mem-cashier-1');

  function makeMenuFixture() {
    return {
      id: 'item-thali',
      outletId,
      name: 'Kathiyawadi Thali',
      dietaryType: DietaryType.VEG,
      basePricePaise: 32000,
      inStock: true,
      isActive: true,
      category: { isActive: true },
      modifierGroups: [
        {
          id: 'grp-sweet',
          name: 'Sweet Side',
          selectionType: SelectionType.SINGLE,
          isRequired: false,
          minSelect: 0,
          maxSelect: 1,
          options: [
            {
              id: 'opt-gulab',
              name: 'Gulab Jamun',
              priceDeltaPaise: 4000,
              inStock: true,
              sortOrder: 0,
            },
          ],
        },
      ],
    };
  }

  function createHarness() {
    const state = {
      kotSeq: 200,
      outletPolicy: {
        gstRateBps: 500,
        requireWaiterApproval: true,
        tablePinEnabled: true,
      },
      table: {
        id: tableId,
        tenantId,
        outletId,
        tableNumber: '4',
        label: 'Family Booth 4',
        capacity: 6,
        isActive: true,
        status: 'AVAILABLE',
      } as Record<string, unknown>,
      sessions: [] as Array<Record<string, unknown>>,
      guests: [] as Array<Record<string, unknown>>,
      orders: [] as Array<Record<string, unknown> & { items: Array<Record<string, unknown>> }>,
      orderEvents: [] as Array<Record<string, unknown>>,
      auditLogs: [] as Array<Record<string, unknown>>,
      outboxEvents: [] as Array<Record<string, unknown>>,
    };

    const resolvedQr = () => ({
      tenant_id: tenantId,
      tenant_name: 'Swad Kathiyawad',
      tenant_status: TenantStatus.ACTIVE,
      outlet_id: outletId,
      outlet_name: 'Satellite Branch',
      outlet_address: 'SG Highway',
      outlet_logo_url: null,
      table_id: tableId,
      table_number: '4',
      table_label: 'Family Booth 4',
      qr_version: 1,
      require_waiter_approval: state.outletPolicy.requireWaiterApproval,
      table_pin_enabled: state.outletPolicy.tablePinEnabled,
    });

    const matchesStatusFilter = (actual: string, filter: unknown): boolean => {
      if (!filter) return true;
      if (typeof filter === 'string') return actual === filter;
      if (typeof filter === 'object' && 'not' in filter) {
        return actual !== (filter as { not: string }).not;
      }
      return true;
    };

    const hydrateOrderRelations = (order: Record<string, unknown> & { items: Array<Record<string, unknown>> }) => {
      const session = state.sessions.find((s) => s.id === order.sessionId);
      return {
        ...order,
        session: session ? { id: session.id, table: state.table } : null,
        acknowledgedByMembership: null,
      };
    };

    const mockTx: Record<string, unknown> = {
      restaurantTable: {
        findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          if (where.id && where.id !== tableId) return null;
          if (where.outletId && state.table.outletId !== where.outletId) return null;
          if (where.isActive !== undefined && state.table.isActive !== where.isActive) return null;
          return state.table;
        }),
        findMany: jest.fn(async () => [
          {
            ...state.table,
            diningSessions: state.sessions
              .filter((s) => s.tableId === tableId && s.status !== DiningSessionStatus.CLOSED)
              .map((s) => ({
                ...s,
                outlet: { gstRateBps: state.outletPolicy.gstRateBps },
                guests: state.guests.filter(
                  (g) => g.sessionId === s.id && g.status !== GuestJoinStatus.REVOKED,
                ),
                orders: state.orders.filter((o) => o.sessionId === s.id),
              })),
          },
        ]),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          state.table = { ...state.table, ...data };
          return state.table;
        }),
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
            const found = [...state.sessions].reverse().find((s) => {
              if (where.id && s.id !== where.id) return false;
              if (where.tableId && s.tableId !== where.tableId) return false;
              if (where.outletId && s.outletId !== where.outletId) return false;
              if (!matchesStatusFilter(String(s.status), where.status)) return false;
              return true;
            });
            if (!found) return null;
            if (!include) return found;
            return {
              ...found,
              outlet: { gstRateBps: state.outletPolicy.gstRateBps },
              table: state.table,
              guests: state.guests.filter(
                (g) => g.sessionId === found.id && g.status !== GuestJoinStatus.REVOKED,
              ),
              orders: state.orders.filter((o) => o.sessionId === found.id),
            };
          },
        ),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const openExists = state.sessions.find(
            (s) => s.tableId === data.tableId && s.status !== DiningSessionStatus.CLOSED,
          );
          if (openExists) {
            throw Object.assign(new Error('Unique constraint uq_active_session_per_table'), {
              code: 'P2002',
            });
          }
          const created = {
            id: `sess-${state.sessions.length + 1}`,
            openedAt: new Date(),
            billRequestedAt: null,
            settledAt: null,
            closedAt: null,
            ...data,
          };
          state.sessions.push(created);
          return created;
        }),
        update: jest.fn(
          async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const idx = state.sessions.findIndex((s) => s.id === where.id);
            state.sessions[idx] = { ...state.sessions[idx]!, ...data };
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
            joinedAt: new Date(),
            approvedAt: null,
            lastSeenAt: null,
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
              return true;
            }) ?? null
          );
        }),
        update: jest.fn(
          async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const idx = state.guests.findIndex((g) => g.id === where.id);
            state.guests[idx] = { ...state.guests[idx]!, ...data };
            return state.guests[idx]!;
          },
        ),
        updateMany: jest.fn(
          async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            let count = 0;
            for (let i = 0; i < state.guests.length; i += 1) {
              const g = state.guests[i]!;
              if (where.sessionId && g.sessionId !== where.sessionId) continue;
              if (!matchesStatusFilter(String(g.status), where.status)) continue;
              state.guests[i] = { ...g, ...data };
              count += 1;
            }
            return { count };
          },
        ),
      },
      menuItem: {
        findMany: jest.fn(async () => [makeMenuFixture()]),
      },
      outlet: {
        update: jest.fn(async () => {
          state.kotSeq += 1;
          return { nextKotSeq: state.kotSeq + 1 };
        }),
      },
      order: {
        findFirst: jest.fn(
          async ({
            where,
            include,
          }: {
            where: Record<string, unknown>;
            include?: Record<string, unknown>;
          }) => {
            const found = state.orders.find((o) => {
              if (where.id && o.id !== where.id) return false;
              if (where.sessionId && o.sessionId !== where.sessionId) return false;
              if (where.idempotencyKey && o.idempotencyKey !== where.idempotencyKey) return false;
              if (where.outletId && o.outletId !== where.outletId) return false;
              return true;
            });
            if (!found) return null;
            return include ? hydrateOrderRelations(found) : found;
          },
        ),
        findMany: jest.fn(async ({ where }: { where: { sessionId: string } }) =>
          state.orders.filter((o) => o.sessionId === where.sessionId),
        ),
        count: jest.fn(async ({ where }: { where: { sessionId: string } }) =>
          state.orders.filter((o) => o.sessionId === where.sessionId).length,
        ),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const id = `order-${state.orders.length + 1}`;
          const itemCreates = ((data.items as { create?: Array<Record<string, unknown>> })?.create ??
            []) as Array<Record<string, unknown>>;
          const items = itemCreates.map((it, idx) => ({
            id: `${id}-item-${idx + 1}`,
            orderId: id,
            status: 'ACTIVE',
            ...it,
          }));
          const created = {
            id,
            ...data,
            tenantId,
            outletId,
            tableId,
            items,
            acknowledgedAt: null,
            acknowledgedByMembershipId: null,
            acceptedAt: null,
            readyAt: null,
            servedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          state.orders.push(created);
          return created;
        }),
        update: jest.fn(
          async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const idx = state.orders.findIndex((o) => o.id === where.id);
            state.orders[idx] = { ...state.orders[idx]!, ...data, updatedAt: new Date() };
            return hydrateOrderRelations(state.orders[idx]!);
          },
        ),
      },
      orderItem: {
        update: jest.fn(
          async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            for (const order of state.orders) {
              const itemIdx = order.items.findIndex((it) => it.id === where.id);
              if (itemIdx >= 0) {
                order.items[itemIdx] = { ...order.items[itemIdx]!, ...data };
                return order.items[itemIdx]!;
              }
            }
            throw new Error(`OrderItem ${where.id} not found`);
          },
        ),
      },
      orderEvent: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          state.orderEvents.push(data);
          return data;
        }),
      },
      auditLog: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          state.auditLogs.push(data);
          return data;
        }),
      },
      outboxEvent: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `outbox-${state.outboxEvents.length + 1}`, createdAt: new Date(), ...data };
          state.outboxEvents.push(row);
          return row;
        }),
      },
    };

    const prismaMock = {
      runInTenantTx: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx)),
    };
    const tenantContextMock = { get: jest.fn(() => ({ ipAddress: '10.0.0.15' })) };
    const tablesServiceMock = {
      verifyQrTokenAndGetTable: jest.fn(async () => resolvedQr()),
    };

    const orderingService = new OrderingService(
      prismaMock as never,
      tenantContextMock as never,
      tablesServiceMock as never,
    );
    const sessionsService = new SessionsService(
      prismaMock as never,
      tenantContextMock as never,
      tablesServiceMock as never,
    );

    return { state, mockTx, orderingService, sessionsService };
  }

  describe('Staff-Only Activation, Short-Lived Join Code & Policy Enforcement', () => {
    it('prevents QR scan/join from auto-opening AVAILABLE table, sets 15m TTL PIN, and enforces policy', async () => {
      const { state, orderingService, sessionsService } = createHarness();

      // QR join before staff opens table -> rejected
      await expect(
        orderingService.joinSessionViaQr(rawQrToken, { joinCode: '1234' }),
      ).rejects.toThrow(ConflictException);
      expect(state.sessions).toHaveLength(0);

      // Staff activates session -> AVAILABLE -> OPEN, 15-min TTL joinCode set
      const opened = await orderingService.openTableSession(waiterPrincipal, tableId);
      expect(opened.alreadyOpen).toBe(false);
      expect(state.table.status).toBe('OCCUPIED');
      expect(opened.session.joinCodeExpiresAt).toBeInstanceOf(Date);
      const ttlDiff =
        (opened.session.joinCodeExpiresAt as Date).getTime() - Date.now();
      expect(ttlDiff).toBeGreaterThan(JOIN_CODE_TTL_MS - 10_000);

      // Expired PIN is rejected even if digits match
      state.sessions[0]!.joinCodeExpiresAt = new Date(Date.now() - 5_000);
      await expect(
        orderingService.joinSessionViaQr(rawQrToken, {
          joinCode: String(opened.session.joinCode),
        }),
      ).rejects.toThrow(ForbiddenException);

      // Rotate restores fresh 15m TTL; revoking clears PIN while keeping seated guests intact
      const rotated = await orderingService.rotateSessionJoinCode(
        waiterPrincipal,
        String(opened.session.id),
      );
      const guest1 = await orderingService.joinSessionViaQr(rawQrToken, {
        joinCode: String(rotated.joinCode),
        displayLabel: 'Meera',
      });
      expect(guest1.status).toBe(GuestJoinStatus.APPROVED);

      await sessionsService.revokeJoinCode(waiterPrincipal, String(opened.session.id));
      await expect(
        orderingService.joinSessionViaQr(rawQrToken, {
          joinCode: String(rotated.joinCode),
        }),
      ).rejects.toThrow(ForbiddenException);

      // Existing approved guest remains approved after PIN revocation
      const poll1 = await orderingService.getCustomerSessionState(rawQrToken, guest1.guestToken);
      expect(poll1.guestStatus).toBe(GuestJoinStatus.APPROVED);

      // Policy: requireWaiterApproval=false & tablePinEnabled=true requires join PIN
      state.outletPolicy.requireWaiterApproval = false;
      state.outletPolicy.tablePinEnabled = true;
      await expect(orderingService.joinSessionViaQr(rawQrToken, {})).rejects.toThrow(
        ForbiddenException,
      );

      // Policy: requireWaiterApproval=false & tablePinEnabled=false auto-approves cleanly
      state.outletPolicy.tablePinEnabled = false;
      const openJoin = await orderingService.joinSessionViaQr(rawQrToken, {
        displayLabel: 'Self Join Diner',
      });
      expect(openJoin.status).toBe(GuestJoinStatus.APPROVED);
    });
  });

  describe('Pre-Prep Item Edits & Override Guard', () => {
    it('allows waiter quantity/cancel edits while NEW, locks PREPARING for waiter, and permits Manager override with reason', async () => {
      const { state, orderingService, sessionsService } = createHarness();
      const { session } = await orderingService.openTableSession(waiterPrincipal, tableId);
      const sessionId = String(session.id);

      const placed = await orderingService.placeStaffOrder(
        waiterPrincipal,
        {
          tableId,
          items: [{ menuItemId: 'item-thali', quantity: 2, selectedOptionIds: ['opt-gulab'] }],
        },
        'preprep-idem-1001',
      );
      const orderId = String(placed.order.id);
      const itemId = String(placed.order.items[0]!.id);
      expect(placed.order.subtotalPaise).toBe(72000); // 2 * (320 + 40) = ₹720

      // Waiter reduces quantity 2 -> 1 while NEW
      const mod1 = await sessionsService.modifyOrderItems(waiterPrincipal, sessionId, orderId, {
        items: [{ orderItemId: itemId, quantity: 1 }],
      });
      expect(mod1.cancelledWholeOrder).toBe(false);
      expect(state.orders[0]!.subtotalPaise).toBe(36000);
      expect(state.outboxEvents.some((e) => e.topic === 'kot.updated')).toBe(true);

      // Simulate KDS transitioning ticket -> PREPARING
      state.orders[0]!.kitchenStatus = KitchenStatus.PREPARING;

      // Waiter is blocked once kitchen started PREPARING
      await expect(
        sessionsService.modifyOrderItems(waiterPrincipal, sessionId, orderId, {
          items: [{ orderItemId: itemId, quantity: 0 }],
        }),
      ).rejects.toThrow(ForbiddenException);

      // Manager without override reason gets BadRequestException
      await expect(
        sessionsService.modifyOrderItems(managerPrincipal, sessionId, orderId, {
          items: [{ orderItemId: itemId, quantity: 0 }],
        }),
      ).rejects.toThrow(BadRequestException);

      // Manager with override reason cancels remaining item -> whole order CANCELLED
      const mod2 = await sessionsService.modifyOrderItems(managerPrincipal, sessionId, orderId, {
        items: [{ orderItemId: itemId, quantity: 0 }],
        reason: 'Guest allergic and kitchen agreed to halt plating',
      });
      expect(mod2.cancelledWholeOrder).toBe(true);
      expect(state.orders[0]!.kitchenStatus).toBe(KitchenStatus.CANCELLED);
      expect(state.orders[0]!.subtotalPaise).toBe(0);

      // Closing a table whose orders are all cancelled is permitted cleanly
      const closed = await sessionsService.closeAndResetSession(waiterPrincipal, sessionId, {
        reason: 'Cancelled order closed cleanly',
      });
      expect(closed.tableStatus).toBe('AVAILABLE');
    });
  });

  describe('Full Session Lifecycle: Open → Checkout Lock → Settled → Closed → Reset & Next-Party Privacy', () => {
    it('enforces multi-round ordering, checkout lock, settlement guard, mass guest revocation, and zero leakage to next party', async () => {
      const { state, orderingService, sessionsService } = createHarness();

      // 1. Staff opens Party 1
      const { session: p1Session } = await orderingService.openTableSession(waiterPrincipal, tableId);
      const p1Id = String(p1Session.id);

      const guestA = await orderingService.joinSessionViaQr(rawQrToken, {
        joinCode: String(p1Session.joinCode),
        displayLabel: 'Party1-GuestA',
      });
      const guestB = await orderingService.joinSessionViaQr(rawQrToken, {
        joinCode: String(p1Session.joinCode),
        displayLabel: 'Party1-GuestB',
      });

      // Empty session cannot lock checkout for bill
      await expect(
        sessionsService.lockSessionForCheckoutCustomer(rawQrToken, guestA.guestToken),
      ).rejects.toMatchObject({ response: { code: ErrorCode.SESSION_EMPTY } });

      // Round 1 + Round 2 (ADD-ON) placed under Party 1
      await orderingService.placeCustomerOrder(
        rawQrToken,
        guestA.guestToken,
        { items: [{ menuItemId: 'item-thali', quantity: 1 }] },
        'p1-round-1-key',
      );
      const round2 = await orderingService.placeCustomerOrder(
        rawQrToken,
        guestB.guestToken,
        { items: [{ menuItemId: 'item-thali', quantity: 1, selectedOptionIds: ['opt-gulab'] }] },
        'p1-round-2-key',
      );
      expect(round2.order.roundNumber).toBe(2);
      expect(round2.order.isAddOn).toBe(true);

      // Floor view & customer summary reflect ₹680 subtotal + 5% GST = ₹714
      const floorSnapshot = await orderingService.listFloorSessions(waiterPrincipal);
      expect(floorSnapshot[0]!.activeSession?.balance?.subtotalPaise).toBe(68000);
      expect(floorSnapshot[0]!.activeSession?.balance?.estimatedTotalPaise).toBe(71400);

      // 2. Customer requests bill -> CHECKOUT_LOCKED
      const lockRes = await sessionsService.lockSessionForCheckoutCustomer(
        rawQrToken,
        guestA.guestToken,
      );
      expect(lockRes.lifecycleStage).toBe('CHECKOUT_LOCKED');

      // While CHECKOUT_LOCKED: customer orders, staff orders, and new QR joins are ALL blocked!
      await expect(
        orderingService.placeCustomerOrder(
          rawQrToken,
          guestB.guestToken,
          { items: [{ menuItemId: 'item-thali', quantity: 1 }] },
          'p1-blocked-after-lock',
        ),
      ).rejects.toThrow(ConflictException);

      await expect(
        orderingService.placeStaffOrder(
          waiterPrincipal,
          { tableId, items: [{ menuItemId: 'item-thali', quantity: 1 }] },
          'p1-staff-blocked-after-lock',
        ),
      ).rejects.toThrow(ConflictException);

      await expect(
        orderingService.joinSessionViaQr(rawQrToken, { joinCode: String(p1Session.joinCode) }),
      ).rejects.toThrow(ConflictException);

      // Reopen briefly if diner wants dessert, then re-lock
      await sessionsService.reopenSession(waiterPrincipal, p1Id);
      await orderingService.placeCustomerOrder(
        rawQrToken,
        guestA.guestToken,
        { items: [{ menuItemId: 'item-thali', quantity: 1 }] },
        'p1-round-3-key',
      );
      await sessionsService.lockSessionForCheckout(waiterPrincipal, p1Id);

      // 3. Premature Close before SETTLED is blocked with SESSION_NOT_SETTLED
      await expect(
        sessionsService.closeAndResetSession(waiterPrincipal, p1Id, {}),
      ).rejects.toMatchObject({ response: { code: ErrorCode.SESSION_NOT_SETTLED } });

      // Waiter cannot mark settled; Cashier marks settled
      await expect(
        sessionsService.markSessionSettled(waiterPrincipal, p1Id, {}),
      ).rejects.toThrow(ForbiddenException);

      const settled = await sessionsService.markSessionSettled(cashierPrincipal, p1Id, {
        note: 'Paid via counter UPI',
      });
      expect(settled.lifecycleStage).toBe('SETTLED');

      // 4. Close & Reset revokes ALL guests, wipes PIN, restores table to AVAILABLE
      const closed = await sessionsService.closeAndResetSession(waiterPrincipal, p1Id, {});
      expect(closed.status).toBe(DiningSessionStatus.CLOSED);
      expect(closed.tableStatus).toBe('AVAILABLE');
      expect(closed.revokedGuestsCount).toBe(2);
      expect(state.sessions[0]!.joinCode).toBeNull();
      expect(state.sessions[0]!.joinCodeExpiresAt).toBeNull();
      expect(state.guests.every((g) => g.status === GuestJoinStatus.REVOKED)).toBe(true);
      expect(state.outboxEvents.some((e) => e.topic === 'session.closed')).toBe(true);

      // 5. NEXT-PARTY PRIVACY CHECK #1 (Idle table between parties)
      const betweenPartiesPoll = await orderingService.getCustomerSessionState(
        rawQrToken,
        guestA.guestToken,
      );
      expect(betweenPartiesPoll.hasActiveSession).toBe(false);
      expect(betweenPartiesPoll.orders).toEqual([]);
      expect(betweenPartiesPoll.runningTotalPaise).toBe(0);

      // 6. Staff opens Party 2 on the exact same table QR
      const { session: p2Session } = await orderingService.openTableSession(waiterPrincipal, tableId);
      expect(p2Session.id).not.toBe(p1Id);

      const party2Guest = await orderingService.joinSessionViaQr(rawQrToken, {
        joinCode: String(p2Session.joinCode),
        displayLabel: 'Party2-Host',
      });
      await orderingService.placeCustomerOrder(
        rawQrToken,
        party2Guest.guestToken,
        { items: [{ menuItemId: 'item-thali', quantity: 1 }] },
        'p2-round-1-key',
      );

      // Party 2 sees ONLY its own 1 order (NOT Party 1's 3 orders!)
      const party2State = await orderingService.getCustomerSessionState(
        rawQrToken,
        party2Guest.guestToken,
      );
      expect(party2State.sessionId).toBe(p2Session.id);
      expect(party2State.orders).toHaveLength(1);
      expect(party2State.runningTotalPaise).toBe(32000);

      // NEXT-PARTY PRIVACY CHECK #2 (Party 1 stale browser tokens cannot read, order, or lock Party 2!)
      const party1Snooping = await orderingService.getCustomerSessionState(
        rawQrToken,
        guestA.guestToken,
      );
      expect(party1Snooping.hasActiveSession).toBe(true);
      expect(party1Snooping.guestStatus).toBeNull();
      expect(party1Snooping.orders).toEqual([]);
      expect(party1Snooping.runningTotalPaise).toBe(0);

      await expect(
        orderingService.placeCustomerOrder(
          rawQrToken,
          guestB.guestToken,
          { items: [{ menuItemId: 'item-thali', quantity: 1 }] },
          'p1-intrude-order',
        ),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        sessionsService.lockSessionForCheckoutCustomer(rawQrToken, guestA.guestToken),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('OutboxRelayService — Floor Lifecycle Relay', () => {
    it('emits floor.event to authenticated staff room for session.updated and session.closed topics', async () => {
      const emitFloorEvent = jest.fn();
      const emitKdsEvent = jest.fn();

      const claimedRows = [
        {
          id: 'evt-floor-1',
          tenantId,
          topic: 'session.closed',
          aggregateType: 'DiningSession',
          aggregateId: 'sess-1',
          payloadJson: {
            outletId,
            tableId,
            sessionId: 'sess-1',
            status: DiningSessionStatus.CLOSED,
            lifecycleStage: 'CLOSED',
          },
          retryCount: 0,
          createdAt: new Date('2026-11-11T17:00:00Z'),
        },
      ];

      const prismaMock = {
        runAsSystemAdmin: jest.fn(async (fn: (db: unknown) => Promise<unknown>) =>
          fn({
            $transaction: async (txFn: (tx: unknown) => Promise<unknown>) =>
              txFn({ $queryRaw: async () => claimedRows }),
            outboxEvent: { update: jest.fn(async () => ({})) },
          }),
        ),
      };

      const relay = new OutboxRelayService(
        prismaMock as never,
        { emitFloorEvent, emitKdsEvent } as never,
      );

      const res = await relay.processPendingBatch(10);
      expect(res).toEqual({ claimed: 1, dispatched: 1, failed: 0 });
      expect(emitKdsEvent).not.toHaveBeenCalled();
      expect(emitFloorEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'evt-floor-1',
          topic: 'session.closed',
          tenantId,
          outletId,
          tableId,
          sessionId: 'sess-1',
          lifecycleStage: 'CLOSED',
        }),
      );
    });
  });
});

