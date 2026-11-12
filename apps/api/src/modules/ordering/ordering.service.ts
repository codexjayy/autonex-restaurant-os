import { randomInt, timingSafeEqual } from 'node:crypto';
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
  DietaryType as SharedDietaryType,
  DiningSessionStatus as SharedDiningSessionStatus,
  ErrorCode,
  GuestJoinStatus,
  JOIN_CODE_TTL_MS,
  KdsTicketModifierSnapshot,
  KdsTicketPayload,
  KitchenStatus,
  mapSessionStatusToStage,
  OrderSource,
  SelectionType,
} from '@autonex/shared';
import {
  BillStatus as PrismaBillStatus,
  DiningSessionStatus as PrismaDiningSessionStatus,
  GuestJoinStatus as PrismaGuestJoinStatus,
  KitchenStatus as PrismaKitchenStatus,
  OrderSource as PrismaOrderSource,
  OutboxStatus as PrismaOutboxStatus,
  Prisma,
  TableStatus as PrismaTableStatus,
  TenantStatus as PrismaTenantStatus,
} from '@prisma/client';
import { TenantContextService } from '../../common/context/tenant-context.service';
import {
  AuthenticatedPrincipal,
  requireOutletContext,
} from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { generateOpaqueToken, sha256Hex } from '../../common/security/crypto.util';
import { TablesService } from '../tables/tables.service';
import { JoinSessionDto } from './dto/join-session.dto';
import { PlaceCustomerOrderDto, PlaceStaffOrderDto } from './dto/place-order.dto';

const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9_.:-]{8,120}$/;

interface OrderActorContext {
  source: OrderSource;
  guestId?: string;
  placedByMembershipId?: string;
  actorType: 'CUSTOMER' | 'STAFF';
  actorId?: string;
}

@Injectable()
export class OrderingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly tablesService: TablesService,
  ) {}

  private generateJoinCode(): string {
    return String(randomInt(1000, 10000));
  }

  private nextJoinCodeExpiry(): Date {
    return new Date(Date.now() + JOIN_CODE_TTL_MS);
  }

  private async emitSessionOutboxEvent(
    tx: Prisma.TransactionClient,
    params: {
      tenantId: string;
      outletId: string;
      sessionId: string;
      tableId: string;
      status: PrismaDiningSessionStatus;
      topic?: 'session.updated' | 'session.closed';
      action?: string;
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
          action: params.action ?? 'updated',
        } as Prisma.InputJsonValue,
        status: PrismaOutboxStatus.PENDING,
      },
    });
  }

  private assertIdempotencyKey(rawKey?: string): string {
    const key = rawKey?.trim();
    if (!key || !IDEMPOTENCY_KEY_REGEX.test(key)) {
      throw new BadRequestException({
        code: ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
        message: 'Valid Idempotency-Key header (8-120 safe characters) is required.',
      });
    }
    return key;
  }

  private verifyJoinCodeMatches(submitted: string, expected: string | null): boolean {
    if (!expected) return false;
    const a = Buffer.from(submitted.trim(), 'utf8');
    const b = Buffer.from(expected.trim(), 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  private async loadOrderSnapshot(tx: Prisma.TransactionClient, orderId: string) {
    return tx.order.findFirst({
      where: { id: orderId },
      include: {
        items: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });
  }

  /**
   * Core transactional order placement shared by both Customer QR & Staff-Assisted POS flows:
   * 1. Checks Idempotency-Key deduplication
   * 2. Re-validates live menu item activity, inStock flags, modifier constraints, & integer paise prices
   * 3. Detects stale cart totals when expectedSubtotalPaise is supplied
   * 4. Atomically increments outlet.kotSeq and commits Order + OrderItems + OrderEvent + OutboxEvent
   */
  private async executePlaceOrderTx(params: {
    tx: Prisma.TransactionClient;
    tenantId: string;
    outletId: string;
    sessionId: string;
    tableId: string;
    tableNumber: string;
    tableLabel?: string | null;
    idempotencyKey: string;
    dto: PlaceCustomerOrderDto;
    actor: OrderActorContext;
  }) {
    const {
      tx,
      tenantId,
      outletId,
      sessionId,
      tableId,
      tableNumber,
      tableLabel = null,
      idempotencyKey,
      dto,
      actor,
    } = params;

    const existing = await tx.order.findFirst({
      where: { idempotencyKey },
      include: { items: { orderBy: { createdAt: 'asc' } } },
    });
    if (existing) {
      if (existing.outletId !== outletId || existing.sessionId !== sessionId) {
        throw new ConflictException({
          code: ErrorCode.CONFLICT,
          message: 'Idempotency-Key was already used for a different order.',
        });
      }
      return { order: existing, idempotentReplay: true };
    }

    const requestedIds = Array.from(new Set(dto.items.map((item) => item.menuItemId)));
    const dbItems = await tx.menuItem.findMany({
      where: {
        id: { in: requestedIds },
        outletId,
      },
      include: {
        category: { select: { id: true, name: true, isActive: true } },
        modifierGroups: {
          orderBy: { sortOrder: 'asc' },
          include: {
            options: { orderBy: { sortOrder: 'asc' } },
          },
        },
      },
    });
    const dbItemMap = new Map(dbItems.map((item) => [item.id, item]));

    let subtotalPaise = 0;
    const preparedLines: Array<{
      menuItemId: string;
      itemNameSnapshot: string;
      dietaryTypeSnapshot: (typeof dbItems)[number]['dietaryType'];
      basePricePaiseSnapshot: number;
      modifiersSnapshotJson: Prisma.InputJsonValue;
      unitPricePaise: number;
      quantity: number;
      lineTotalPaise: number;
      prepNotes: string | null;
    }> = [];

    for (const line of dto.items) {
      const dbItem = dbItemMap.get(line.menuItemId);
      if (!dbItem || !dbItem.isActive || !dbItem.category.isActive) {
        throw new ConflictException({
          code: ErrorCode.OUT_OF_STOCK,
          message: 'One or more ordered items are no longer available on the menu.',
          details: { menuItemId: line.menuItemId },
        });
      }

      if (!dbItem.inStock) {
        throw new ConflictException({
          code: ErrorCode.OUT_OF_STOCK,
          message: `"${dbItem.name}" is currently out of stock.`,
          details: { menuItemId: dbItem.id, itemName: dbItem.name },
        });
      }

      const selectedIds = Array.from(new Set(line.selectedOptionIds ?? []));
      const optionById = new Map<
        string,
        {
          id: string;
          name: string;
          priceDeltaPaise: number;
          inStock: boolean;
          groupId: string;
          groupName: string;
        }
      >();

      for (const group of dbItem.modifierGroups) {
        for (const opt of group.options) {
          optionById.set(opt.id, {
            id: opt.id,
            name: opt.name,
            priceDeltaPaise: opt.priceDeltaPaise,
            inStock: opt.inStock,
            groupId: group.id,
            groupName: group.name,
          });
        }
      }

      const selectedOptions = selectedIds.map((optId) => {
        const found = optionById.get(optId);
        if (!found) {
          throw new BadRequestException({
            code: ErrorCode.VALIDATION_ERROR,
            message: `Invalid modifier option selected for "${dbItem.name}".`,
          });
        }
        if (!found.inStock) {
          throw new ConflictException({
            code: ErrorCode.OUT_OF_STOCK,
            message: `Add-on "${found.name}" for "${dbItem.name}" is currently out of stock.`,
            details: { menuItemId: dbItem.id, modifierOptionId: found.id },
          });
        }
        return found;
      });

      for (const group of dbItem.modifierGroups) {
        const chosenCount = selectedOptions.filter((opt) => opt.groupId === group.id).length;
        const minRequired = group.isRequired ? Math.max(1, group.minSelect) : group.minSelect;

        if (group.selectionType === SelectionType.SINGLE && chosenCount > 1) {
          throw new BadRequestException({
            code: ErrorCode.VALIDATION_ERROR,
            message: `Modifier group "${group.name}" allows only 1 option.`,
          });
        }

        if (chosenCount < minRequired || chosenCount > group.maxSelect) {
          throw new BadRequestException({
            code: ErrorCode.VALIDATION_ERROR,
            message: `Modifier group "${group.name}" on "${dbItem.name}" requires ${minRequired}–${group.maxSelect} selection(s).`,
          });
        }
      }

      const modifierDeltaPaise = selectedOptions.reduce(
        (sum, opt) => sum + opt.priceDeltaPaise,
        0,
      );
      const unitPricePaise = dbItem.basePricePaise + modifierDeltaPaise;
      if (!Number.isInteger(unitPricePaise) || unitPricePaise < 0) {
        throw new BadRequestException({
          code: ErrorCode.INVALID_PRICE,
          message: `Computed unit price for "${dbItem.name}" is invalid.`,
        });
      }

      const lineTotalPaise = unitPricePaise * line.quantity;
      subtotalPaise += lineTotalPaise;

      preparedLines.push({
        menuItemId: dbItem.id,
        itemNameSnapshot: dbItem.name,
        dietaryTypeSnapshot: dbItem.dietaryType,
        basePricePaiseSnapshot: dbItem.basePricePaise,
        modifiersSnapshotJson: selectedOptions.map((opt) => ({
          groupId: opt.groupId,
          groupName: opt.groupName,
          optionId: opt.id,
          optionName: opt.name,
          priceDeltaPaise: opt.priceDeltaPaise,
        })) as Prisma.InputJsonValue,
        unitPricePaise,
        quantity: line.quantity,
        lineTotalPaise,
        prepNotes: line.prepNotes?.trim() || null,
      });
    }

    if (
      dto.expectedSubtotalPaise !== undefined &&
      dto.expectedSubtotalPaise !== subtotalPaise
    ) {
      throw new ConflictException({
        code: ErrorCode.STALE_MENU_PRICE,
        message:
          'Menu prices updated while you were browsing. Review the refreshed total and place your order again.',
        details: {
          expectedSubtotalPaise: dto.expectedSubtotalPaise,
          currentSubtotalPaise: subtotalPaise,
        },
      });
    }

    const activeOrdersCount = await tx.order.count({
      where: {
        sessionId,
        kitchenStatus: { not: PrismaKitchenStatus.CANCELLED },
      },
    });
    const roundNumber = activeOrdersCount + 1;
    const isAddOn = roundNumber > 1;

    const updatedOutlet = await tx.outlet.update({
      where: { id: outletId },
      data: { kotSeq: { increment: 1 } },
      select: { kotSeq: true },
    });

    const created = await tx.order.create({
      data: {
        tenantId,
        outletId,
        sessionId,
        guestId: actor.guestId ?? null,
        placedByMembershipId: actor.placedByMembershipId ?? null,
        roundNumber,
        kotNumber: updatedOutlet.kotSeq,
        isAddOn,
        source: actor.source as PrismaOrderSource,
        kitchenStatus: PrismaKitchenStatus.NEW,
        idempotencyKey,
        subtotalPaise,
        notes: dto.notes?.trim() || null,
        items: {
          create: preparedLines.map((line) => ({
            tenantId,
            menuItemId: line.menuItemId,
            itemNameSnapshot: line.itemNameSnapshot,
            dietaryTypeSnapshot: line.dietaryTypeSnapshot,
            basePricePaiseSnapshot: line.basePricePaiseSnapshot,
            modifiersSnapshotJson: line.modifiersSnapshotJson,
            unitPricePaise: line.unitPricePaise,
            quantity: line.quantity,
            lineTotalPaise: line.lineTotalPaise,
            prepNotes: line.prepNotes,
          })),
        },
        events: {
          create: {
            tenantId,
            eventType: 'ORDER_PLACED',
            toStatus: KitchenStatus.NEW,
            actorType: actor.actorType,
            actorId: actor.actorId ?? null,
            metadataJson: {
              roundNumber,
              kotNumber: updatedOutlet.kotSeq,
              source: actor.source,
            },
          },
        },
      },
      include: {
        items: { orderBy: { createdAt: 'asc' } },
      },
    });

    const kdsTicket: KdsTicketPayload = {
      id: created.id,
      tenantId,
      outletId,
      sessionId,
      tableId,
      tableNumber,
      tableLabel,
      roundNumber,
      kotNumber: created.kotNumber,
      isAddOn,
      source: actor.source,
      kitchenStatus: KitchenStatus.NEW,
      subtotalPaise,
      notes: created.notes ?? null,
      acknowledgedAt: null,
      acknowledgedByMembershipId: null,
      acknowledgedByName: null,
      acceptedAt: null,
      readyAt: null,
      servedAt: null,
      createdAt: created.createdAt.toISOString(),
      updatedAt: (created.updatedAt ?? created.createdAt).toISOString(),
      items: created.items.map((line) => ({
        id: line.id,
        menuItemId: line.menuItemId,
        itemNameSnapshot: line.itemNameSnapshot,
        dietaryTypeSnapshot: line.dietaryTypeSnapshot as SharedDietaryType,
        quantity: line.quantity,
        modifiersSnapshotJson:
          (line.modifiersSnapshotJson as unknown as KdsTicketModifierSnapshot[]) ?? [],
        prepNotes: line.prepNotes ?? null,
        status: String(line.status ?? 'ACTIVE'),
      })),
    };

    await tx.outboxEvent.create({
      data: {
        tenantId,
        topic: 'order.created',
        aggregateType: 'Order',
        aggregateId: created.id,
        status: PrismaOutboxStatus.PENDING,
        payloadJson: {
          orderId: created.id,
          outletId,
          sessionId,
          tableId,
          tableNumber,
          tableLabel,
          roundNumber,
          kotNumber: created.kotNumber,
          isAddOn,
          subtotalPaise,
          itemCount: created.items.length,
          createdAt: created.createdAt.toISOString(),
          ticket: kdsTicket as unknown as Prisma.InputJsonValue,
        } as Prisma.InputJsonValue,
      },
    });

    return { order: created, idempotentReplay: false };
  }

  // ============================================================================
  // STAFF FLOOR & SESSION ACTIVATION FLOWS
  // ============================================================================

  async listFloorSessions(principal: AuthenticatedPrincipal) {
    const ctx = requireOutletContext(principal);

    return this.prisma.runInTenantTx(async (tx) => {
      const tables = await tx.restaurantTable.findMany({
        where: { outletId: ctx.outletId, isActive: true },
        orderBy: { tableNumber: 'asc' },
        include: {
          diningSessions: {
            where: { status: { not: PrismaDiningSessionStatus.CLOSED } },
            take: 1,
            include: {
              outlet: { select: { gstRateBps: true } },
              bills: {
                where: { status: { not: PrismaBillStatus.VOID } },
                take: 1,
                orderBy: { createdAt: 'desc' },
                select: {
                  id: true,
                  billNumber: true,
                  status: true,
                  subtotalPaise: true,
                  discountPaise: true,
                  taxMode: true,
                  gstRateBps: true,
                  cgstPaise: true,
                  sgstPaise: true,
                  roundOffPaise: true,
                  totalPaise: true,
                  paidPaise: true,
                  refundedPaise: true,
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
                include: {
                  items: { orderBy: { createdAt: 'asc' } },
                },
              },
            },
          },
        },
      });

      return tables.map((table) => {
        const activeSession = table.diningSessions[0] ?? null;
        const gstRateBps =
          (activeSession as { outlet?: { gstRateBps?: number } } | null)?.outlet?.gstRateBps ?? 500;
        const balance = activeSession
          ? computeSessionBalanceSummary(activeSession.orders, gstRateBps)
          : null;
        const lifecycleStage = activeSession
          ? mapSessionStatusToStage(
              activeSession.status as unknown as SharedDiningSessionStatus,
            )
          : 'AVAILABLE';
        const readyToServeCount = activeSession
          ? activeSession.orders.filter((o) => o.kitchenStatus === PrismaKitchenStatus.READY).length
          : 0;
        const unackedCount = activeSession
          ? activeSession.orders.filter(
              (o) => o.kitchenStatus === PrismaKitchenStatus.NEW && !o.acknowledgedAt,
            ).length
          : 0;
        const rawActiveBill =
          (activeSession as {
            bills?: Array<{
              id: string;
              billNumber: string;
              status: string;
              subtotalPaise: number;
              discountPaise: number;
              taxMode: string;
              gstRateBps: number;
              cgstPaise: number;
              sgstPaise: number;
              roundOffPaise: number;
              totalPaise: number;
              paidPaise: number;
              refundedPaise: number;
            }>;
          } | null)?.bills?.[0] ?? null;
        const activeBill = rawActiveBill
          ? {
              ...rawActiveBill,
              netPaidPaise: Math.max(0, rawActiveBill.paidPaise - rawActiveBill.refundedPaise),
              duePaise: Math.max(
                0,
                rawActiveBill.totalPaise -
                  Math.max(0, rawActiveBill.paidPaise - rawActiveBill.refundedPaise),
              ),
            }
          : null;

        return {
          id: table.id,
          tableNumber: table.tableNumber,
          label: table.label,
          capacity: table.capacity,
          tableStatus: table.status,
          lifecycleStage,
          activeSession: activeSession
            ? {
                id: activeSession.id,
                status: activeSession.status,
                lifecycleStage,
                joinCode: activeSession.joinCode,
                joinCodeExpiresAt: activeSession.joinCodeExpiresAt,
                openedAt: activeSession.openedAt,
                billRequestedAt: activeSession.billRequestedAt,
                settledAt: activeSession.settledAt,
                runningTotalPaise: balance?.subtotalPaise ?? 0,
                balance,
                activeBill,
                readyToServeCount,
                unackedCount,
                pendingGuestsCount: activeSession.guests.filter(
                  (g) => g.status === PrismaGuestJoinStatus.PENDING_APPROVAL,
                ).length,
                guests: activeSession.guests,
                orders: activeSession.orders,
              }
            : null,
        };
      });
    }, ctx.tenantId);
  }

  async openTableSession(principal: AuthenticatedPrincipal, tableId: string) {
    const ctx = requireOutletContext(principal);
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    const attemptOpen = async () =>
      this.prisma.runInTenantTx(async (tx) => {
        await this.assertTenantOrderingActive(tx, ctx.tenantId);

        const table = await tx.restaurantTable.findFirst({
          where: { id: tableId, outletId: ctx.outletId, isActive: true },
        });
        if (!table) {
          throw new NotFoundException({
            code: ErrorCode.NOT_FOUND,
            message: 'Active table not found.',
          });
        }

        const existing = await tx.diningSession.findFirst({
          where: { tableId: table.id, status: { not: PrismaDiningSessionStatus.CLOSED } },
        });

        if (existing) {
          if (
            existing.status === PrismaDiningSessionStatus.BILL_REQUESTED ||
            existing.status === PrismaDiningSessionStatus.SETTLED
          ) {
            throw new ConflictException({
              code: ErrorCode.SESSION_NOT_ACTIVE,
              message:
                existing.status === PrismaDiningSessionStatus.SETTLED
                  ? 'Table session is settled and awaiting reset before seating a new party.'
                  : 'Table is awaiting checkout settlement and cannot start a new party.',
            });
          }
          return { session: existing, alreadyOpen: true };
        }

        const session = await tx.diningSession.create({
          data: {
            tenantId: ctx.tenantId,
            outletId: ctx.outletId,
            tableId: table.id,
            status: PrismaDiningSessionStatus.ACTIVE,
            joinCode: this.generateJoinCode(),
            joinCodeExpiresAt: this.nextJoinCodeExpiry(),
            openedByMembershipId: ctx.membershipId ?? null,
          },
        });

        await tx.restaurantTable.update({
          where: { id: table.id },
          data: { status: PrismaTableStatus.OCCUPIED },
        });

        await tx.auditLog.create({
          data: {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            actorRole: ctx.role,
            action: 'DINING_SESSION_OPENED',
            entityType: 'DiningSession',
            entityId: session.id,
            afterJson: { tableId: table.id, tableNumber: table.tableNumber },
            ipAddress,
          },
        });

        await this.emitSessionOutboxEvent(tx, {
          tenantId: ctx.tenantId,
          outletId: ctx.outletId,
          sessionId: session.id,
          tableId: table.id,
          status: session.status,
          action: 'opened',
        });

        return { session, alreadyOpen: false };
      }, ctx.tenantId);

    try {
      return await attemptOpen();
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') {
        const raced = await this.prisma.runInTenantTx(
          (tx) =>
            tx.diningSession.findFirst({
              where: { tableId, status: { not: PrismaDiningSessionStatus.CLOSED } },
            }),
          ctx.tenantId,
        );
        if (raced) {
          if (
            raced.status === PrismaDiningSessionStatus.BILL_REQUESTED ||
            raced.status === PrismaDiningSessionStatus.SETTLED
          ) {
            throw new ConflictException({
              code: ErrorCode.SESSION_NOT_ACTIVE,
              message: 'Table session is awaiting checkout reset.',
            });
          }
          return { session: raced, alreadyOpen: true };
        }
      }
      throw err;
    }
  }

  async rotateSessionJoinCode(principal: AuthenticatedPrincipal, sessionId: string) {
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

      const nextCode = this.generateJoinCode();
      const nextExpiry = this.nextJoinCodeExpiry();
      const updated = await tx.diningSession.update({
        where: { id: session.id },
        data: { joinCode: nextCode, joinCodeExpiresAt: nextExpiry },
        select: { id: true, joinCode: true, joinCodeExpiresAt: true, status: true },
      });

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'SESSION_JOIN_CODE_ROTATED',
          entityType: 'DiningSession',
          entityId: session.id,
          afterJson: { joinCodeExpiresAt: nextExpiry.toISOString() },
          ipAddress,
        },
      });

      await this.emitSessionOutboxEvent(tx, {
        tenantId: ctx.tenantId,
        outletId: ctx.outletId,
        sessionId: session.id,
        tableId: session.tableId,
        status: updated.status,
        action: 'join_code_rotated',
      });

      return updated;
    }, ctx.tenantId);
  }

  async updateGuestJoinStatus(
    principal: AuthenticatedPrincipal,
    sessionId: string,
    guestId: string,
    status: GuestJoinStatus.APPROVED | GuestJoinStatus.REVOKED,
  ) {
    const ctx = requireOutletContext(principal);
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runInTenantTx(async (tx) => {
      const session = await tx.diningSession.findFirst({
        where: {
          id: sessionId,
          outletId: ctx.outletId,
          status: PrismaDiningSessionStatus.ACTIVE,
        },
      });
      if (!session) {
        throw new NotFoundException({
          code: ErrorCode.SESSION_NOT_ACTIVE,
          message: 'Active dining session not found.',
        });
      }

      const guest = await tx.sessionGuest.findFirst({
        where: {
          id: guestId,
          sessionId: session.id,
        },
      });
      if (!guest) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Session guest request not found.',
        });
      }

      const updated = await tx.sessionGuest.update({
        where: { id: guest.id },
        data: {
          status: status as PrismaGuestJoinStatus,
          approvedByMembershipId: ctx.membershipId ?? null,
          ...(status === GuestJoinStatus.APPROVED ? { approvedAt: new Date() } : {}),
        },
        select: {
          id: true,
          displayLabel: true,
          status: true,
          approvedAt: true,
        },
      });

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: status === GuestJoinStatus.APPROVED ? 'SESSION_GUEST_APPROVED' : 'SESSION_GUEST_REVOKED',
          entityType: 'SessionGuest',
          entityId: guest.id,
          beforeJson: { status: guest.status },
          afterJson: { status: updated.status },
          ipAddress,
        },
      });

      await this.emitSessionOutboxEvent(tx, {
        tenantId: ctx.tenantId,
        outletId: ctx.outletId,
        sessionId: guest.sessionId,
        tableId: session.tableId,
        status: PrismaDiningSessionStatus.ACTIVE,
        action: status === GuestJoinStatus.APPROVED ? 'guest_approved' : 'guest_revoked',
      });

      return updated;
    }, ctx.tenantId);
  }

  async getSessionOrders(principal: AuthenticatedPrincipal, sessionId: string) {
    const ctx = requireOutletContext(principal);

    return this.prisma.runInTenantTx(async (tx) => {
      const session = await tx.diningSession.findFirst({
        where: { id: sessionId, outletId: ctx.outletId },
        include: {
          table: { select: { id: true, tableNumber: true, label: true } },
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
      return session;
    }, ctx.tenantId);
  }

  async placeStaffOrder(
    principal: AuthenticatedPrincipal,
    dto: PlaceStaffOrderDto,
    rawIdempotencyKey?: string,
  ) {
    const ctx = requireOutletContext(principal);
    const idempotencyKey = this.assertIdempotencyKey(rawIdempotencyKey);

    try {
      return await this.prisma.runInTenantTx(async (tx) => {
        await this.assertTenantOrderingActive(tx, ctx.tenantId);

        const table = await tx.restaurantTable.findFirst({
          where: { id: dto.tableId, outletId: ctx.outletId, isActive: true },
        });
        if (!table) {
          throw new NotFoundException({
            code: ErrorCode.NOT_FOUND,
            message: 'Active table not found.',
          });
        }

        let session = await tx.diningSession.findFirst({
          where: { tableId: table.id, status: { not: PrismaDiningSessionStatus.CLOSED } },
        });

        if (!session) {
          if (dto.openIfAvailable === false) {
            throw new ConflictException({
              code: ErrorCode.SESSION_NOT_ACTIVE,
              message: 'No active dining session on this table.',
            });
          }

          session = await tx.diningSession.create({
            data: {
              tenantId: ctx.tenantId,
              outletId: ctx.outletId,
              tableId: table.id,
              status: PrismaDiningSessionStatus.ACTIVE,
              joinCode: this.generateJoinCode(),
              joinCodeExpiresAt: this.nextJoinCodeExpiry(),
              openedByMembershipId: ctx.membershipId ?? null,
            },
          });

          await tx.restaurantTable.update({
            where: { id: table.id },
            data: { status: PrismaTableStatus.OCCUPIED },
          });

          await this.emitSessionOutboxEvent(tx, {
            tenantId: ctx.tenantId,
            outletId: ctx.outletId,
            sessionId: session.id,
            tableId: table.id,
            status: session.status,
            action: 'opened',
          });
        } else if (session.status !== PrismaDiningSessionStatus.ACTIVE) {
          throw new ConflictException({
            code: ErrorCode.SESSION_NOT_ACTIVE,
            message:
              session.status === PrismaDiningSessionStatus.SETTLED
                ? 'Table session is settled and must be closed before accepting new orders.'
                : 'Table session is locked for billing and cannot accept new orders.',
          });
        }

        return this.executePlaceOrderTx({
          tx,
          tenantId: ctx.tenantId,
          outletId: ctx.outletId,
          sessionId: session.id,
          tableId: table.id,
          tableNumber: table.tableNumber,
          tableLabel: table.label,
          idempotencyKey,
          dto,
          actor: {
            source: OrderSource.STAFF_POS,
            placedByMembershipId: ctx.membershipId,
            actorType: 'STAFF',
            actorId: ctx.userId,
          },
        });
      }, ctx.tenantId);
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') {
        const replayed = await this.prisma.runInTenantTx(
          (tx) =>
            tx.order.findFirst({
              where: { idempotencyKey, outletId: ctx.outletId },
              include: { items: { orderBy: { createdAt: 'asc' } } },
            }),
          ctx.tenantId,
        );
        if (replayed) {
          return { order: replayed, idempotentReplay: true };
        }
      }
      throw err;
    }
  }

  // ============================================================================
  // CUSTOMER QR ENTRY, SESSION JOIN, ORDER PLACEMENT & STATUS POLLING
  // ============================================================================

  async joinSessionViaQr(rawToken: string, dto: JoinSessionDto) {
    const resolved = await this.tablesService.verifyQrTokenAndGetTable(rawToken);
    this.assertResolvedQrOrderingAllowed(resolved.tenant_status);

    return this.prisma.runInTenantTx(async (tx) => {
      const session = await tx.diningSession.findFirst({
        where: {
          tableId: resolved.table_id,
          status: { not: PrismaDiningSessionStatus.CLOSED },
        },
      });

      if (!session || session.status !== PrismaDiningSessionStatus.ACTIVE) {
        throw new ConflictException({
          code: ErrorCode.SESSION_NOT_ACTIVE,
          message:
            session?.status === PrismaDiningSessionStatus.BILL_REQUESTED
              ? 'Bill has already been requested for this table. Checkout is in progress.'
              : session?.status === PrismaDiningSessionStatus.SETTLED
                ? 'This table session is settled and awaiting reset.'
                : 'Table session has not been started yet. Please ask your waiter to activate your table.',
        });
      }

      let guestStatus: PrismaGuestJoinStatus = PrismaGuestJoinStatus.PENDING_APPROVAL;

      if (dto.joinCode) {
        const isRevoked = !session.joinCode;
        const isExpired = Boolean(
          session.joinCodeExpiresAt && session.joinCodeExpiresAt <= new Date(),
        );
        if (isRevoked || isExpired || !this.verifyJoinCodeMatches(dto.joinCode, session.joinCode)) {
          throw new ForbiddenException({
            code: ErrorCode.INVALID_JOIN_CODE,
            message:
              isRevoked || isExpired
                ? 'This table join code has expired or been revoked. Please ask your waiter for a fresh code.'
                : 'Invalid table join code. Please check the 4-digit code with your waiter.',
          });
        }
        guestStatus = PrismaGuestJoinStatus.APPROVED;
      } else if (resolved.require_waiter_approval === false) {
        if (resolved.table_pin_enabled !== false) {
          throw new ForbiddenException({
            code: ErrorCode.INVALID_JOIN_CODE,
            message: 'A 4-digit table join code is required to join this table.',
          });
        }
        guestStatus = PrismaGuestJoinStatus.APPROVED;
      }

      const rawGuestToken = generateOpaqueToken(32);
      const guestTokenHash = sha256Hex(rawGuestToken);
      const existingCount = await tx.sessionGuest.count({
        where: { sessionId: session.id },
      });

      const guest = await tx.sessionGuest.create({
        data: {
          tenantId: resolved.tenant_id,
          sessionId: session.id,
          guestTokenHash,
          displayLabel: dto.displayLabel?.trim() || `Guest ${existingCount + 1}`,
          status: guestStatus,
          ...(guestStatus === PrismaGuestJoinStatus.APPROVED ? { approvedAt: new Date() } : {}),
        },
      });

      await this.emitSessionOutboxEvent(tx, {
        tenantId: resolved.tenant_id,
        outletId: resolved.outlet_id,
        sessionId: session.id,
        tableId: resolved.table_id,
        status: session.status,
        action: 'guest_joined',
      });

      return {
        guestToken: rawGuestToken,
        guestId: guest.id,
        displayLabel: guest.displayLabel,
        status: guest.status,
        sessionId: session.id,
        tableNumber: resolved.table_number,
      };
    }, resolved.tenant_id);
  }

  async getCustomerSessionState(rawToken: string, rawGuestToken?: string) {
    if (!rawGuestToken || rawGuestToken.trim().length < 20) {
      throw new UnauthorizedException({
        code: ErrorCode.UNAUTHORIZED,
        message: 'Guest session token is required.',
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
        include: {
          outlet: { select: { gstRateBps: true } },
        },
      });

      if (!session) {
        return {
          hasActiveSession: false,
          lifecycleStage: 'AVAILABLE' as const,
          sessionStatus: null,
          guestStatus: null,
          orders: [],
          runningTotalPaise: 0,
          balance: computeSessionBalanceSummary([], 500),
        };
      }

      const lifecycleStage = mapSessionStatusToStage(
        session.status as unknown as SharedDiningSessionStatus,
      );

      const guest = await tx.sessionGuest.findFirst({
        where: { sessionId: session.id, guestTokenHash: guestHash },
      });

      if (!guest || guest.status === PrismaGuestJoinStatus.REVOKED) {
        return {
          hasActiveSession: true,
          lifecycleStage,
          sessionStatus: session.status,
          guestStatus: guest?.status ?? null,
          orders: [],
          runningTotalPaise: 0,
        };
      }

      await tx.sessionGuest.update({
        where: { id: guest.id },
        data: { lastSeenAt: new Date() },
      });

      if (guest.status !== PrismaGuestJoinStatus.APPROVED) {
        return {
          hasActiveSession: true,
          lifecycleStage,
          sessionStatus: session.status,
          guestStatus: guest.status,
          displayLabel: guest.displayLabel,
          orders: [],
          runningTotalPaise: 0,
        };
      }

      const orders = await tx.order.findMany({
        where: { sessionId: session.id },
        orderBy: [{ roundNumber: 'asc' }, { createdAt: 'asc' }],
        include: {
          items: { orderBy: { createdAt: 'asc' } },
        },
      });

      const gstRateBps =
        (session as { outlet?: { gstRateBps?: number } }).outlet?.gstRateBps ?? 500;
      const balance = computeSessionBalanceSummary(orders, gstRateBps);

      const rawBill = await tx.bill?.findFirst?.({
        where: { sessionId: session.id, status: { not: PrismaBillStatus.VOID } },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          billNumber: true,
          status: true,
          subtotalPaise: true,
          discountPaise: true,
          discountReason: true,
          taxMode: true,
          gstRateBps: true,
          cgstPaise: true,
          sgstPaise: true,
          roundOffPaise: true,
          totalPaise: true,
          paidPaise: true,
          refundedPaise: true,
          finalizedAt: true,
          paidAt: true,
        },
      });
      const activeBill = rawBill
        ? {
            ...rawBill,
            netPaidPaise: Math.max(0, rawBill.paidPaise - rawBill.refundedPaise),
            duePaise: Math.max(
              0,
              rawBill.totalPaise - Math.max(0, rawBill.paidPaise - rawBill.refundedPaise),
            ),
          }
        : null;

      return {
        hasActiveSession: true,
        sessionId: session.id,
        lifecycleStage,
        sessionStatus: session.status,
        billRequestedAt: session.billRequestedAt ?? null,
        settledAt: session.settledAt ?? null,
        guestStatus: guest.status,
        displayLabel: guest.displayLabel,
        orders,
        runningTotalPaise: balance.subtotalPaise,
        balance,
        activeBill,
      };
    }, resolved.tenant_id);
  }

  async placeCustomerOrder(
    rawToken: string,
    rawGuestToken: string | undefined,
    dto: PlaceCustomerOrderDto,
    rawIdempotencyKey?: string,
  ) {
    if (!rawGuestToken || rawGuestToken.trim().length < 20) {
      throw new UnauthorizedException({
        code: ErrorCode.GUEST_NOT_APPROVED,
        message: 'Join the table session before placing an order.',
      });
    }

    const idempotencyKey = this.assertIdempotencyKey(rawIdempotencyKey);
    const resolved = await this.tablesService.verifyQrTokenAndGetTable(rawToken);
    this.assertResolvedQrOrderingAllowed(resolved.tenant_status);
    const guestHash = sha256Hex(rawGuestToken.trim());

    try {
      return await this.prisma.runInTenantTx(async (tx) => {
        const session = await tx.diningSession.findFirst({
          where: {
            tableId: resolved.table_id,
            status: PrismaDiningSessionStatus.ACTIVE,
          },
        });

        if (!session) {
          throw new ConflictException({
            code: ErrorCode.SESSION_NOT_ACTIVE,
            message: 'This table does not have an active dining session for ordering.',
          });
        }

        const guest = await tx.sessionGuest.findFirst({
          where: {
            sessionId: session.id,
            guestTokenHash: guestHash,
          },
        });

        if (!guest || guest.status !== PrismaGuestJoinStatus.APPROVED) {
          throw new ForbiddenException({
            code: ErrorCode.GUEST_NOT_APPROVED,
            message:
              guest?.status === PrismaGuestJoinStatus.PENDING_APPROVAL
                ? 'Waiting for waiter approval before ordering.'
                : 'Your guest access is not active for this table.',
          });
        }

        await tx.sessionGuest.update({
          where: { id: guest.id },
          data: { lastSeenAt: new Date() },
        });

        return this.executePlaceOrderTx({
          tx,
          tenantId: resolved.tenant_id,
          outletId: resolved.outlet_id,
          sessionId: session.id,
          tableId: resolved.table_id,
          tableNumber: resolved.table_number,
          tableLabel: resolved.table_label,
          idempotencyKey,
          dto,
          actor: {
            source: OrderSource.CUSTOMER_QR,
            guestId: guest.id,
            actorType: 'CUSTOMER',
            actorId: guest.id,
          },
        });
      }, resolved.tenant_id);
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') {
        const replayed = await this.prisma.runInTenantTx(async (tx) => {
          const order = await tx.order.findFirst({
            where: { idempotencyKey, outletId: resolved.outlet_id },
            include: { items: { orderBy: { createdAt: 'asc' } } },
          });
          return order ? this.loadOrderSnapshot(tx, order.id) : null;
        }, resolved.tenant_id);

        if (replayed) {
          return { order: replayed, idempotentReplay: true };
        }
      }
      throw err;
    }
  }

  private async assertTenantOrderingActive(tx: Prisma.TransactionClient, tenantId: string) {
    const tenant = await tx.tenant?.findUnique?.({
      where: { id: tenantId },
      select: { status: true },
    });
    if (!tenant) return;

    if (tenant.status === PrismaTenantStatus.SUSPENDED) {
      throw new ForbiddenException({
        code: ErrorCode.TENANT_SUSPENDED,
        message: 'Restaurant account is suspended. New tables and orders are blocked.',
      });
    }

    if (tenant.status === PrismaTenantStatus.LOCKED) {
      throw new ForbiddenException({
        code: ErrorCode.SUBSCRIPTION_LOCKED,
        message:
          'Subscription expired or suspension pending. New tables and orders are disabled; only open table settlement is allowed.',
      });
    }
  }

  private assertResolvedQrOrderingAllowed(tenantStatus: string | undefined) {
    if (tenantStatus === 'SUSPENDED') {
      throw new ForbiddenException({
        code: ErrorCode.TENANT_SUSPENDED,
        message: 'Restaurant account is temporarily unavailable for new orders.',
      });
    }
    if (tenantStatus === 'LOCKED') {
      throw new ForbiddenException({
        code: ErrorCode.SUBSCRIPTION_LOCKED,
        message:
          'New ordering is paused at this restaurant right now. Existing diners can still view their bill and complete payment.',
      });
    }
  }
}
