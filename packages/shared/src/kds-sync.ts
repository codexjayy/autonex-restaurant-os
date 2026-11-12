import { KitchenStatus } from './enums';
import type { KdsBoardPayload, KdsEventEnvelope, KdsTicketPayload } from './kds';

export interface KdsSyncState {
  ticketsById: Map<string, KdsTicketPayload>;
  seenEventIds: string[];
  seenEventSet: Set<string>;
  syncCursor: string | null;
}

const MAX_SEEN_EVENTS = 500;

export function createInitialKdsSyncState(): KdsSyncState {
  return {
    ticketsById: new Map<string, KdsTicketPayload>(),
    seenEventIds: [],
    seenEventSet: new Set<string>(),
    syncCursor: null,
  };
}

function isNewerOrEqualTimestamp(incomingIso: string, existingIso: string): boolean {
  const incomingMs = Date.parse(incomingIso);
  const existingMs = Date.parse(existingIso);
  if (Number.isNaN(incomingMs) || Number.isNaN(existingMs)) return true;
  return incomingMs >= existingMs;
}

function recordEventId(
  prevIds: string[],
  prevSet: Set<string>,
  eventId: string,
): { nextIds: string[]; nextSet: Set<string> } {
  const nextSet = new Set(prevSet);
  const nextIds = [...prevIds, eventId];
  nextSet.add(eventId);
  while (nextIds.length > MAX_SEEN_EVENTS) {
    const evicted = nextIds.shift();
    if (evicted) nextSet.delete(evicted);
  }
  return { nextIds, nextSet };
}

function maxCursor(current: string | null, candidate: string | null | undefined): string | null {
  if (!candidate) return current;
  if (!current) return candidate;
  return isNewerOrEqualTimestamp(candidate, current) ? candidate : current;
}

export function applyKdsEventToState(
  state: KdsSyncState,
  envelope: KdsEventEnvelope,
): {
  nextState: KdsSyncState;
  duplicateEvent: boolean;
  isNewUnackedArrival: boolean;
} {
  if (state.seenEventSet.has(envelope.eventId)) {
    return {
      nextState: state,
      duplicateEvent: true,
      isNewUnackedArrival: false,
    };
  }

  const { nextIds, nextSet } = recordEventId(
    state.seenEventIds,
    state.seenEventSet,
    envelope.eventId,
  );
  const existing = state.ticketsById.get(envelope.ticket.id);

  // Guard against stale/out-of-order replay overwriting a newer status transition
  if (existing && !isNewerOrEqualTimestamp(envelope.ticket.updatedAt, existing.updatedAt)) {
    return {
      nextState: {
        ...state,
        seenEventIds: nextIds,
        seenEventSet: nextSet,
      },
      duplicateEvent: false,
      isNewUnackedArrival: false,
    };
  }

  const nextTickets = new Map(state.ticketsById);
  nextTickets.set(envelope.ticket.id, envelope.ticket);

  const isNewUnackedArrival =
    !existing &&
    envelope.topic === 'order.created' &&
    envelope.ticket.kitchenStatus === KitchenStatus.NEW &&
    !envelope.ticket.acknowledgedAt;

  return {
    nextState: {
      ticketsById: nextTickets,
      seenEventIds: nextIds,
      seenEventSet: nextSet,
      syncCursor: maxCursor(state.syncCursor, envelope.ticket.updatedAt),
    },
    duplicateEvent: false,
    isNewUnackedArrival,
  };
}

export function applySingleTicketUpdateToState(
  state: KdsSyncState,
  ticket: KdsTicketPayload,
): KdsSyncState {
  const existing = state.ticketsById.get(ticket.id);
  if (existing && !isNewerOrEqualTimestamp(ticket.updatedAt, existing.updatedAt)) {
    return state;
  }
  const nextTickets = new Map(state.ticketsById);
  nextTickets.set(ticket.id, ticket);
  return {
    ...state,
    ticketsById: nextTickets,
    syncCursor: maxCursor(state.syncCursor, ticket.updatedAt),
  };
}

export function reconcileKdsPollResponse(
  state: KdsSyncState,
  response: KdsBoardPayload,
  options: { includeServed?: boolean; notifyNewArrivals?: boolean } = {},
): {
  nextState: KdsSyncState;
  newlyArrivedUnackedCount: number;
  recoveredCount: number;
} {
  let newlyArrivedUnackedCount = 0;
  let recoveredCount = 0;

  if (!response.incremental) {
    const nextTickets = new Map<string, KdsTicketPayload>();
    for (const incoming of response.orders) {
      const prev = state.ticketsById.get(incoming.id);
      const chosen =
        prev && !isNewerOrEqualTimestamp(incoming.updatedAt, prev.updatedAt) ? prev : incoming;
      nextTickets.set(chosen.id, chosen);

      if (!prev) {
        recoveredCount += 1;
        if (
          options.notifyNewArrivals &&
          chosen.kitchenStatus === KitchenStatus.NEW &&
          !chosen.acknowledgedAt
        ) {
          newlyArrivedUnackedCount += 1;
        }
      } else if (prev.updatedAt !== chosen.updatedAt) {
        recoveredCount += 1;
      }
    }

    if (!options.includeServed) {
      for (const [id, ticket] of nextTickets.entries()) {
        if (
          ticket.kitchenStatus === KitchenStatus.SERVED ||
          ticket.kitchenStatus === KitchenStatus.CANCELLED
        ) {
          nextTickets.delete(id);
        }
      }
    }

    return {
      nextState: {
        ...state,
        ticketsById: nextTickets,
        syncCursor: maxCursor(state.syncCursor, response.syncCursor),
      },
      newlyArrivedUnackedCount,
      recoveredCount,
    };
  }

  const nextTickets = new Map(state.ticketsById);
  for (const incoming of response.orders) {
    const prev = nextTickets.get(incoming.id);
    if (prev && !isNewerOrEqualTimestamp(incoming.updatedAt, prev.updatedAt)) {
      continue;
    }
    nextTickets.set(incoming.id, incoming);
    recoveredCount += 1;
    if (
      !prev &&
      options.notifyNewArrivals &&
      incoming.kitchenStatus === KitchenStatus.NEW &&
      !incoming.acknowledgedAt
    ) {
      newlyArrivedUnackedCount += 1;
    }
  }

  return {
    nextState: {
      ...state,
      ticketsById: nextTickets,
      syncCursor: maxCursor(state.syncCursor, response.syncCursor),
    },
    newlyArrivedUnackedCount,
    recoveredCount,
  };
}

