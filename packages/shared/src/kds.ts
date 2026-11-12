import { DietaryType, KitchenStation, KitchenStatus, OrderSource } from './enums';

export type KdsOutboxTopic = 'order.created' | 'kot.acknowledged' | 'kot.updated';

export const KDS_ALLOWED_TRANSITIONS: Record<KitchenStatus, readonly KitchenStatus[]> = {
  [KitchenStatus.NEW]: [
    KitchenStatus.ACKNOWLEDGED,
    KitchenStatus.PREPARING,
    KitchenStatus.CANCELLED,
  ],
  [KitchenStatus.ACKNOWLEDGED]: [KitchenStatus.PREPARING, KitchenStatus.CANCELLED],
  [KitchenStatus.PREPARING]: [KitchenStatus.READY, KitchenStatus.CANCELLED],
  [KitchenStatus.READY]: [KitchenStatus.SERVED],
  [KitchenStatus.SERVED]: [],
  [KitchenStatus.CANCELLED]: [],
};

export function canTransitionKitchenStatus(from: KitchenStatus, to: KitchenStatus): boolean {
  const allowed = KDS_ALLOWED_TRANSITIONS[from] ?? [];
  return allowed.includes(to);
}

export function kdsKitchenRoom(tenantId: string, outletId: string): string {
  return `tenant:${tenantId}:outlet:${outletId}:kitchen`;
}

export function kdsStaffRoom(tenantId: string, outletId: string): string {
  return `tenant:${tenantId}:outlet:${outletId}:staff`;
}

export interface KdsTicketModifierSnapshot {
  groupId: string;
  groupName: string;
  optionId: string;
  optionName: string;
  priceDeltaPaise: number;
}

export interface KdsTicketItemPayload {
  id: string;
  menuItemId: string;
  itemNameSnapshot: string;
  dietaryTypeSnapshot: DietaryType;
  quantity: number;
  modifiersSnapshotJson: KdsTicketModifierSnapshot[];
  prepTimeMinutes?: number | null;
  kitchenStation?: KitchenStation;
  prepNotes: string | null;
  status: string;
}

export interface KdsTicketPayload {
  id: string;
  tenantId: string;
  outletId: string;
  sessionId: string;
  tableId: string;
  tableNumber: string;
  tableLabel: string | null;
  customerName?: string | null;
  placedByName?: string | null;
  roundNumber: number;
  kotNumber: number;
  isAddOn: boolean;
  source: OrderSource;
  kitchenStatus: KitchenStatus;
  stations?: KitchenStation[];
  subtotalPaise: number;
  notes: string | null;
  acknowledgedAt: string | null;
  acknowledgedByMembershipId: string | null;
  acknowledgedByName: string | null;
  acceptedAt: string | null;
  readyAt: string | null;
  servedAt: string | null;
  createdAt: string;
  updatedAt: string;
  items: KdsTicketItemPayload[];
}

export interface KdsEventEnvelope {
  eventId: string;
  topic: KdsOutboxTopic;
  tenantId: string;
  outletId: string;
  aggregateId: string;
  createdAt: string;
  ticket: KdsTicketPayload;
}

export interface KdsBoardPayload {
  orders: KdsTicketPayload[];
  openCount: number;
  unacknowledgedCount: number;
  incremental: boolean;
  serverTime: string;
  syncCursor: string;
}
