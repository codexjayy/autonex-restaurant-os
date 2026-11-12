import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { RealtimeEventsService } from '../../common/realtime/realtime-events.service';
import {
  DEFAULT_GRACE_DAYS,
  DEFAULT_TRIAL_DAYS,
  ErrorCode,
  evaluateSubscriptionLifecycle,
  formatSubscriptionInvoiceNumber,
  PlanDto,
  PlatformOverviewDto,
  RestaurantUsageTelemetryDto,
  SubscriptionBillingCycle,
  SubscriptionInvoiceDto,
  SubscriptionInvoiceStatus,
  SubscriptionStatus,
  SubscriptionSummaryDto,
  TenantStatus,
} from '@autonex/shared';
import {
  BillStatus as PrismaBillStatus,
  DiningSessionStatus as PrismaDiningSessionStatus,
  PaymentMethod as PrismaPaymentMethod,
  PaymentStatus as PrismaPaymentStatus,
  Prisma,
  SubscriptionBillingCycle as PrismaSubscriptionBillingCycle,
  SubscriptionInvoiceStatus as PrismaSubscriptionInvoiceStatus,
  SubscriptionStatus as PrismaSubscriptionStatus,
  TenantStatus as PrismaTenantStatus,
} from '@prisma/client';
import { TenantContextService } from '../../common/context/tenant-context.service';
import {
  AuthenticatedPrincipal,
  requireOutletContext,
} from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  AssignSubscriptionDto,
  CreatePlanDto,
  UpdatePlanDto,
} from './dto/subscriptions.dto';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SAAS_GST_RATE_BPS = 1800;

@Injectable()
export class SubscriptionsService implements OnModuleInit, OnModuleDestroy {
  private sweepInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    @Optional() private readonly realtimeEvents?: RealtimeEventsService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.sweepInterval = setInterval(() => {
      void this.sweepExpiredSubscriptions().catch(() => {
        // Periodic background lifecycle sweep handles errors without crashing API process
      });
    }, 60 * 60 * 1000);
    this.sweepInterval.unref();
  }

  onModuleDestroy(): void {
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
  }

  toPlanDto(plan: {
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
    featuresJson: unknown;
    isActive: boolean;
    sortOrder: number;
  }): PlanDto {
    const features = Array.isArray(plan.featuresJson)
      ? plan.featuresJson.map((entry) => String(entry))
      : [];

    return {
      id: plan.id,
      code: plan.code,
      name: plan.name,
      description: plan.description,
      monthlyPricePaise: plan.monthlyPricePaise,
      yearlyPricePaise: plan.yearlyPricePaise,
      maxOutlets: plan.maxOutlets,
      maxTables: plan.maxTables,
      maxStaff: plan.maxStaff,
      trialDays: plan.trialDays,
      graceDays: plan.graceDays,
      features,
      isActive: plan.isActive,
      sortOrder: plan.sortOrder,
    };
  }

  private toInvoiceDto(inv: {
    id: string;
    invoiceNumber: string;
    planId: string;
    billingCycle: string;
    amountPaise: number;
    taxPaise: number;
    totalPaise: number;
    status: string;
    periodStart: Date;
    periodEnd: Date;
    paidAt: Date | null;
    paymentRef: string | null;
    notes: string | null;
    createdAt: Date;
    plan?: { name: string } | null;
  }): SubscriptionInvoiceDto {
    return {
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      planId: inv.planId,
      planName: inv.plan?.name,
      billingCycle: inv.billingCycle as SubscriptionBillingCycle,
      amountPaise: inv.amountPaise,
      taxPaise: inv.taxPaise,
      totalPaise: inv.totalPaise,
      status: inv.status as SubscriptionInvoiceStatus,
      periodStart: inv.periodStart.toISOString(),
      periodEnd: inv.periodEnd.toISOString(),
      paidAt: inv.paidAt?.toISOString() ?? null,
      paymentRef: inv.paymentRef,
      notes: inv.notes,
      createdAt: inv.createdAt.toISOString(),
    };
  }

  async provisionDefaultTrialTx(
    tx: Prisma.TransactionClient,
    params: { tenantId: string; now?: Date },
  ) {
    if (!tx.subscription?.findUnique || !tx.plan?.findFirst) return null;

    const existing = await tx.subscription.findUnique({
      where: { tenantId: params.tenantId },
      include: { plan: true },
    });
    if (existing) return existing;

    const starterPlan = await tx.plan.findFirst({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
    if (!starterPlan) return null;

    const now = params.now ?? new Date();
    const trialEndsAt = new Date(
      now.getTime() + (starterPlan.trialDays ?? DEFAULT_TRIAL_DAYS) * MS_PER_DAY,
    );
    const graceEndsAt = new Date(
      trialEndsAt.getTime() + (starterPlan.graceDays ?? DEFAULT_GRACE_DAYS) * MS_PER_DAY,
    );

    return tx.subscription.create({
      data: {
        tenantId: params.tenantId,
        planId: starterPlan.id,
        status: PrismaSubscriptionStatus.TRIAL,
        billingCycle: PrismaSubscriptionBillingCycle.MONTHLY,
        startedAt: now,
        trialEndsAt,
        currentPeriodStart: now,
        currentPeriodEnd: trialEndsAt,
        graceEndsAt,
      },
      include: { plan: true },
    });
  }

  async evaluateAndSyncTenantSubscription(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actor?: { userId?: string; role?: string },
    now = new Date(),
  ): Promise<SubscriptionSummaryDto | null> {
    const [tenant, subscription, activeOpenSessionsCount] = await Promise.all([
      tx.tenant.findUnique({
        where: { id: tenantId },
        select: {
          id: true,
          status: true,
          pendingSuspensionAfterService: true,
        },
      }),
      tx.subscription.findUnique({
        where: { tenantId },
        include: { plan: true },
      }),
      tx.diningSession.count({
        where: {
          tenantId,
          status: {
            in: [
              PrismaDiningSessionStatus.ACTIVE,
              PrismaDiningSessionStatus.BILL_REQUESTED,
              PrismaDiningSessionStatus.SETTLED,
            ],
          },
        },
      }),
    ]);

    if (!tenant || !subscription) return null;

    const evaluation = evaluateSubscriptionLifecycle({
      subscriptionStatus: subscription.status as SubscriptionStatus,
      tenantStatus: tenant.status as TenantStatus,
      trialEndsAt: subscription.trialEndsAt,
      currentPeriodEnd: subscription.currentPeriodEnd,
      graceEndsAt: subscription.graceEndsAt,
      graceDays: subscription.plan.graceDays,
      pendingSuspensionAfterService: tenant.pendingSuspensionAfterService,
      activeOpenSessionsCount,
      now,
    });

    const needsSubSync =
      evaluation.effectiveSubscriptionStatus !== (subscription.status as SubscriptionStatus);
    const needsTenantSync =
      tenant.status !== PrismaTenantStatus.PENDING_APPROVAL &&
      evaluation.targetTenantStatus !== (tenant.status as TenantStatus);

    let syncedSub = subscription;
    if (needsSubSync) {
      syncedSub = await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          status: evaluation.effectiveSubscriptionStatus as PrismaSubscriptionStatus,
          graceEndsAt: evaluation.computedGraceEndsAt
            ? new Date(evaluation.computedGraceEndsAt)
            : subscription.graceEndsAt,
          suspendedAt:
            evaluation.effectiveSubscriptionStatus === SubscriptionStatus.SUSPENDED
              ? subscription.suspendedAt ?? now
              : subscription.suspendedAt,
        },
        include: { plan: true },
      });
    }

    if (needsTenantSync) {
      await tx.tenant.update({
        where: { id: tenantId },
        data: {
          status: evaluation.targetTenantStatus as PrismaTenantStatus,
          ...(evaluation.targetTenantStatus === TenantStatus.SUSPENDED
            ? {
                pendingSuspensionAfterService: false,
                suspendedAt: now,
              }
            : {}),
        },
      });
    }

    if (needsSubSync || needsTenantSync) {
      let actorUserId = actor?.userId;
      const actorRole = actor?.role ?? 'SYSTEM';
      if (!actorUserId) {
        const ownerMembership = await tx.membership.findFirst({
          where: { tenantId, role: 'OWNER', isActive: true },
          select: { userId: true },
        });
        const fallbackUser = ownerMembership
          ? { id: ownerMembership.userId }
          : await tx.user.findFirst({
              where: { isSuperAdmin: true },
              select: { id: true },
            });
        actorUserId = fallbackUser?.id;
      }

      if (actorUserId) {
        await tx.auditLog.create({
          data: {
            tenantId,
            actorUserId,
            actorRole,
            action: 'SUBSCRIPTION_AUTO_TRANSITION',
            entityType: 'Subscription',
            entityId: subscription.id,
            beforeJson: {
              subscriptionStatus: subscription.status,
              tenantStatus: tenant.status,
            },
            afterJson: {
              subscriptionStatus: syncedSub.status,
              tenantStatus: evaluation.targetTenantStatus,
              activeOpenSessionsCount,
            },
          },
        });
      }
    }

    return {
      id: syncedSub.id,
      tenantId: syncedSub.tenantId,
      plan: this.toPlanDto(syncedSub.plan),
      status: syncedSub.status as SubscriptionStatus,
      billingCycle: syncedSub.billingCycle as SubscriptionBillingCycle,
      startedAt: syncedSub.startedAt.toISOString(),
      trialEndsAt: syncedSub.trialEndsAt?.toISOString() ?? null,
      currentPeriodStart: syncedSub.currentPeriodStart?.toISOString() ?? null,
      currentPeriodEnd: syncedSub.currentPeriodEnd?.toISOString() ?? null,
      graceEndsAt: syncedSub.graceEndsAt?.toISOString() ?? null,
      autoRenew: syncedSub.autoRenew,
      evaluation,
    };
  }

  async sweepExpiredSubscriptions(now = new Date()) {
    const candidates = await this.prisma.runAsSystemAdmin((db) =>
      db.subscription.findMany({
        where: {
          OR: [
            { status: PrismaSubscriptionStatus.TRIAL, trialEndsAt: { lte: now } },
            { status: PrismaSubscriptionStatus.ACTIVE, currentPeriodEnd: { lte: now } },
            { status: PrismaSubscriptionStatus.GRACE, graceEndsAt: { lte: now } },
            { tenant: { pendingSuspensionAfterService: true } },
          ],
        },
        select: { tenantId: true, status: true },
      }),
    );

    const transitionedTenantIds: string[] = [];
    const lockedTenantIds: string[] = [];
    const graceTenantIds: string[] = [];

    for (const candidate of candidates) {
      const result = await this.prisma.runAsSystemAdmin((db) =>
        db.$transaction((tx) =>
          this.evaluateAndSyncTenantSubscription(tx, candidate.tenantId, undefined, now),
        ),
      );
      if (result && result.status !== (candidate.status as SubscriptionStatus)) {
        transitionedTenantIds.push(candidate.tenantId);
        if (result.evaluation.isReadOnlyLocked) {
          lockedTenantIds.push(candidate.tenantId);
        } else if (result.evaluation.inGracePeriod) {
          graceTenantIds.push(candidate.tenantId);
        }
      }
    }

    return {
      sweptAt: now.toISOString(),
      checkedCount: candidates.length,
      transitionedCount: transitionedTenantIds.length,
      graceTenantIds,
      lockedTenantIds,
    };
  }

  async computeTenantTelemetry(
    tx: Prisma.TransactionClient,
    tenantId: string,
    now = new Date(),
  ): Promise<RestaurantUsageTelemetryDto> {
    const thirtyDaysAgo = new Date(now.getTime() - 30 * MS_PER_DAY);
    const twentyFourHoursAgo = new Date(now.getTime() - MS_PER_DAY);
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const [
      ordersLast30Days,
      ordersLast24Hours,
      sessionsLast30Days,
      activeOpenSessionsCount,
      revenue30Agg,
      revenueTodayAgg,
      tablesCount,
      staffCount,
    ] = await Promise.all([
      tx.order.count({
        where: { tenantId, createdAt: { gte: thirtyDaysAgo } },
      }),
      tx.order.count({
        where: { tenantId, createdAt: { gte: twentyFourHoursAgo } },
      }),
      tx.diningSession.count({
        where: { tenantId, openedAt: { gte: thirtyDaysAgo } },
      }),
      tx.diningSession.count({
        where: {
          tenantId,
          status: {
            in: [
              PrismaDiningSessionStatus.ACTIVE,
              PrismaDiningSessionStatus.BILL_REQUESTED,
              PrismaDiningSessionStatus.SETTLED,
            ],
          },
        },
      }),
      tx.bill.aggregate({
        where: {
          tenantId,
          status: { in: [PrismaBillStatus.PAID, PrismaBillStatus.PARTIALLY_PAID] },
          createdAt: { gte: thirtyDaysAgo },
        },
        _sum: { paidPaise: true },
      }),
      tx.bill.aggregate({
        where: {
          tenantId,
          status: { in: [PrismaBillStatus.PAID, PrismaBillStatus.PARTIALLY_PAID] },
          createdAt: { gte: todayStart },
        },
        _sum: { paidPaise: true },
      }),
      tx.restaurantTable.count({
        where: { tenantId, isActive: true },
      }),
      tx.membership.count({
        where: { tenantId, isActive: true },
      }),
    ]);

    return {
      ordersLast30Days,
      ordersLast24Hours,
      sessionsLast30Days,
      activeOpenSessionsCount,
      revenueLast30DaysPaise: revenue30Agg._sum.paidPaise ?? 0,
      revenueTodayPaise: revenueTodayAgg._sum.paidPaise ?? 0,
      tablesCount,
      staffCount,
    };
  }

  async listPlans(includeInactive = false): Promise<PlanDto[]> {
    const plans = await this.prisma.runAsSystemAdmin((db) =>
      db.plan.findMany({
        where: includeInactive ? {} : { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { monthlyPricePaise: 'asc' }],
      }),
    );

    return plans.map((plan) => this.toPlanDto(plan));
  }

  async createPlan(principal: AuthenticatedPrincipal, dto: CreatePlanDto): Promise<PlanDto> {
    const code = dto.code.trim().toUpperCase();
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    const existing = await this.prisma.runAsSystemAdmin((db) =>
      db.plan.findUnique({ where: { code }, select: { id: true } }),
    );
    if (existing) {
      throw new ConflictException({
        code: ErrorCode.CONFLICT,
        message: `Plan code '${code}' already exists.`,
      });
    }

    const featuresPayload = dto.features ?? dto.featuresJson ?? [];

    const created = await this.prisma.runAsSystemAdmin((db) =>
      db.$transaction(async (tx) => {
        const plan = await tx.plan.create({
          data: {
            code,
            name: dto.name.trim(),
            description: dto.description?.trim() ?? null,
            monthlyPricePaise: dto.monthlyPricePaise,
            yearlyPricePaise: dto.yearlyPricePaise,
            maxOutlets: dto.maxOutlets ?? 1,
            maxTables: dto.maxTables ?? 30,
            maxStaff: dto.maxStaff ?? 15,
            trialDays: dto.trialDays ?? DEFAULT_TRIAL_DAYS,
            graceDays: dto.graceDays ?? DEFAULT_GRACE_DAYS,
            sortOrder: dto.sortOrder ?? 10,
            featuresJson: featuresPayload as Prisma.InputJsonValue,
          },
        });

        await tx.auditLog.create({
          data: {
            tenantId: null,
            actorUserId: principal.userId,
            actorRole: principal.role,
            action: 'PLAN_CREATED',
            entityType: 'Plan',
            entityId: plan.id,
            afterJson: {
              code: plan.code,
              name: plan.name,
              monthlyPricePaise: plan.monthlyPricePaise,
              yearlyPricePaise: plan.yearlyPricePaise,
              maxTables: plan.maxTables,
              maxStaff: plan.maxStaff,
            },
            ipAddress,
          },
        });

        return plan;
      }),
    );

    return this.toPlanDto(created);
  }

  async updatePlan(
    principal: AuthenticatedPrincipal,
    planId: string,
    dto: UpdatePlanDto,
  ): Promise<PlanDto> {
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    const updated = await this.prisma.runAsSystemAdmin((db) =>
      db.$transaction(async (tx) => {
        const existing = await tx.plan.findUnique({ where: { id: planId } });
        if (!existing) {
          throw new NotFoundException({
            code: ErrorCode.PLAN_NOT_FOUND,
            message: 'Subscription plan not found.',
          });
        }

        const featuresPayload =
          dto.features !== undefined
            ? dto.features
            : dto.featuresJson !== undefined
              ? dto.featuresJson
              : existing.featuresJson;

        const saved = await tx.plan.update({
          where: { id: planId },
          data: {
            name: dto.name?.trim() ?? existing.name,
            description:
              dto.description !== undefined ? dto.description.trim() || null : existing.description,
            monthlyPricePaise: dto.monthlyPricePaise ?? existing.monthlyPricePaise,
            yearlyPricePaise: dto.yearlyPricePaise ?? existing.yearlyPricePaise,
            maxOutlets: dto.maxOutlets ?? existing.maxOutlets,
            maxTables: dto.maxTables ?? existing.maxTables,
            maxStaff: dto.maxStaff ?? existing.maxStaff,
            trialDays: dto.trialDays ?? existing.trialDays,
            graceDays: dto.graceDays ?? existing.graceDays,
            sortOrder: dto.sortOrder ?? existing.sortOrder,
            isActive: dto.isActive ?? existing.isActive,
            featuresJson: featuresPayload as Prisma.InputJsonValue,
          },
        });

        await tx.auditLog.create({
          data: {
            tenantId: null,
            actorUserId: principal.userId,
            actorRole: principal.role,
            action: 'PLAN_UPDATED',
            entityType: 'Plan',
            entityId: saved.id,
            beforeJson: {
              name: existing.name,
              monthlyPricePaise: existing.monthlyPricePaise,
              yearlyPricePaise: existing.yearlyPricePaise,
              isActive: existing.isActive,
            },
            afterJson: {
              name: saved.name,
              monthlyPricePaise: saved.monthlyPricePaise,
              yearlyPricePaise: saved.yearlyPricePaise,
              isActive: saved.isActive,
            },
            ipAddress,
          },
        });

        return saved;
      }),
    );

    return this.toPlanDto(updated);
  }

  async getOwnerCurrentSubscription(principal: AuthenticatedPrincipal) {
    const ctx = requireOutletContext(principal);
    const plans = await this.listPlans(false);

    return this.prisma.runInTenantTx(async (tx) => {
      await this.provisionDefaultTrialTx(tx, { tenantId: ctx.tenantId });
      const subscription = await this.evaluateAndSyncTenantSubscription(
        tx,
        ctx.tenantId,
        { userId: ctx.userId, role: ctx.role },
      );

      const [tenant, invoices, telemetry, openSupportCasesCount] = await Promise.all([
        tx.tenant.findUniqueOrThrow({
          where: { id: ctx.tenantId },
          select: {
            id: true,
            name: true,
            status: true,
            pendingSuspensionAfterService: true,
            suspensionReason: true,
          },
        }),
        tx.subscriptionInvoice.findMany({
          where: { tenantId: ctx.tenantId },
          orderBy: { createdAt: 'desc' },
          take: 25,
          include: { plan: { select: { name: true } } },
        }),
        this.computeTenantTelemetry(tx, ctx.tenantId),
        tx.supportCase.count({
          where: {
            tenantId: ctx.tenantId,
            status: { in: ['OPEN', 'IN_PROGRESS'] },
          },
        }),
      ]);

      return {
        tenant,
        subscription,
        telemetry,
        openSupportCasesCount,
        invoices: invoices.map((inv) => this.toInvoiceDto(inv)),
        availablePlans: plans,
      };
    }, ctx.tenantId);
  }

  async getOwnerDailySummary(principal: AuthenticatedPrincipal) {
    const ctx = requireOutletContext(principal);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    return this.prisma.runInTenantTx(async (tx) => {
      const [tenant, ordersToday, sessionsToday, billsToday, paymentsToday] = await Promise.all([
        tx.tenant.findUnique({
          where: { id: ctx.tenantId },
          select: { id: true, name: true, status: true },
        }),
        tx.order.count({
          where: { tenantId: ctx.tenantId, createdAt: { gte: todayStart } },
        }),
        tx.diningSession.count({
          where: { tenantId: ctx.tenantId, openedAt: { gte: todayStart } },
        }),
        tx.bill.findMany({
          where: { tenantId: ctx.tenantId, createdAt: { gte: todayStart } },
          select: {
            billNumber: true,
            status: true,
            subtotalPaise: true,
            discountPaise: true,
            cgstPaise: true,
            sgstPaise: true,
            totalPaise: true,
            paidPaise: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        }),
        tx.paymentAttempt.groupBy({
          by: ['method'],
          where: {
            tenantId: ctx.tenantId,
            status: PrismaPaymentStatus.SUCCEEDED,
            createdAt: { gte: todayStart },
          },
          _sum: { amountPaise: true },
          _count: { _all: true },
        }),
      ]);

      const settledBills = billsToday.filter((b) => b.status === PrismaBillStatus.PAID);
      const paymentBreakdown: Record<string, number> = {
        [PrismaPaymentMethod.CASH]: 0,
        [PrismaPaymentMethod.UPI_MANUAL]: 0,
        [PrismaPaymentMethod.UPI_GATEWAY]: 0,
        [PrismaPaymentMethod.CARD]: 0,
      };
      for (const p of paymentsToday) {
        paymentBreakdown[p.method] = p._sum.amountPaise ?? 0;
      }

      return {
        exportedAt: new Date().toISOString(),
        date: todayStart.toISOString().slice(0, 10),
        restaurantName: tenant?.name ?? 'Restaurant',
        tenantStatus: tenant?.status ?? TenantStatus.LOCKED,
        totals: {
          ordersToday,
          sessionsToday,
          billsGenerated: billsToday.length,
          billsPaid: settledBills.length,
          grossSubtotalPaise: billsToday.reduce((sum, b) => sum + b.subtotalPaise, 0),
          totalDiscountPaise: billsToday.reduce((sum, b) => sum + b.discountPaise, 0),
          totalGstPaise: billsToday.reduce((sum, b) => sum + b.cgstPaise + b.sgstPaise, 0),
          totalBilledPaise: billsToday.reduce((sum, b) => sum + b.totalPaise, 0),
          totalCollectedPaise: billsToday.reduce((sum, b) => sum + b.paidPaise, 0),
        },
        paymentMethodTotalsPaise: paymentBreakdown,
        bills: billsToday.map((b) => ({
          ...b,
          createdAt: b.createdAt.toISOString(),
        })),
      };
    }, ctx.tenantId);
  }

  async assignOrUpdateSubscription(
    principal: AuthenticatedPrincipal,
    tenantId: string,
    dto: AssignSubscriptionDto,
  ) {
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;
    const invoiceCountBefore = await this.prisma.runAsSystemAdmin((db) =>
      db.subscriptionInvoice.count(),
    );

    const result = await this.prisma.runAsSystemAdmin((db) =>
      db.$transaction(async (tx) => {
        const [tenant, plan, existingSub] = await Promise.all([
          tx.tenant.findUnique({ where: { id: tenantId } }),
          tx.plan.findUnique({ where: { id: dto.planId } }),
          tx.subscription.findUnique({
            where: { tenantId },
            include: { plan: true },
          }),
        ]);

        if (!tenant) {
          throw new NotFoundException({
            code: ErrorCode.NOT_FOUND,
            message: 'Restaurant tenant not found.',
          });
        }
        if (!plan) {
          throw new NotFoundException({
            code: ErrorCode.PLAN_NOT_FOUND,
            message: 'Subscription plan not found.',
          });
        }

        const now = new Date();
        const billingCycle =
          (dto.billingCycle as PrismaSubscriptionBillingCycle) ??
          PrismaSubscriptionBillingCycle.MONTHLY;
        const durationMonths =
          dto.durationMonths ?? (billingCycle === PrismaSubscriptionBillingCycle.YEARLY ? 12 : 1);
        const nextStatus =
          (dto.status as PrismaSubscriptionStatus) ?? PrismaSubscriptionStatus.ACTIVE;

        const periodEnd = new Date(now);
        if (nextStatus === PrismaSubscriptionStatus.TRIAL) {
          periodEnd.setTime(now.getTime() + plan.trialDays * MS_PER_DAY);
        } else {
          periodEnd.setMonth(periodEnd.getMonth() + durationMonths);
        }
        const graceEndsAt = new Date(periodEnd.getTime() + plan.graceDays * MS_PER_DAY);

        const savedSub = existingSub
          ? await tx.subscription.update({
              where: { tenantId },
              data: {
                planId: plan.id,
                status: nextStatus,
                billingCycle,
                currentPeriodStart: now,
                currentPeriodEnd: periodEnd,
                trialEndsAt:
                  nextStatus === PrismaSubscriptionStatus.TRIAL ? periodEnd : existingSub.trialEndsAt,
                graceEndsAt,
                suspendedAt:
                  nextStatus === PrismaSubscriptionStatus.SUSPENDED ? now : null,
              },
              include: { plan: true },
            })
          : await tx.subscription.create({
              data: {
                tenantId,
                planId: plan.id,
                status: nextStatus,
                billingCycle,
                startedAt: now,
                trialEndsAt: nextStatus === PrismaSubscriptionStatus.TRIAL ? periodEnd : null,
                currentPeriodStart: now,
                currentPeriodEnd: periodEnd,
                graceEndsAt,
                suspendedAt:
                  nextStatus === PrismaSubscriptionStatus.SUSPENDED ? now : null,
              },
              include: { plan: true },
            });

        let targetTenantStatus = tenant.status;
        if (nextStatus === PrismaSubscriptionStatus.TRIAL) {
          targetTenantStatus = PrismaTenantStatus.TRIAL;
        } else if (nextStatus === PrismaSubscriptionStatus.ACTIVE) {
          targetTenantStatus = PrismaTenantStatus.ACTIVE;
        } else if (nextStatus === PrismaSubscriptionStatus.GRACE) {
          targetTenantStatus = PrismaTenantStatus.GRACE;
        } else if (nextStatus === PrismaSubscriptionStatus.EXPIRED) {
          targetTenantStatus = PrismaTenantStatus.LOCKED;
        } else if (nextStatus === PrismaSubscriptionStatus.SUSPENDED) {
          targetTenantStatus = PrismaTenantStatus.SUSPENDED;
        }

        if (tenant.status !== PrismaTenantStatus.PENDING_APPROVAL) {
          await tx.tenant.update({
            where: { id: tenantId },
            data: {
              status: targetTenantStatus,
              pendingSuspensionAfterService: false,
              suspendedAt:
                targetTenantStatus === PrismaTenantStatus.SUSPENDED ? now : null,
            },
          });
        }

        let createdInvoice: SubscriptionInvoiceDto | null = null;
        if (
          dto.recordPaidInvoice !== false &&
          (nextStatus === PrismaSubscriptionStatus.ACTIVE || dto.amountPaiseOverride !== undefined)
        ) {
          const basePaise =
            dto.amountPaiseOverride ??
            (billingCycle === PrismaSubscriptionBillingCycle.YEARLY
              ? plan.yearlyPricePaise
              : plan.monthlyPricePaise);
          const taxPaise =
            basePaise > 0 ? Math.round((basePaise * SAAS_GST_RATE_BPS) / 10000) : 0;
          const inv = await tx.subscriptionInvoice.create({
            data: {
              tenantId,
              subscriptionId: savedSub.id,
              planId: plan.id,
              invoiceNumber: formatSubscriptionInvoiceNumber(invoiceCountBefore + 1, now),
              billingCycle,
              amountPaise: basePaise,
              taxPaise,
              totalPaise: basePaise + taxPaise,
              status: PrismaSubscriptionInvoiceStatus.PAID,
              periodStart: now,
              periodEnd,
              paidAt: now,
              paymentRef:
                dto.paymentReference?.trim() ??
                (dto.paymentMethod ? `${dto.paymentMethod}-ADMIN` : 'ADMIN-RECORDED'),
              notes: dto.notes?.trim() ?? `Assigned ${plan.name} (${billingCycle})`,
            },
            include: { plan: { select: { name: true } } },
          });
          createdInvoice = this.toInvoiceDto(inv);
        }

        await tx.auditLog.create({
          data: {
            tenantId,
            actorUserId: principal.userId,
            actorRole: principal.role,
            action: 'SUBSCRIPTION_UPDATED',
            entityType: 'Subscription',
            entityId: savedSub.id,
            beforeJson: existingSub
              ? {
                  planCode: existingSub.plan.code,
                  status: existingSub.status,
                  billingCycle: existingSub.billingCycle,
                }
              : Prisma.JsonNull,
            afterJson: {
              planCode: savedSub.plan.code,
              status: savedSub.status,
              billingCycle: savedSub.billingCycle,
              tenantStatus: targetTenantStatus,
              invoiceNumber: createdInvoice?.invoiceNumber ?? null,
            },
            ipAddress,
          },
        });

        const evaluated = await this.evaluateAndSyncTenantSubscription(
          tx,
          tenantId,
          { userId: principal.userId, role: principal.role },
          now,
        );

        return {
          subscription: evaluated,
          invoice: createdInvoice,
        };
      }),
    );

    this.realtimeEvents?.emit({
      type: 'subscription.updated',
      tenantId,
      tenantWide: true,
      payload: {
        tenantId,
        planCode: result.subscription?.plan?.code ?? null,
        status: result.subscription?.status ?? null,
      },
    });
    return result;
  }

  async listAllSubscriptions() {
    const subs = await this.prisma.runAsSystemAdmin((db) =>
      db.subscription.findMany({
        where: { tenant: { deletedAt: null } },
        orderBy: { updatedAt: 'desc' },
        include: {
          plan: true,
          tenant: { select: { id: true, name: true, slug: true, status: true } },
        },
      }),
    );

    return subs.map((s) => ({
      id: s.id,
      tenantId: s.tenantId,
      tenantName: s.tenant.name,
      tenantSlug: s.tenant.slug,
      tenantStatus: s.tenant.status,
      plan: this.toPlanDto(s.plan),
      status: s.status,
      billingCycle: s.billingCycle,
      startedAt: s.startedAt.toISOString(),
      trialEndsAt: s.trialEndsAt?.toISOString() ?? null,
      currentPeriodStart: s.currentPeriodStart?.toISOString() ?? null,
      currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
      graceEndsAt: s.graceEndsAt?.toISOString() ?? null,
      autoRenew: s.autoRenew,
    }));
  }

  async getPlatformOverview(): Promise<{
    overview: PlatformOverviewDto;
    restaurantsTelemetry: Array<{
      tenantId: string;
      tenantName: string;
      status: TenantStatus;
      planName: string | null;
      subscriptionStatus: SubscriptionStatus | null;
      telemetry: RestaurantUsageTelemetryDto;
    }>;
  }> {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * MS_PER_DAY);
    const twentyFourHoursAgo = new Date(now.getTime() - MS_PER_DAY);

    return this.prisma.runAsSystemAdmin(async (db) => {
      const [
        tenants,
        subscriptions,
        orders30ByTenant,
        orders24ByTenant,
        sessions30ByTenant,
        activeSessionsByTenant,
        revenue30ByTenant,
        tablesByTenant,
        staffByTenant,
        openSupportCasesCount,
        paidSubInvoicesAgg,
        allTimeBillsAgg,
      ] = await Promise.all([
        db.tenant.findMany({
          orderBy: { createdAt: 'desc' },
          select: { id: true, name: true, status: true },
        }),
        db.subscription.findMany({ include: { plan: true } }),
        db.order.groupBy({
          by: ['tenantId'],
          where: { createdAt: { gte: thirtyDaysAgo } },
          _count: { _all: true },
        }),
        db.order.groupBy({
          by: ['tenantId'],
          where: { createdAt: { gte: twentyFourHoursAgo } },
          _count: { _all: true },
        }),
        db.diningSession.groupBy({
          by: ['tenantId'],
          where: { openedAt: { gte: thirtyDaysAgo } },
          _count: { _all: true },
        }),
        db.diningSession.groupBy({
          by: ['tenantId'],
          where: {
            status: {
              in: [
                PrismaDiningSessionStatus.ACTIVE,
                PrismaDiningSessionStatus.BILL_REQUESTED,
                PrismaDiningSessionStatus.SETTLED,
              ],
            },
          },
          _count: { _all: true },
        }),
        db.bill.groupBy({
          by: ['tenantId'],
          where: {
            status: { in: [PrismaBillStatus.PAID, PrismaBillStatus.PARTIALLY_PAID] },
            createdAt: { gte: thirtyDaysAgo },
          },
          _sum: { paidPaise: true },
        }),
        db.restaurantTable.groupBy({
          by: ['tenantId'],
          where: { isActive: true },
          _count: { _all: true },
        }),
        db.membership.groupBy({
          by: ['tenantId'],
          where: { isActive: true },
          _count: { _all: true },
        }),
        db.supportCase.count({
          where: { status: { in: ['OPEN', 'IN_PROGRESS'] } },
        }),
        db.subscriptionInvoice?.aggregate?.({
          where: { status: 'PAID' },
          _sum: { totalPaise: true },
        }) ?? Promise.resolve(null),
        db.bill?.aggregate?.({
          where: {
            status: { in: [PrismaBillStatus.PAID, PrismaBillStatus.PARTIALLY_PAID] },
          },
          _sum: { paidPaise: true },
        }) ?? Promise.resolve(null),
      ]);

      const restaurantsByStatus: Record<TenantStatus, number> = {
        [TenantStatus.PENDING_APPROVAL]: 0,
        [TenantStatus.TRIAL]: 0,
        [TenantStatus.ACTIVE]: 0,
        [TenantStatus.GRACE]: 0,
        [TenantStatus.LOCKED]: 0,
        [TenantStatus.SUSPENDED]: 0,
        [TenantStatus.REJECTED]: 0,
      };
      for (const t of tenants) {
        restaurantsByStatus[t.status as TenantStatus] =
          (restaurantsByStatus[t.status as TenantStatus] ?? 0) + 1;
      }

      const subscriptionsByStatus: Record<SubscriptionStatus, number> = {
        [SubscriptionStatus.TRIAL]: 0,
        [SubscriptionStatus.ACTIVE]: 0,
        [SubscriptionStatus.GRACE]: 0,
        [SubscriptionStatus.EXPIRED]: 0,
        [SubscriptionStatus.SUSPENDED]: 0,
      };

      const subByTenant = new Map<string, (typeof subscriptions)[number]>();
      let mrrPaise = 0;
      for (const s of subscriptions) {
        subByTenant.set(s.tenantId, s);
        subscriptionsByStatus[s.status as SubscriptionStatus] =
          (subscriptionsByStatus[s.status as SubscriptionStatus] ?? 0) + 1;
        if (s.status === PrismaSubscriptionStatus.ACTIVE) {
          mrrPaise +=
            s.billingCycle === PrismaSubscriptionBillingCycle.YEARLY
              ? Math.round(s.plan.yearlyPricePaise / 12)
              : s.plan.monthlyPricePaise;
        }
      }

      const mapCount = (rows: Array<{ tenantId: string; _count: { _all: number } }>) =>
        new Map(rows.map((r) => [r.tenantId, r._count._all]));
      const orders30Map = mapCount(orders30ByTenant);
      const orders24Map = mapCount(orders24ByTenant);
      const sessions30Map = mapCount(sessions30ByTenant);
      const activeSessMap = mapCount(activeSessionsByTenant);
      const tablesMap = mapCount(tablesByTenant);
      const staffMap = mapCount(staffByTenant);
      const rev30Map = new Map(
        revenue30ByTenant.map((r) => [r.tenantId, r._sum.paidPaise ?? 0]),
      );

      let platformOrdersLast30Days = 0;
      let platformSessionsLast30Days = 0;
      let platformRevenueLast30DaysPaise = 0;

      const restaurantsTelemetry = tenants.map((tenant) => {
        const orders30 = orders30Map.get(tenant.id) ?? 0;
        const sessions30 = sessions30Map.get(tenant.id) ?? 0;
        const rev30 = rev30Map.get(tenant.id) ?? 0;
        platformOrdersLast30Days += orders30;
        platformSessionsLast30Days += sessions30;
        platformRevenueLast30DaysPaise += rev30;

        const sub = subByTenant.get(tenant.id);
        return {
          tenantId: tenant.id,
          tenantName: tenant.name,
          status: tenant.status as TenantStatus,
          planName: sub?.plan.name ?? null,
          subscriptionStatus: (sub?.status as SubscriptionStatus) ?? null,
          telemetry: {
            ordersLast30Days: orders30,
            ordersLast24Hours: orders24Map.get(tenant.id) ?? 0,
            sessionsLast30Days: sessions30,
            activeOpenSessionsCount: activeSessMap.get(tenant.id) ?? 0,
            revenueLast30DaysPaise: rev30,
            revenueTodayPaise: 0,
            tablesCount: tablesMap.get(tenant.id) ?? 0,
            staffCount: staffMap.get(tenant.id) ?? 0,
          },
        };
      });

      const totalSubscriptionRevenuePaise = paidSubInvoicesAgg?._sum?.totalPaise ?? 0;
      const totalRestaurantRevenuePaise =
        allTimeBillsAgg?._sum?.paidPaise ?? platformRevenueLast30DaysPaise;

      return {
        overview: {
          restaurantsByStatus,
          subscriptionsByStatus,
          totalRestaurants: tenants.length,
          approvedRestaurantsCount:
            restaurantsByStatus[TenantStatus.ACTIVE] + restaurantsByStatus[TenantStatus.TRIAL],
          pendingApprovalCount: restaurantsByStatus[TenantStatus.PENDING_APPROVAL],
          rejectedCount: restaurantsByStatus[TenantStatus.REJECTED],
          mrrPaise,
          totalSubscriptionRevenuePaise,
          platformOrdersLast30Days,
          platformSessionsLast30Days,
          platformRevenueLast30DaysPaise,
          totalRestaurantRevenuePaise,
          openSupportCasesCount,
        },
        restaurantsTelemetry,
      };
    });
  }

  async extendTrial(
    principal: AuthenticatedPrincipal,
    tenantId: string,
    days: number,
    reason?: string,
  ) {
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;
    const safeDays = Math.min(Math.max(Math.round(days), 1), 90);

    return this.prisma.runAsSystemAdmin((db) =>
      db.$transaction(async (tx) => {
        const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
        if (!tenant) {
          throw new NotFoundException({
            code: ErrorCode.NOT_FOUND,
            message: 'Restaurant tenant not found.',
          });
        }

        if (
          tenant.status === PrismaTenantStatus.PENDING_APPROVAL ||
          tenant.status === PrismaTenantStatus.REJECTED
        ) {
          throw new BadRequestException({
            code: ErrorCode.VALIDATION_ERROR,
            message: `Cannot extend trial while restaurant is ${tenant.status}. Approve or reactivate first.`,
          });
        }

        const existingSub = await tx.subscription.findUnique({
          where: { tenantId },
          include: { plan: true },
        });
        const sub =
          existingSub ?? (await this.provisionDefaultTrialTx(tx, { tenantId }));
        if (!sub) {
          throw new NotFoundException({
            code: ErrorCode.PLAN_NOT_FOUND,
            message: 'Subscription record not found for tenant.',
          });
        }

        const now = new Date();
        const baseEnd =
          sub.trialEndsAt && sub.trialEndsAt.getTime() > now.getTime()
            ? sub.trialEndsAt
            : now;
        const newTrialEnd = new Date(baseEnd.getTime() + safeDays * MS_PER_DAY);

        const updatedSub = await tx.subscription.update({
          where: { id: sub.id },
          data: {
            status: PrismaSubscriptionStatus.TRIAL,
            trialEndsAt: newTrialEnd,
            currentPeriodEnd: newTrialEnd,
            graceEndsAt: null,
          },
          include: { plan: true },
        });

        if (
          tenant.status === PrismaTenantStatus.GRACE ||
          tenant.status === PrismaTenantStatus.LOCKED ||
          tenant.status === PrismaTenantStatus.SUSPENDED
        ) {
          await tx.tenant.update({
            where: { id: tenantId },
            data: {
              status: PrismaTenantStatus.TRIAL,
              pendingSuspensionAfterService: false,
              suspendedAt: null,
              suspensionReason: null,
            },
          });
        }

        await tx.auditLog.create({
          data: {
            tenantId,
            actorUserId: principal.userId,
            actorRole: principal.role,
            action: 'SUBSCRIPTION_TRIAL_EXTENDED',
            entityType: 'Subscription',
            entityId: sub.id,
            beforeJson: {
              status: sub.status,
              trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
            },
            afterJson: {
              status: updatedSub.status,
              trialEndsAt: newTrialEnd.toISOString(),
              addedDays: safeDays,
              reason: reason?.trim() ?? null,
            },
            ipAddress,
          },
        });

        const res = {
          id: updatedSub.id,
          tenantId: updatedSub.tenantId,
          status: updatedSub.status,
          trialEndsAt: updatedSub.trialEndsAt?.toISOString() ?? null,
          currentPeriodEnd: updatedSub.currentPeriodEnd?.toISOString() ?? null,
          planName: updatedSub.plan.name,
        };
        this.realtimeEvents?.emit({
          type: 'trial.updated',
          tenantId,
          tenantWide: true,
          payload: res,
        });
        return res;
      }),
    );
  }

  async listAdminPayments() {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * MS_PER_DAY);

    return this.prisma.runAsSystemAdmin(async (db) => {
      const [
        invoices,
        paidSubAgg,
        pendingSubAgg,
        activeSubs,
        todayBillsByTenant,
        thirtyDayBillsByTenant,
        tenants,
      ] = await Promise.all([
        db.subscriptionInvoice.findMany({
          orderBy: { createdAt: 'desc' },
          take: 100,
          include: {
            plan: { select: { name: true, code: true } },
            tenant: { select: { id: true, name: true, slug: true, status: true } },
          },
        }),
        db.subscriptionInvoice.aggregate({
          where: { status: PrismaSubscriptionInvoiceStatus.PAID },
          _sum: { totalPaise: true },
        }),
        db.subscriptionInvoice.aggregate({
          where: { status: PrismaSubscriptionInvoiceStatus.PENDING },
          _sum: { totalPaise: true },
        }),
        db.subscription.findMany({
          where: { status: PrismaSubscriptionStatus.ACTIVE },
          include: { plan: true },
        }),
        db.bill.groupBy({
          by: ['tenantId'],
          where: {
            status: { in: [PrismaBillStatus.PAID, PrismaBillStatus.PARTIALLY_PAID] },
            createdAt: { gte: todayStart },
          },
          _sum: { paidPaise: true },
          _count: { _all: true },
        }),
        db.bill.groupBy({
          by: ['tenantId'],
          where: {
            status: { in: [PrismaBillStatus.PAID, PrismaBillStatus.PARTIALLY_PAID] },
            createdAt: { gte: thirtyDaysAgo },
          },
          _sum: { paidPaise: true },
          _count: { _all: true },
        }),
        db.tenant.findMany({
          where: { deletedAt: null },
          select: { id: true, name: true, slug: true, status: true },
          orderBy: { createdAt: 'desc' },
        }),
      ]);

      let mrrPaise = 0;
      for (const s of activeSubs) {
        mrrPaise +=
          s.billingCycle === PrismaSubscriptionBillingCycle.YEARLY
            ? Math.round(s.plan.yearlyPricePaise / 12)
            : s.plan.monthlyPricePaise;
      }

      const todayMap = new Map(
        todayBillsByTenant.map((r) => [
          r.tenantId,
          { revenuePaise: r._sum.paidPaise ?? 0, billsCount: r._count._all },
        ]),
      );
      const thirtyMap = new Map(
        thirtyDayBillsByTenant.map((r) => [
          r.tenantId,
          { revenuePaise: r._sum.paidPaise ?? 0, billsCount: r._count._all },
        ]),
      );

      let todayRestaurantRevenuePaise = 0;
      let thirtyDayRestaurantRevenuePaise = 0;

      const restaurantRevenueBreakdown = tenants.map((t) => {
        const td = todayMap.get(t.id) ?? { revenuePaise: 0, billsCount: 0 };
        const th = thirtyMap.get(t.id) ?? { revenuePaise: 0, billsCount: 0 };
        todayRestaurantRevenuePaise += td.revenuePaise;
        thirtyDayRestaurantRevenuePaise += th.revenuePaise;
        return {
          tenantId: t.id,
          tenantName: t.name,
          status: t.status,
          todayRevenuePaise: td.revenuePaise,
          todayBillsCount: td.billsCount,
          last30DaysRevenuePaise: th.revenuePaise,
          last30DaysBillsCount: th.billsCount,
        };
      });

      return {
        summary: {
          mrrPaise,
          totalSubscriptionRevenuePaise: paidSubAgg._sum.totalPaise ?? 0,
          pendingSubscriptionRevenuePaise: pendingSubAgg._sum.totalPaise ?? 0,
          todayRestaurantRevenuePaise,
          last30DaysRestaurantRevenuePaise: thirtyDayRestaurantRevenuePaise,
        },
        subscriptionInvoices: invoices.map((inv) => ({
          id: inv.id,
          invoiceNumber: inv.invoiceNumber,
          tenantId: inv.tenantId,
          tenantName: inv.tenant.name,
          tenantStatus: inv.tenant.status,
          planId: inv.planId,
          planName: inv.plan.name,
          billingCycle: inv.billingCycle,
          amountPaise: inv.amountPaise,
          taxPaise: inv.taxPaise,
          totalPaise: inv.totalPaise,
          status: inv.status,
          periodStart: inv.periodStart.toISOString(),
          periodEnd: inv.periodEnd.toISOString(),
          paidAt: inv.paidAt?.toISOString() ?? null,
          paymentRef: inv.paymentRef,
          notes: inv.notes,
          createdAt: inv.createdAt.toISOString(),
        })),
        restaurantRevenueBreakdown,
      };
    });
  }

  async markInvoicePaid(
    principal: AuthenticatedPrincipal,
    invoiceId: string,
    paymentRef?: string,
    notes?: string,
  ) {
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runAsSystemAdmin((db) =>
      db.$transaction(async (tx) => {
        const existing = await tx.subscriptionInvoice.findUnique({
          where: { id: invoiceId },
          include: { plan: { select: { name: true } } },
        });
        if (!existing) {
          throw new NotFoundException({
            code: ErrorCode.NOT_FOUND,
            message: 'Subscription invoice not found.',
          });
        }

        const now = new Date();
        const updated = await tx.subscriptionInvoice.update({
          where: { id: invoiceId },
          data: {
            status: PrismaSubscriptionInvoiceStatus.PAID,
            paidAt: existing.paidAt ?? now,
            paymentRef: paymentRef?.trim() || existing.paymentRef || `ADMIN-SETTLED-${now.getTime()}`,
            notes: notes?.trim() || existing.notes,
          },
          include: { plan: { select: { name: true } } },
        });

        await tx.auditLog.create({
          data: {
            tenantId: existing.tenantId,
            actorUserId: principal.userId,
            actorRole: principal.role,
            action: 'SUBSCRIPTION_INVOICE_PAID',
            entityType: 'SubscriptionInvoice',
            entityId: invoiceId,
            beforeJson: { status: existing.status },
            afterJson: {
              status: updated.status,
              paymentRef: updated.paymentRef,
              totalPaise: updated.totalPaise,
            },
            ipAddress,
          },
        });

        const dto = this.toInvoiceDto(updated);
        this.realtimeEvents?.emit({
          type: 'subscription.updated',
          tenantId: existing.tenantId,
          tenantWide: true,
          payload: {
            tenantId: existing.tenantId,
            invoiceId: updated.id,
            status: updated.status,
          },
        });
        return dto;
      }),
    );
  }
}
