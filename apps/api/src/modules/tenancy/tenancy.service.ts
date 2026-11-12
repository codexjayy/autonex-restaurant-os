import { SYSTEM_ROLE_DEFINITIONS } from '@autonex/permissions';
import { ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ErrorCode, TenantStatus } from '@autonex/shared';
import {
  BillStatus as PrismaBillStatus,
  DiningSessionStatus as PrismaDiningSessionStatus,
  InvitationStatus as PrismaInvitationStatus,
  KitchenStatus as PrismaKitchenStatus,
  StaffRole as PrismaStaffRole,
  TableStatus as PrismaTableStatus,
  TaxMode as PrismaTaxMode,
} from '@prisma/client';
import { TenantContextService } from '../../common/context/tenant-context.service';
import { AuthenticatedPrincipal } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RealtimeEventsService } from '../../common/realtime/realtime-events.service';
import { CreateOutletDto, UpdateTenantDto } from './dto/milestone1-tenancy.dto';
import { UpdateOutletDto } from './dto/update-outlet.dto';

@Injectable()
export class TenancyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    @Optional() private readonly realtimeEvents?: RealtimeEventsService,
  ) {}

  async getOutletProfile(principal: AuthenticatedPrincipal) {
    return this.prisma.runInTenantTx(async (tx) => {
      const tenant = await tx.tenant.findFirst({
        where: { id: principal.tenantId },
        select: { id: true, name: true, slug: true, status: true, approvedAt: true },
      });
      const outlet = await tx.outlet.findFirst({
        where: { id: principal.outletId },
      });

      if (!tenant || !outlet) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Restaurant outlet not found.',
        });
      }

      return { tenant, outlet };
    }, principal.tenantId);
  }

  async updateOutletProfile(principal: AuthenticatedPrincipal, dto: UpdateOutletDto) {
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runInTenantTx(async (tx) => {
      const existing = await tx.outlet.findFirst({
        where: { id: principal.outletId },
      });
      if (!existing) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Restaurant outlet not found.',
        });
      }

      const updated = await tx.outlet.update({
        where: { id: existing.id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.address !== undefined ? { address: dto.address.trim() } : {}),
          ...(dto.logoUrl !== undefined ? { logoUrl: dto.logoUrl } : {}),
          ...(dto.timezone !== undefined ? { timezone: dto.timezone.trim() } : {}),
          ...(dto.gstin !== undefined ? { gstin: dto.gstin.trim() } : {}),
          ...(dto.gstRateBps !== undefined ? { gstRateBps: dto.gstRateBps } : {}),
          ...(dto.taxMode !== undefined ? { taxMode: dto.taxMode as PrismaTaxMode } : {}),
          ...(dto.roundOffEnabled !== undefined ? { roundOffEnabled: dto.roundOffEnabled } : {}),
          ...(dto.requireWaiterApproval !== undefined
            ? { requireWaiterApproval: dto.requireWaiterApproval }
            : {}),
          ...(dto.tablePinEnabled !== undefined ? { tablePinEnabled: dto.tablePinEnabled } : {}),
        },
      });

      await tx.auditLog.create({
        data: {
          tenantId: principal.tenantId!,
          actorUserId: principal.userId,
          actorRole: principal.role,
          action: 'OUTLET_UPDATED',
          entityType: 'Outlet',
          entityId: updated.id,
          beforeJson: {
            name: existing.name,
            gstRateBps: existing.gstRateBps,
            taxMode: existing.taxMode,
            roundOffEnabled: existing.roundOffEnabled,
            timezone: existing.timezone,
          },
          afterJson: {
            name: updated.name,
            gstRateBps: updated.gstRateBps,
            taxMode: updated.taxMode,
            roundOffEnabled: updated.roundOffEnabled,
            timezone: updated.timezone,
          },
          ipAddress,
        },
      });

      this.realtimeEvents?.emit({
        type: 'outlet.updated',
        tenantId: principal.tenantId!,
        tenantWide: true,
        payload: { tenantId: updated?.id ?? principal.tenantId, name: updated?.name ?? null },
      });

      return updated;
    }, principal.tenantId);
  }

  async getOnboardingChecklist(principal: AuthenticatedPrincipal) {
    return this.prisma.runInTenantTx(async (tx) => {
      const tenant = await tx.tenant.findFirst({ where: { id: principal.tenantId } });
      const outlet = await tx.outlet.findFirst({ where: { id: principal.outletId } });
      const [staffCount, menuItemsCount, tablesCount, activeQrCount] = await Promise.all([
        tx.membership.count({
          where: { outletId: principal.outletId, isActive: true },
        }),
        tx.menuItem.count({
          where: { outletId: principal.outletId, isActive: true },
        }),
        tx.restaurantTable.count({
          where: { outletId: principal.outletId, isActive: true },
        }),
        tx.tableQrToken.count({
          where: { outletId: principal.outletId, isActive: true, revokedAt: null },
        }),
      ]);

      if (!tenant || !outlet) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Outlet not found.',
        });
      }

      const adminApproved =
        tenant.status === TenantStatus.ACTIVE || tenant.status === TenantStatus.TRIAL;
      const profileComplete = Boolean(outlet.name && outlet.contactPhone && outlet.address);
      const staffAdded = staffCount > 1;
      const menuConfigured = menuItemsCount > 0;
      const tablesConfigured = tablesCount > 0;
      const qrGenerated = activeQrCount > 0;
      const goLiveReady =
        profileComplete && adminApproved && menuConfigured && tablesConfigured && qrGenerated;

      return {
        tenantStatus: tenant.status,
        steps: {
          profileComplete,
          adminApproved,
          staffAdded,
          menuConfigured,
          tablesConfigured,
          qrGenerated,
        },
        counts: {
          staffCount,
          menuItemsCount,
          tablesCount,
          activeQrCount,
        },
        goLiveReady,
      };
    }, principal.tenantId);
  }

  async getCurrentTenant(principal: AuthenticatedPrincipal) {
    if (!principal.tenantId) {
      throw new ForbiddenException({
        code: ErrorCode.TENANT_CONTEXT_MISSING,
        message: 'Tenant context required.',
      });
    }

    return this.prisma.runInTenantTx(async (tx) => {
      const tenant = await tx.tenant.findFirst({
        where: { id: principal.tenantId, deletedAt: null },
        include: { settings: true },
      });
      if (!tenant) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Restaurant tenant not found.',
        });
      }

      const outletCount = await tx.outlet.count({
        where: { tenantId: principal.tenantId, deletedAt: null },
      });

      return {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        status: tenant.status,
        approvedAt: tenant.approvedAt,
        outletCount,
        settings: tenant.settings ?? null,
      };
    }, principal.tenantId);
  }

  async updateCurrentTenant(principal: AuthenticatedPrincipal, dto: UpdateTenantDto) {
    if (!principal.tenantId) {
      throw new ForbiddenException({
        code: ErrorCode.TENANT_CONTEXT_MISSING,
        message: 'Tenant context required.',
      });
    }
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runInTenantTx(async (tx) => {
      const existing = await tx.tenant.findFirst({
        where: { id: principal.tenantId, deletedAt: null },
        include: { settings: true },
      });
      if (!existing) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Restaurant tenant not found.',
        });
      }

      if (dto.name !== undefined) {
        await tx.tenant.update({
          where: { id: existing.id },
          data: { name: dto.name.trim() },
        });
      }

      const hasSettingsUpdate =
        dto.currency !== undefined ||
        dto.locale !== undefined ||
        dto.defaultTimezone !== undefined ||
        dto.onboardingCompleted !== undefined ||
        dto.onboardingStep !== undefined;

      if (hasSettingsUpdate && tx.tenantSettings) {
        await tx.tenantSettings.upsert({
          where: { tenantId: existing.id },
          create: {
            tenantId: existing.id,
            currency: dto.currency?.trim() ?? 'INR',
            locale: dto.locale?.trim() ?? 'en-IN',
            defaultTimezone: dto.defaultTimezone?.trim() ?? 'Asia/Kolkata',
            onboardingCompleted: dto.onboardingCompleted ?? false,
            onboardingStep: dto.onboardingStep ?? 1,
          },
          update: {
            ...(dto.currency !== undefined ? { currency: dto.currency.trim() } : {}),
            ...(dto.locale !== undefined ? { locale: dto.locale.trim() } : {}),
            ...(dto.defaultTimezone !== undefined
              ? { defaultTimezone: dto.defaultTimezone.trim() }
              : {}),
            ...(dto.onboardingCompleted !== undefined
              ? { onboardingCompleted: dto.onboardingCompleted }
              : {}),
            ...(dto.onboardingStep !== undefined ? { onboardingStep: dto.onboardingStep } : {}),
          },
        });
      }

      const updated = await tx.tenant.findFirst({
        where: { id: existing.id },
        include: { settings: true },
      });

      await tx.auditLog.create({
        data: {
          tenantId: principal.tenantId!,
          actorUserId: principal.userId,
          actorRole: principal.role,
          action: 'TENANT_SETTINGS_UPDATED',
          entityType: 'Tenant',
          entityId: existing.id,
          beforeJson: {
            name: existing.name,
            currency: existing.settings?.currency,
            locale: existing.settings?.locale,
          },
          afterJson: {
            name: updated?.name,
            currency: updated?.settings?.currency,
            locale: updated?.settings?.locale,
          },
          ipAddress,
        },
      });

      this.realtimeEvents?.emit({
        type: 'outlet.updated',
        tenantId: principal.tenantId!,
        tenantWide: true,
        payload: { tenantId: updated?.id ?? principal.tenantId, name: updated?.name ?? null },
      });

      return updated;
    }, principal.tenantId);
  }

  async listOutlets(principal: AuthenticatedPrincipal) {
    if (!principal.tenantId) {
      throw new ForbiddenException({
        code: ErrorCode.TENANT_CONTEXT_MISSING,
        message: 'Tenant context required.',
      });
    }

    return this.prisma.runInTenantTx(async (tx) => {
      return tx.outlet.findMany({
        where: { tenantId: principal.tenantId, deletedAt: null },
        include: { settings: true },
        orderBy: { createdAt: 'asc' },
      });
    }, principal.tenantId);
  }

  async createOutlet(principal: AuthenticatedPrincipal, dto: CreateOutletDto) {
    if (!principal.tenantId) {
      throw new ForbiddenException({
        code: ErrorCode.TENANT_CONTEXT_MISSING,
        message: 'Tenant context required.',
      });
    }
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runInTenantTx(async (tx) => {
      const outlet = await tx.outlet.create({
        data: {
          tenantId: principal.tenantId!,
          name: dto.name.trim(),
          contactPhone: dto.contactPhone.trim(),
          address: dto.address?.trim() ?? null,
          logoUrl: dto.logoUrl?.trim() ?? null,
          timezone: dto.timezone?.trim() || 'Asia/Kolkata',
          gstin: dto.gstin?.trim() ?? null,
          gstRateBps: dto.gstRateBps ?? 500,
          taxMode: (dto.taxMode as unknown as PrismaTaxMode) ?? PrismaTaxMode.EXCLUSIVE,
          roundOffEnabled: dto.roundOffEnabled ?? true,
          requireWaiterApproval: dto.requireWaiterApproval ?? true,
          tablePinEnabled: dto.tablePinEnabled ?? true,
          isActive: true,
        },
      });

      const settings = await tx.outletSettings?.create?.({
        data: {
          tenantId: principal.tenantId!,
          outletId: outlet.id,
          taxMode: outlet.taxMode,
          gstRateBps: outlet.gstRateBps,
          roundOffEnabled: outlet.roundOffEnabled,
          requireWaiterApproval: outlet.requireWaiterApproval,
          tablePinEnabled: outlet.tablePinEnabled,
          kdsLanguage: dto.kdsLanguage ?? 'en',
          receiptFooter: dto.receiptFooter?.trim() ?? null,
        },
      });

      // Automatically grant creating owner access to the new outlet
      const ownerMembership = await tx.membership.findFirst({
        where: { userId: principal.userId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      });
      const ownerRole = await tx.role?.findFirst?.({
        where: { tenantId: null, code: PrismaStaffRole.OWNER },
      });
      await tx.membership.create({
        data: {
          tenantId: principal.tenantId!,
          outletId: outlet.id,
          userId: principal.userId,
          role: PrismaStaffRole.OWNER,
          ...(ownerRole ? { roleId: ownerRole.id } : {}),
          staffPinHash: ownerMembership?.staffPinHash ?? 'pin-reset-required',
          isActive: true,
        },
      });

      await tx.auditLog.create({
        data: {
          tenantId: principal.tenantId!,
          actorUserId: principal.userId,
          actorRole: principal.role,
          action: 'OUTLET_CREATED',
          entityType: 'Outlet',
          entityId: outlet.id,
          afterJson: { name: outlet.name, timezone: outlet.timezone },
          ipAddress,
        },
      });

      this.realtimeEvents?.emit({
        type: 'outlet.created',
        tenantId: principal.tenantId!,
        outletId: outlet.id,
        tenantWide: true,
        payload: { outletId: outlet.id, name: outlet.name },
      });

      return { ...outlet, settings: settings ?? null };
    }, principal.tenantId);
  }

  async getOutletById(principal: AuthenticatedPrincipal, outletId: string) {
    if (!principal.tenantId) {
      throw new ForbiddenException({
        code: ErrorCode.TENANT_CONTEXT_MISSING,
        message: 'Tenant context required.',
      });
    }

    return this.prisma.runInTenantTx(async (tx) => {
      const outlet = await tx.outlet.findFirst({
        where: { id: outletId, deletedAt: null },
        include: { settings: true },
      });
      if (!outlet) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Outlet not found.',
        });
      }
      return outlet;
    }, principal.tenantId);
  }

  async updateOutletById(principal: AuthenticatedPrincipal, outletId: string, dto: UpdateOutletDto) {
    if (!principal.tenantId) {
      throw new ForbiddenException({
        code: ErrorCode.TENANT_CONTEXT_MISSING,
        message: 'Tenant context required.',
      });
    }
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runInTenantTx(async (tx) => {
      const existing = await tx.outlet.findFirst({
        where: { id: outletId, deletedAt: null },
      });
      if (!existing) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Outlet not found.',
        });
      }

      const updated = await tx.outlet.update({
        where: { id: existing.id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.contactPhone !== undefined ? { contactPhone: dto.contactPhone.trim() } : {}),
          ...(dto.address !== undefined ? { address: dto.address.trim() } : {}),
          ...(dto.logoUrl !== undefined ? { logoUrl: dto.logoUrl } : {}),
          ...(dto.timezone !== undefined ? { timezone: dto.timezone.trim() } : {}),
          ...(dto.gstin !== undefined ? { gstin: dto.gstin.trim() } : {}),
          ...(dto.gstRateBps !== undefined ? { gstRateBps: dto.gstRateBps } : {}),
          ...(dto.taxMode !== undefined ? { taxMode: dto.taxMode as PrismaTaxMode } : {}),
          ...(dto.roundOffEnabled !== undefined ? { roundOffEnabled: dto.roundOffEnabled } : {}),
          ...(dto.requireWaiterApproval !== undefined
            ? { requireWaiterApproval: dto.requireWaiterApproval }
            : {}),
          ...(dto.tablePinEnabled !== undefined ? { tablePinEnabled: dto.tablePinEnabled } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });

      const settings = await tx.outletSettings?.upsert?.({
        where: { outletId: existing.id },
        create: {
          tenantId: principal.tenantId!,
          outletId: existing.id,
          taxMode: updated.taxMode,
          gstRateBps: updated.gstRateBps,
          roundOffEnabled: updated.roundOffEnabled,
          requireWaiterApproval: updated.requireWaiterApproval,
          tablePinEnabled: updated.tablePinEnabled,
          kdsLanguage: dto.kdsLanguage ?? 'en',
          receiptFooter: dto.receiptFooter?.trim() ?? null,
        },
        update: {
          taxMode: updated.taxMode,
          gstRateBps: updated.gstRateBps,
          roundOffEnabled: updated.roundOffEnabled,
          requireWaiterApproval: updated.requireWaiterApproval,
          tablePinEnabled: updated.tablePinEnabled,
          ...(dto.kdsLanguage !== undefined ? { kdsLanguage: dto.kdsLanguage } : {}),
          ...(dto.receiptFooter !== undefined
            ? { receiptFooter: dto.receiptFooter.trim() }
            : {}),
        },
      });

      await tx.auditLog.create({
        data: {
          tenantId: principal.tenantId!,
          actorUserId: principal.userId,
          actorRole: principal.role,
          action: 'OUTLET_UPDATED',
          entityType: 'Outlet',
          entityId: updated.id,
          beforeJson: {
            name: existing.name,
            gstRateBps: existing.gstRateBps,
            taxMode: existing.taxMode,
            isActive: existing.isActive,
          },
          afterJson: {
            name: updated.name,
            gstRateBps: updated.gstRateBps,
            taxMode: updated.taxMode,
            isActive: updated.isActive,
          },
          ipAddress,
        },
      });

      this.realtimeEvents?.emit({
        type: 'outlet.updated',
        tenantId: principal.tenantId!,
        outletId: updated.id,
        tenantWide: true,
        payload: { outletId: updated.id, name: updated.name },
      });

      return { ...updated, settings: settings ?? null };
    }, principal.tenantId);
  }

  async softDeleteOutlet(principal: AuthenticatedPrincipal, outletId: string) {
    if (!principal.tenantId) {
      throw new ForbiddenException({
        code: ErrorCode.TENANT_CONTEXT_MISSING,
        message: 'Tenant context required.',
      });
    }
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runInTenantTx(async (tx) => {
      const target = await tx.outlet.findFirst({
        where: { id: outletId, deletedAt: null },
      });
      if (!target) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Outlet not found.',
        });
      }

      const activeCount = await tx.outlet.count({
        where: { deletedAt: null },
      });
      if (activeCount <= 1) {
        throw new ConflictException({
          code: ErrorCode.CONFLICT,
          message: 'At least one active outlet must remain for the restaurant.',
        });
      }

      const deletedAt = new Date();
      await tx.outlet.update({
        where: { id: target.id },
        data: { isActive: false, deletedAt },
      });

      await tx.membership.updateMany({
        where: { outletId: target.id, deletedAt: null },
        data: { isActive: false, deletedAt },
      });

      await tx.auditLog.create({
        data: {
          tenantId: principal.tenantId!,
          actorUserId: principal.userId,
          actorRole: principal.role,
          action: 'OUTLET_DELETED',
          entityType: 'Outlet',
          entityId: target.id,
          beforeJson: { name: target.name, isActive: target.isActive },
          afterJson: { deletedAt: deletedAt.toISOString(), isActive: false },
          ipAddress,
        },
      });

      this.realtimeEvents?.emit({
        type: 'outlet.updated',
        tenantId: principal.tenantId!,
        outletId: target.id,
        tenantWide: true,
        payload: { outletId: target.id, deleted: true },
      });

      return { id: target.id, deletedAt };
    }, principal.tenantId);
  }

  async listRoles(principal: AuthenticatedPrincipal) {
    if (!principal.tenantId) {
      return SYSTEM_ROLE_DEFINITIONS;
    }

    return this.prisma.runInTenantTx(async (tx) => {
      const rows = await tx.role?.findMany?.({
        include: {
          rolePermissions: {
            include: { permission: true },
          },
        },
        orderBy: { createdAt: 'asc' },
      });

      if (!rows || rows.length === 0) {
        return SYSTEM_ROLE_DEFINITIONS;
      }

      return rows.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        description: r.description ?? '',
        isSystem: r.isSystem,
        permissions: r.rolePermissions.map((rp) => rp.permission.code),
      }));
    }, principal.tenantId);
  }

  async getWorkspaceOverview(principal: AuthenticatedPrincipal) {
    if (!principal.tenantId || !principal.outletId) {
      throw new ForbiddenException({
        code: ErrorCode.TENANT_CONTEXT_MISSING,
        message: 'Tenant and outlet context required.',
      });
    }

    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    return this.prisma.runInTenantTx(async (tx) => {
      const [
        tenant,
        activeOutlet,
        outletsCount,
        subscription,
        activeMemberships,
        pendingInvitationsCount,
        tables,
        activeQrCount,
        categoriesCount,
        menuItemsCount,
        ordersTodayCount,
        activeKitchenOrdersCount,
        billsToday,
        sessionsTodayCount,
        activeSessionsCount,
        recentLogs,
      ] = await Promise.all([
        tx.tenant.findFirst({
          where: { id: principal.tenantId, deletedAt: null },
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
            createdAt: true,
            approvedAt: true,
            rejectedAt: true,
            rejectionReason: true,
            suspendedAt: true,
            suspensionReason: true,
            pendingSuspensionAfterService: true,
            settings: true,
          },
        }),
        tx.outlet.findFirst({
          where: { id: principal.outletId, tenantId: principal.tenantId, deletedAt: null },
          select: {
            id: true,
            name: true,
            contactPhone: true,
            address: true,
            gstin: true,
            gstRateBps: true,
            taxMode: true,
            timezone: true,
          },
        }),
        tx.outlet.count({
          where: { tenantId: principal.tenantId, deletedAt: null },
        }),
        tx.subscription?.findUnique?.({
          where: { tenantId: principal.tenantId },
          include: { plan: true },
        }) ?? Promise.resolve(null),
        tx.membership.findMany({
          where: {
            outletId: principal.outletId,
            tenantId: principal.tenantId,
            isActive: true,
            deletedAt: null,
          },
          select: { role: true },
        }),
        tx.invitation?.count?.({
          where: {
            tenantId: principal.tenantId,
            outletId: principal.outletId,
            status: PrismaInvitationStatus.PENDING,
          },
        }) ?? Promise.resolve(0),
        tx.restaurantTable.findMany({
          where: { outletId: principal.outletId, tenantId: principal.tenantId, isActive: true },
          select: { status: true },
        }),
        tx.tableQrToken.count({
          where: {
            outletId: principal.outletId,
            tenantId: principal.tenantId,
            isActive: true,
            revokedAt: null,
          },
        }),
        tx.category.count({
          where: { outletId: principal.outletId, tenantId: principal.tenantId, isActive: true },
        }),
        tx.menuItem.count({
          where: { outletId: principal.outletId, tenantId: principal.tenantId, isActive: true },
        }),
        tx.order.count({
          where: {
            outletId: principal.outletId,
            tenantId: principal.tenantId,
            createdAt: { gte: todayStart },
          },
        }),
        tx.order.count({
          where: {
            outletId: principal.outletId,
            tenantId: principal.tenantId,
            kitchenStatus: {
              in: [
                PrismaKitchenStatus.NEW,
                PrismaKitchenStatus.ACKNOWLEDGED,
                PrismaKitchenStatus.PREPARING,
                PrismaKitchenStatus.READY,
              ],
            },
          },
        }),
        tx.bill.aggregate({
          where: {
            outletId: principal.outletId,
            tenantId: principal.tenantId,
            createdAt: { gte: todayStart },
            status: { in: [PrismaBillStatus.PAID, PrismaBillStatus.PARTIALLY_PAID] },
          },
          _sum: { paidPaise: true },
        }),
        tx.diningSession.count({
          where: {
            outletId: principal.outletId,
            tenantId: principal.tenantId,
            openedAt: { gte: todayStart },
          },
        }),
        tx.diningSession.count({
          where: {
            outletId: principal.outletId,
            tenantId: principal.tenantId,
            status: {
              in: [
                PrismaDiningSessionStatus.ACTIVE,
                PrismaDiningSessionStatus.BILL_REQUESTED,
                PrismaDiningSessionStatus.SETTLED,
              ],
            },
          },
        }),
        tx.auditLog.findMany({
          where: { tenantId: principal.tenantId },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            action: true,
            entityType: true,
            entityId: true,
            actorRole: true,
            createdAt: true,
            actorUser: { select: { name: true } },
          },
        }),
      ]);

      if (!tenant || !activeOutlet) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Restaurant or active outlet not found.',
        });
      }

      const staffCount = activeMemberships.length;
      const totalTables = tables.length;
      let availableTables = 0;
      let occupiedTables = 0;
      let reservedTables = 0;
      for (const tbl of tables) {
        if (tbl.status === PrismaTableStatus.AVAILABLE) availableTables += 1;
        else if (tbl.status === PrismaTableStatus.OCCUPIED) occupiedTables += 1;
        else if (tbl.status === PrismaTableStatus.RESERVED) reservedTables += 1;
      }

      const adminApproved =
        tenant.status === TenantStatus.ACTIVE || tenant.status === TenantStatus.TRIAL;
      const profileComplete = Boolean(
        activeOutlet.name && activeOutlet.contactPhone && activeOutlet.address,
      );
      const staffAdded = staffCount > 1;
      const menuConfigured = menuItemsCount > 0;
      const tablesConfigured = totalTables > 0;
      const qrGenerated = activeQrCount > 0;

      const stepFlags = [
        profileComplete,
        adminApproved,
        menuConfigured,
        tablesConfigured,
        qrGenerated,
        staffAdded,
      ];
      const completedCount = stepFlags.filter(Boolean).length;
      const totalCount = stepFlags.length;
      const progressPercent = Math.round((completedCount / totalCount) * 100);
      const goLiveReady =
        profileComplete && adminApproved && menuConfigured && tablesConfigured && qrGenerated;

      const expiryRef =
        subscription?.status === 'TRIAL'
          ? subscription.trialEndsAt ?? subscription.currentPeriodEnd
          : subscription?.status === 'GRACE'
            ? subscription.graceEndsAt ?? subscription.currentPeriodEnd
            : subscription?.currentPeriodEnd ?? subscription?.trialEndsAt ?? null;
      const daysRemaining = expiryRef
        ? Math.max(0, Math.ceil((expiryRef.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)))
        : null;

      return {
        tenant: {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
          status: tenant.status,
          createdAt: tenant.createdAt.toISOString(),
          approvedAt: tenant.approvedAt?.toISOString() ?? null,
          rejectedAt: tenant.rejectedAt?.toISOString() ?? null,
          rejectionReason: tenant.rejectionReason ?? null,
          suspendedAt: tenant.suspendedAt?.toISOString() ?? null,
          suspensionReason: tenant.suspensionReason ?? null,
          pendingSuspensionAfterService: tenant.pendingSuspensionAfterService,
          settings: tenant.settings ?? null,
        },
        activeOutlet,
        outletsCount,
        subscription: subscription
          ? {
              id: subscription.id,
              status: subscription.status,
              billingCycle: subscription.billingCycle,
              planName: subscription.plan.name,
              planCode: subscription.plan.code,
              startedAt: subscription.startedAt.toISOString(),
              trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
              currentPeriodStart: subscription.currentPeriodStart?.toISOString() ?? null,
              currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
              graceEndsAt: subscription.graceEndsAt?.toISOString() ?? null,
              expiryDate: expiryRef?.toISOString() ?? null,
              daysRemaining,
              maxOutlets: subscription.plan.maxOutlets,
              maxTables: subscription.plan.maxTables,
              maxStaff: subscription.plan.maxStaff,
            }
          : null,
        metrics: {
          staffCount,
          pendingInvitationsCount,
          totalTables,
          availableTables,
          occupiedTables,
          reservedTables,
          activeQrCount,
          categoriesCount,
          menuItemsCount,
          ordersTodayCount,
          activeKitchenOrdersCount,
          revenueTodayPaise: billsToday._sum.paidPaise ?? 0,
          sessionsTodayCount,
          activeSessionsCount,
        },
        checklist: {
          steps: {
            profileComplete,
            adminApproved,
            staffAdded,
            menuConfigured,
            tablesConfigured,
            qrGenerated,
          },
          completedCount,
          totalCount,
          progressPercent,
          goLiveReady,
        },
        recentActivity: recentLogs.map((log) => ({
          id: log.id,
          action: log.action,
          entityType: log.entityType,
          entityId: log.entityId,
          actorRole: log.actorRole,
          actorName: log.actorUser?.name ?? log.actorRole,
          createdAt: log.createdAt.toISOString(),
        })),
      };
    }, principal.tenantId);
  }
}

