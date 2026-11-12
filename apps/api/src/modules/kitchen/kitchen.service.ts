import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DietaryType,
  ErrorCode,
  KdsTicketModifierSnapshot,
  KdsTicketPayload,
  KitchenStatus,
  OrderSource,
  StaffRole,
  canTransitionKitchenStatus,
} from '@autonex/shared';
import {
  KitchenStatus as PrismaKitchenStatus,
  OutboxStatus as PrismaOutboxStatus,
  Prisma,
} from '@prisma/client';
import { TenantContextService } from '../../common/context/tenant-context.service';
import {
  AuthenticatedPrincipal,
  requireOutletContext,
} from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { KdsOrdersQueryDto, UpdateKdsStatusDto } from './dto/kds.dto';

const KDS_STATUS_EVENT_MAP: Record<KitchenStatus, string> = {
  [KitchenStatus.NEW]: 'ORDER_PLACED',
  [KitchenStatus.PREPARING]: 'KOT_ACCEPTED',
  [KitchenStatus.READY]: 'KOT_READY',
  [KitchenStatus.SERVED]: 'KOT_SERVED',
  [KitchenStatus.CANCELLED]: 'KOT_CANCELLED',
};

export const KDS_TICKET_INCLUDE = {
  session: {
    select: {
      id: true,
      table: {
        select: { id: true, tableNumber: true, label: true },
      },
    },
  },
  acknowledgedByMembership: {
    select: {
      id: true,
      user: { select: { name: true } },
    },
  },
  items: {
    orderBy: { createdAt: 'asc' as const },
  },
} satisfies Prisma.OrderInclude;

type OrderWithKdsRelations = Prisma.OrderGetPayload<{
  include: typeof KDS_TICKET_INCLUDE;
}>;

export function serializeKdsTicket(order: OrderWithKdsRelations): KdsTicketPayload {
  return {
    id: order.id,
    tenantId: order.tenantId,
    outletId: order.outletId,
    sessionId: order.sessionId,
    tableId: order.session.table.id,
    tableNumber: order.session.table.tableNumber,
    tableLabel: order.session.table.label ?? null,
    roundNumber: order.roundNumber,
    kotNumber: order.kotNumber,
    isAddOn: order.isAddOn,
    source: order.source as OrderSource,
    kitchenStatus: order.kitchenStatus as KitchenStatus,
    subtotalPaise: order.subtotalPaise,
    notes: order.notes ?? null,
    acknowledgedAt: order.acknowledgedAt ? order.acknowledgedAt.toISOString() : null,
    acknowledgedByMembershipId: order.acknowledgedByMembershipId ?? null,
    acknowledgedByName: order.acknowledgedByMembership?.user?.name ?? null,
    acceptedAt: order.acceptedAt ? order.acceptedAt.toISOString() : null,
    readyAt: order.readyAt ? order.readyAt.toISOString() : null,
    servedAt: order.servedAt ? order.servedAt.toISOString() : null,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    items: order.items.map((item) => ({
      id: item.id,
      menuItemId: item.menuItemId,
      itemNameSnapshot: item.itemNameSnapshot,
      dietaryTypeSnapshot: item.dietaryTypeSnapshot as DietaryType,
      quantity: item.quantity,
      modifiersSnapshotJson:
        (item.modifiersSnapshotJson as unknown as KdsTicketModifierSnapshot[]) ?? [],
      prepNotes: item.prepNotes ?? null,
      status: String(item.status),
    })),
  };
}

@Injectable()
export class KitchenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async getKdsBoard(principal: AuthenticatedPrincipal, query: KdsOrdersQueryDto = {}) {
    const ctx = requireOutletContext(principal);
    const serverNow = new Date();
    const includeServed = query.includeServed === 'true';
    const sinceDate = query.since ? new Date(query.since) : null;

    return this.prisma.runInTenantTx(async (tx) => {
      const openStatuses: PrismaKitchenStatus[] = [
        PrismaKitchenStatus.NEW,
        PrismaKitchenStatus.PREPARING,
        PrismaKitchenStatus.READY,
      ];

      let where: Prisma.OrderWhereInput;
      if (sinceDate && !Number.isNaN(sinceDate.getTime())) {
        // Cursor sync returns everything touched at or after `since`, plus any still-open tickets
        where = {
          outletId: ctx.outletId,
          updatedAt: { gte: sinceDate },
        };
      } else if (includeServed) {
        const recentCutoff = new Date(serverNow.getTime() - 45 * 60 * 1000);
        where = {
          outletId: ctx.outletId,
          OR: [
            { kitchenStatus: { in: openStatuses } },
            { kitchenStatus: PrismaKitchenStatus.SERVED, servedAt: { gte: recentCutoff } },
          ],
        };
      } else {
        where = {
          outletId: ctx.outletId,
          kitchenStatus: { in: openStatuses },
        };
      }

      const orders = await tx.order.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }],
        include: KDS_TICKET_INCLUDE,
      });

      const tickets = orders.map(serializeKdsTicket);
      // Use max DB updatedAt (or serverNow - 1s overlap safety margin when empty) so
      // in-flight transactions committed concurrently are never skipped by cursor polling.
      let latestUpdatedAt =
        sinceDate && !Number.isNaN(sinceDate.getTime())
          ? sinceDate
          : new Date(serverNow.getTime() - 1000);
      for (const order of orders) {
        if (order.updatedAt > latestUpdatedAt) {
          latestUpdatedAt = order.updatedAt;
        }
      }

      const openCount = tickets.filter(
        (t) =>
          t.kitchenStatus === KitchenStatus.NEW ||
          t.kitchenStatus === KitchenStatus.PREPARING ||
          t.kitchenStatus === KitchenStatus.READY,
      ).length;
      const unacknowledgedCount = tickets.filter(
        (t) => t.kitchenStatus === KitchenStatus.NEW && !t.acknowledgedAt,
      ).length;

      return {
        orders: tickets,
        openCount,
        unacknowledgedCount,
        incremental: Boolean(sinceDate && !Number.isNaN(sinceDate.getTime())),
        serverTime: serverNow.toISOString(),
        syncCursor: latestUpdatedAt.toISOString(),
      };
    }, ctx.tenantId);
  }

  async getKdsTicket(principal: AuthenticatedPrincipal, orderId: string) {
    const ctx = requireOutletContext(principal);

    return this.prisma.runInTenantTx(async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: orderId, outletId: ctx.outletId },
        include: KDS_TICKET_INCLUDE,
      });
      if (!order) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Kitchen order ticket not found.',
        });
      }
      return { order: serializeKdsTicket(order) };
    }, ctx.tenantId);
  }

  async acknowledgeOrder(principal: AuthenticatedPrincipal, orderId: string) {
    const ctx = requireOutletContext(principal);
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runInTenantTx(async (tx) => {
      const existing = await tx.order.findFirst({
        where: { id: orderId, outletId: ctx.outletId },
        include: KDS_TICKET_INCLUDE,
      });
      if (!existing) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Kitchen order ticket not found.',
        });
      }

      if (existing.kitchenStatus === PrismaKitchenStatus.CANCELLED) {
        throw new ConflictException({
          code: ErrorCode.INVALID_KDS_TRANSITION,
          message: 'Cancelled order ticket cannot be acknowledged.',
        });
      }

      // Idempotent acknowledgement so repeat clicks or flaky retries never fail or double-emit
      if (existing.acknowledgedAt) {
        return {
          order: serializeKdsTicket(existing),
          alreadyAcknowledged: true,
        };
      }

      const now = new Date();
      const updated = await tx.order.update({
        where: { id: existing.id },
        data: {
          acknowledgedAt: now,
          acknowledgedByMembershipId: ctx.membershipId ?? null,
        },
        include: KDS_TICKET_INCLUDE,
      });

      await tx.orderEvent.create({
        data: {
          tenantId: ctx.tenantId,
          orderId: updated.id,
          eventType: 'KOT_ACKNOWLEDGED',
          fromStatus: existing.kitchenStatus,
          toStatus: updated.kitchenStatus,
          actorType: 'STAFF',
          actorId: ctx.userId,
          metadataJson: {
            kotNumber: updated.kotNumber,
            roundNumber: updated.roundNumber,
            acknowledgedAt: now.toISOString(),
          },
        },
      });

      const ticket = serializeKdsTicket(updated);
      await tx.outboxEvent.create({
        data: {
          tenantId: ctx.tenantId,
          topic: 'kot.acknowledged',
          aggregateType: 'Order',
          aggregateId: updated.id,
          status: PrismaOutboxStatus.PENDING,
          payloadJson: {
            orderId: updated.id,
            outletId: updated.outletId,
            sessionId: updated.sessionId,
            kotNumber: updated.kotNumber,
            kitchenStatus: updated.kitchenStatus,
            acknowledgedAt: ticket.acknowledgedAt,
            acknowledgedByMembershipId: ticket.acknowledgedByMembershipId,
            ticket: ticket as unknown as Prisma.InputJsonValue,
          } as Prisma.InputJsonValue,
        },
      });

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'KOT_ACKNOWLEDGED',
          entityType: 'Order',
          entityId: updated.id,
          beforeJson: { acknowledgedAt: null },
          afterJson: { acknowledgedAt: ticket.acknowledgedAt },
          ipAddress,
        },
      });

      return {
        order: ticket,
        alreadyAcknowledged: false,
      };
    }, ctx.tenantId);
  }

  async transitionOrderStatus(
    principal: AuthenticatedPrincipal,
    orderId: string,
    dto: UpdateKdsStatusDto,
  ) {
    const ctx = requireOutletContext(principal);
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runInTenantTx(async (tx) => {
      const existing = await tx.order.findFirst({
        where: { id: orderId, outletId: ctx.outletId },
        include: KDS_TICKET_INCLUDE,
      });
      if (!existing) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Kitchen order ticket not found.',
        });
      }

      const fromStatus = existing.kitchenStatus as KitchenStatus;
      const toStatus = dto.status;

      // Idempotent status update: repeat PATCH with same status succeeds cleanly
      if (fromStatus === toStatus) {
        return {
          order: serializeKdsTicket(existing),
          idempotentReplay: true,
        };
      }

      // Waiters can confirm serving a READY ticket to the table, while kitchen transitions belong to KITCHEN/MANAGER/OWNER/CASHIER
      if (
        ctx.role === StaffRole.WAITER &&
        !(fromStatus === KitchenStatus.READY && toStatus === KitchenStatus.SERVED)
      ) {
        throw new ForbiddenException({
          code: ErrorCode.FORBIDDEN,
          message: 'Waiter role can only mark READY orders as SERVED.',
        });
      }

      if (!canTransitionKitchenStatus(fromStatus, toStatus)) {
        throw new ConflictException({
          code: ErrorCode.INVALID_KDS_TRANSITION,
          message: `Cannot transition KOT #${existing.kotNumber} from ${fromStatus} to ${toStatus}.`,
          details: { fromStatus, toStatus },
        });
      }

      const now = new Date();
      const updateData: Prisma.OrderUpdateInput = {
        kitchenStatus: toStatus as PrismaKitchenStatus,
      };

      if (toStatus === KitchenStatus.PREPARING) {
        updateData.acceptedAt = existing.acceptedAt ?? now;
        if (!existing.acknowledgedAt) {
          updateData.acknowledgedAt = now;
          if (ctx.membershipId) {
            updateData.acknowledgedByMembership = { connect: { id: ctx.membershipId } };
          }
        }
      } else if (toStatus === KitchenStatus.READY) {
        updateData.readyAt = existing.readyAt ?? now;
        updateData.acceptedAt = existing.acceptedAt ?? now;
        if (!existing.acknowledgedAt) {
          updateData.acknowledgedAt = now;
          if (ctx.membershipId) {
            updateData.acknowledgedByMembership = { connect: { id: ctx.membershipId } };
          }
        }
      } else if (toStatus === KitchenStatus.SERVED) {
        updateData.servedAt = existing.servedAt ?? now;
      }

      const updated = await tx.order.update({
        where: { id: existing.id },
        data: updateData,
        include: KDS_TICKET_INCLUDE,
      });

      const reason = dto.reason?.trim() || null;

      await tx.orderEvent.create({
        data: {
          tenantId: ctx.tenantId,
          orderId: updated.id,
          eventType: KDS_STATUS_EVENT_MAP[toStatus] ?? 'KOT_UPDATED',
          fromStatus,
          toStatus,
          actorType: 'STAFF',
          actorId: ctx.userId,
          metadataJson: {
            kotNumber: updated.kotNumber,
            roundNumber: updated.roundNumber,
            ...(reason ? { reason } : {}),
          },
        },
      });

      const ticket = serializeKdsTicket(updated);
      await tx.outboxEvent.create({
        data: {
          tenantId: ctx.tenantId,
          topic: 'kot.updated',
          aggregateType: 'Order',
          aggregateId: updated.id,
          status: PrismaOutboxStatus.PENDING,
          payloadJson: {
            orderId: updated.id,
            outletId: updated.outletId,
            sessionId: updated.sessionId,
            kotNumber: updated.kotNumber,
            fromStatus,
            toStatus,
            reason,
            ticket: ticket as unknown as Prisma.InputJsonValue,
          } as Prisma.InputJsonValue,
        },
      });

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'KOT_STATUS_UPDATED',
          entityType: 'Order',
          entityId: updated.id,
          beforeJson: { kitchenStatus: fromStatus },
          afterJson: { kitchenStatus: toStatus, ...(reason ? { reason } : {}) },
          ipAddress,
        },
      });

      return {
        order: ticket,
        idempotentReplay: false,
      };
    }, ctx.tenantId);
  }
}

