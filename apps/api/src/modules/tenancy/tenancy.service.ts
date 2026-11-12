import { Injectable, NotFoundException } from '@nestjs/common';
import { ErrorCode, TenantStatus } from '@autonex/shared';
import { TaxMode as PrismaTaxMode } from '@prisma/client';
import { TenantContextService } from '../../common/context/tenant-context.service';
import { AuthenticatedPrincipal } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { UpdateOutletDto } from './dto/update-outlet.dto';

@Injectable()
export class TenancyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
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
}

