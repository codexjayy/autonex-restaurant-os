import {
  BillLineType,
  BillStatus,
  PaymentMethod,
  PaymentProvider,
  PaymentStatus,
  RefundStatus,
  TaxMode,
} from './enums';
import { calculateGstPaise } from './money';

export interface BillCalculationInput {
  itemsSubtotalPaise: number;
  discountPaise: number;
  gstRateBps: number;
  taxMode: TaxMode;
  roundOffEnabled?: boolean;
}

export interface BillCalculationResult {
  itemsSubtotalPaise: number;
  discountPaise: number;
  taxablePaise: number;
  gstRateBps: number;
  taxMode: TaxMode;
  cgstPaise: number;
  sgstPaise: number;
  totalTaxPaise: number;
  roundOffPaise: number;
  totalPaise: number;
}

export function calculateBillTotalsPaise(input: BillCalculationInput): BillCalculationResult {
  const { itemsSubtotalPaise, discountPaise, gstRateBps, taxMode, roundOffEnabled = false } = input;

  if (!Number.isInteger(itemsSubtotalPaise) || itemsSubtotalPaise < 0) {
    throw new Error('itemsSubtotalPaise must be a non-negative integer');
  }
  if (!Number.isInteger(discountPaise) || discountPaise < 0 || discountPaise > itemsSubtotalPaise) {
    throw new Error('discountPaise must be between 0 and itemsSubtotalPaise');
  }
  if (!Number.isInteger(gstRateBps) || gstRateBps < 0 || gstRateBps > 2800) {
    throw new Error('gstRateBps must be an integer between 0 and 2800');
  }

  const netPaise = itemsSubtotalPaise - discountPaise;
  let taxablePaise = netPaise;
  let cgstPaise = 0;
  let sgstPaise = 0;
  let preRoundTotalPaise = netPaise;

  if (taxMode === TaxMode.EXCLUSIVE && gstRateBps > 0 && netPaise > 0) {
    const gst = calculateGstPaise(netPaise, gstRateBps);
    cgstPaise = gst.cgstPaise;
    sgstPaise = gst.sgstPaise;
    preRoundTotalPaise = netPaise + gst.totalTaxPaise;
  } else if (taxMode === TaxMode.INCLUSIVE && gstRateBps > 0 && netPaise > 0) {
    const divisor = 10000 + gstRateBps;
    taxablePaise = Math.floor((netPaise * 10000 + Math.floor(divisor / 2)) / divisor);
    const extractedTaxPaise = netPaise - taxablePaise;
    cgstPaise = Math.ceil(extractedTaxPaise / 2);
    sgstPaise = Math.floor(extractedTaxPaise / 2);
    preRoundTotalPaise = netPaise;
  }

  const totalTaxPaise = cgstPaise + sgstPaise;
  let roundOffPaise = 0;
  let totalPaise = preRoundTotalPaise;

  if (roundOffEnabled && preRoundTotalPaise > 0) {
    totalPaise = Math.floor((preRoundTotalPaise + 50) / 100) * 100;
    roundOffPaise = totalPaise - preRoundTotalPaise;
  }

  return {
    itemsSubtotalPaise,
    discountPaise,
    taxablePaise,
    gstRateBps,
    taxMode,
    cgstPaise,
    sgstPaise,
    totalTaxPaise,
    roundOffPaise,
    totalPaise,
  };
}

export function computeBillPaymentProgress(params: {
  totalPaise: number;
  succeededAllocatedPaise: number;
  refundedPaise: number;
}): {
  netPaidPaise: number;
  duePaise: number;
  status: BillStatus;
} {
  const { totalPaise, succeededAllocatedPaise, refundedPaise } = params;
  const netPaidPaise = Math.max(0, succeededAllocatedPaise - refundedPaise);
  const duePaise = Math.max(0, totalPaise - netPaidPaise);

  let status = BillStatus.OPEN;
  if (duePaise === 0) {
    status = BillStatus.PAID;
  } else if (netPaidPaise > 0) {
    status = BillStatus.PARTIALLY_PAID;
  }

  return { netPaidPaise, duePaise, status };
}

export function formatSequentialBillNumber(sequence: number, now = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const padded = String(sequence).padStart(5, '0');
  return `INV-${year}${month}-${padded}`;
}

export type BillingOutboxTopic =
  | 'bill.generated'
  | 'bill.updated'
  | 'payment.succeeded'
  | 'payment.failed'
  | 'refund.processed';

export interface BillLineDto {
  id: string;
  orderItemId: string | null;
  lineType: BillLineType;
  description: string;
  quantity: number;
  unitAmountPaise: number;
  lineAmountPaise: number;
}

export interface PaymentAttemptDto {
  id: string;
  billId: string;
  method: PaymentMethod;
  provider: PaymentProvider;
  amountPaise: number;
  status: PaymentStatus;
  gatewayOrderId: string | null;
  gatewayPaymentId: string | null;
  qrPayloadUrl: string | null;
  receiptRef: string | null;
  failureReason: string | null;
  reconcileAttempts: number;
  lastReconciledAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface RefundDto {
  id: string;
  billId: string;
  paymentAttemptId: string;
  amountPaise: number;
  reason: string;
  status: RefundStatus;
  gatewayRefundId: string | null;
  processedAt: string | null;
  createdAt: string;
}

export interface BillItemGstDto {
  lineId?: string;
  orderItemId: string | null;
  description: string;
  quantity: number;
  unitAmountPaise: number;
  lineAmountPaise: number;
  discountSharePaise: number;
  taxablePaise: number;
  gstRateBps: number;
  cgstPaise: number;
  sgstPaise: number;
  lineTotalWithTaxPaise: number;
}

export interface BillAuditEntryDto {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actorUserId: string;
  actorRole: string;
  beforeJson: unknown | null;
  afterJson: unknown | null;
  createdAt: string;
}

export interface BillingPeriodBucketDto {
  key: string;
  label: string;
  billsCount: number;
  completedBillsCount: number;
  grossSalesPaise: number;
  discountPaise: number;
  gstPaise: number;
  collectedPaise: number;
  refundedPaise: number;
  netRevenuePaise: number;
}

export interface BillingAnalyticsDto {
  timezone: string;
  generatedAt: string;
  today: {
    dateKey: string;
    totalSalesPaise: number;
    collectedNetPaise: number;
    cashCollectedPaise: number;
    upiCollectedPaise: number;
    upiManualPaise: number;
    razorpayOnlinePaise: number;
    cardCollectedPaise: number;
    pendingPaymentsPaise: number;
    pendingBillsCount: number;
    gstCollectedPaise: number;
    completedBillsCount: number;
    openBillsCount: number;
    partialBillsCount: number;
    voidedBillsCount: number;
    refundedTodayPaise: number;
  };
  allTime: {
    totalPaidBillsCount: number;
    totalNetCollectedPaise: number;
    totalPendingDuePaise: number;
  };
  daily: BillingPeriodBucketDto[];
  weekly: BillingPeriodBucketDto[];
  monthly: BillingPeriodBucketDto[];
}

/**
 * Distributes bill-level discount, taxable base, CGST, and SGST proportionally
 * across item lines using Hamilton's largest-remainder method so line sums always
 * reconcile to exact integer paise totals.
 */
export function distributeIntegerPaise(totalPaise: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const totalWeight = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (totalPaise === 0 || totalWeight === 0) {
    return weights.map((_, idx) => (idx === 0 ? totalPaise : 0));
  }

  const sign = totalPaise < 0 ? -1 : 1;
  const absTotal = Math.abs(totalPaise);
  const exactShares = weights.map((w) => (absTotal * Math.max(0, w)) / totalWeight);
  const floors = exactShares.map((v) => Math.floor(v));
  let remainder = absTotal - floors.reduce((s, v) => s + v, 0);

  const ranked = exactShares
    .map((v, idx) => ({ idx, frac: v - (floors[idx] ?? 0) }))
    .sort((a, b) => b.frac - a.frac || a.idx - b.idx);

  for (let i = 0; i < ranked.length && remainder > 0; i++) {
    const entry = ranked[i];
    if (!entry) break;
    floors[entry.idx] = (floors[entry.idx] ?? 0) + 1;
    remainder -= 1;
  }

  return floors.map((v) => v * sign);
}

export function computeItemWiseGstBreakdown(params: {
  itemLines: Array<{
    id?: string;
    orderItemId: string | null;
    description: string;
    quantity: number;
    unitAmountPaise: number;
    lineAmountPaise: number;
  }>;
  discountPaise: number;
  taxMode: TaxMode;
  gstRateBps: number;
  cgstPaise: number;
  sgstPaise: number;
}): BillItemGstDto[] {
  if (params.itemLines.length === 0) return [];
  const weights = params.itemLines.map((l) => Math.max(0, l.lineAmountPaise));
  const discountShares = distributeIntegerPaise(params.discountPaise, weights);
  const cgstShares =
    params.taxMode === TaxMode.NONE ? weights.map(() => 0) : distributeIntegerPaise(params.cgstPaise, weights);
  const sgstShares =
    params.taxMode === TaxMode.NONE ? weights.map(() => 0) : distributeIntegerPaise(params.sgstPaise, weights);

  return params.itemLines.map((line, i) => {
    const discountSharePaise = discountShares[i] ?? 0;
    const netLinePaise = Math.max(0, line.lineAmountPaise - discountSharePaise);
    const cgst = cgstShares[i] ?? 0;
    const sgst = sgstShares[i] ?? 0;

    if (params.taxMode === TaxMode.INCLUSIVE) {
      const taxablePaise = Math.max(0, netLinePaise - cgst - sgst);
      return {
        lineId: line.id,
        orderItemId: line.orderItemId,
        description: line.description,
        quantity: line.quantity,
        unitAmountPaise: line.unitAmountPaise,
        lineAmountPaise: line.lineAmountPaise,
        discountSharePaise,
        taxablePaise,
        gstRateBps: params.gstRateBps,
        cgstPaise: cgst,
        sgstPaise: sgst,
        lineTotalWithTaxPaise: netLinePaise,
      };
    }

    if (params.taxMode === TaxMode.EXCLUSIVE) {
      return {
        lineId: line.id,
        orderItemId: line.orderItemId,
        description: line.description,
        quantity: line.quantity,
        unitAmountPaise: line.unitAmountPaise,
        lineAmountPaise: line.lineAmountPaise,
        discountSharePaise,
        taxablePaise: netLinePaise,
        gstRateBps: params.gstRateBps,
        cgstPaise: cgst,
        sgstPaise: sgst,
        lineTotalWithTaxPaise: netLinePaise + cgst + sgst,
      };
    }

    return {
      lineId: line.id,
      orderItemId: line.orderItemId,
      description: line.description,
      quantity: line.quantity,
      unitAmountPaise: line.unitAmountPaise,
      lineAmountPaise: line.lineAmountPaise,
      discountSharePaise,
      taxablePaise: netLinePaise,
      gstRateBps: 0,
      cgstPaise: 0,
      sgstPaise: 0,
      lineTotalWithTaxPaise: netLinePaise,
    };
  });
}

export interface BillSummaryDto {
  id: string;
  sessionId: string;
  billNumber: string;
  status: BillStatus;
  subtotalPaise: number;
  discountPaise: number;
  discountReason: string | null;
  taxMode: TaxMode;
  gstRateBps: number;
  cgstPaise: number;
  sgstPaise: number;
  roundOffPaise: number;
  totalPaise: number;
  paidPaise: number;
  refundedPaise: number;
  netPaidPaise: number;
  duePaise: number;
  gstinSnapshot: string | null;
  outletNameSnapshot: string;
  outletAddressSnapshot: string | null;
  receiptFooter?: string | null;
  tableNumber: string;
  tableLabel: string | null;
  voidReason: string | null;
  finalizedAt: string;
  paidAt: string | null;
  createdAt: string;
  lines: BillLineDto[];
  itemGstBreakdown?: BillItemGstDto[];
  paymentAttempts: PaymentAttemptDto[];
  refunds: RefundDto[];
}

