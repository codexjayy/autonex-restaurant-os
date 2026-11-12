import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  DiningSessionStatus as PrismaDiningSessionStatus,
  Prisma,
  StaffRole as PrismaStaffRole,
  SubscriptionBillingCycle as PrismaSubscriptionBillingCycle,
  SubscriptionStatus as PrismaSubscriptionStatus,
  TenantStatus as PrismaTenantStatus,
} from '@prisma/client';
import {
  ErrorCode,
  SYSTEM_ROLE_SUPER_ADMIN,
  TenantStatus,
} from '@autonex/shared';
import { TenantContextService } from '../../common/context/tenant-context.service';
import { AuthenticatedPrincipal } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RealtimeEventsService } from '../../common/realtime/realtime-events.service';
import { hashSecret } from '../../common/security/crypto.util';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import {
  CreateSuperAdminDto,
  ListAdminUsersQueryDto,
  ListAuditLogsQueryDto,
  OffboardRestaurantDto,
  OnboardRestaurantDto,
  ReactivateRestaurantDto,
  UpdatePlatformSettingsDto,
  UpdateUserStatusDto,
} from './dto/admin-phase7.dto';
import { ApproveTenantDto, RejectTenantDto, SuspendTenantDto } from './dto/approve-tenant.dto';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    @Optional() private readonly subscriptionsService?: SubscriptionsService,
    @Optional() private readonly realtimeEvents?: RealtimeEventsService,
  ) {}

  private buildSlug(name: string): string {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    const suffix = randomBytes(3).toString('hex');
    return `${base || 'restaurant'}-${suffix}`;
  }

  private normalizePhone(phone: string): string {
    const cleaned = phone.trim().replace(/[\s-]/g, '');
    if (cleaned.startsWith('+')) return cleaned;
    if (/^[6-9]\d{9}$/.test(cleaned)) return `+91${cleaned}`;
    return cleaned;
  }

  async listRestaurants(status?: string) {
    const normalized = status?.trim().toUpperCase();
    let whereClause: Prisma.TenantWhereInput | undefined;
    if (normalized === 'APPROVED') {
      whereClause = {
        status: { in: [PrismaTenantStatus.ACTIVE, PrismaTenantStatus.TRIAL] },
      };
    } else if (
      normalized &&
      Object.values(PrismaTenantStatus).includes(normalized as PrismaTenantStatus)
    ) {
      whereClause = { status: normalized as PrismaTenantStatus };
    }

    return this.prisma.runAsSystemAdmin(async (db) => {
      const tenants = await db.tenant.findMany({
        where: whereClause,
        include: {
          outlets: {
            select: {
              id: true,
              name: true,
              contactPhone: true,
              address: true,
              gstin: true,
              gstRateBps: true,
              taxMode: true,
              timezone: true,
              isActive: true,
            },
          },
          memberships: {
            where: { role: PrismaStaffRole.OWNER, deletedAt: null },
            include: {
              user: { select: { id: true, name: true, email: true, phone: true } },
            },
            orderBy: { createdAt: 'asc' },
            take: 3,
          },
          subscription: {
            include: { plan: true },
          },
          _count: {
            select: {
              memberships: true,
              diningSessions: true,
              orders: true,
              supportCases: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      const [activeSessionCounts, billRevenueByTenant] = await Promise.all([
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
        db.bill?.groupBy?.({
          by: ['tenantId'],
          where: { status: { in: ['PAID', 'PARTIALLY_PAID'] } },
          _sum: { paidPaise: true },
        }) ?? Promise.resolve([]),
      ]);

      const activeSessMap = new Map(
        activeSessionCounts.map((row) => [row.tenantId, row._count._all]),
      );
      const revenueMap = new Map(
        billRevenueByTenant.map((row) => [row.tenantId, row._sum?.paidPaise ?? 0]),
      );

      return tenants.map((t) => {
        const ownerMembership = t.memberships?.[0];
        return {
          ...t,
          owner: ownerMembership?.user ?? null,
          revenueTotalPaise: revenueMap.get(t.id) ?? 0,
          activeOpenSessionsCount: activeSessMap.get(t.id) ?? 0,
          subscription: t.subscription
            ? {
                ...t.subscription,
                plan: this.subscriptionsService?.toPlanDto(t.subscription.plan) ?? t.subscription.plan,
              }
            : null,
        };
      });
    });
  }

  async getRestaurantDetail(tenantId: string) {
    const detail = await this.prisma.runAsSystemAdmin(async (db) => {
      const tenant = await db.tenant.findUnique({
        where: { id: tenantId },
        include: {
          approvedByUser: { select: { id: true, name: true, email: true } },
          rejectedByUser: { select: { id: true, name: true, email: true } },
          outlets: true,
          memberships: {
            include: {
              user: { select: { id: true, name: true, email: true, phone: true } },
            },
          },
          subscription: {
            include: { plan: true },
          },
          subscriptionInvoices: {
            orderBy: { createdAt: 'desc' },
            take: 25,
            include: { plan: { select: { name: true } } },
          },
          supportCases: {
            orderBy: { createdAt: 'desc' },
            take: 25,
          },
          auditLogs: {
            take: 50,
            orderBy: { createdAt: 'desc' },
          },
        },
      });

      if (!tenant) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Restaurant tenant not found.',
        });
      }

      const telemetry = this.subscriptionsService
        ? await this.subscriptionsService.computeTenantTelemetry(db, tenantId)
        : null;

      return {
        ...tenant,
        telemetry,
      };
    });

    return detail;
  }

  async approveRestaurant(
    principal: AuthenticatedPrincipal,
    tenantId: string,
    dto: ApproveTenantDto,
  ) {
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;
    const targetStatus =
      dto.targetStatus === 'ACTIVE' ? PrismaTenantStatus.ACTIVE : PrismaTenantStatus.TRIAL;

    const result = await this.prisma.runAsSystemAdmin(async (db) => {
      const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Restaurant tenant not found.',
        });
      }

      if (tenant.status === targetStatus) {
        throw new BadRequestException({
          code: ErrorCode.CONFLICT,
          message: `Restaurant is already in ${targetStatus} status.`,
        });
      }

      return db.$transaction(async (tx) => {
        const now = new Date();
        const updated = await tx.tenant.update({
          where: { id: tenantId },
          data: {
            status: targetStatus,
            approvedAt: now,
            approvedByUserId: principal.userId,
            rejectedAt: null,
            rejectedByUserId: null,
            rejectionReason: null,
            pendingSuspensionAfterService: false,
            suspendedAt: null,
            suspensionReason: null,
          },
        });

        if (this.subscriptionsService) {
          const existingSub = await tx.subscription?.findUnique?.({
            where: { tenantId },
            include: { plan: true },
          });
          if (!existingSub) {
            await this.subscriptionsService.provisionDefaultTrialTx(tx, { tenantId, now });
          } else if (targetStatus === PrismaTenantStatus.ACTIVE) {
            const periodEnd = new Date(now);
            periodEnd.setMonth(periodEnd.getMonth() + 1);
            await tx.subscription.update({
              where: { tenantId },
              data: {
                status: PrismaSubscriptionStatus.ACTIVE,
                currentPeriodStart: now,
                currentPeriodEnd: periodEnd,
                graceEndsAt: new Date(
                  periodEnd.getTime() + existingSub.plan.graceDays * MS_PER_DAY,
                ),
                suspendedAt: null,
              },
            });
          }
        }

        await tx.auditLog.create({
          data: {
            tenantId,
            actorUserId: principal.userId,
            actorRole: SYSTEM_ROLE_SUPER_ADMIN,
            action: 'RESTAURANT_APPROVED',
            entityType: 'Tenant',
            entityId: tenantId,
            beforeJson: { status: tenant.status },
            afterJson: { status: updated.status, note: dto.note ?? null },
            ipAddress,
          },
        });

        return updated;
      });
    });

    this.realtimeEvents?.emit({
      type: 'restaurant.approved',
      tenantId,
      tenantWide: true,
      payload: {
        tenantId,
        status: result.status,
        note: dto.note ?? null,
      },
    });
    return result;
  }

  async rejectRestaurant(
    principal: AuthenticatedPrincipal,
    tenantId: string,
    dto: RejectTenantDto,
  ) {
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    const result = await this.prisma.runAsSystemAdmin(async (db) => {
      const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Restaurant tenant not found.',
        });
      }

      if (tenant.status === PrismaTenantStatus.REJECTED) {
        throw new ConflictException({
          code: ErrorCode.CONFLICT,
          message: 'Restaurant is already rejected.',
        });
      }

      return db.$transaction(async (tx) => {
        const now = new Date();
        const reason = dto.reason.trim();
        const updated = await tx.tenant.update({
          where: { id: tenantId },
          data: {
            status: PrismaTenantStatus.REJECTED,
            rejectedAt: now,
            rejectedByUserId: principal.userId,
            rejectionReason: reason,
            pendingSuspensionAfterService: false,
          },
        });

        const existingSub = await tx.subscription?.findUnique?.({
          where: { tenantId },
        });
        if (existingSub) {
          await tx.subscription.update({
            where: { tenantId },
            data: {
              status: PrismaSubscriptionStatus.SUSPENDED,
              suspendedAt: now,
              autoRenew: false,
            },
          });
        }

        await tx.refreshToken?.updateMany?.({
          where: { tenantId, revokedAt: null },
          data: { revokedAt: now },
        });

        await tx.session?.updateMany?.({
          where: { tenantId, revokedAt: null },
          data: { revokedAt: now },
        });

        await tx.auditLog.create({
          data: {
            tenantId,
            actorUserId: principal.userId,
            actorRole: SYSTEM_ROLE_SUPER_ADMIN,
            action: 'RESTAURANT_REJECTED',
            entityType: 'Tenant',
            entityId: tenantId,
            beforeJson: { status: tenant.status },
            afterJson: { status: updated.status, reason },
            ipAddress,
          },
        });

        return updated;
      });
    });

    this.realtimeEvents?.emit({
      type: 'restaurant.rejected',
      tenantId,
      tenantWide: true,
      payload: {
        tenantId,
        status: result.status,
        reason: result.rejectionReason ?? dto.reason.trim(),
      },
    });
    return result;
  }

  async onboardRestaurant(principal: AuthenticatedPrincipal, dto: OnboardRestaurantDto) {
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;
    const emailNormalized = dto.ownerEmail.trim().toLowerCase();
    const phoneNormalized = this.normalizePhone(dto.ownerPhone);
    const passwordHash = await hashSecret(dto.password);

    return this.prisma.runAsSystemAdmin(async (db) => {
      const existingUser = await db.user.findFirst({
        where: {
          OR: [{ email: emailNormalized }, { phone: phoneNormalized }],
        },
        select: { id: true, email: true, phone: true },
      });
      if (existingUser) {
        throw new ConflictException({
          code: ErrorCode.CONFLICT,
          message:
            existingUser.email === emailNormalized
              ? 'An account with this email already exists.'
              : 'An account with this phone number already exists.',
        });
      }

      const plan = dto.planId
        ? await db.plan.findUnique({ where: { id: dto.planId } })
        : await db.plan.findFirst({
            where: { isActive: true },
            orderBy: { sortOrder: 'asc' },
          });

      if (dto.planId && !plan) {
        throw new NotFoundException({
          code: ErrorCode.PLAN_NOT_FOUND,
          message: 'Selected subscription plan not found.',
        });
      }

      const activateNow = dto.activateImmediately !== false;
      const now = new Date();
      const targetTenantStatus = !activateNow
        ? PrismaTenantStatus.PENDING_APPROVAL
        : dto.planId
          ? PrismaTenantStatus.ACTIVE
          : PrismaTenantStatus.TRIAL;

      return db.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
          data: {
            name: dto.restaurantName.trim(),
            slug: this.buildSlug(dto.restaurantName),
            status: targetTenantStatus,
            approvedAt: activateNow ? now : null,
            approvedByUserId: activateNow ? principal.userId : null,
          },
        });

        const outlet = await tx.outlet.create({
          data: {
            tenantId: tenant.id,
            name: dto.outletName.trim(),
            contactPhone: phoneNormalized,
            address: dto.address?.trim() ?? null,
            timezone: 'Asia/Kolkata',
            gstin: dto.gstin?.trim() ?? null,
            gstRateBps: dto.gstRateBps ?? 500,
          },
        });

        const ownerUser = await tx.user.create({
          data: {
            name: dto.ownerName.trim(),
            email: emailNormalized,
            phone: phoneNormalized,
            passwordHash,
            isSuperAdmin: false,
            mfaEnabled: false,
          },
        });

        const defaultPinHash = await hashSecret('0000');
        const membership = await tx.membership.create({
          data: {
            tenantId: tenant.id,
            outletId: outlet.id,
            userId: ownerUser.id,
            role: PrismaStaffRole.OWNER,
            staffPinHash: defaultPinHash,
          },
        });

        let subscription = null;
        if (plan) {
          const billingCycle =
            (dto.billingCycle as PrismaSubscriptionBillingCycle) ??
            PrismaSubscriptionBillingCycle.MONTHLY;
          const isPaidActive = targetTenantStatus === PrismaTenantStatus.ACTIVE;
          const periodEnd = new Date(now);
          if (isPaidActive) {
            periodEnd.setMonth(
              periodEnd.getMonth() + (billingCycle === PrismaSubscriptionBillingCycle.YEARLY ? 12 : 1),
            );
          } else {
            periodEnd.setTime(now.getTime() + plan.trialDays * MS_PER_DAY);
          }
          const graceEndsAt = new Date(periodEnd.getTime() + plan.graceDays * MS_PER_DAY);

          subscription = await tx.subscription.create({
            data: {
              tenantId: tenant.id,
              planId: plan.id,
              status: isPaidActive
                ? PrismaSubscriptionStatus.ACTIVE
                : PrismaSubscriptionStatus.TRIAL,
              billingCycle,
              startedAt: now,
              trialEndsAt: isPaidActive ? null : periodEnd,
              currentPeriodStart: now,
              currentPeriodEnd: periodEnd,
              graceEndsAt,
            },
            include: { plan: true },
          });
        }

        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            actorUserId: principal.userId,
            actorRole: SYSTEM_ROLE_SUPER_ADMIN,
            action: 'RESTAURANT_ONBOARDED_BY_ADMIN',
            entityType: 'Tenant',
            entityId: tenant.id,
            afterJson: {
              tenantName: tenant.name,
              outletName: outlet.name,
              ownerEmail: emailNormalized,
              status: tenant.status,
              planCode: plan?.code ?? null,
            },
            ipAddress,
          },
        });

        return {
          tenant,
          outlet,
          owner: {
            id: ownerUser.id,
            name: ownerUser.name,
            email: ownerUser.email,
            phone: ownerUser.phone,
            membershipId: membership.id,
          },
          subscription,
        };
      });
    });
  }

  /**
   * Mid-meal safe suspension:
   * - If open dining sessions exist (ACTIVE, BILL_REQUESTED, SETTLED), enters LOCKED read-only
   *   drain mode (`pendingSuspensionAfterService = true`) so active tables can finish KDS,
   *   consolidation, online/counter payment, and table close before transitioning to SUSPENDED.
   * - If zero open sessions exist, immediately transitions to SUSPENDED and revokes refresh tokens.
   */
  async suspendRestaurant(
    principal: AuthenticatedPrincipal,
    tenantId: string,
    dto: SuspendTenantDto,
  ) {
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    const result = await this.prisma.runAsSystemAdmin(async (db) => {
      const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Restaurant tenant not found.',
        });
      }

      return db.$transaction(async (tx) => {
        const now = new Date();
        const activeOpenSessions =
          (await tx.diningSession?.count?.({
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
          })) ?? 0;

        if (activeOpenSessions > 0) {
          const updated = await tx.tenant.update({
            where: { id: tenantId },
            data: {
              status: PrismaTenantStatus.LOCKED,
              pendingSuspensionAfterService: true,
              suspensionReason: dto.reason.trim(),
            },
          });

          await tx.auditLog.create({
            data: {
              tenantId,
              actorUserId: principal.userId,
              actorRole: SYSTEM_ROLE_SUPER_ADMIN,
              action: 'RESTAURANT_SUSPENSION_SCHEDULED',
              entityType: 'Tenant',
              entityId: tenantId,
              beforeJson: { status: tenant.status },
              afterJson: {
                status: updated.status,
                pendingSuspensionAfterService: true,
                activeOpenSessions,
                reason: dto.reason.trim(),
              },
              ipAddress,
            },
          });

          return {
            ...updated,
            suspensionDeferredForLiveService: true,
            activeOpenSessionsCount: activeOpenSessions,
          };
        }

        const updated = await tx.tenant.update({
          where: { id: tenantId },
          data: {
            status: PrismaTenantStatus.SUSPENDED,
            pendingSuspensionAfterService: false,
            suspendedAt: now,
            suspensionReason: dto.reason.trim(),
          },
        });

        // Revoke active refresh tokens for suspended tenant
        await tx.refreshToken.updateMany({
          where: { tenantId, revokedAt: null },
          data: { revokedAt: now },
        });

        await tx.auditLog.create({
          data: {
            tenantId,
            actorUserId: principal.userId,
            actorRole: SYSTEM_ROLE_SUPER_ADMIN,
            action: 'RESTAURANT_SUSPENDED',
            entityType: 'Tenant',
            entityId: tenantId,
            beforeJson: { status: tenant.status },
            afterJson: { status: updated.status, reason: dto.reason.trim() },
            ipAddress,
          },
        });

        return {
          ...updated,
          suspensionDeferredForLiveService: false,
          activeOpenSessionsCount: 0,
        };
      });
    });

    this.realtimeEvents?.emit({
      type: 'restaurant.suspended',
      tenantId,
      tenantWide: true,
      payload: {
        tenantId,
        status: result.status,
        reason: dto.reason.trim(),
      },
    });
    return result;
  }

  async reactivateRestaurant(
    principal: AuthenticatedPrincipal,
    tenantId: string,
    dto: ReactivateRestaurantDto,
  ) {
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    const result = await this.prisma.runAsSystemAdmin(async (db) => {
      const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Restaurant tenant not found.',
        });
      }

      const targetStatus =
        dto.targetStatus &&
        [
          TenantStatus.ACTIVE,
          TenantStatus.TRIAL,
          TenantStatus.GRACE,
        ].includes(dto.targetStatus)
          ? (dto.targetStatus as PrismaTenantStatus)
          : PrismaTenantStatus.ACTIVE;

      return db.$transaction(async (tx) => {
        const updated = await tx.tenant.update({
          where: { id: tenantId },
          data: {
            status: targetStatus,
            approvedAt: tenant.approvedAt ?? new Date(),
            approvedByUserId: tenant.approvedByUserId ?? principal.userId,
            pendingSuspensionAfterService: false,
            suspendedAt: null,
            offboardedAt: null,
            suspensionReason: null,
            rejectedAt: null,
            rejectedByUserId: null,
            rejectionReason: null,
          },
        });

        const existingSub = await tx.subscription?.findUnique?.({
          where: { tenantId },
        });
        if (existingSub && existingSub.status === PrismaSubscriptionStatus.SUSPENDED) {
          await tx.subscription.update({
            where: { tenantId },
            data: {
              status:
                targetStatus === PrismaTenantStatus.TRIAL
                  ? PrismaSubscriptionStatus.TRIAL
                  : PrismaSubscriptionStatus.ACTIVE,
              suspendedAt: null,
            },
          });
        }

        await tx.auditLog.create({
          data: {
            tenantId,
            actorUserId: principal.userId,
            actorRole: SYSTEM_ROLE_SUPER_ADMIN,
            action: 'RESTAURANT_REACTIVATED',
            entityType: 'Tenant',
            entityId: tenantId,
            beforeJson: {
              status: tenant.status,
              pendingSuspensionAfterService: tenant.pendingSuspensionAfterService,
              suspendedAt: tenant.suspendedAt?.toISOString() ?? null,
            },
            afterJson: {
              status: updated.status,
              reason: dto.reason?.trim() ?? null,
            },
            ipAddress,
          },
        });

        return updated;
      });
    });

    this.realtimeEvents?.emit({
      type: 'restaurant.reactivated',
      tenantId,
      tenantWide: true,
      payload: {
        tenantId,
        status: result.status,
        reason: dto.reason?.trim() ?? null,
      },
    });
    return result;
  }

  async offboardRestaurant(
    principal: AuthenticatedPrincipal,
    tenantId: string,
    dto: OffboardRestaurantDto,
  ) {
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    const result = await this.prisma.runAsSystemAdmin(async (db) => {
      const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Restaurant tenant not found.',
        });
      }

      return db.$transaction(async (tx) => {
        const now = new Date();
        const activeOpenSessions =
          (await tx.diningSession?.count?.({
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
          })) ?? 0;

        const existingSub = await tx.subscription?.findUnique?.({ where: { tenantId } });
        if (existingSub) {
          await tx.subscription.update({
            where: { tenantId },
            data: {
              status: PrismaSubscriptionStatus.SUSPENDED,
              cancelledAt: existingSub.cancelledAt ?? now,
              suspendedAt: now,
              autoRenew: false,
            },
          });
        }

        if (activeOpenSessions > 0) {
          const updated = await tx.tenant.update({
            where: { id: tenantId },
            data: {
              status: PrismaTenantStatus.LOCKED,
              pendingSuspensionAfterService: true,
              offboardedAt: now,
              suspensionReason: `Offboarded: ${dto.reason.trim()}`,
            },
          });

          await tx.auditLog.create({
            data: {
              tenantId,
              actorUserId: principal.userId,
              actorRole: SYSTEM_ROLE_SUPER_ADMIN,
              action: 'RESTAURANT_OFFBOARDING_SCHEDULED',
              entityType: 'Tenant',
              entityId: tenantId,
              beforeJson: { status: tenant.status },
              afterJson: {
                status: updated.status,
                pendingSuspensionAfterService: true,
                activeOpenSessions,
                reason: dto.reason.trim(),
              },
              ipAddress,
            },
          });

          return {
            ...updated,
            offboardingDeferredForLiveService: true,
            activeOpenSessionsCount: activeOpenSessions,
          };
        }

        const updated = await tx.tenant.update({
          where: { id: tenantId },
          data: {
            status: PrismaTenantStatus.SUSPENDED,
            pendingSuspensionAfterService: false,
            suspendedAt: now,
            offboardedAt: now,
            suspensionReason: `Offboarded: ${dto.reason.trim()}`,
          },
        });

        await tx.refreshToken.updateMany({
          where: { tenantId, revokedAt: null },
          data: { revokedAt: now },
        });

        await tx.auditLog.create({
          data: {
            tenantId,
            actorUserId: principal.userId,
            actorRole: SYSTEM_ROLE_SUPER_ADMIN,
            action: 'RESTAURANT_OFFBOARDED',
            entityType: 'Tenant',
            entityId: tenantId,
            beforeJson: { status: tenant.status },
            afterJson: { status: updated.status, reason: dto.reason.trim() },
            ipAddress,
          },
        });

        return {
          ...updated,
          offboardingDeferredForLiveService: false,
          activeOpenSessionsCount: 0,
        };
      });
    });

    this.realtimeEvents?.emit({
      type: 'restaurant.suspended',
      tenantId,
      tenantWide: true,
      payload: {
        tenantId,
        status: result.status,
        reason: dto.reason.trim(),
      },
    });
    return result;
  }

  async listAuditLogs(query: ListAuditLogsQueryDto | string, limitArg?: number) {
    const filters: ListAuditLogsQueryDto =
      typeof query === 'string'
        ? { tenantId: query, limit: limitArg }
        : query ?? {};
    const safeLimit = Math.min(Math.max(filters.limit ?? 50, 1), 200);

    const where: Prisma.AuditLogWhereInput = {
      ...(filters.tenantId ? { tenantId: filters.tenantId } : {}),
      ...(filters.action ? { action: { contains: filters.action.trim(), mode: 'insensitive' } } : {}),
      ...(filters.actorRole ? { actorRole: filters.actorRole.trim() } : {}),
    };

    return this.prisma.runAsSystemAdmin((db) =>
      db.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: safeLimit,
        include: {
          tenant: { select: { id: true, name: true } },
          actorUser: { select: { id: true, name: true, email: true } },
        },
      }),
    );
  }

  private normalizeAdminPhone(raw: string): string {
    const cleaned = raw.replace(/[^\d+]/g, '');
    if (/^\d{10}$/.test(cleaned)) {
      return `+91${cleaned}`;
    }
    return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
  }

  async listUsers(query: ListAdminUsersQueryDto = {}) {
    const scope = query.scope ?? 'all';
    const roleFilter = query.role?.trim().toUpperCase();
    const search = query.search?.trim();

    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      ...(scope === 'super_admins' ? { isSuperAdmin: true } : {}),
      ...(scope === 'tenant_users' ? { isSuperAdmin: false } : {}),
      ...(roleFilter === SYSTEM_ROLE_SUPER_ADMIN
        ? { isSuperAdmin: true }
        : roleFilter &&
            Object.values(PrismaStaffRole).includes(roleFilter as PrismaStaffRole)
          ? {
              memberships: {
                some: {
                  role: roleFilter as PrismaStaffRole,
                  deletedAt: null,
                },
              },
            }
          : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const users = await this.prisma.runAsSystemAdmin((db) =>
      db.user.findMany({
        where,
        orderBy: [{ isSuperAdmin: 'desc' }, { createdAt: 'desc' }],
        take: 200,
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          isSuperAdmin: true,
          isActive: true,
          lastLoginAt: true,
          failedLoginAttempts: true,
          lockedUntil: true,
          createdAt: true,
          memberships: {
            where: { deletedAt: null },
            select: {
              id: true,
              role: true,
              isActive: true,
              tenant: { select: { id: true, name: true, status: true } },
              outlet: { select: { id: true, name: true } },
            },
          },
        },
      }),
    );

    return users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      isSuperAdmin: u.isSuperAdmin,
      isActive: u.isActive,
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      failedLoginAttempts: u.failedLoginAttempts,
      lockedUntil: u.lockedUntil?.toISOString() ?? null,
      createdAt: u.createdAt.toISOString(),
      memberships: u.memberships.map((m) => ({
        id: m.id,
        role: m.role,
        isActive: m.isActive,
        tenantId: m.tenant.id,
        tenantName: m.tenant.name,
        tenantStatus: m.tenant.status,
        outletId: m.outlet.id,
        outletName: m.outlet.name,
      })),
    }));
  }

  async createSuperAdminUser(
    principal: AuthenticatedPrincipal,
    dto: CreateSuperAdminDto,
  ) {
    const email = dto.email.trim().toLowerCase();
    const phone = this.normalizeAdminPhone(dto.phone);
    const hasUpper = /[A-Z]/.test(dto.password);
    const hasLower = /[a-z]/.test(dto.password);
    const hasDigit = /\d/.test(dto.password);

    if (!hasUpper || !hasLower || !hasDigit || dto.password.length < 10) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message:
          'Super Admin password must be at least 10 characters and include uppercase, lowercase, and numeric characters.',
      });
    }

    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runAsSystemAdmin((db) =>
      db.$transaction(async (tx) => {
        const conflict = await tx.user.findFirst({
          where: { OR: [{ email }, { phone }], deletedAt: null },
          select: { id: true },
        });
        if (conflict) {
          throw new ConflictException({
            code: ErrorCode.CONFLICT,
            message: 'An account with this email or phone already exists.',
          });
        }

        const created = await tx.user.create({
          data: {
            name: dto.name.trim(),
            email,
            phone,
            passwordHash: hashSecret(dto.password),
            isSuperAdmin: true,
            isActive: true,
            passwordChangedAt: new Date(),
          },
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            isSuperAdmin: true,
            isActive: true,
            createdAt: true,
          },
        });

        await tx.auditLog.create({
          data: {
            tenantId: null,
            actorUserId: principal.userId,
            actorRole: SYSTEM_ROLE_SUPER_ADMIN,
            action: 'SUPER_ADMIN_CREATED',
            entityType: 'User',
            entityId: created.id,
            afterJson: {
              email: created.email,
              phone: created.phone,
              name: created.name,
            },
            ipAddress,
          },
        });

        return {
          ...created,
          createdAt: created.createdAt.toISOString(),
        };
      }),
    );
  }

  async updateUserStatus(
    principal: AuthenticatedPrincipal,
    userId: string,
    dto: UpdateUserStatusDto,
  ) {
    if (principal.userId === userId && !dto.isActive) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'You cannot deactivate your own active Super Admin account.',
      });
    }

    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runAsSystemAdmin((db) =>
      db.$transaction(async (tx) => {
        const existing = await tx.user.findFirst({
          where: { id: userId, deletedAt: null },
          select: { id: true, name: true, email: true, isActive: true, isSuperAdmin: true },
        });
        if (!existing) {
          throw new NotFoundException({
            code: ErrorCode.NOT_FOUND,
            message: 'User account not found.',
          });
        }

        if (existing.isSuperAdmin && !dto.isActive) {
          const otherActiveAdmins = await tx.user.count({
            where: {
              id: { not: userId },
              isSuperAdmin: true,
              isActive: true,
              deletedAt: null,
            },
          });
          if (otherActiveAdmins < 1) {
            throw new BadRequestException({
              code: ErrorCode.VALIDATION_ERROR,
              message: 'At least one active Super Admin account must remain.',
            });
          }
        }

        const now = new Date();
        const updated = await tx.user.update({
          where: { id: userId },
          data: {
            isActive: dto.isActive,
            ...(dto.isActive ? { failedLoginAttempts: 0, lockedUntil: null } : {}),
          },
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            isSuperAdmin: true,
            isActive: true,
          },
        });

        if (!dto.isActive) {
          await tx.refreshToken.updateMany({
            where: { userId, revokedAt: null },
            data: { revokedAt: now },
          });
        }

        await tx.auditLog.create({
          data: {
            tenantId: null,
            actorUserId: principal.userId,
            actorRole: SYSTEM_ROLE_SUPER_ADMIN,
            action: 'USER_STATUS_UPDATED',
            entityType: 'User',
            entityId: userId,
            beforeJson: { isActive: existing.isActive },
            afterJson: {
              isActive: updated.isActive,
              isSuperAdmin: updated.isSuperAdmin,
              reason: dto.reason?.trim() ?? null,
            },
            ipAddress,
          },
        });

        return updated;
      }),
    );
  }

  async getPlatformSettings() {
    return this.prisma.runAsSystemAdmin(async (db) => {
      const existing = await db.platformSettings.findUnique({ where: { id: 'default' } });
      if (existing) {
        return {
          ...existing,
          updatedAt: existing.updatedAt.toISOString(),
        };
      }
      const created = await db.platformSettings.create({
        data: { id: 'default' },
      });
      return {
        ...created,
        updatedAt: created.updatedAt.toISOString(),
      };
    });
  }

  async updatePlatformSettings(
    principal: AuthenticatedPrincipal,
    dto: UpdatePlatformSettingsDto,
  ) {
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runAsSystemAdmin((db) =>
      db.$transaction(async (tx) => {
        const before =
          (await tx.platformSettings.findUnique({ where: { id: 'default' } })) ??
          (await tx.platformSettings.create({ data: { id: 'default' } }));

        const updated = await tx.platformSettings.update({
          where: { id: 'default' },
          data: {
            ...(dto.platformName !== undefined
              ? { platformName: dto.platformName.trim() }
              : {}),
            ...(dto.supportEmail !== undefined
              ? { supportEmail: dto.supportEmail.trim().toLowerCase() }
              : {}),
            ...(dto.supportPhone !== undefined
              ? { supportPhone: dto.supportPhone.trim() }
              : {}),
            ...(dto.defaultTrialDays !== undefined
              ? { defaultTrialDays: dto.defaultTrialDays }
              : {}),
            ...(dto.defaultGraceDays !== undefined
              ? { defaultGraceDays: dto.defaultGraceDays }
              : {}),
            ...(dto.saasGstRateBps !== undefined
              ? { saasGstRateBps: dto.saasGstRateBps }
              : {}),
            ...(dto.autoApproveRegistrations !== undefined
              ? { autoApproveRegistrations: dto.autoApproveRegistrations }
              : {}),
            ...(dto.maintenanceMode !== undefined
              ? { maintenanceMode: dto.maintenanceMode }
              : {}),
            ...(dto.maintenanceMessage !== undefined
              ? { maintenanceMessage: dto.maintenanceMessage.trim() || null }
              : {}),
            updatedByUserId: principal.userId,
          },
        });

        await tx.auditLog.create({
          data: {
            tenantId: null,
            actorUserId: principal.userId,
            actorRole: SYSTEM_ROLE_SUPER_ADMIN,
            action: 'PLATFORM_SETTINGS_UPDATED',
            entityType: 'PlatformSettings',
            entityId: '00000000-0000-0000-0000-000000000001',
            beforeJson: {
              defaultTrialDays: before.defaultTrialDays,
              defaultGraceDays: before.defaultGraceDays,
              saasGstRateBps: before.saasGstRateBps,
              autoApproveRegistrations: before.autoApproveRegistrations,
              maintenanceMode: before.maintenanceMode,
            },
            afterJson: {
              platformName: updated.platformName,
              supportEmail: updated.supportEmail,
              supportPhone: updated.supportPhone,
              defaultTrialDays: updated.defaultTrialDays,
              defaultGraceDays: updated.defaultGraceDays,
              saasGstRateBps: updated.saasGstRateBps,
              autoApproveRegistrations: updated.autoApproveRegistrations,
              maintenanceMode: updated.maintenanceMode,
            },
            ipAddress,
          },
        });

        return {
          ...updated,
          updatedAt: updated.updatedAt.toISOString(),
        };
      }),
    );
  }
}
