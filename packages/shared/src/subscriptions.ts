import {
  SubscriptionBillingCycle,
  SubscriptionInvoiceStatus,
  SubscriptionStatus,
  SupportCaseCategory,
  SupportCasePriority,
  SupportCaseStatus,
  TenantStatus,
} from './enums';

export const DEFAULT_TRIAL_DAYS = 14;
export const DEFAULT_GRACE_DAYS = 3;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface SubscriptionEvaluationInput {
  subscriptionStatus: SubscriptionStatus;
  tenantStatus: TenantStatus;
  trialEndsAt: Date | string | null;
  currentPeriodEnd: Date | string | null;
  graceEndsAt: Date | string | null;
  graceDays?: number;
  pendingSuspensionAfterService?: boolean;
  activeOpenSessionsCount?: number;
  now?: Date;
}

export interface SubscriptionEvaluationResult {
  effectiveSubscriptionStatus: SubscriptionStatus;
  targetTenantStatus: TenantStatus;
  daysRemaining: number;
  graceDaysRemaining: number;
  inGracePeriod: boolean;
  isReadOnlyLocked: boolean;
  orderingBlocked: boolean;
  canSettleExistingSessions: boolean;
  computedGraceEndsAt: string | null;
}

function toDateOrNull(val: Date | string | null | undefined): Date | null {
  if (!val) return null;
  const d = val instanceof Date ? val : new Date(val);
  return Number.isNaN(d.getTime()) ? null : d;
}

function ceilDaysRemaining(target: Date | null, now: Date): number {
  if (!target) return 0;
  const diffMs = target.getTime() - now.getTime();
  if (diffMs <= 0) return 0;
  return Math.ceil(diffMs / MS_PER_DAY);
}

/**
 * Deterministically evaluates Trial -> Grace (3d) -> Expired/Locked lifecycle transitions
 * and mid-meal live service drain protections so suspended or expired restaurants do not drop open meals.
 */
export function evaluateSubscriptionLifecycle(
  input: SubscriptionEvaluationInput,
): SubscriptionEvaluationResult {
  const now = input.now ?? new Date();
  const graceDays = Math.max(0, input.graceDays ?? DEFAULT_GRACE_DAYS);
  const activeOpenSessionsCount = Math.max(0, input.activeOpenSessionsCount ?? 0);
  const pendingSuspension = Boolean(input.pendingSuspensionAfterService);

  if (input.tenantStatus === TenantStatus.REJECTED) {
    return {
      effectiveSubscriptionStatus: SubscriptionStatus.SUSPENDED,
      targetTenantStatus: TenantStatus.REJECTED,
      daysRemaining: 0,
      graceDaysRemaining: 0,
      inGracePeriod: false,
      isReadOnlyLocked: true,
      orderingBlocked: true,
      canSettleExistingSessions: false,
      computedGraceEndsAt: null,
    };
  }

  if (input.tenantStatus === TenantStatus.PENDING_APPROVAL) {
    return {
      effectiveSubscriptionStatus: input.subscriptionStatus,
      targetTenantStatus: TenantStatus.PENDING_APPROVAL,
      daysRemaining: ceilDaysRemaining(toDateOrNull(input.trialEndsAt), now),
      graceDaysRemaining: 0,
      inGracePeriod: false,
      isReadOnlyLocked: false,
      orderingBlocked: true,
      canSettleExistingSessions: false,
      computedGraceEndsAt: toDateOrNull(input.graceEndsAt)?.toISOString() ?? null,
    };
  }

  if (
    input.subscriptionStatus === SubscriptionStatus.SUSPENDED ||
    input.tenantStatus === TenantStatus.SUSPENDED
  ) {
    const midMealDrainAllowed = activeOpenSessionsCount > 0;
    return {
      effectiveSubscriptionStatus: SubscriptionStatus.SUSPENDED,
      targetTenantStatus: midMealDrainAllowed ? TenantStatus.LOCKED : TenantStatus.SUSPENDED,
      daysRemaining: 0,
      graceDaysRemaining: 0,
      inGracePeriod: false,
      isReadOnlyLocked: true,
      orderingBlocked: true,
      canSettleExistingSessions: midMealDrainAllowed,
      computedGraceEndsAt: null,
    };
  }

  if (pendingSuspension) {
    const midMealDrainAllowed = activeOpenSessionsCount > 0;
    return {
      effectiveSubscriptionStatus: SubscriptionStatus.SUSPENDED,
      targetTenantStatus: midMealDrainAllowed ? TenantStatus.LOCKED : TenantStatus.SUSPENDED,
      daysRemaining: 0,
      graceDaysRemaining: 0,
      inGracePeriod: false,
      isReadOnlyLocked: true,
      orderingBlocked: true,
      canSettleExistingSessions: midMealDrainAllowed,
      computedGraceEndsAt: null,
    };
  }

  const trialEnds = toDateOrNull(input.trialEndsAt);
  const periodEnds = toDateOrNull(input.currentPeriodEnd);
  const explicitGraceEnds = toDateOrNull(input.graceEndsAt);

  if (input.subscriptionStatus === SubscriptionStatus.TRIAL) {
    if (!trialEnds || trialEnds > now) {
      return {
        effectiveSubscriptionStatus: SubscriptionStatus.TRIAL,
        targetTenantStatus: TenantStatus.TRIAL,
        daysRemaining: ceilDaysRemaining(trialEnds, now),
        graceDaysRemaining: 0,
        inGracePeriod: false,
        isReadOnlyLocked: false,
        orderingBlocked: false,
        canSettleExistingSessions: true,
        computedGraceEndsAt: null,
      };
    }

    const derivedGraceEnds =
      explicitGraceEnds && explicitGraceEnds > trialEnds
        ? explicitGraceEnds
        : new Date(trialEnds.getTime() + graceDays * MS_PER_DAY);

    if (derivedGraceEnds > now) {
      const gDays = ceilDaysRemaining(derivedGraceEnds, now);
      return {
        effectiveSubscriptionStatus: SubscriptionStatus.GRACE,
        targetTenantStatus: TenantStatus.GRACE,
        daysRemaining: gDays,
        graceDaysRemaining: gDays,
        inGracePeriod: true,
        isReadOnlyLocked: false,
        orderingBlocked: false,
        canSettleExistingSessions: true,
        computedGraceEndsAt: derivedGraceEnds.toISOString(),
      };
    }

    return {
      effectiveSubscriptionStatus: SubscriptionStatus.EXPIRED,
      targetTenantStatus: TenantStatus.LOCKED,
      daysRemaining: 0,
      graceDaysRemaining: 0,
      inGracePeriod: false,
      isReadOnlyLocked: true,
      orderingBlocked: true,
      canSettleExistingSessions: true,
      computedGraceEndsAt: derivedGraceEnds.toISOString(),
    };
  }

  if (input.subscriptionStatus === SubscriptionStatus.ACTIVE) {
    if (!periodEnds || periodEnds > now) {
      return {
        effectiveSubscriptionStatus: SubscriptionStatus.ACTIVE,
        targetTenantStatus: TenantStatus.ACTIVE,
        daysRemaining: ceilDaysRemaining(periodEnds, now),
        graceDaysRemaining: 0,
        inGracePeriod: false,
        isReadOnlyLocked: false,
        orderingBlocked: false,
        canSettleExistingSessions: true,
        computedGraceEndsAt: null,
      };
    }

    const derivedGraceEnds =
      explicitGraceEnds && explicitGraceEnds > periodEnds
        ? explicitGraceEnds
        : new Date(periodEnds.getTime() + graceDays * MS_PER_DAY);

    if (derivedGraceEnds > now) {
      const gDays = ceilDaysRemaining(derivedGraceEnds, now);
      return {
        effectiveSubscriptionStatus: SubscriptionStatus.GRACE,
        targetTenantStatus: TenantStatus.GRACE,
        daysRemaining: gDays,
        graceDaysRemaining: gDays,
        inGracePeriod: true,
        isReadOnlyLocked: false,
        orderingBlocked: false,
        canSettleExistingSessions: true,
        computedGraceEndsAt: derivedGraceEnds.toISOString(),
      };
    }

    return {
      effectiveSubscriptionStatus: SubscriptionStatus.EXPIRED,
      targetTenantStatus: TenantStatus.LOCKED,
      daysRemaining: 0,
      graceDaysRemaining: 0,
      inGracePeriod: false,
      isReadOnlyLocked: true,
      orderingBlocked: true,
      canSettleExistingSessions: true,
      computedGraceEndsAt: derivedGraceEnds.toISOString(),
    };
  }

  if (input.subscriptionStatus === SubscriptionStatus.GRACE) {
    const fallbackEnd =
      explicitGraceEnds ??
      (trialEnds
        ? new Date(trialEnds.getTime() + graceDays * MS_PER_DAY)
        : periodEnds
          ? new Date(periodEnds.getTime() + graceDays * MS_PER_DAY)
          : new Date(now.getTime() + graceDays * MS_PER_DAY));

    if (fallbackEnd > now) {
      const gDays = ceilDaysRemaining(fallbackEnd, now);
      return {
        effectiveSubscriptionStatus: SubscriptionStatus.GRACE,
        targetTenantStatus: TenantStatus.GRACE,
        daysRemaining: gDays,
        graceDaysRemaining: gDays,
        inGracePeriod: true,
        isReadOnlyLocked: false,
        orderingBlocked: false,
        canSettleExistingSessions: true,
        computedGraceEndsAt: fallbackEnd.toISOString(),
      };
    }

    return {
      effectiveSubscriptionStatus: SubscriptionStatus.EXPIRED,
      targetTenantStatus: TenantStatus.LOCKED,
      daysRemaining: 0,
      graceDaysRemaining: 0,
      inGracePeriod: false,
      isReadOnlyLocked: true,
      orderingBlocked: true,
      canSettleExistingSessions: true,
      computedGraceEndsAt: fallbackEnd.toISOString(),
    };
  }

  // SubscriptionStatus.EXPIRED
  return {
    effectiveSubscriptionStatus: SubscriptionStatus.EXPIRED,
    targetTenantStatus: TenantStatus.LOCKED,
    daysRemaining: 0,
    graceDaysRemaining: 0,
    inGracePeriod: false,
    isReadOnlyLocked: true,
    orderingBlocked: true,
    canSettleExistingSessions: true,
    computedGraceEndsAt: explicitGraceEnds?.toISOString() ?? null,
  };
}

export function formatSupportCaseNumber(sequence: number, now = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `SUP-${year}${month}-${String(sequence).padStart(4, '0')}`;
}

export function formatSubscriptionInvoiceNumber(sequence: number, now = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `SUB-${year}${month}-${String(sequence).padStart(5, '0')}`;
}

export interface PlanDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  monthlyPricePaise: number;
  yearlyPricePaise: number;
  maxOutlets: number;
  maxTables: number;
  maxStaff: number;
  trialDays: number;
  graceDays: number;
  features: string[];
  isActive: boolean;
  sortOrder: number;
}

export interface SubscriptionInvoiceDto {
  id: string;
  invoiceNumber: string;
  planId: string;
  planName?: string;
  billingCycle: SubscriptionBillingCycle;
  amountPaise: number;
  taxPaise: number;
  totalPaise: number;
  status: SubscriptionInvoiceStatus;
  periodStart: string;
  periodEnd: string;
  paidAt: string | null;
  paymentRef: string | null;
  notes: string | null;
  createdAt: string;
}

export interface SubscriptionSummaryDto {
  id: string;
  tenantId: string;
  plan: PlanDto;
  status: SubscriptionStatus;
  billingCycle: SubscriptionBillingCycle;
  startedAt: string;
  trialEndsAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  graceEndsAt: string | null;
  autoRenew: boolean;
  evaluation: SubscriptionEvaluationResult;
}

export interface RestaurantUsageTelemetryDto {
  ordersLast30Days: number;
  ordersLast24Hours: number;
  sessionsLast30Days: number;
  activeOpenSessionsCount: number;
  revenueLast30DaysPaise: number;
  revenueTodayPaise: number;
  tablesCount: number;
  staffCount: number;
}

export interface SupportCaseNoteDto {
  id: string;
  authorUserId: string;
  authorRole: string;
  authorName?: string;
  body: string;
  isInternal: boolean;
  createdAt: string;
}

export interface SupportCaseDto {
  id: string;
  caseNumber: string;
  tenantId: string;
  tenantName?: string;
  outletId: string | null;
  category: SupportCaseCategory;
  priority: SupportCasePriority;
  status: SupportCaseStatus;
  subject: string;
  description: string;
  resolutionNotes: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  notes?: SupportCaseNoteDto[];
}

export interface PlatformOverviewDto {
  restaurantsByStatus: Record<TenantStatus, number>;
  subscriptionsByStatus: Record<SubscriptionStatus, number>;
  totalRestaurants: number;
  approvedRestaurantsCount: number;
  pendingApprovalCount: number;
  rejectedCount: number;
  mrrPaise: number;
  totalSubscriptionRevenuePaise: number;
  platformOrdersLast30Days: number;
  platformSessionsLast30Days: number;
  platformRevenueLast30DaysPaise: number;
  totalRestaurantRevenuePaise: number;
  openSupportCasesCount: number;
}

