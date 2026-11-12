import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  BillAuditEntryDto,
  BillItemGstDto,
  BillLineType,
  BillingAnalyticsDto,
  BillingPeriodBucketDto,
  BillStatus,
  BillSummaryDto,
  BillingOutboxTopic,
  calculateBillTotalsPaise,
  computeBillPaymentProgress,
  computeItemWiseGstBreakdown,
  ErrorCode,
  formatSequentialBillNumber,
  PaymentMethod,
  PaymentProvider,
  PaymentStatus,
  RefundStatus,
  StaffRole,
  TaxMode,
} from '@autonex/shared';
import {
  BillLineType as PrismaBillLineType,
  BillStatus as PrismaBillStatus,
  DiningSessionStatus as PrismaDiningSessionStatus,
  GuestJoinStatus as PrismaGuestJoinStatus,
  KitchenStatus as PrismaKitchenStatus,
  OrderItemStatus as PrismaOrderItemStatus,
  OutboxStatus as PrismaOutboxStatus,
  PaymentStatus as PrismaPaymentStatus,
  Prisma,
  RefundStatus as PrismaRefundStatus,
  TableStatus as PrismaTableStatus,
  TaxMode as PrismaTaxMode,
} from '@prisma/client';
import { TenantContextService } from '../../common/context/tenant-context.service';
import {
  AuthenticatedPrincipal,
  requireOutletContext,
} from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { sha256Hex } from '../../common/security/crypto.util';
import { TablesService } from '../tables/tables.service';
import {
  ApplyDiscountDto,
  GenerateBillDto,
  ListBillsQueryDto,
  VoidBillDto,
} from './dto/billing.dto';
import { ReceiptPdfService } from './receipt-pdf.service';

const FINANCIAL_STAFF_ROLES = new Set<string>([
  StaffRole.OWNER,
  StaffRole.MANAGER,
  StaffRole.CASHIER,
]);

const BILL_INCLUDE = {
  session: {
    select: {
      id: true,
      status: true,
      table: {
        select: { id: true, tableNumber: true, label: true },
      },
    },
  },
  lines: {
    orderBy: { createdAt: 'asc' as const },
  },
  paymentAttempts: {
    orderBy: { createdAt: 'desc' as const },
  },
  refunds: {
    orderBy: { createdAt: 'desc' as const },
  },
} satisfies Prisma.BillInclude;

type BillWithRelations = Prisma.BillGetPayload<{ include: typeof BILL_INCLUDE }>;

export function serializeBillSummary(bill: BillWithRelations): BillSummaryDto {
  const progress = computeBillPaymentProgress({
    totalPaise: bill.totalPaise,
    succeededAllocatedPaise: bill.paidPaise,
    refundedPaise: bill.refundedPaise,
  });

  const serializedLines = bill.lines.map((line) => ({
    id: line.id,
    orderItemId: line.orderItemId,
    lineType: line.lineType as unknown as BillLineType,
    description: line.description,
    quantity: line.quantity,
    unitAmountPaise: line.unitAmountPaise,
    lineAmountPaise: line.lineAmountPaise,
  }));

  const itemGstBreakdown: BillItemGstDto[] = computeItemWiseGstBreakdown({
    itemLines: serializedLines.filter((l) => l.lineType === BillLineType.ITEM),
    discountPaise: bill.discountPaise,
    taxMode: bill.taxMode as unknown as TaxMode,
    gstRateBps: bill.gstRateBps,
    cgstPaise: bill.cgstPaise,
    sgstPaise: bill.sgstPaise,
  });

  return {
    id: bill.id,
    sessionId: bill.sessionId,
    billNumber: bill.billNumber,
    status: bill.status as unknown as BillStatus,
    subtotalPaise: bill.subtotalPaise,
    discountPaise: bill.discountPaise,
    discountReason: bill.discountReason,
    taxMode: bill.taxMode as unknown as TaxMode,
    gstRateBps: bill.gstRateBps,
    cgstPaise: bill.cgstPaise,
    sgstPaise: bill.sgstPaise,
    roundOffPaise: bill.roundOffPaise,
    totalPaise: bill.totalPaise,
    paidPaise: bill.paidPaise,
    refundedPaise: bill.refundedPaise,
    netPaidPaise: progress.netPaidPaise,
    duePaise: progress.duePaise,
    gstinSnapshot: bill.gstinSnapshot,
    outletNameSnapshot: bill.outletNameSnapshot,
    outletAddressSnapshot: bill.outletAddressSnapshot,
    tableNumber: bill.session.table.tableNumber,
    tableLabel: bill.session.table.label,
    voidReason: bill.voidReason,
    finalizedAt: bill.finalizedAt.toISOString(),
    paidAt: bill.paidAt ? bill.paidAt.toISOString() : null,
    createdAt: bill.createdAt.toISOString(),
    lines: serializedLines,
    itemGstBreakdown,
    paymentAttempts: bill.paymentAttempts.map((p) => ({
      id: p.id,
      billId: p.billId,
      method: p.method as unknown as PaymentMethod,
      provider: p.provider as unknown as PaymentProvider,
      amountPaise: p.amountPaise,
      status: p.status as unknown as PaymentStatus,
      gatewayOrderId: p.gatewayOrderId,
      gatewayPaymentId: p.gatewayPaymentId,
      qrPayloadUrl: p.qrPayloadUrl,
      receiptRef: p.receiptRef,
      failureReason: p.failureReason,
      reconcileAttempts: p.reconcileAttempts,
      lastReconciledAt: p.lastReconciledAt ? p.lastReconciledAt.toISOString() : null,
      completedAt: p.completedAt ? p.completedAt.toISOString() : null,
      createdAt: p.createdAt.toISOString(),
    })),
    refunds: bill.refunds.map((r) => ({
      id: r.id,
      billId: r.billId,
      paymentAttemptId: r.paymentAttemptId,
      amountPaise: r.amountPaise,
      reason: r.reason,
      status: r.status as unknown as RefundStatus,
      gatewayRefundId: r.gatewayRefundId,
      processedAt: r.processedAt ? r.processedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly tablesService: TablesService,
    private readonly receiptPdfService: ReceiptPdfService,
  ) {}

  private async emitBillingOutbox(
    tx: Prisma.TransactionClient,
    params: {
      tenantId: string;
      outletId: string;
      topic: BillingOutboxTopic;
      billId: string;
      sessionId: string;
      tableId: string;
      billStatus: string;
    },
  ) {
    await tx.outboxEvent.create({
      data: {
        tenantId: params.tenantId,
        topic: params.topic,
        aggregateType: 'Bill',
        aggregateId: params.billId,
        payloadJson: {
          tenantId: params.tenantId,
          outletId: params.outletId,
          billId: params.billId,
          sessionId: params.sessionId,
          tableId: params.tableId,
          status: params.billStatus,
        } as Prisma.InputJsonValue,
        status: PrismaOutboxStatus.PENDING,
      },
    });
  }

  private buildBillLinesData(params: {
    tenantId: string;
    billId: string;
    activeItems: Array<{
      id: string;
      itemNameSnapshot: string;
      modifiersSnapshotJson: unknown;
      quantity: number;
      unitPricePaise: number;
      lineTotalPaise: number;
    }>;
    calc: ReturnType<typeof calculateBillTotalsPaise>;
    discountReason: string | null;
  }): Prisma.BillLineCreateManyInput[] {
    const lines: Prisma.BillLineCreateManyInput[] = params.activeItems.map((item) => {
      const mods = Array.isArray(item.modifiersSnapshotJson)
        ? (item.modifiersSnapshotJson as Array<{ optionName?: string }>)
            .map((m) => m.optionName)
            .filter(Boolean)
            .join(', ')
        : '';
      const desc = mods ? `${item.itemNameSnapshot} (${mods})` : item.itemNameSnapshot;
      return {
        tenantId: params.tenantId,
        billId: params.billId,
        orderItemId: item.id,
        lineType: PrismaBillLineType.ITEM,
        description: desc.slice(0, 160),
        quantity: item.quantity,
        unitAmountPaise: item.unitPricePaise,
        lineAmountPaise: item.lineTotalPaise,
      };
    });

    if (params.calc.discountPaise > 0) {
      lines.push({
        tenantId: params.tenantId,
        billId: params.billId,
        orderItemId: null,
        lineType: PrismaBillLineType.DISCOUNT,
        description: params.discountReason
          ? `Discount: ${params.discountReason}`.slice(0, 160)
          : 'Bill Discount',
        quantity: 1,
        unitAmountPaise: -params.calc.discountPaise,
        lineAmountPaise: -params.calc.discountPaise,
      });
    }

    if (params.calc.taxMode !== TaxMode.NONE && params.calc.totalTaxPaise > 0) {
      lines.push({
        tenantId: params.tenantId,
        billId: params.billId,
        orderItemId: null,
        lineType: PrismaBillLineType.CGST,
        description: `CGST (${params.calc.gstRateBps / 200}%)`,
        quantity: 1,
        unitAmountPaise: params.calc.cgstPaise,
        lineAmountPaise: params.calc.cgstPaise,
      });
      lines.push({
        tenantId: params.tenantId,
        billId: params.billId,
        orderItemId: null,
        lineType: PrismaBillLineType.SGST,
        description: `SGST (${params.calc.gstRateBps / 200}%)`,
        quantity: 1,
        unitAmountPaise: params.calc.sgstPaise,
        lineAmountPaise: params.calc.sgstPaise,
      });
    }

    if (params.calc.roundOffPaise !== 0) {
      lines.push({
        tenantId: params.tenantId,
        billId: params.billId,
        orderItemId: null,
        lineType: PrismaBillLineType.ROUND_OFF,
        description: 'Round-Off',
        quantity: 1,
        unitAmountPaise: params.calc.roundOffPaise,
        lineAmountPaise: params.calc.roundOffPaise,
      });
    }

    return lines;
  }

  private async consolidateBillTx(
    tx: Prisma.TransactionClient,
    params: {
      tenantId: string;
      outletId: string;
      sessionId: string;
      actorUserId: string;
      actorRole: string;
      discountPaise?: number;
      discountPercentBps?: number;
      discountReason?: string;
      refresh?: boolean;
      ipAddress: string | null;
    },
  ): Promise<{ bill: BillSummaryDto; alreadyExisted: boolean }> {
    const session = await tx.diningSession.findFirst({
      where: { id: params.sessionId, outletId: params.outletId },
      include: {
        outlet: true,
        table: { select: { id: true, tableNumber: true, label: true } },
        orders: {
          where: { kitchenStatus: { not: PrismaKitchenStatus.CANCELLED } },
          orderBy: [{ roundNumber: 'asc' }, { createdAt: 'asc' }],
          include: {
            items: {
              where: { status: PrismaOrderItemStatus.ACTIVE, quantity: { gt: 0 } },
              orderBy: { createdAt: 'asc' },
            },
          },
        },
      },
    });

    if (!session) {
      throw new NotFoundException({
        code: ErrorCode.NOT_FOUND,
        message: 'Dining session not found.',
      });
    }

    const existingBill = await tx.bill.findFirst({
      where: { sessionId: session.id, status: { not: PrismaBillStatus.VOID } },
      include: BILL_INCLUDE,
    });

    if (existingBill) {
      if (!params.refresh) {
        return { bill: serializeBillSummary(existingBill), alreadyExisted: true };
      }

      if (
        existingBill.status !== PrismaBillStatus.OPEN ||
        existingBill.paidPaise > 0 ||
        existingBill.refundedPaise > 0
      ) {
        throw new ConflictException({
          code: ErrorCode.CONFLICT,
          message:
            'Only unpaid OPEN bills with zero collected payments can be refreshed after order edits.',
        });
      }

      const activeItems = session.orders.flatMap((o) => o.items);
      if (activeItems.length === 0) {
        throw new ConflictException({
          code: ErrorCode.SESSION_EMPTY,
          message: 'No active ordered items remain in this session.',
        });
      }

      const itemsSubtotalPaise = activeItems.reduce((sum, item) => sum + item.lineTotalPaise, 0);
      const nextDiscountPaise =
        params.discountPaise !== undefined
          ? params.discountPaise
          : params.discountPercentBps !== undefined
            ? Math.round((itemsSubtotalPaise * params.discountPercentBps) / 10000)
            : Math.min(existingBill.discountPaise, itemsSubtotalPaise);
      const nextDiscountReason =
        nextDiscountPaise > 0
          ? params.discountReason?.trim() || existingBill.discountReason || 'Bill Discount'
          : null;

      if (nextDiscountPaise > itemsSubtotalPaise) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_ERROR,
          message: 'Discount cannot exceed the updated item subtotal.',
        });
      }

      const calc = calculateBillTotalsPaise({
        itemsSubtotalPaise,
        discountPaise: nextDiscountPaise,
        gstRateBps: session.outlet.gstRateBps,
        taxMode: session.outlet.taxMode as unknown as TaxMode,
        roundOffEnabled: session.outlet.roundOffEnabled,
      });

      const now = new Date();
      await tx.billLine.deleteMany({ where: { billId: existingBill.id } });
      const newLines = this.buildBillLinesData({
        tenantId: params.tenantId,
        billId: existingBill.id,
        activeItems,
        calc,
        discountReason: nextDiscountReason,
      });
      if (newLines.length > 0) {
        await tx.billLine.createMany({ data: newLines });
      }

      const nextStatus = calc.totalPaise === 0 ? PrismaBillStatus.PAID : PrismaBillStatus.OPEN;
      await tx.bill.update({
        where: { id: existingBill.id },
        data: {
          status: nextStatus,
          subtotalPaise: calc.itemsSubtotalPaise,
          discountPaise: calc.discountPaise,
          discountReason: nextDiscountReason,
          taxMode: calc.taxMode as unknown as PrismaTaxMode,
          gstRateBps: calc.gstRateBps,
          cgstPaise: calc.cgstPaise,
          sgstPaise: calc.sgstPaise,
          roundOffPaise: calc.roundOffPaise,
          totalPaise: calc.totalPaise,
          paidAt: nextStatus === PrismaBillStatus.PAID ? now : null,
          billSnapshotJson: {
            billNumber: existingBill.billNumber,
            tableNumber: session.table.tableNumber,
            tableLabel: session.table.label,
            roundCount: session.orders.length,
            rounds: session.orders.map((o) => ({
              orderId: o.id,
              roundNumber: o.roundNumber,
              kotNumber: o.kotNumber,
              subtotalPaise: o.subtotalPaise,
            })),
            totals: calc,
          } as unknown as Prisma.InputJsonValue,
        },
      });

      await tx.auditLog.create({
        data: {
          tenantId: params.tenantId,
          actorUserId: params.actorUserId,
          actorRole: params.actorRole,
          action: 'BILL_REFRESHED_FROM_ORDERS',
          entityType: 'Bill',
          entityId: existingBill.id,
          beforeJson: {
            subtotalPaise: existingBill.subtotalPaise,
            totalPaise: existingBill.totalPaise,
          },
          afterJson: {
            subtotalPaise: calc.itemsSubtotalPaise,
            totalPaise: calc.totalPaise,
            itemCount: activeItems.length,
          },
          ipAddress: params.ipAddress,
        },
      });

      await this.emitBillingOutbox(tx, {
        tenantId: params.tenantId,
        outletId: params.outletId,
        topic: 'bill.updated',
        billId: existingBill.id,
        sessionId: session.id,
        tableId: session.table.id,
        billStatus: nextStatus,
      });

      const refreshed = await tx.bill.findFirst({
        where: { id: existingBill.id },
        include: BILL_INCLUDE,
      });
      return { bill: serializeBillSummary(refreshed!), alreadyExisted: false };
    }

    if (session.status === PrismaDiningSessionStatus.CLOSED) {
      throw new ConflictException({
        code: ErrorCode.SESSION_NOT_ACTIVE,
        message: 'Cannot generate a bill on a closed session.',
      });
    }

    const activeItems = session.orders.flatMap((o) => o.items);
    if (activeItems.length === 0) {
      throw new ConflictException({
        code: ErrorCode.SESSION_EMPTY,
        message: 'No active ordered items found to consolidate into a bill.',
      });
    }

    const itemsSubtotalPaise = activeItems.reduce((sum, item) => sum + item.lineTotalPaise, 0);
    const discountPaise =
      params.discountPaise !== undefined
        ? params.discountPaise
        : params.discountPercentBps !== undefined
          ? Math.round((itemsSubtotalPaise * params.discountPercentBps) / 10000)
          : 0;

    if (discountPaise > 0) {
      if (!FINANCIAL_STAFF_ROLES.has(params.actorRole)) {
        throw new ForbiddenException({
          code: ErrorCode.FORBIDDEN,
          message: 'Only Owner, Manager, or Cashier can apply bill discounts.',
        });
      }
      if (!params.discountReason || params.discountReason.trim().length < 3) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_ERROR,
          message: 'A discount reason is required.',
        });
      }
      if (discountPaise > itemsSubtotalPaise) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_ERROR,
          message: 'Discount cannot exceed the item subtotal.',
        });
      }
    }

    const calc = calculateBillTotalsPaise({
      itemsSubtotalPaise,
      discountPaise,
      gstRateBps: session.outlet.gstRateBps,
      taxMode: session.outlet.taxMode as unknown as TaxMode,
      roundOffEnabled: session.outlet.roundOffEnabled,
    });

    const now = new Date();
    const updatedOutlet = await tx.outlet.update({
      where: { id: session.outlet.id },
      data: { invoiceSeq: { increment: 1 } },
      select: { invoiceSeq: true },
    });
    const billNumber = formatSequentialBillNumber(updatedOutlet.invoiceSeq, now);

    // Ensure session enters CHECKOUT_LOCKED (BILL_REQUESTED) if still ACTIVE
    if (session.status === PrismaDiningSessionStatus.ACTIVE) {
      await tx.diningSession.update({
        where: { id: session.id },
        data: {
          status: PrismaDiningSessionStatus.BILL_REQUESTED,
          billRequestedAt: session.billRequestedAt ?? now,
        },
      });
    }

    const billStatus =
      calc.totalPaise === 0 ? PrismaBillStatus.PAID : PrismaBillStatus.OPEN;

    const createdBill = await tx.bill.create({
      data: {
        tenantId: params.tenantId,
        outletId: params.outletId,
        sessionId: session.id,
        billNumber,
        status: billStatus,
        subtotalPaise: calc.itemsSubtotalPaise,
        discountPaise: calc.discountPaise,
        discountReason: discountPaise > 0 ? params.discountReason?.trim() ?? null : null,
        taxMode: calc.taxMode as unknown as PrismaTaxMode,
        gstRateBps: calc.gstRateBps,
        cgstPaise: calc.cgstPaise,
        sgstPaise: calc.sgstPaise,
        roundOffPaise: calc.roundOffPaise,
        totalPaise: calc.totalPaise,
        paidPaise: 0,
        refundedPaise: 0,
        gstinSnapshot: session.outlet.gstin,
        outletNameSnapshot: session.outlet.name,
        outletAddressSnapshot: session.outlet.address,
        finalizedAt: now,
        paidAt: billStatus === PrismaBillStatus.PAID ? now : null,
        billSnapshotJson: {
          billNumber,
          tableNumber: session.table.tableNumber,
          tableLabel: session.table.label,
          roundCount: session.orders.length,
          rounds: session.orders.map((o) => ({
            orderId: o.id,
            roundNumber: o.roundNumber,
            kotNumber: o.kotNumber,
            subtotalPaise: o.subtotalPaise,
          })),
          totals: calc,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    const billLines = this.buildBillLinesData({
      tenantId: params.tenantId,
      billId: createdBill.id,
      activeItems,
      calc,
      discountReason: discountPaise > 0 ? params.discountReason?.trim() ?? null : null,
    });

    if (billLines.length > 0) {
      await tx.billLine.createMany({ data: billLines });
    }

    await tx.auditLog.create({
      data: {
        tenantId: params.tenantId,
        actorUserId: params.actorUserId,
        actorRole: params.actorRole,
        action: 'BILL_GENERATED',
        entityType: 'Bill',
        entityId: createdBill.id,
        afterJson: {
          billNumber,
          sessionId: session.id,
          subtotalPaise: calc.itemsSubtotalPaise,
          discountPaise: calc.discountPaise,
          cgstPaise: calc.cgstPaise,
          sgstPaise: calc.sgstPaise,
          totalPaise: calc.totalPaise,
          taxMode: calc.taxMode,
        },
        ipAddress: params.ipAddress,
      },
    });

    await this.emitBillingOutbox(tx, {
      tenantId: params.tenantId,
      outletId: params.outletId,
      topic: 'bill.generated',
      billId: createdBill.id,
      sessionId: session.id,
      tableId: session.table.id,
      billStatus: createdBill.status,
    });

    const hydrated = await tx.bill.findFirst({
      where: { id: createdBill.id },
      include: BILL_INCLUDE,
    });

    return { bill: serializeBillSummary(hydrated!), alreadyExisted: false };
  }

  async generateOrRefreshBill(
    principal: AuthenticatedPrincipal,
    sessionId: string,
    dto: GenerateBillDto = {},
  ) {
    const ctx = requireOutletContext(principal);
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    try {
      return await this.prisma.runInTenantTx(
        (tx) =>
          this.consolidateBillTx(tx, {
            tenantId: ctx.tenantId,
            outletId: ctx.outletId,
            sessionId,
            actorUserId: ctx.userId,
            actorRole: ctx.role,
            discountPaise: dto.discountPaise,
            discountPercentBps: dto.discountPercentBps,
            discountReason: dto.discountReason,
            refresh: dto.refresh,
            ipAddress,
          }),
        ctx.tenantId,
      );
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') {
        const existing = await this.getBillBySession(principal, sessionId);
        return { bill: existing, alreadyExisted: true };
      }
      throw err;
    }
  }

  private async resolveApprovedCustomerSession(rawToken: string, rawGuestToken?: string) {
    if (!rawGuestToken || rawGuestToken.trim().length < 20) {
      throw new UnauthorizedException({
        code: ErrorCode.UNAUTHORIZED,
        message: 'Valid guest session token is required.',
      });
    }
    const resolved = await this.tablesService.verifyQrTokenAndGetTable(rawToken);
    const guestHash = sha256Hex(rawGuestToken.trim());
    return { resolved, guestHash };
  }

  async generateOrGetCustomerBill(rawToken: string, rawGuestToken?: string) {
    const { resolved, guestHash } = await this.resolveApprovedCustomerSession(
      rawToken,
      rawGuestToken,
    );

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
          message: 'Only approved table guests can view or generate the bill.',
        });
      }

      return this.consolidateBillTx(tx, {
        tenantId: resolved.tenant_id,
        outletId: resolved.outlet_id,
        sessionId: session.id,
        actorUserId: guest.id,
        actorRole: 'GUEST',
        ipAddress: null,
      });
    }, resolved.tenant_id);
  }

  async getCustomerBill(rawToken: string, rawGuestToken?: string) {
    const { resolved, guestHash } = await this.resolveApprovedCustomerSession(
      rawToken,
      rawGuestToken,
    );

    return this.prisma.runInTenantTx(async (tx) => {
      const session = await tx.diningSession.findFirst({
        where: {
          tableId: resolved.table_id,
          status: { not: PrismaDiningSessionStatus.CLOSED },
        },
      });
      if (!session) {
        return { bill: null };
      }

      const guest = await tx.sessionGuest.findFirst({
        where: { sessionId: session.id, guestTokenHash: guestHash },
      });
      if (!guest || guest.status !== PrismaGuestJoinStatus.APPROVED) {
        throw new ForbiddenException({
          code: ErrorCode.GUEST_NOT_APPROVED,
          message: 'Only approved table guests can view the bill.',
        });
      }

      const bill = await tx.bill.findFirst({
        where: { sessionId: session.id, status: { not: PrismaBillStatus.VOID } },
        include: BILL_INCLUDE,
      });
      return { bill: bill ? serializeBillSummary(bill) : null };
    }, resolved.tenant_id);
  }

  async getBill(principal: AuthenticatedPrincipal, billId: string): Promise<BillSummaryDto> {
    const ctx = requireOutletContext(principal);
    return this.prisma.runInTenantTx(async (tx) => {
      const bill = await tx.bill.findFirst({
        where: { id: billId, outletId: ctx.outletId },
        include: BILL_INCLUDE,
      });
      if (!bill) {
        throw new NotFoundException({
          code: ErrorCode.BILL_NOT_FOUND,
          message: 'Bill not found.',
        });
      }
      return serializeBillSummary(bill);
    }, ctx.tenantId);
  }

  async getBillBySession(
    principal: AuthenticatedPrincipal,
    sessionId: string,
  ): Promise<BillSummaryDto> {
    const ctx = requireOutletContext(principal);
    return this.prisma.runInTenantTx(async (tx) => {
      const bill = await tx.bill.findFirst({
        where: { sessionId, outletId: ctx.outletId, status: { not: PrismaBillStatus.VOID } },
        include: BILL_INCLUDE,
      });
      if (!bill) {
        throw new NotFoundException({
          code: ErrorCode.BILL_NOT_FOUND,
          message: 'Active bill not found for this dining session.',
        });
      }
      return serializeBillSummary(bill);
    }, ctx.tenantId);
  }

  async listOutletBills(principal: AuthenticatedPrincipal, query: ListBillsQueryDto) {
    const ctx = requireOutletContext(principal);
    return this.prisma.runInTenantTx(async (tx) => {
      const bills = await tx.bill.findMany({
        where: {
          outletId: ctx.outletId,
          ...(query.status ? { status: query.status as PrismaBillStatus } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: query.limit ?? 40,
        include: BILL_INCLUDE,
      });
      return bills.map(serializeBillSummary);
    }, ctx.tenantId);
  }

  async applyAuditedDiscount(
    principal: AuthenticatedPrincipal,
    billId: string,
    dto: ApplyDiscountDto,
  ): Promise<BillSummaryDto> {
    const ctx = requireOutletContext(principal);
    if (!FINANCIAL_STAFF_ROLES.has(ctx.role)) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Only Owner, Manager, or Cashier can modify bill discounts.',
      });
    }
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runInTenantTx(async (tx) => {
      const bill = await tx.bill.findFirst({
        where: { id: billId, outletId: ctx.outletId },
        include: BILL_INCLUDE,
      });
      if (!bill) {
        throw new NotFoundException({
          code: ErrorCode.BILL_NOT_FOUND,
          message: 'Bill not found.',
        });
      }
      if (bill.status === PrismaBillStatus.VOID) {
        throw new ConflictException({
          code: ErrorCode.BILL_VOIDED,
          message: 'Cannot apply a discount to a voided bill.',
        });
      }
      if (bill.status === PrismaBillStatus.PAID) {
        throw new ConflictException({
          code: ErrorCode.BILL_ALREADY_PAID,
          message: 'Bill is already paid; issue a refund instead of altering discount.',
        });
      }

      if (dto.discountPaise === undefined && dto.discountPercentBps === undefined) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_ERROR,
          message: 'Specify either discountPaise or discountPercentBps.',
        });
      }

      const resolvedDiscountPaise =
        dto.discountPaise !== undefined
          ? dto.discountPaise
          : Math.round((bill.subtotalPaise * (dto.discountPercentBps ?? 0)) / 10000);

      if (resolvedDiscountPaise > bill.subtotalPaise) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_ERROR,
          message: 'Discount cannot exceed subtotal.',
        });
      }

      const outlet = await tx.outlet.findFirst({
        where: { id: bill.outletId },
        select: { roundOffEnabled: true },
      });

      const calc = calculateBillTotalsPaise({
        itemsSubtotalPaise: bill.subtotalPaise,
        discountPaise: resolvedDiscountPaise,
        gstRateBps: bill.gstRateBps,
        taxMode: bill.taxMode as unknown as TaxMode,
        roundOffEnabled: outlet?.roundOffEnabled ?? bill.roundOffPaise !== 0,
      });

      const netPaid = Math.max(0, bill.paidPaise - bill.refundedPaise);
      if (calc.totalPaise < netPaid) {
        throw new ConflictException({
          code: ErrorCode.CONFLICT,
          message: `New total (${calc.totalPaise}) cannot be less than already collected payments (${netPaid}). Refund excess payment first.`,
        });
      }

      const progress = computeBillPaymentProgress({
        totalPaise: calc.totalPaise,
        succeededAllocatedPaise: bill.paidPaise,
        refundedPaise: bill.refundedPaise,
      });

      const now = new Date();
      await tx.bill.update({
        where: { id: bill.id },
        data: {
          discountPaise: calc.discountPaise,
          discountReason: dto.reason.trim(),
          cgstPaise: calc.cgstPaise,
          sgstPaise: calc.sgstPaise,
          roundOffPaise: calc.roundOffPaise,
          totalPaise: calc.totalPaise,
          status: progress.status as unknown as PrismaBillStatus,
          paidAt: progress.status === BillStatus.PAID ? now : null,
        },
      });

      if (progress.status === BillStatus.PAID && bill.session.status !== PrismaDiningSessionStatus.CLOSED) {
        let unbilledActiveItemsCount = 0;
        if (tx.orderItem?.count) {
          const billedItemIds = bill.lines
            .map((l) => l.orderItemId)
            .filter((id): id is string => Boolean(id));
          unbilledActiveItemsCount = await tx.orderItem.count({
            where: {
              status: PrismaOrderItemStatus.ACTIVE,
              quantity: { gt: 0 },
              ...(billedItemIds.length > 0 ? { id: { notIn: billedItemIds } } : {}),
              order: {
                sessionId: bill.sessionId,
                kitchenStatus: { not: PrismaKitchenStatus.CANCELLED },
              },
            },
          });
        }
        if (unbilledActiveItemsCount === 0) {
          await tx.diningSession.update({
            where: { id: bill.sessionId },
            data: {
              status: PrismaDiningSessionStatus.SETTLED,
              settledAt: now,
              settledByMembershipId: ctx.membershipId ?? null,
            },
          });

          await tx.restaurantTable?.update?.({
            where: { id: bill.session.table.id },
            data: { status: PrismaTableStatus.AVAILABLE },
          });
        }
      }

      // Replace non-item summary lines deterministically
      await tx.billLine.deleteMany({
        where: {
          billId: bill.id,
          lineType: { not: PrismaBillLineType.ITEM },
        },
      });

      const summaryLines = this.buildBillLinesData({
        tenantId: ctx.tenantId,
        billId: bill.id,
        activeItems: [],
        calc,
        discountReason: dto.reason.trim(),
      });
      if (summaryLines.length > 0) {
        await tx.billLine.createMany({ data: summaryLines });
      }

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'BILL_DISCOUNT_APPLIED',
          entityType: 'Bill',
          entityId: bill.id,
          beforeJson: {
            discountPaise: bill.discountPaise,
            totalPaise: bill.totalPaise,
          },
          afterJson: {
            discountPaise: calc.discountPaise,
            ...(dto.discountPercentBps !== undefined
              ? { discountPercentBps: dto.discountPercentBps }
              : {}),
            reason: dto.reason.trim(),
            totalPaise: calc.totalPaise,
          },
          ipAddress,
        },
      });

      await this.emitBillingOutbox(tx, {
        tenantId: ctx.tenantId,
        outletId: ctx.outletId,
        topic: 'bill.updated',
        billId: bill.id,
        sessionId: bill.sessionId,
        tableId: bill.session.table.id,
        billStatus: progress.status,
      });

      const updated = await tx.bill.findFirst({
        where: { id: bill.id },
        include: BILL_INCLUDE,
      });
      return serializeBillSummary(updated!);
    }, ctx.tenantId);
  }

  async voidBill(
    principal: AuthenticatedPrincipal,
    billId: string,
    dto: VoidBillDto,
  ): Promise<BillSummaryDto> {
    const ctx = requireOutletContext(principal);
    if (!FINANCIAL_STAFF_ROLES.has(ctx.role)) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Only Owner, Manager, or Cashier can void a bill.',
      });
    }
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runInTenantTx(async (tx) => {
      const bill = await tx.bill.findFirst({
        where: { id: billId, outletId: ctx.outletId },
        include: BILL_INCLUDE,
      });
      if (!bill) {
        throw new NotFoundException({
          code: ErrorCode.BILL_NOT_FOUND,
          message: 'Bill not found.',
        });
      }
      if (bill.status === PrismaBillStatus.VOID) {
        return serializeBillSummary(bill);
      }

      const netPaid = Math.max(0, bill.paidPaise - bill.refundedPaise);
      if (netPaid > 0) {
        throw new ConflictException({
          code: ErrorCode.CONFLICT,
          message: 'Issue full refund for collected payments before voiding this bill.',
        });
      }

      const now = new Date();
      await tx.bill.update({
        where: { id: bill.id },
        data: {
          status: PrismaBillStatus.VOID,
          voidReason: dto.reason.trim(),
          voidedByMembershipId: ctx.membershipId ?? null,
          voidedAt: now,
        },
      });

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'BILL_VOIDED',
          entityType: 'Bill',
          entityId: bill.id,
          beforeJson: { status: bill.status, totalPaise: bill.totalPaise },
          afterJson: { status: BillStatus.VOID, reason: dto.reason.trim() },
          ipAddress,
        },
      });

      await this.emitBillingOutbox(tx, {
        tenantId: ctx.tenantId,
        outletId: ctx.outletId,
        topic: 'bill.updated',
        billId: bill.id,
        sessionId: bill.sessionId,
        tableId: bill.session.table.id,
        billStatus: BillStatus.VOID,
      });

      const updated = await tx.bill.findFirst({
        where: { id: bill.id },
        include: BILL_INCLUDE,
      });
      return serializeBillSummary(updated!);
    }, ctx.tenantId);
  }

  async getBillAuditLogs(
    principal: AuthenticatedPrincipal,
    billId: string,
  ): Promise<BillAuditEntryDto[]> {
    const ctx = requireOutletContext(principal);
    if (!FINANCIAL_STAFF_ROLES.has(ctx.role)) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Only Owner, Manager, or Cashier can view billing audit logs.',
      });
    }

    return this.prisma.runInTenantTx(async (tx) => {
      const bill = await tx.bill.findFirst({
        where: { id: billId, outletId: ctx.outletId },
        include: {
          paymentAttempts: { select: { id: true } },
          refunds: { select: { id: true } },
        },
      });
      if (!bill) {
        throw new NotFoundException({
          code: ErrorCode.BILL_NOT_FOUND,
          message: 'Bill not found.',
        });
      }

      const attemptIds = bill.paymentAttempts.map((p) => p.id);
      const refundIds = bill.refunds.map((r) => r.id);

      const rows = await tx.auditLog.findMany({
        where: {
          OR: [
            { entityType: 'Bill', entityId: bill.id },
            ...(attemptIds.length > 0
              ? [{ entityType: 'PaymentAttempt', entityId: { in: attemptIds } }]
              : []),
            ...(refundIds.length > 0
              ? [{ entityType: 'Refund', entityId: { in: refundIds } }]
              : []),
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });

      return rows.map((row) => ({
        id: row.id,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId ?? bill.id,
        actorUserId: row.actorUserId,
        actorRole: row.actorRole,
        beforeJson: row.beforeJson ?? null,
        afterJson: row.afterJson ?? null,
        createdAt: row.createdAt.toISOString(),
      }));
    }, ctx.tenantId);
  }

  async getBillingAnalytics(principal: AuthenticatedPrincipal): Promise<BillingAnalyticsDto> {
    const ctx = requireOutletContext(principal);
    if (!FINANCIAL_STAFF_ROLES.has(ctx.role)) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Only Owner, Manager, or Cashier can view revenue reports.',
      });
    }

    return this.prisma.runInTenantTx(async (tx) => {
      const outlet = await tx.outlet.findFirst({
        where: { id: ctx.outletId },
        select: { timezone: true },
      });
      const timezone = outlet?.timezone || 'Asia/Kolkata';

      const formatYmd = (d: Date) =>
        new Intl.DateTimeFormat('en-CA', {
          timeZone: timezone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(d);

      const formatDayLabel = (d: Date) =>
        new Intl.DateTimeFormat('en-IN', {
          timeZone: timezone,
          day: '2-digit',
          month: 'short',
        }).format(d);

      const formatMonthKey = (d: Date) => formatYmd(d).slice(0, 7);
      const formatMonthLabel = (d: Date) =>
        new Intl.DateTimeFormat('en-IN', {
          timeZone: timezone,
          month: 'short',
          year: 'numeric',
        }).format(d);

      const getWeekStartYmd = (ymd: string) => {
        const [y, m, day] = ymd.split('-').map(Number);
        const utc = new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1, day ?? 1));
        const dow = utc.getUTCDay(); // 0 Sun..6 Sat
        const diff = dow === 0 ? -6 : 1 - dow; // Monday start
        utc.setUTCDate(utc.getUTCDate() + diff);
        return utc.toISOString().slice(0, 10);
      };

      const now = new Date();
      const todayKey = formatYmd(now);

      const dailyMap = new Map<string, BillingPeriodBucketDto>();
      for (let i = 13; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 86400000);
        const key = formatYmd(d);
        dailyMap.set(key, {
          key,
          label: formatDayLabel(d),
          billsCount: 0,
          completedBillsCount: 0,
          grossSalesPaise: 0,
          discountPaise: 0,
          gstPaise: 0,
          collectedPaise: 0,
          refundedPaise: 0,
          netRevenuePaise: 0,
        });
      }

      const weeklyMap = new Map<string, BillingPeriodBucketDto>();
      for (let w = 7; w >= 0; w--) {
        const d = new Date(now.getTime() - w * 7 * 86400000);
        const weekKey = getWeekStartYmd(formatYmd(d));
        if (!weeklyMap.has(weekKey)) {
          const [wy, wm, wd] = weekKey.split('-').map(Number);
          const weekDate = new Date(Date.UTC(wy ?? 2026, (wm ?? 1) - 1, wd ?? 1));
          weeklyMap.set(weekKey, {
            key: weekKey,
            label: `Wk ${weekDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' })}`,
            billsCount: 0,
            completedBillsCount: 0,
            grossSalesPaise: 0,
            discountPaise: 0,
            gstPaise: 0,
            collectedPaise: 0,
            refundedPaise: 0,
            netRevenuePaise: 0,
          });
        }
      }

      const monthlyMap = new Map<string, BillingPeriodBucketDto>();
      for (let m = 5; m >= 0; m--) {
        const ref = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, 15));
        const key = formatMonthKey(ref);
        monthlyMap.set(key, {
          key,
          label: formatMonthLabel(ref),
          billsCount: 0,
          completedBillsCount: 0,
          grossSalesPaise: 0,
          discountPaise: 0,
          gstPaise: 0,
          collectedPaise: 0,
          refundedPaise: 0,
          netRevenuePaise: 0,
        });
      }

      const sixMonthsAgo = new Date(now.getTime() - 190 * 86400000);

      const [bills, attempts, refunds] = await Promise.all([
        tx.bill.findMany({
          where: { outletId: ctx.outletId },
          select: {
            id: true,
            status: true,
            subtotalPaise: true,
            discountPaise: true,
            cgstPaise: true,
            sgstPaise: true,
            totalPaise: true,
            paidPaise: true,
            refundedPaise: true,
            finalizedAt: true,
          },
        }),
        tx.paymentAttempt.findMany({
          where: {
            outletId: ctx.outletId,
            status: PrismaPaymentStatus.SUCCEEDED,
            createdAt: { gte: sixMonthsAgo },
          },
          select: {
            method: true,
            provider: true,
            amountPaise: true,
            completedAt: true,
            createdAt: true,
          },
        }),
        tx.refund.findMany({
          where: {
            bill: { outletId: ctx.outletId },
            status: PrismaRefundStatus.SUCCEEDED,
            createdAt: { gte: sixMonthsAgo },
          },
          select: {
            amountPaise: true,
            processedAt: true,
            createdAt: true,
          },
        }),
      ]);

      let pendingPaymentsPaise = 0;
      let pendingBillsCount = 0;
      let openBillsCount = 0;
      let partialBillsCount = 0;
      let voidedBillsCount = 0;
      let totalPaidBillsCount = 0;
      let totalNetCollectedPaise = 0;

      let todaySalesPaise = 0;
      let todayGstPaise = 0;
      let todayCompletedBills = 0;

      const addBillToBucket = (
        bucket: BillingPeriodBucketDto | undefined,
        bill: (typeof bills)[number],
      ) => {
        if (!bucket) return;
        bucket.billsCount += 1;
        if (bill.status === PrismaBillStatus.PAID) {
          bucket.completedBillsCount += 1;
        }
        bucket.grossSalesPaise += bill.totalPaise;
        bucket.discountPaise += bill.discountPaise;
        bucket.gstPaise += bill.cgstPaise + bill.sgstPaise;
      };

      for (const bill of bills) {
        if (bill.status === PrismaBillStatus.VOID) {
          voidedBillsCount += 1;
          continue;
        }

        const netPaid = Math.max(0, bill.paidPaise - bill.refundedPaise);
        const due = Math.max(0, bill.totalPaise - netPaid);
        totalNetCollectedPaise += netPaid;

        if (bill.status === PrismaBillStatus.PAID) {
          totalPaidBillsCount += 1;
        } else if (bill.status === PrismaBillStatus.PARTIALLY_PAID) {
          partialBillsCount += 1;
          pendingBillsCount += 1;
          pendingPaymentsPaise += due;
        } else if (bill.status === PrismaBillStatus.OPEN) {
          openBillsCount += 1;
          pendingBillsCount += 1;
          pendingPaymentsPaise += due;
        }

        const ymd = formatYmd(bill.finalizedAt);
        const wKey = getWeekStartYmd(ymd);
        const mKey = ymd.slice(0, 7);

        addBillToBucket(dailyMap.get(ymd), bill);
        addBillToBucket(weeklyMap.get(wKey), bill);
        addBillToBucket(monthlyMap.get(mKey), bill);

        if (ymd === todayKey) {
          todaySalesPaise += bill.totalPaise;
          todayGstPaise += bill.cgstPaise + bill.sgstPaise;
          if (bill.status === PrismaBillStatus.PAID) {
            todayCompletedBills += 1;
          }
        }
      }

      let todayCash = 0;
      let todayUpiManual = 0;
      let todayRazorpay = 0;
      let todayCard = 0;

      for (const p of attempts) {
        const ts = p.completedAt ?? p.createdAt;
        const ymd = formatYmd(ts);
        const wKey = getWeekStartYmd(ymd);
        const mKey = ymd.slice(0, 7);

        for (const bucket of [dailyMap.get(ymd), weeklyMap.get(wKey), monthlyMap.get(mKey)]) {
          if (bucket) {
            bucket.collectedPaise += p.amountPaise;
            bucket.netRevenuePaise += p.amountPaise;
          }
        }

        if (ymd === todayKey) {
          if (p.method === 'CASH') {
            todayCash += p.amountPaise;
          } else if (p.method === 'CARD') {
            todayCard += p.amountPaise;
          } else if (p.method === 'UPI_MANUAL') {
            todayUpiManual += p.amountPaise;
          } else {
            todayRazorpay += p.amountPaise;
          }
        }
      }

      let refundedTodayPaise = 0;
      for (const r of refunds) {
        const ts = r.processedAt ?? r.createdAt;
        const ymd = formatYmd(ts);
        const wKey = getWeekStartYmd(ymd);
        const mKey = ymd.slice(0, 7);

        for (const bucket of [dailyMap.get(ymd), weeklyMap.get(wKey), monthlyMap.get(mKey)]) {
          if (bucket) {
            bucket.refundedPaise += r.amountPaise;
            bucket.netRevenuePaise = Math.max(0, bucket.collectedPaise - bucket.refundedPaise);
          }
        }

        if (ymd === todayKey) {
          refundedTodayPaise += r.amountPaise;
        }
      }

      const todayCollectedNet = Math.max(
        0,
        todayCash + todayUpiManual + todayRazorpay + todayCard - refundedTodayPaise,
      );

      return {
        timezone,
        generatedAt: now.toISOString(),
        today: {
          dateKey: todayKey,
          totalSalesPaise: todaySalesPaise,
          collectedNetPaise: todayCollectedNet,
          cashCollectedPaise: todayCash,
          upiCollectedPaise: todayUpiManual + todayRazorpay,
          upiManualPaise: todayUpiManual,
          razorpayOnlinePaise: todayRazorpay,
          cardCollectedPaise: todayCard,
          pendingPaymentsPaise,
          pendingBillsCount,
          gstCollectedPaise: todayGstPaise,
          completedBillsCount: todayCompletedBills,
          openBillsCount,
          partialBillsCount,
          voidedBillsCount,
          refundedTodayPaise,
        },
        allTime: {
          totalPaidBillsCount,
          totalNetCollectedPaise,
          totalPendingDuePaise: pendingPaymentsPaise,
        },
        daily: Array.from(dailyMap.values()),
        weekly: Array.from(weeklyMap.values()),
        monthly: Array.from(monthlyMap.values()),
      };
    }, ctx.tenantId);
  }

  async buildBillReceiptPdf(
    principal: AuthenticatedPrincipal,
    billId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const bill = await this.getBill(principal, billId);
    const buffer = await this.receiptPdfService.buildReceiptPdf(bill);
    return { buffer, filename: `${bill.billNumber}.pdf` };
  }

  async buildCustomerReceiptPdf(
    rawToken: string,
    rawGuestToken?: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const { bill } = await this.getCustomerBill(rawToken, rawGuestToken);
    if (!bill) {
      throw new NotFoundException({
        code: ErrorCode.BILL_NOT_FOUND,
        message: 'No finalized bill found for this dining session.',
      });
    }
    const buffer = await this.receiptPdfService.buildReceiptPdf(bill);
    return { buffer, filename: `${bill.billNumber}.pdf` };
  }
}

