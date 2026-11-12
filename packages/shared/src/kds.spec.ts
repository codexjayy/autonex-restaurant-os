import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DietaryType,
  KitchenStatus,
  OrderSource,
  canTransitionKitchenStatus,
  kdsKitchenRoom,
  kdsStaffRoom,
} from './index';
import type { KdsBoardPayload, KdsEventEnvelope, KdsTicketPayload } from './kds';
import {
  applyKdsEventToState,
  applySingleTicketUpdateToState,
  createInitialKdsSyncState,
  reconcileKdsPollResponse,
} from './kds-sync';

function makeTicket(overrides: Partial<KdsTicketPayload> = {}): KdsTicketPayload {
  return {
    id: 'order-1',
    tenantId: 'tenant-1',
    outletId: 'outlet-1',
    sessionId: 'sess-1',
    tableId: 'table-1',
    tableNumber: '4',
    tableLabel: 'Window 4',
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
        quantity: 2,
        modifiersSnapshotJson: [],
        prepNotes: 'Less spicy',
        status: 'ACTIVE',
      },
    ],
    ...overrides,
  };
}

describe('KDS state machine & disconnect/reconnect sync reconciliation', () => {
  it('enforces valid kitchen transition graph strictly', () => {
    assert.equal(canTransitionKitchenStatus(KitchenStatus.NEW, KitchenStatus.ACKNOWLEDGED), true);
    assert.equal(canTransitionKitchenStatus(KitchenStatus.ACKNOWLEDGED, KitchenStatus.PREPARING), true);
    assert.equal(canTransitionKitchenStatus(KitchenStatus.NEW, KitchenStatus.PREPARING), true);
    assert.equal(canTransitionKitchenStatus(KitchenStatus.PREPARING, KitchenStatus.READY), true);
    assert.equal(canTransitionKitchenStatus(KitchenStatus.READY, KitchenStatus.SERVED), true);

    assert.equal(canTransitionKitchenStatus(KitchenStatus.ACKNOWLEDGED, KitchenStatus.READY), false);
    assert.equal(canTransitionKitchenStatus(KitchenStatus.ACKNOWLEDGED, KitchenStatus.SERVED), false);
    assert.equal(canTransitionKitchenStatus(KitchenStatus.NEW, KitchenStatus.READY), false);
    assert.equal(canTransitionKitchenStatus(KitchenStatus.NEW, KitchenStatus.SERVED), false);
    assert.equal(canTransitionKitchenStatus(KitchenStatus.SERVED, KitchenStatus.PREPARING), false);
    assert.equal(canTransitionKitchenStatus(KitchenStatus.CANCELLED, KitchenStatus.NEW), false);
  });

  it('builds isolated room keys scoped by both tenantId and outletId', () => {
    assert.equal(kdsKitchenRoom('t1', 'o1'), 'tenant:t1:outlet:o1:kitchen');
    assert.equal(kdsStaffRoom('t1', 'o1'), 'tenant:t1:outlet:o1:staff');
  });

  it('deduplicates at-least-once WS deliveries and blocks stale out-of-order replays', () => {
    let state = createInitialKdsSyncState();

    const ev1: KdsEventEnvelope = {
      eventId: 'evt-1',
      topic: 'order.created',
      tenantId: 'tenant-1',
      outletId: 'outlet-1',
      aggregateId: 'order-1',
      createdAt: '2026-11-11T10:00:00.000Z',
      ticket: makeTicket(),
    };

    const first = applyKdsEventToState(state, ev1);
    assert.equal(first.duplicateEvent, false);
    assert.equal(first.isNewUnackedArrival, true);
    state = first.nextState;

    // Exact replay of same eventId (at-least-once retry) -> suppressed cleanly
    const replay = applyKdsEventToState(state, ev1);
    assert.equal(replay.duplicateEvent, true);
    assert.equal(replay.isNewUnackedArrival, false);

    // Kitchen locally advances ticket to PREPARING at 10:02
    state = applySingleTicketUpdateToState(
      state,
      makeTicket({
        kitchenStatus: KitchenStatus.PREPARING,
        acknowledgedAt: '2026-11-11T10:01:00.000Z',
        acceptedAt: '2026-11-11T10:02:00.000Z',
        updatedAt: '2026-11-11T10:02:00.000Z',
      }),
    );

    // Delayed out-of-order acknowledgement event (different eventId, older updatedAt 10:01) arrives -> ignored
    const staleAckEnvelope: KdsEventEnvelope = {
      eventId: 'evt-old-ack',
      topic: 'kot.acknowledged',
      tenantId: 'tenant-1',
      outletId: 'outlet-1',
      aggregateId: 'order-1',
      createdAt: '2026-11-11T10:01:00.000Z',
      ticket: makeTicket({
        kitchenStatus: KitchenStatus.NEW,
        acknowledgedAt: '2026-11-11T10:01:00.000Z',
        updatedAt: '2026-11-11T10:01:00.000Z',
      }),
    };

    const staleAttempt = applyKdsEventToState(state, staleAckEnvelope);
    assert.equal(staleAttempt.duplicateEvent, false);
    state = staleAttempt.nextState;
    assert.equal(state.ticketsById.get('order-1')?.kitchenStatus, KitchenStatus.PREPARING);
  });

  it('recovers missed orders cleanly across 30s disconnect, 4s polling delta, and full WS reconnect catch-up without duplicates', () => {
    let state = createInitialKdsSyncState();

    // Step 1: Initial load has KOT #101
    const initialBoard: KdsBoardPayload = {
      orders: [makeTicket({ id: 'order-1', kotNumber: 101 })],
      openCount: 1,
      unacknowledgedCount: 1,
      incremental: false,
      serverTime: '2026-11-11T10:00:00.000Z',
      syncCursor: '2026-11-11T10:00:00.000Z',
    };
    state = reconcileKdsPollResponse(state, initialBoard, { notifyNewArrivals: false }).nextState;
    assert.equal(state.ticketsById.size, 1);

    // Step 2: Wi-Fi / WS drops -> backup 4s polling (?since=...) retrieves missed KOT #102 & updated KOT #101
    const pollDelta: KdsBoardPayload = {
      orders: [
        makeTicket({
          id: 'order-1',
          kotNumber: 101,
          acknowledgedAt: '2026-11-11T10:00:20.000Z',
          kitchenStatus: KitchenStatus.PREPARING,
          updatedAt: '2026-11-11T10:00:20.000Z',
        }),
        makeTicket({
          id: 'order-2',
          kotNumber: 102,
          roundNumber: 2,
          isAddOn: true,
          kitchenStatus: KitchenStatus.NEW,
          updatedAt: '2026-11-11T10:00:25.000Z',
        }),
      ],
      openCount: 2,
      unacknowledgedCount: 1,
      incremental: true,
      serverTime: '2026-11-11T10:00:26.000Z',
      syncCursor: '2026-11-11T10:00:25.000Z',
    };

    const deltaResult = reconcileKdsPollResponse(state, pollDelta, { notifyNewArrivals: true });
    assert.equal(deltaResult.newlyArrivedUnackedCount, 1); // Chime for missed KOT #102
    assert.equal(deltaResult.recoveredCount, 2);
    state = deltaResult.nextState;
    assert.equal(state.ticketsById.size, 2);

    // Step 3: WS reconnects and catches up full snapshot (KOT #101 now SERVED, KOT #102 still open, KOT #103 arrived during reconnect)
    const reconnectSnapshot: KdsBoardPayload = {
      orders: [
        makeTicket({
          id: 'order-2',
          kotNumber: 102,
          roundNumber: 2,
          isAddOn: true,
          kitchenStatus: KitchenStatus.NEW,
          updatedAt: '2026-11-11T10:00:25.000Z',
        }),
        makeTicket({
          id: 'order-3',
          kotNumber: 103,
          kitchenStatus: KitchenStatus.NEW,
          updatedAt: '2026-11-11T10:00:30.000Z',
        }),
      ],
      openCount: 2,
      unacknowledgedCount: 2,
      incremental: false,
      serverTime: '2026-11-11T10:00:31.000Z',
      syncCursor: '2026-11-11T10:00:30.000Z',
    };

    const reconnectResult = reconcileKdsPollResponse(state, reconnectSnapshot, {
      notifyNewArrivals: true,
    });
    assert.equal(reconnectResult.newlyArrivedUnackedCount, 1); // Only KOT #103 triggers new chime (KOT #102 already present!)
    state = reconnectResult.nextState;
    assert.equal(state.ticketsById.has('order-1'), false); // Closed/served ticket pruned cleanly
    assert.equal(state.ticketsById.size, 2);
    assert.equal(state.syncCursor, '2026-11-11T10:00:30.000Z');
  });
});

