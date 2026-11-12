import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  BillLineType,
  BillStatus,
  BillSummaryDto,
  BillingOutboxTopic,
  calculateBillTotalsPaise,
  computeBillPaymentProgress,
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
  Prisma,
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
    lines: bill.lines.map((line) => ({
      id: line.id,
      orderItemId: line.orderItemId,
      lineType: line.lineType as unknown as BillLineType,
      description: line.description,
      quantity: line.quantity,
      unitAmountPaise: line.unitAmountPaise,
      lineAmountPaise: line.lineAmountPaise,
    })),
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
      discountReason?: string;
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
      return { bill: serializeBillSummary(existingBill), alreadyExisted: true };
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
    const discountPaise = params.discountPaise ?? 0;

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
            discountReason: dto.discountReason,
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
      if (dto.discountPaise > bill.subtotalPaise) {
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
        discountPaise: dto.discountPaise,
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
        await tx.diningSession.update({
          where: { id: bill.sessionId },
          data: {
            status: PrismaDiningSessionStatus.SETTLED,
            settledAt: now,
            settledByMembershipId: ctx.membershipId ?? null,
          },
        });
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

