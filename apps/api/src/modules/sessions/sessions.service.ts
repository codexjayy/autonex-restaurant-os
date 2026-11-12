import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  computeSessionBalanceSummary,
  DiningSessionStatus as SharedDiningSessionStatus,
  ErrorCode,
  mapSessionStatusToStage,
  StaffRole,
} from '@autonex/shared';
import {
  BillStatus as PrismaBillStatus,
  DiningSessionStatus as PrismaDiningSessionStatus,
  GuestJoinStatus as PrismaGuestJoinStatus,
  KitchenStatus as PrismaKitchenStatus,
  OutboxStatus as PrismaOutboxStatus,
  Prisma,
  TableStatus as PrismaTableStatus,
} from '@prisma/client';
import { TenantContextService } from '../../common/context/tenant-context.service';
import {
  AuthenticatedPrincipal,
  requireOutletContext,
} from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { sha256Hex } from '../../common/security/crypto.util';
import { KDS_TICKET_INCLUDE, serializeKdsTicket } from '../kitchen/kitchen.service';
import { TablesService } from '../tables/tables.service';
import {
  CloseSessionDto,
  ModifyOrderItemsDto,
  SettleSessionDto,
} from './dto/session-lifecycle.dto';

const SETTLEMENT_ALLOWED_ROLES = new Set<string>([
  StaffRole.OWNER,
  StaffRole.MANAGER,
  StaffRole.CASHIER,
]);

const PREPARING_OVERRIDE_ROLES = new Set<string>([
  StaffRole.OWNER,
  StaffRole.MANAGER,
  StaffRole.CASHIER,
]);

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly tablesService: TablesService,
  ) {}

  private async emitSessionOutbox(
    tx: Prisma.TransactionClient,
    params: {
      tenantId: string;
      outletId: string;
      sessionId: string;
      tableId: string;
      status: PrismaDiningSessionStatus;
      topic?: 'session.updated' | 'session.closed';
      action: string;
    },
  ) {
    const sharedStatus = params.status as unknown as SharedDiningSessionStatus;
    await tx.outboxEvent.create({
      data: {
        tenantId: params.tenantId,
        topic: params.topic ?? 'session.updated',
        aggregateType: 'DiningSession',
        aggregateId: params.sessionId,
        payloadJson: {
          tenantId: params.tenantId,
          outletId: params.outletId,
          sessionId: params.sessionId,
          tableId: params.tableId,
          status: params.status,
          lifecycleStage: mapSessionStatusToStage(sharedStatus),
          action: params.action,
        } as Prisma.InputJsonValue,
        status: PrismaOutboxStatus.PENDING,
      },
    });
  }

  private async performCheckoutLockTx(
    tx: Prisma.TransactionClient,
    params: {
      tenantId: string;
      outletId: string;
      sessionId: string;
      actorType: 'STAFF' | 'CUSTOMER';
      actorUserId: string;
      actorRole: string;
      ipAddress: string | null;
    },
  ) {
    const session = await tx.diningSession.findFirst({
      where: { id: params.sessionId, outletId: params.outletId },
      include: {
        outlet: { select: { gstRateBps: true } },
        orders: {
          include: { items: { orderBy: { createdAt: 'asc' } } },
        },
      },
    });

    if (!session) {
      throw new NotFoundException({
        code: ErrorCode.NOT_FOUND,
        message: 'Dining session not found.',
      });
    }

    const gstRateBps =
      (session as { outlet?: { gstRateBps?: number } }).outlet?.gstRateBps ?? 500;
    const balance = computeSessionBalanceSummary(session.orders, gstRateBps);

    if (session.status === PrismaDiningSessionStatus.BILL_REQUESTED) {
      return {
        id: session.id,
        tableId: session.tableId,
        status: session.status,
        lifecycleStage: 'CHECKOUT_LOCKED' as const,
        billRequestedAt: session.billRequestedAt,
        balance,
        alreadyLocked: true,
      };
    }

    if (session.status !== PrismaDiningSessionStatus.ACTIVE) {
      throw new ConflictException({
        code: ErrorCode.SESSION_NOT_ACTIVE,
        message: 'Only open sessions can be locked for checkout.',
      });
    }

    if (balance.activeOrdersCount === 0) {
      throw new ConflictException({
        code: ErrorCode.SESSION_EMPTY,
        message: 'Place at least one order before requesting the bill.',
      });
    }

    const now = new Date();
    const updated = await tx.diningSession.update({
      where: { id: session.id },
      data: {
        status: PrismaDiningSessionStatus.BILL_REQUESTED,
        billRequestedAt: session.billRequestedAt ?? now,
      },
    });

    await tx.auditLog.create({
      data: {
        tenantId: params.tenantId,
        actorUserId: params.actorUserId,
        actorRole: params.actorRole,
        action: 'SESSION_CHECKOUT_LOCKED',
        entityType: 'DiningSession',
        entityId: session.id,
        beforeJson: { status: session.status },
        afterJson: {
          status: updated.status,
          requestedBy: params.actorType,
          subtotalPaise: balance.subtotalPaise,
        },
        ipAddress: params.ipAddress,
      },
    });

    await this.emitSessionOutbox(tx, {
      tenantId: params.tenantId,
      outletId: params.outletId,
      sessionId: session.id,
      tableId: session.tableId,
      status: updated.status,
      action: 'checkout_locked',
    });

    return {
      id: updated.id,
      tableId: updated.tableId,
      status: updated.status,
      lifecycleStage: 'CHECKOUT_LOCKED' as const,
      billRequestedAt: updated.billRequestedAt,
      balance,
      alreadyLocked: false,
    };
  }

  async getSessionSummary(principal: AuthenticatedPrincipal, sessionId: string) {
    const ctx = requireOutletContext(principal);

    return this.prisma.runInTenantTx(async (tx) => {
      const session = await tx.diningSession.findFirst({
        where: { id: sessionId, outletId: ctx.outletId },
        include: {
          outlet: { select: { gstRateBps: true } },
          table: {
            select: {
              id: true,
              tableNumber: true,
              label: true,
              capacity: true,
              status: true,
            },
          },
          guests: {
            where: { status: { not: PrismaGuestJoinStatus.REVOKED } },
            orderBy: { joinedAt: 'asc' },
            select: {
              id: true,
              displayLabel: true,
              status: true,
              joinedAt: true,
              approvedAt: true,
            },
          },
          orders: {
            orderBy: [{ roundNumber: 'asc' }, { createdAt: 'asc' }],
            include: { items: { orderBy: { createdAt: 'asc' } } },
          },
        },
      });

      if (!session) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Dining session not found.',
        });
      }

      const gstRateBps =
        (session as { outlet?: { gstRateBps?: number } }).outlet?.gstRateBps ?? 500;
      const balance = computeSessionBalanceSummary(session.orders, gstRateBps);
      const lifecycleStage = mapSessionStatusToStage(
        session.status as unknown as SharedDiningSessionStatus,
      );

      return {
        ...session,
        lifecycleStage,
        balance,
        runningTotalPaise: balance.subtotalPaise,
      };
    }, ctx.tenantId);
  }

  async revokeJoinCode(principal: AuthenticatedPrincipal, sessionId: string) {
    const ctx = requireOutletContext(principal);
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runInTenantTx(async (tx) => {
      const session = await tx.diningSession.findFirst({
        where: { id: sessionId, outletId: ctx.outletId, status: PrismaDiningSessionStatus.ACTIVE },
      });

      if (!session) {
        throw new NotFoundException({
          code: ErrorCode.SESSION_NOT_ACTIVE,
          message: 'Active dining session not found.',
        });
      }

      const updated = await tx.diningSession.update({
        where: { id: session.id },
        data: { joinCode: null, joinCodeExpiresAt: null },
        select: { id: true, joinCode: true, joinCodeExpiresAt: true, status: true },
      });

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'SESSION_JOIN_CODE_REVOKED',
          entityType: 'DiningSession',
          entityId: session.id,
          ipAddress,
        },
      });

      await this.emitSessionOutbox(tx, {
        tenantId: ctx.tenantId,
        outletId: ctx.outletId,
        sessionId: session.id,
        tableId: session.tableId,
        status: updated.status,
        action: 'join_code_revoked',
      });

      return updated;
    }, ctx.tenantId);
  }

  async modifyOrderItems(
    principal: AuthenticatedPrincipal,
    sessionId: string,
    orderId: string,
    dto: ModifyOrderItemsDto,
  ) {
    const ctx = requireOutletContext(principal);
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    const requestedByItemId = new Map<string, number>();
    for (const line of dto.items) {
      if (requestedByItemId.has(line.orderItemId)) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_ERROR,
          message: 'Duplicate orderItemId in modification payload.',
        });
      }
      requestedByItemId.set(line.orderItemId, line.quantity);
    }

    return this.prisma.runInTenantTx(async (tx) => {
      const session = await tx.diningSession.findFirst({
        where: { id: sessionId, outletId: ctx.outletId },
      });

      if (!session || session.status !== PrismaDiningSessionStatus.ACTIVE) {
        throw new ConflictException({
          code: ErrorCode.SESSION_NOT_ACTIVE,
          message: 'Session is locked for checkout or closed; items cannot be edited.',
        });
      }

      const order = await tx.order.findFirst({
        where: { id: orderId, sessionId: session.id, outletId: ctx.outletId },
        include: {
          items: { orderBy: { createdAt: 'asc' } },
        },
      });

      if (!order) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Order not found in this dining session.',
        });
      }

      if (
        order.kitchenStatus === PrismaKitchenStatus.READY ||
        order.kitchenStatus === PrismaKitchenStatus.SERVED ||
        order.kitchenStatus === PrismaKitchenStatus.CANCELLED
      ) {
        throw new ConflictException({
          code: ErrorCode.INVALID_KDS_TRANSITION,
          message: 'Ready, served, or cancelled orders can no longer be edited.',
        });
      }

      if (order.kitchenStatus === PrismaKitchenStatus.PREPARING) {
        if (!PREPARING_OVERRIDE_ROLES.has(ctx.role)) {
          throw new ForbiddenException({
            code: ErrorCode.FORBIDDEN,
            message:
              'Kitchen has already started preparing this order. Ask a Manager or Cashier to override.',
          });
        }
        if (!dto.reason || dto.reason.trim().length < 3) {
          throw new BadRequestException({
            code: ErrorCode.VALIDATION_ERROR,
            message:
              'An override reason (minimum 3 characters) is required when editing a PREPARING order.',
          });
        }
      }

      const existingItemsById = new Map(order.items.map((item) => [item.id, item]));
      for (const orderItemId of requestedByItemId.keys()) {
        if (!existingItemsById.has(orderItemId)) {
          throw new NotFoundException({
            code: ErrorCode.NOT_FOUND,
            message: `Order item ${orderItemId} does not belong to this order.`,
          });
        }
      }

      const changes: Array<{
        orderItemId: string;
        itemName: string;
        fromQty: number;
        toQty: number;
      }> = [];

      let nextSubtotalPaise = 0;
      let remainingActiveItems = 0;

      for (const item of order.items) {
        const requestedQty = requestedByItemId.get(item.id);
        const nextQty = requestedQty !== undefined ? requestedQty : item.quantity;
        const nextLineStatus = nextQty === 0 ? 'CANCELLED' : 'ACTIVE';
        const nextLineTotal = nextQty === 0 ? 0 : item.unitPricePaise * nextQty;

        if (requestedQty !== undefined && requestedQty !== item.quantity) {
          changes.push({
            orderItemId: item.id,
            itemName: item.itemNameSnapshot,
            fromQty: item.quantity,
            toQty: nextQty,
          });
          await tx.orderItem.update({
            where: { id: item.id },
            data: {
              quantity: nextQty,
              lineTotalPaise: nextLineTotal,
              status: nextLineStatus,
            },
          });
        }

        if (nextLineStatus !== 'CANCELLED' && nextQty > 0) {
          remainingActiveItems += nextQty;
          nextSubtotalPaise += nextLineTotal;
        }
      }

      if (changes.length === 0) {
        return { order, cancelledWholeOrder: false, unchanged: true };
      }

      const cancelledWholeOrder = remainingActiveItems === 0;
      const nextKitchenStatus = cancelledWholeOrder
        ? PrismaKitchenStatus.CANCELLED
        : order.kitchenStatus;

      const updatedOrder = await tx.order.update({
        where: { id: order.id },
        data: {
          subtotalPaise: nextSubtotalPaise,
          kitchenStatus: nextKitchenStatus,
        },
        include: KDS_TICKET_INCLUDE,
      });

      const eventType = cancelledWholeOrder ? 'ORDER_CANCELLED' : 'ITEMS_MODIFIED';

      await tx.orderEvent.create({
        data: {
          tenantId: ctx.tenantId,
          orderId: order.id,
          eventType,
          fromStatus: order.kitchenStatus,
          toStatus: nextKitchenStatus,
          actorType: 'STAFF',
          actorId: ctx.userId,
          metadataJson: {
            previousSubtotalPaise: order.subtotalPaise,
            nextSubtotalPaise,
            kitchenStatusBefore: order.kitchenStatus,
            kitchenStatusAfter: nextKitchenStatus,
            reason: dto.reason?.trim() || null,
            changes,
          } as Prisma.InputJsonValue,
        },
      });

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: cancelledWholeOrder ? 'ORDER_CANCELLED_PRE_PREP' : 'ORDER_ITEMS_MODIFIED',
          entityType: 'Order',
          entityId: order.id,
          beforeJson: { subtotalPaise: order.subtotalPaise, kitchenStatus: order.kitchenStatus },
          afterJson: {
            subtotalPaise: nextSubtotalPaise,
            kitchenStatus: nextKitchenStatus,
            reason: dto.reason?.trim() || null,
            changes,
          },
          ipAddress,
        },
      });

      const ticket = serializeKdsTicket(updatedOrder);
      await tx.outboxEvent.create({
        data: {
          tenantId: ctx.tenantId,
          topic: 'kot.updated',
          aggregateType: 'Order',
          aggregateId: order.id,
          payloadJson: {
            orderId: order.id,
            outletId: ctx.outletId,
            sessionId: session.id,
            tableId: session.tableId,
            kitchenStatus: nextKitchenStatus,
            ticket,
          } as unknown as Prisma.InputJsonValue,
          status: PrismaOutboxStatus.PENDING,
        },
      });

      await this.emitSessionOutbox(tx, {
        tenantId: ctx.tenantId,
        outletId: ctx.outletId,
        sessionId: session.id,
        tableId: session.tableId,
        status: session.status,
        action: cancelledWholeOrder ? 'order_cancelled' : 'order_modified',
      });

      return { order: updatedOrder, cancelledWholeOrder, unchanged: false };
    }, ctx.tenantId);
  }

  async lockSessionForCheckout(principal: AuthenticatedPrincipal, sessionId: string) {
    const ctx = requireOutletContext(principal);
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runInTenantTx(
      (tx) =>
        this.performCheckoutLockTx(tx, {
          tenantId: ctx.tenantId,
          outletId: ctx.outletId,
          sessionId,
          actorType: 'STAFF',
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          ipAddress,
        }),
      ctx.tenantId,
    );
  }

  async lockSessionForCheckoutCustomer(rawToken: string, rawGuestToken?: string) {
    if (!rawGuestToken || rawGuestToken.trim().length < 20) {
      throw new UnauthorizedException({
        code: ErrorCode.UNAUTHORIZED,
        message: 'Join the table session before requesting the bill.',
      });
    }

    const resolved = await this.tablesService.verifyQrTokenAndGetTable(rawToken);
    const guestHash = sha256Hex(rawGuestToken.trim());

    return this.prisma.runInTenantTx(async (tx) => {
      const session = await tx.diningSession.findFirst({
        where: {
          tableId: resolved.table_id,
          status: { not: PrismaDiningSessionStatus.CLOSED },
        },
      });

      if (!session) {
        throw new ConflictException({
          code: ErrorCode.SESSION_NOT_ACTIVE,
          message: 'No active dining session found on this table.',
        });
      }

      const guest = await tx.sessionGuest.findFirst({
        where: { sessionId: session.id, guestTokenHash: guestHash },
      });

      if (!guest || guest.status !== PrismaGuestJoinStatus.APPROVED) {
        throw new ForbiddenException({
          code: ErrorCode.GUEST_NOT_APPROVED,
          message: 'Only approved table guests can request the bill.',
        });
      }

      return this.performCheckoutLockTx(tx, {
        tenantId: resolved.tenant_id,
        outletId: resolved.outlet_id,
        sessionId: session.id,
        actorType: 'CUSTOMER',
        actorUserId: guest.id,
        actorRole: 'GUEST',
        ipAddress: null,
      });
    }, resolved.tenant_id);
  }

  async reopenSession(principal: AuthenticatedPrincipal, sessionId: string) {
    const ctx = requireOutletContext(principal);
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runInTenantTx(async (tx) => {
      const session = await tx.diningSession.findFirst({
        where: { id: sessionId, outletId: ctx.outletId },
      });

      if (!session) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Dining session not found.',
        });
      }

      if (session.status !== PrismaDiningSessionStatus.BILL_REQUESTED) {
        throw new ConflictException({
          code: ErrorCode.CONFLICT,
          message: 'Only checkout-locked sessions (before settlement) can be reopened.',
        });
      }

      const activeBill = await tx.bill?.findFirst?.({
        where: { sessionId: session.id, status: { not: PrismaBillStatus.VOID } },
      });
      if (activeBill) {
        if (activeBill.paidPaise - activeBill.refundedPaise > 0) {
          throw new ConflictException({
            code: ErrorCode.BILL_ALREADY_PAID,
            message: 'Cannot reopen table after payment has been recorded against the bill.',
          });
        }
        await tx.bill.update({
          where: { id: activeBill.id },
          data: {
            status: PrismaBillStatus.VOID,
            voidReason: 'Voided automatically on table reopen before payment',
            voidedByMembershipId: ctx.membershipId ?? null,
            voidedAt: new Date(),
          },
        });
      }

      const updated = await tx.diningSession.update({
        where: { id: session.id },
        data: {
          status: PrismaDiningSessionStatus.ACTIVE,
          billRequestedAt: null,
        },
      });

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'SESSION_REOPENED',
          entityType: 'DiningSession',
          entityId: session.id,
          beforeJson: { status: session.status },
          afterJson: { status: updated.status },
          ipAddress,
        },
      });

      await this.emitSessionOutbox(tx, {
        tenantId: ctx.tenantId,
        outletId: ctx.outletId,
        sessionId: session.id,
        tableId: session.tableId,
        status: updated.status,
        action: 'reopened',
      });

      return {
        id: updated.id,
        status: updated.status,
        lifecycleStage: 'OPEN' as const,
      };
    }, ctx.tenantId);
  }

  async markSessionSettled(
    principal: AuthenticatedPrincipal,
    sessionId: string,
    dto: SettleSessionDto,
  ) {
    const ctx = requireOutletContext(principal);
    if (!SETTLEMENT_ALLOWED_ROLES.has(ctx.role)) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Only Owner, Manager, or Cashier can mark a session settled.',
      });
    }
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runInTenantTx(async (tx) => {
      const session = await tx.diningSession.findFirst({
        where: { id: sessionId, outletId: ctx.outletId },
        include: {
          outlet: { select: { gstRateBps: true } },
          orders: { include: { items: { orderBy: { createdAt: 'asc' } } } },
        },
      });

      if (!session) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Dining session not found.',
        });
      }

      if (session.status === PrismaDiningSessionStatus.SETTLED) {
        return {
          id: session.id,
          status: session.status,
          lifecycleStage: 'SETTLED' as const,
          settledAt: session.settledAt,
          alreadySettled: true,
        };
      }

      if (session.status !== PrismaDiningSessionStatus.BILL_REQUESTED) {
        throw new ConflictException({
          code: ErrorCode.CONFLICT,
          message: 'Request bill / lock checkout before marking this session settled.',
        });
      }

      const unpaidBill = await tx.bill?.findFirst?.({
        where: {
          sessionId: session.id,
          status: { in: [PrismaBillStatus.OPEN, PrismaBillStatus.PARTIALLY_PAID] },
        },
      });
      if (unpaidBill) {
        throw new ConflictException({
          code: ErrorCode.SESSION_NOT_SETTLED,
          message: `Bill ${unpaidBill.billNumber} still has an unpaid balance. Record payment before settling this session.`,
        });
      }

      const gstRateBps =
        (session as { outlet?: { gstRateBps?: number } }).outlet?.gstRateBps ?? 500;
      const balance = computeSessionBalanceSummary(session.orders, gstRateBps);

      const now = new Date();
      const updated = await tx.diningSession.update({
        where: { id: session.id },
        data: {
          status: PrismaDiningSessionStatus.SETTLED,
          settledAt: now,
          settledByMembershipId: ctx.membershipId ?? null,
        },
      });

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'SESSION_SETTLED',
          entityType: 'DiningSession',
          entityId: session.id,
          beforeJson: { status: session.status },
          afterJson: {
            status: updated.status,
            subtotalPaise: balance.subtotalPaise,
            estimatedTotalPaise: balance.estimatedTotalPaise,
            note: dto.note?.trim() || null,
          },
          ipAddress,
        },
      });

      await this.emitSessionOutbox(tx, {
        tenantId: ctx.tenantId,
        outletId: ctx.outletId,
        sessionId: session.id,
        tableId: session.tableId,
        status: updated.status,
        action: 'settled',
      });

      return {
        id: updated.id,
        status: updated.status,
        lifecycleStage: 'SETTLED' as const,
        settledAt: updated.settledAt,
        balance,
        alreadySettled: false,
      };
    }, ctx.tenantId);
  }

  async closeAndResetSession(
    principal: AuthenticatedPrincipal,
    sessionId: string,
    dto: CloseSessionDto,
  ) {
    const ctx = requireOutletContext(principal);
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runInTenantTx(async (tx) => {
      const session = await tx.diningSession.findFirst({
        where: { id: sessionId, outletId: ctx.outletId },
        include: {
          orders: { select: { id: true, kitchenStatus: true } },
        },
      });

      if (!session) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Dining session not found.',
        });
      }

      if (session.status === PrismaDiningSessionStatus.CLOSED) {
        throw new ConflictException({
          code: ErrorCode.CONFLICT,
          message: 'Dining session is already closed.',
        });
      }

      const activeOrdersCount = session.orders.filter(
        (o) => o.kitchenStatus !== PrismaKitchenStatus.CANCELLED,
      ).length;

      if (activeOrdersCount > 0 && session.status !== PrismaDiningSessionStatus.SETTLED) {
        throw new ConflictException({
          code: ErrorCode.SESSION_NOT_SETTLED,
          message:
            'Cannot close an unpaid table session. Settle the bill first before resetting the table.',
        });
      }

      const unsettledBill = await tx.bill?.findFirst?.({
        where: {
          sessionId: session.id,
          status: { in: [PrismaBillStatus.OPEN, PrismaBillStatus.PARTIALLY_PAID] },
        },
      });
      if (unsettledBill) {
        throw new ConflictException({
          code: ErrorCode.SESSION_NOT_SETTLED,
          message: `Bill ${unsettledBill.billNumber} is unsettled; complete payment or refund/void cleanly before closing.`,
        });
      }

      const now = new Date();
      const revokedResult = await tx.sessionGuest.updateMany({
        where: {
          sessionId: session.id,
          status: { not: PrismaGuestJoinStatus.REVOKED },
        },
        data: {
          status: PrismaGuestJoinStatus.REVOKED,
        },
      });

      const closed = await tx.diningSession.update({
        where: { id: session.id },
        data: {
          status: PrismaDiningSessionStatus.CLOSED,
          joinCode: null,
          joinCodeExpiresAt: null,
          closedAt: now,
          closedByMembershipId: ctx.membershipId ?? null,
        },
      });

      await tx.restaurantTable.update({
        where: { id: session.tableId },
        data: { status: PrismaTableStatus.AVAILABLE },
      });

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'SESSION_CLOSED_TABLE_RESET',
          entityType: 'DiningSession',
          entityId: session.id,
          beforeJson: { status: session.status, activeOrdersCount },
          afterJson: {
            status: closed.status,
            revokedGuestsCount: revokedResult.count,
            reason: dto.reason?.trim() || null,
          },
          ipAddress,
        },
      });

      await this.emitSessionOutbox(tx, {
        tenantId: ctx.tenantId,
        outletId: ctx.outletId,
        sessionId: session.id,
        tableId: session.tableId,
        status: closed.status,
        topic: 'session.closed',
        action: 'closed_reset',
      });

      const tenantRecord = await tx.tenant?.findUnique?.({
        where: { id: ctx.tenantId },
        select: { id: true, status: true, pendingSuspensionAfterService: true },
      });

      let suspensionAutoCompleted = false;
      if (tenantRecord?.pendingSuspensionAfterService) {
        const remainingOpenSessions = await tx.diningSession.count({
          where: {
            tenantId: ctx.tenantId,
            status: {
              in: [
                PrismaDiningSessionStatus.ACTIVE,
                PrismaDiningSessionStatus.BILL_REQUESTED,
                PrismaDiningSessionStatus.SETTLED,
              ],
            },
          },
        });

        if (remainingOpenSessions === 0) {
          await tx.tenant.update({
            where: { id: ctx.tenantId },
            data: {
              status: 'SUSPENDED',
              pendingSuspensionAfterService: false,
              suspendedAt: now,
            },
          });

          await tx.refreshToken?.updateMany?.({
            where: {
              user: { memberships: { some: { tenantId: ctx.tenantId } } },
              revokedAt: null,
            },
            data: { revokedAt: now },
          });

          await tx.auditLog.create({
            data: {
              tenantId: ctx.tenantId,
              actorUserId: ctx.userId,
              actorRole: ctx.role,
              action: 'RESTAURANT_SUSPENDED_COMPLETED',
              entityType: 'Tenant',
              entityId: ctx.tenantId,
              beforeJson: {
                status: tenantRecord.status,
                pendingSuspensionAfterService: true,
              },
              afterJson: {
                status: 'SUSPENDED',
                pendingSuspensionAfterService: false,
                completedAfterSessionId: session.id,
              },
              ipAddress,
            },
          });

          suspensionAutoCompleted = true;
        }
      }

      return {
        id: closed.id,
        tableId: session.tableId,
        status: closed.status,
        lifecycleStage: 'CLOSED' as const,
        tableStatus: PrismaTableStatus.AVAILABLE,
        revokedGuestsCount: revokedResult.count,
        closedAt: closed.closedAt,
        suspensionAutoCompleted,
      };
    }, ctx.tenantId);
  }
}

