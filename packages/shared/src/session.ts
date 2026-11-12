import { DiningSessionStatus, KitchenStatus } from './enums';
import { calculateGstPaise } from './money';

export type SessionLifecycleStage =
  | 'AVAILABLE'
  | 'OPEN'
  | 'CHECKOUT_LOCKED'
  | 'SETTLED'
  | 'CLOSED';

export type SessionOutboxTopic = 'session.updated' | 'session.closed';

export const JOIN_CODE_TTL_MINUTES = 15;
export const JOIN_CODE_TTL_MS = JOIN_CODE_TTL_MINUTES * 60 * 1000;

export function mapSessionStatusToStage(
  status: DiningSessionStatus | null | undefined,
): SessionLifecycleStage {
  if (!status) return 'AVAILABLE';
  if (status === DiningSessionStatus.ACTIVE) return 'OPEN';
  if (status === DiningSessionStatus.BILL_REQUESTED) return 'CHECKOUT_LOCKED';
  if (status === DiningSessionStatus.SETTLED) return 'SETTLED';
  return 'CLOSED';
}

export interface SessionBalanceSummary {
  activeOrdersCount: number;
  activeItemsCount: number;
  subtotalPaise: number;
  gstRateBps: number;
  cgstPaise: number;
  sgstPaise: number;
  totalTaxPaise: number;
  estimatedTotalPaise: number;
}

export interface BalanceOrderInput {
  kitchenStatus: KitchenStatus | string;
  subtotalPaise: number;
  items?: Array<{ quantity: number; status?: string }>;
}

export function computeSessionBalanceSummary(
  orders: BalanceOrderInput[],
  gstRateBps = 500,
): SessionBalanceSummary {
  const activeOrders = orders.filter((o) => o.kitchenStatus !== KitchenStatus.CANCELLED);
  const subtotalPaise = activeOrders.reduce((sum, o) => sum + o.subtotalPaise, 0);
  const activeItemsCount = activeOrders.reduce((count, order) => {
    const items = order.items ?? [];
    const orderQty = items
      .filter((item) => item.status !== 'CANCELLED')
      .reduce((itemSum, item) => itemSum + item.quantity, 0);
    return count + orderQty;
  }, 0);
  const gst = calculateGstPaise(subtotalPaise, gstRateBps);

  return {
    activeOrdersCount: activeOrders.length,
    activeItemsCount,
    subtotalPaise,
    gstRateBps,
    cgstPaise: gst.cgstPaise,
    sgstPaise: gst.sgstPaise,
    totalTaxPaise: gst.totalTaxPaise,
    estimatedTotalPaise: subtotalPaise + gst.totalTaxPaise,
  };
}

export interface FloorEventEnvelope {
  eventId: string;
  topic: SessionOutboxTopic;
  tenantId: string;
  outletId: string;
  sessionId: string;
  tableId: string;
  status: DiningSessionStatus;
  lifecycleStage: SessionLifecycleStage;
  createdAt: string;
}
