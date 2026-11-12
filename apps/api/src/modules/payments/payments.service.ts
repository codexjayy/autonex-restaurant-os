import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  BillStatus,
  computeBillPaymentProgress,
  ErrorCode,
  StaffRole,
} from '@autonex/shared';
import {
  BillStatus as PrismaBillStatus,
  DiningSessionStatus as PrismaDiningSessionStatus,
  GuestJoinStatus as PrismaGuestJoinStatus,
  KitchenStatus as PrismaKitchenStatus,
  OrderItemStatus as PrismaOrderItemStatus,
  OutboxStatus as PrismaOutboxStatus,
  PaymentMethod as PrismaPaymentMethod,
  PaymentProvider as PrismaPaymentProvider,
  PaymentStatus as PrismaPaymentStatus,
  Prisma,
  RefundStatus as PrismaRefundStatus,
  TableStatus as PrismaTableStatus,
  WebhookStatus as PrismaWebhookStatus,
} from '@prisma/client';
import { TenantContextService } from '../../common/context/tenant-context.service';
import {
  AuthenticatedPrincipal,
  requireOutletContext,
} from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { sha256Hex } from '../../common/security/crypto.util';
import { BillingService } from '../billing/billing.service';
import { TablesService } from '../tables/tables.service';
import {
  CreateRazorpayOrderDto,
  CreateRefundDto,
  RecordManualPaymentDto,
  ReportPaymentFailureDto,
  VerifyRazorpayPaymentDto,
} from './dto/payments.dto';
import { RazorpayClientService } from './razorpay-client.service';

const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9_.:-]{8,120}$/;

const PAYMENT_STAFF_ROLES = new Set<string>([
  StaffRole.OWNER,
  StaffRole.MANAGER,
  StaffRole.CASHIER,
]);

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly tablesService: TablesService,
    private readonly billingService: BillingService,
    private readonly razorpayClient: RazorpayClientService,
  ) {}

  private assertIdempotencyKey(rawKey?: string): string {
    const key = rawKey?.trim();
    if (!key || !IDEMPOTENCY_KEY_REGEX.test(key)) {
      throw new BadRequestException({
        code: ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
        message: 'A valid Idempotency-Key header (8-120 alphanumeric chars) is required.',
      });
    }
    return key;
  }

  private async emitPaymentOutbox(
    tx: Prisma.TransactionClient,
    params: {
      tenantId: string;
      outletId: string;
      topic: 'payment.succeeded' | 'payment.failed' | 'refund.processed' | 'session.updated';
      aggregateType: string;
      aggregateId: string;
      payload: Record<string, unknown>;
    },
  ) {
    await tx.outboxEvent.create({
      data: {
        tenantId: params.tenantId,
        topic: params.topic,
        aggregateType: params.aggregateType,
        aggregateId: params.aggregateId,
        payloadJson: {
          tenantId: params.tenantId,
          outletId: params.outletId,
          ...params.payload,
        } as Prisma.InputJsonValue,
        status: PrismaOutboxStatus.PENDING,
      },
    });
  }

  /**
   * Core idempotent payment capture & allocation ledger writer.
   * Ensures partial splits accumulate cleanly, late webhooks after manual counter settlement
   * never double-count paid balances, and full settlement moves the DiningSession to SETTLED.
   */
  async applyPaymentSuccessTx(
    tx: Prisma.TransactionClient,
    params: {
      tenantId: string;
      outletId: string;
      attemptId: string;
      gatewayPaymentId?: string;
      receiptRef?: string;
      confirmedByMembershipId?: string | null;
      actorUserId: string;
      actorRole: string;
      ipAddress: string | null;
    },
  ) {
    const attempt = await tx.paymentAttempt.findFirst({
      where: { id: params.attemptId },
      include: {
        bill: {
          include: {
            session: { select: { id: true, status: true, tableId: true } },
          },
        },
      },
    });

    if (!attempt) {
      throw new NotFoundException({
        code: ErrorCode.NOT_FOUND,
        message: 'Payment attempt not found.',
      });
    }

    if (attempt.status === PrismaPaymentStatus.SUCCEEDED) {
      return { attempt, idempotentReplay: true, lateWebhookOverpayment: false };
    }

    if (params.gatewayPaymentId) {
      const existingByGatewayId = await tx.paymentAttempt.findFirst({
        where: { gatewayPaymentId: params.gatewayPaymentId },
      });
      if (existingByGatewayId && existingByGatewayId.id !== attempt.id) {
        return { attempt: existingByGatewayId, idempotentReplay: true, lateWebhookOverpayment: false };
      }
    }

    const bill = attempt.bill;
    const now = new Date();
    const currentNetPaid = Math.max(0, bill.paidPaise - bill.refundedPaise);
    const currentDue = Math.max(0, bill.totalPaise - currentNetPaid);

    // Handle edge case where bill was already voided or paid manually while webhook lagged
    if (bill.status === PrismaBillStatus.VOID || currentDue === 0) {
      const updatedAttempt = await tx.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          status: PrismaPaymentStatus.SUCCEEDED,
          ...(params.gatewayPaymentId ? { gatewayPaymentId: params.gatewayPaymentId } : {}),
          ...(params.receiptRef ? { receiptRef: params.receiptRef } : {}),
          confirmedByMembershipId: params.confirmedByMembershipId ?? null,
          completedAt: now,
          failureReason:
            bill.status === PrismaBillStatus.VOID
              ? 'Late capture on VOID bill — refund required'
              : 'Late gateway capture after bill already paid manually — refund review needed',
        },
      });

      await tx.auditLog.create({
        data: {
          tenantId: params.tenantId,
          actorUserId: params.actorUserId,
          actorRole: params.actorRole,
          action: 'PAYMENT_LATE_WEBHOOK_RECONCILED',
          entityType: 'PaymentAttempt',
          entityId: updatedAttempt.id,
          afterJson: {
            billId: bill.id,
            billNumber: bill.billNumber,
            billStatus: bill.status,
            amountPaise: attempt.amountPaise,
            gatewayPaymentId: params.gatewayPaymentId ?? null,
          },
          ipAddress: params.ipAddress,
        },
      });

      await this.emitPaymentOutbox(tx, {
        tenantId: params.tenantId,
        outletId: params.outletId,
        topic: 'payment.succeeded',
        aggregateType: 'Bill',
        aggregateId: bill.id,
        payload: {
          billId: bill.id,
          sessionId: bill.sessionId,
          tableId: bill.session.tableId,
          lateWebhookNeedsRefundReview: true,
        },
      });

      return { attempt: updatedAttempt, idempotentReplay: false, lateWebhookOverpayment: true };
    }

    const allocatedPaise = Math.min(attempt.amountPaise, currentDue);

    const updatedAttempt = await tx.paymentAttempt.update({
      where: { id: attempt.id },
      data: {
        status: PrismaPaymentStatus.SUCCEEDED,
        ...(params.gatewayPaymentId ? { gatewayPaymentId: params.gatewayPaymentId } : {}),
        ...(params.receiptRef ? { receiptRef: params.receiptRef } : {}),
        confirmedByMembershipId: params.confirmedByMembershipId ?? null,
        failureReason: null,
        completedAt: now,
      },
    });

    await tx.paymentAllocation.create({
      data: {
        tenantId: params.tenantId,
        paymentAttemptId: updatedAttempt.id,
        billId: bill.id,
        allocatedPaise,
      },
    });

    const nextPaidPaise = bill.paidPaise + allocatedPaise;
    const progress = computeBillPaymentProgress({
      totalPaise: bill.totalPaise,
      succeededAllocatedPaise: nextPaidPaise,
      refundedPaise: bill.refundedPaise,
    });

    await tx.bill.update({
      where: { id: bill.id },
      data: {
        paidPaise: nextPaidPaise,
        status: progress.status as unknown as PrismaBillStatus,
        paidAt: progress.status === BillStatus.PAID ? now : bill.paidAt,
      },
    });

    if (
      progress.status === BillStatus.PAID &&
      bill.session.status !== PrismaDiningSessionStatus.CLOSED
    ) {
      let unbilledActiveItemsCount = 0;
      if (tx.orderItem?.count) {
        const billedItemIds = await tx.billLine
          ?.findMany?.({
            where: { billId: bill.id, orderItemId: { not: null } },
            select: { orderItemId: true },
          })
          .then((rows) => rows.map((r) => r.orderItemId).filter((id): id is string => Boolean(id)))
          .catch(() => []);

        unbilledActiveItemsCount = await tx.orderItem.count({
          where: {
            status: PrismaOrderItemStatus.ACTIVE,
            quantity: { gt: 0 },
            ...(billedItemIds && billedItemIds.length > 0 ? { id: { notIn: billedItemIds } } : {}),
            order: {
              sessionId: bill.sessionId,
              kitchenStatus: { not: PrismaKitchenStatus.CANCELLED },
            },
          },
        });
      }

      if (unbilledActiveItemsCount === 0 && bill.session.status !== PrismaDiningSessionStatus.SETTLED) {
        await tx.diningSession.update({
          where: { id: bill.sessionId },
          data: {
            status: PrismaDiningSessionStatus.SETTLED,
            settledAt: now,
            settledByMembershipId: params.confirmedByMembershipId ?? null,
          },
        });

        await tx.restaurantTable?.update?.({
          where: { id: bill.session.tableId },
          data: { status: PrismaTableStatus.AVAILABLE },
        });

        await this.emitPaymentOutbox(tx, {
          tenantId: params.tenantId,
          outletId: params.outletId,
          topic: 'session.updated',
          aggregateType: 'DiningSession',
          aggregateId: bill.sessionId,
          payload: {
            sessionId: bill.sessionId,
            tableId: bill.session.tableId,
            status: PrismaDiningSessionStatus.SETTLED,
            tableStatus: PrismaTableStatus.AVAILABLE,
            lifecycleStage: 'SETTLED',
            action: 'payment_settled',
          },
        });
      }
    }

    await tx.auditLog.create({
      data: {
        tenantId: params.tenantId,
        actorUserId: params.actorUserId,
        actorRole: params.actorRole,
        action: 'PAYMENT_ALLOCATED_SUCCEEDED',
        entityType: 'PaymentAttempt',
        entityId: updatedAttempt.id,
        afterJson: {
          billId: bill.id,
          billNumber: bill.billNumber,
          method: updatedAttempt.method,
          provider: updatedAttempt.provider,
          allocatedPaise,
          billStatusAfter: progress.status,
          duePaiseAfter: progress.duePaise,
        },
        ipAddress: params.ipAddress,
      },
    });

    await this.emitPaymentOutbox(tx, {
      tenantId: params.tenantId,
      outletId: params.outletId,
      topic: 'payment.succeeded',
      aggregateType: 'Bill',
      aggregateId: bill.id,
      payload: {
        billId: bill.id,
        sessionId: bill.sessionId,
        tableId: bill.session.tableId,
        paymentAttemptId: updatedAttempt.id,
        status: progress.status,
        allocatedPaise,
        duePaise: progress.duePaise,
      },
    });

    return { attempt: updatedAttempt, idempotentReplay: false, lateWebhookOverpayment: false };
  }

  /**
   * Marks a failed payment attempt.
   * CRITICAL INVARIANT: Payment failure NEVER settles or closes the DiningSession.
   */
  async applyPaymentFailureTx(
    tx: Prisma.TransactionClient,
    params: {
      tenantId: string;
      outletId: string;
      attemptId: string;
      failureReason: string;
      actorUserId: string;
      actorRole: string;
      ipAddress: string | null;
    },
  ) {
    const attempt = await tx.paymentAttempt.findFirst({
      where: { id: params.attemptId },
      include: {
        bill: {
          include: { session: { select: { id: true, tableId: true } } },
        },
      },
    });
    if (!attempt || attempt.status === PrismaPaymentStatus.SUCCEEDED) {
      return attempt;
    }

    const updated = await tx.paymentAttempt.update({
      where: { id: attempt.id },
      data: {
        status: PrismaPaymentStatus.FAILED,
        failureReason: params.failureReason.slice(0, 240),
        completedAt: new Date(),
      },
    });

    await tx.auditLog.create({
      data: {
        tenantId: params.tenantId,
        actorUserId: params.actorUserId,
        actorRole: params.actorRole,
        action: 'PAYMENT_ATTEMPT_FAILED',
        entityType: 'PaymentAttempt',
        entityId: attempt.id,
        afterJson: {
          billId: attempt.billId,
          reason: params.failureReason.slice(0, 240),
        },
        ipAddress: params.ipAddress,
      },
    });

    await this.emitPaymentOutbox(tx, {
      tenantId: params.tenantId,
      outletId: params.outletId,
      topic: 'payment.failed',
      aggregateType: 'Bill',
      aggregateId: attempt.billId,
      payload: {
        billId: attempt.billId,
        sessionId: attempt.bill.sessionId,
        tableId: attempt.bill.session.tableId,
        paymentAttemptId: attempt.id,
        status: PrismaPaymentStatus.FAILED,
        failureReason: params.failureReason.slice(0, 240),
      },
    });

    return updated;
  }

  async recordManualPayment(
    principal: AuthenticatedPrincipal,
    billId: string,
    dto: RecordManualPaymentDto,
    rawIdempotencyKey?: string,
  ) {
    const ctx = requireOutletContext(principal);
    if (!PAYMENT_STAFF_ROLES.has(ctx.role)) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Only Owner, Manager, or Cashier can record counter payments.',
      });
    }
    const idempotencyKey = this.assertIdempotencyKey(rawIdempotencyKey);
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    try {
      const txResult = await this.prisma.runInTenantTx(async (tx) => {
        const existingIdem = await tx.paymentAttempt.findFirst({
          where: { idempotencyKey },
        });
        if (existingIdem) {
          if (existingIdem.billId !== billId) {
            throw new ConflictException({
              code: ErrorCode.CONFLICT,
              message: 'Idempotency-Key was already used for another bill.',
            });
          }
          return {
            attempt: existingIdem,
            billId,
            idempotentReplay: true,
          };
        }

        const bill = await tx.bill.findFirst({
          where: { id: billId, outletId: ctx.outletId },
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
            message: 'Cannot accept payment on a voided bill.',
          });
        }

        const netPaid = Math.max(0, bill.paidPaise - bill.refundedPaise);
        const duePaise = Math.max(0, bill.totalPaise - netPaid);
        if (duePaise <= 0 || bill.status === PrismaBillStatus.PAID) {
          throw new ConflictException({
            code: ErrorCode.BILL_ALREADY_PAID,
            message: 'Bill has already been paid in full.',
          });
        }

        const amountPaise = dto.amountPaise ?? duePaise;
        if (amountPaise > duePaise) {
          throw new BadRequestException({
            code: ErrorCode.PAYMENT_EXCEEDS_DUE,
            message: `Payment amount (${amountPaise} paise) exceeds balance due (${duePaise} paise).`,
          });
        }

        const created = await tx.paymentAttempt.create({
          data: {
            tenantId: ctx.tenantId,
            outletId: ctx.outletId,
            billId: bill.id,
            method: dto.method as PrismaPaymentMethod,
            provider: PrismaPaymentProvider.MANUAL,
            amountPaise,
            status: PrismaPaymentStatus.INITIATED,
            idempotencyKey,
            receiptRef: dto.receiptRef?.trim() || null,
          },
        });

        const result = await this.applyPaymentSuccessTx(tx, {
          tenantId: ctx.tenantId,
          outletId: ctx.outletId,
          attemptId: created.id,
          receiptRef: dto.receiptRef?.trim() || undefined,
          confirmedByMembershipId: ctx.membershipId ?? null,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          ipAddress,
        });

        return {
          attempt: result.attempt,
          billId: bill.id,
          idempotentReplay: result.idempotentReplay,
        };
      }, ctx.tenantId);

      const updatedBill = await this.billingService.getBill(principal, txResult.billId);
      return {
        attempt: txResult.attempt,
        bill: updatedBill,
        idempotentReplay: txResult.idempotentReplay,
      };
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') {
        const bill = await this.billingService.getBill(principal, billId);
        return { attempt: null, bill, idempotentReplay: true };
      }
      throw err;
    }
  }

  private async initiateGatewayOrderTx(params: {
    tenantId: string;
    outletId: string;
    billId: string;
    requestedAmountPaise?: number;
    idempotencyKey: string;
    actorUserId: string;
    actorRole: string;
  }) {
    const precheck = await this.prisma.runInTenantTx(async (tx) => {
      const existing = await tx.paymentAttempt.findFirst({
        where: { idempotencyKey: params.idempotencyKey },
      });
      if (existing) {
        if (existing.billId !== params.billId) {
          throw new ConflictException({
            code: ErrorCode.CONFLICT,
            message: 'Idempotency-Key was already used on a different bill.',
          });
        }
        return { replay: existing, bill: null, amountPaise: existing.amountPaise };
      }

      const bill = await tx.bill.findFirst({
        where: { id: params.billId, outletId: params.outletId },
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
          message: 'Voided bill cannot accept online payments.',
        });
      }

      const duePaise = Math.max(0, bill.totalPaise - Math.max(0, bill.paidPaise - bill.refundedPaise));
      if (duePaise <= 0 || bill.status === PrismaBillStatus.PAID) {
        throw new ConflictException({
          code: ErrorCode.BILL_ALREADY_PAID,
          message: 'Bill has already been settled in full.',
        });
      }

      const amountPaise = params.requestedAmountPaise ?? duePaise;
      if (amountPaise > duePaise) {
        throw new BadRequestException({
          code: ErrorCode.PAYMENT_EXCEEDS_DUE,
          message: `Requested amount (${amountPaise} paise) exceeds balance due (${duePaise} paise).`,
        });
      }

      const attempt = await tx.paymentAttempt.create({
        data: {
          tenantId: params.tenantId,
          outletId: params.outletId,
          billId: bill.id,
          method: PrismaPaymentMethod.UPI_GATEWAY,
          provider: PrismaPaymentProvider.RAZORPAY,
          amountPaise,
          status: PrismaPaymentStatus.INITIATED,
          idempotencyKey: params.idempotencyKey,
        },
      });

      return { replay: null, attempt, bill, amountPaise };
    }, params.tenantId);

    if (precheck.replay) {
      return {
        attemptId: precheck.replay.id,
        gatewayOrderId: precheck.replay.gatewayOrderId,
        keyId: undefined,
        amountPaise: precheck.replay.amountPaise,
        currency: 'INR' as const,
        qrPayloadUrl: precheck.replay.qrPayloadUrl,
        isMock: this.razorpayClient.getMockModeFlag(),
        idempotentReplay: true,
      };
    }

    let orderRes;
    try {
      orderRes = await this.razorpayClient.createOrder({
        amountPaise: precheck.amountPaise,
        receipt: precheck.bill!.billNumber,
        notes: {
          tenantId: params.tenantId,
          billId: params.billId,
          attemptId: precheck.attempt!.id,
        },
      });
    } catch (err) {
      await this.prisma.runInTenantTx(
        (tx) =>
          this.applyPaymentFailureTx(tx, {
            tenantId: params.tenantId,
            outletId: params.outletId,
            attemptId: precheck.attempt!.id,
            failureReason: err instanceof Error ? err.message : 'Razorpay order creation failed',
            actorUserId: params.actorUserId,
            actorRole: params.actorRole,
            ipAddress: null,
          }),
        params.tenantId,
      );
      throw err;
    }

    const updated = await this.prisma.runInTenantTx(async (tx) => {
      return tx.paymentAttempt.update({
        where: { id: precheck.attempt!.id },
        data: {
          status: PrismaPaymentStatus.PENDING,
          gatewayOrderId: orderRes.gatewayOrderId,
          qrPayloadUrl: orderRes.qrPayloadUrl,
        },
      });
    }, params.tenantId);

    const mockSamplePaymentId = orderRes.isMock ? `pay_mock_${randomBytes(6).toString('hex')}` : undefined;
    const mockSampleSignature =
      orderRes.isMock && mockSamplePaymentId
        ? this.razorpayClient.computeMockCheckoutSignature(
            orderRes.gatewayOrderId,
            mockSamplePaymentId,
          )
        : undefined;

    return {
      attemptId: updated.id,
      billId: params.billId,
      gatewayOrderId: orderRes.gatewayOrderId,
      keyId: orderRes.keyId,
      amountPaise: orderRes.amountPaise,
      currency: orderRes.currency,
      qrPayloadUrl: orderRes.qrPayloadUrl,
      isMock: orderRes.isMock,
      mockCheckoutHint: orderRes.isMock
        ? {
            razorpayOrderId: orderRes.gatewayOrderId,
            razorpayPaymentId: mockSamplePaymentId,
            razorpaySignature: mockSampleSignature,
          }
        : undefined,
      idempotentReplay: false,
    };
  }

  async createRazorpayOrder(
    principal: AuthenticatedPrincipal,
    billId: string,
    dto: CreateRazorpayOrderDto,
    rawIdempotencyKey?: string,
  ) {
    const ctx = requireOutletContext(principal);
    if (!PAYMENT_STAFF_ROLES.has(ctx.role)) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Only Owner, Manager, or Cashier can initiate online payments.',
      });
    }
    const idempotencyKey = this.assertIdempotencyKey(rawIdempotencyKey);

    return this.initiateGatewayOrderTx({
      tenantId: ctx.tenantId,
      outletId: ctx.outletId,
      billId,
      requestedAmountPaise: dto.amountPaise,
      idempotencyKey,
      actorUserId: ctx.userId,
      actorRole: ctx.role,
    });
  }

  private async resolveApprovedCustomerBill(rawToken: string, rawGuestToken?: string) {
    if (!rawGuestToken || rawGuestToken.trim().length < 20) {
      throw new UnauthorizedException({
        code: ErrorCode.UNAUTHORIZED,
        message: 'Valid guest session token is required.',
      });
    }
    const resolved = await this.tablesService.verifyQrTokenAndGetTable(rawToken);
    const guestHash = sha256Hex(rawGuestToken.trim());

    const lookup = await this.prisma.runInTenantTx(async (tx) => {
      const session = await tx.diningSession.findFirst({
        where: {
          tableId: resolved.table_id,
          status: { not: PrismaDiningSessionStatus.CLOSED },
        },
      });
      if (!session) {
        throw new ConflictException({
          code: ErrorCode.SESSION_NOT_ACTIVE,
          message: 'No active dining session on this table.',
        });
      }

      const guest = await tx.sessionGuest.findFirst({
        where: { sessionId: session.id, guestTokenHash: guestHash },
      });
      if (!guest || guest.status !== PrismaGuestJoinStatus.APPROVED) {
        throw new ForbiddenException({
          code: ErrorCode.GUEST_NOT_APPROVED,
          message: 'Only approved guests can complete online payment.',
        });
      }

      const bill = await tx.bill.findFirst({
        where: { sessionId: session.id, status: { not: PrismaBillStatus.VOID } },
      });
      return { session, guest, bill };
    }, resolved.tenant_id);

    if (!lookup.bill) {
      const generated = await this.billingService.generateOrGetCustomerBill(rawToken, rawGuestToken);
      return {
        tenantId: resolved.tenant_id,
        outletId: resolved.outlet_id,
        guestId: lookup.guest.id,
        billId: generated.bill.id,
      };
    }

    return {
      tenantId: resolved.tenant_id,
      outletId: resolved.outlet_id,
      guestId: lookup.guest.id,
      billId: lookup.bill.id,
    };
  }

  async createCustomerRazorpayOrder(
    rawToken: string,
    rawGuestToken: string | undefined,
    dto: CreateRazorpayOrderDto,
    rawIdempotencyKey?: string,
  ) {
    const idempotencyKey = this.assertIdempotencyKey(rawIdempotencyKey);
    const ctx = await this.resolveApprovedCustomerBill(rawToken, rawGuestToken);

    return this.initiateGatewayOrderTx({
      tenantId: ctx.tenantId,
      outletId: ctx.outletId,
      billId: ctx.billId,
      requestedAmountPaise: dto.amountPaise,
      idempotencyKey,
      actorUserId: ctx.guestId,
      actorRole: 'GUEST',
    });
  }

  private async verifyGatewayCheckoutInternal(params: {
    tenantId: string;
    outletId: string;
    dto: VerifyRazorpayPaymentDto;
    actorUserId: string;
    actorRole: string;
    confirmedByMembershipId?: string | null;
  }) {
    const sigOk = this.razorpayClient.verifyCheckoutSignature(
      params.dto.razorpayOrderId,
      params.dto.razorpayPaymentId,
      params.dto.razorpaySignature,
    );
    if (!sigOk) {
      throw new ForbiddenException({
        code: ErrorCode.INVALID_WEBHOOK_SIGNATURE,
        message: 'Invalid Razorpay payment signature.',
      });
    }

    return this.prisma.runInTenantTx(async (tx) => {
      const attempt = await tx.paymentAttempt.findFirst({
        where: {
          gatewayOrderId: params.dto.razorpayOrderId,
          outletId: params.outletId,
        },
      });
      if (!attempt) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Payment attempt for Razorpay order not found.',
        });
      }

      return this.applyPaymentSuccessTx(tx, {
        tenantId: params.tenantId,
        outletId: params.outletId,
        attemptId: attempt.id,
        gatewayPaymentId: params.dto.razorpayPaymentId,
        receiptRef: params.dto.razorpayPaymentId,
        confirmedByMembershipId: params.confirmedByMembershipId ?? null,
        actorUserId: params.actorUserId,
        actorRole: params.actorRole,
        ipAddress: null,
      });
    }, params.tenantId);
  }

  async verifyRazorpayPayment(principal: AuthenticatedPrincipal, dto: VerifyRazorpayPaymentDto) {
    const ctx = requireOutletContext(principal);
    return this.verifyGatewayCheckoutInternal({
      tenantId: ctx.tenantId,
      outletId: ctx.outletId,
      dto,
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      confirmedByMembershipId: ctx.membershipId ?? null,
    });
  }

  async verifyCustomerRazorpayPayment(
    rawToken: string,
    rawGuestToken: string | undefined,
    dto: VerifyRazorpayPaymentDto,
  ) {
    const ctx = await this.resolveApprovedCustomerBill(rawToken, rawGuestToken);
    return this.verifyGatewayCheckoutInternal({
      tenantId: ctx.tenantId,
      outletId: ctx.outletId,
      dto,
      actorUserId: ctx.guestId,
      actorRole: 'GUEST',
      confirmedByMembershipId: null,
    });
  }

  async reportCustomerPaymentFailure(
    rawToken: string,
    rawGuestToken: string | undefined,
    dto: ReportPaymentFailureDto,
  ) {
    const ctx = await this.resolveApprovedCustomerBill(rawToken, rawGuestToken);
    return this.prisma.runInTenantTx(async (tx) => {
      const attempt = await tx.paymentAttempt.findFirst({
        where: { gatewayOrderId: dto.razorpayOrderId, billId: ctx.billId },
      });
      if (!attempt) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Payment attempt not found.',
        });
      }
      return this.applyPaymentFailureTx(tx, {
        tenantId: ctx.tenantId,
        outletId: ctx.outletId,
        attemptId: attempt.id,
        failureReason: dto.reason?.trim() || 'Customer cancelled or payment declined',
        actorUserId: ctx.guestId,
        actorRole: 'GUEST',
        ipAddress: null,
      });
    }, ctx.tenantId);
  }

  /**
   * Authoritative Razorpay Webhook ingestion:
   * - Validates HMAC-SHA256 strictly over raw request bytes (`rawBody`).
   * - Deduplicates replays atomically via `webhook_events(provider, provider_event_id)`.
   * - Reconciles `payment.captured`, `order.paid`, `payment.failed`, and `refund.processed`.
   */
  async handleRazorpayWebhook(params: {
    rawBody: Buffer | undefined;
    signatureHeader?: string;
    eventIdHeader?: string;
  }): Promise<{ received: true; duplicate?: boolean; status: string }> {
    const rawBody = params.rawBody;
    if (!rawBody || rawBody.length === 0) {
      throw new UnauthorizedException({
        code: ErrorCode.INVALID_WEBHOOK_SIGNATURE,
        message: 'Raw webhook body is required for signature verification.',
      });
    }

    const parsedPayload = (() => {
      try {
        return JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
      } catch {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_ERROR,
          message: 'Malformed JSON webhook payload.',
        });
      }
    })();

    const signatureValid = this.razorpayClient.verifyWebhookSignature(
      rawBody,
      params.signatureHeader,
    );

    const eventType =
      typeof parsedPayload.event === 'string' ? parsedPayload.event : 'unknown';
    const paymentEntity = (
      parsedPayload.payload as {
        payment?: { entity?: Record<string, unknown> };
        order?: { entity?: Record<string, unknown> };
        refund?: { entity?: Record<string, unknown> };
      } | undefined
    )?.payment?.entity;
    const orderEntity = (
      parsedPayload.payload as { order?: { entity?: Record<string, unknown> } } | undefined
    )?.order?.entity;
    const refundEntity = (
      parsedPayload.payload as { refund?: { entity?: Record<string, unknown> } } | undefined
    )?.refund?.entity;

    const gatewayOrderId =
      (typeof paymentEntity?.order_id === 'string' && paymentEntity.order_id) ||
      (typeof orderEntity?.id === 'string' && orderEntity.id) ||
      null;
    const gatewayPaymentId =
      typeof paymentEntity?.id === 'string' ? paymentEntity.id : null;
    const gatewayRefundId =
      typeof refundEntity?.id === 'string' ? refundEntity.id : null;

    const providerEventId =
      params.eventIdHeader?.trim() ||
      `${eventType}:${gatewayPaymentId ?? gatewayRefundId ?? gatewayOrderId ?? sha256Hex(rawBody.toString('utf8')).slice(0, 24)}`;

    if (!signatureValid) {
      await this.prisma.runAsSystemAdmin(async (adminDb) => {
        const existing = await adminDb.webhookEvent.findFirst({
          where: { provider: 'RAZORPAY', providerEventId },
        });
        if (!existing) {
          await adminDb.webhookEvent.create({
            data: {
              provider: 'RAZORPAY',
              providerEventId,
              eventType,
              payloadJson: parsedPayload as Prisma.InputJsonValue,
              signatureValid: false,
              status: PrismaWebhookStatus.FAILED,
              errorMessage: 'Invalid X-Razorpay-Signature',
            },
          });
        }
      });

      throw new UnauthorizedException({
        code: ErrorCode.INVALID_WEBHOOK_SIGNATURE,
        message: 'Invalid Razorpay webhook signature.',
      });
    }

    // Deduplicate & resolve owning tenant
    const prep = await this.prisma.runAsSystemAdmin(async (adminDb) => {
      const existingEvent = await adminDb.webhookEvent.findFirst({
        where: { provider: 'RAZORPAY', providerEventId },
      });
      if (
        existingEvent &&
        (existingEvent.status === PrismaWebhookStatus.PROCESSED ||
          existingEvent.status === PrismaWebhookStatus.IGNORED)
      ) {
        return { duplicate: true as const, eventRowId: existingEvent.id, attempt: null };
      }

      const attempt = gatewayOrderId
        ? await adminDb.paymentAttempt.findFirst({
            where: { gatewayOrderId },
          })
        : gatewayPaymentId
          ? await adminDb.paymentAttempt.findFirst({
              where: { gatewayPaymentId },
            })
          : null;

      const eventRow =
        existingEvent ??
        (await adminDb.webhookEvent.create({
          data: {
            tenantId: attempt?.tenantId ?? null,
            provider: 'RAZORPAY',
            providerEventId,
            eventType,
            payloadJson: parsedPayload as Prisma.InputJsonValue,
            signatureValid: true,
            status: PrismaWebhookStatus.RECEIVED,
          },
        }));

      return { duplicate: false as const, eventRowId: eventRow.id, attempt };
    });

    if (prep.duplicate) {
      return { received: true, duplicate: true, status: 'DUPLICATE_IGNORED' };
    }

    if (!prep.attempt) {
      await this.prisma.runAsSystemAdmin((adminDb) =>
        adminDb.webhookEvent.update({
          where: { id: prep.eventRowId },
          data: {
            status: PrismaWebhookStatus.IGNORED,
            errorMessage: `No matching payment attempt found for order=${gatewayOrderId}`,
            processedAt: new Date(),
          },
        }),
      );
      return { received: true, status: 'IGNORED_NO_MATCHING_ORDER' };
    }

    const attempt = prep.attempt;
    let finalWebhookStatus: PrismaWebhookStatus = PrismaWebhookStatus.PROCESSED;

    await this.prisma.runInTenantTx(async (tx) => {
      if (eventType === 'payment.captured' || eventType === 'order.paid') {
        await this.applyPaymentSuccessTx(tx, {
          tenantId: attempt.tenantId,
          outletId: attempt.outletId,
          attemptId: attempt.id,
          gatewayPaymentId: gatewayPaymentId ?? undefined,
          receiptRef: gatewayPaymentId ?? gatewayOrderId ?? undefined,
          confirmedByMembershipId: null,
          actorUserId: attempt.tenantId,
          actorRole: 'WEBHOOK',
          ipAddress: null,
        });
      } else if (eventType === 'payment.failed') {
        const failureReason =
          (typeof paymentEntity?.error_description === 'string' && paymentEntity.error_description) ||
          (typeof paymentEntity?.error_reason === 'string' && paymentEntity.error_reason) ||
          'Razorpay payment failed webhook';

        await this.applyPaymentFailureTx(tx, {
          tenantId: attempt.tenantId,
          outletId: attempt.outletId,
          attemptId: attempt.id,
          failureReason,
          actorUserId: attempt.tenantId,
          actorRole: 'WEBHOOK',
          ipAddress: null,
        });
      } else if (eventType === 'refund.processed' && gatewayRefundId) {
        const refundRow = await tx.refund.findFirst({
          where: { gatewayRefundId },
        });
        if (refundRow && refundRow.status !== PrismaRefundStatus.SUCCEEDED) {
          await tx.refund.update({
            where: { id: refundRow.id },
            data: { status: PrismaRefundStatus.SUCCEEDED, processedAt: new Date() },
          });
        }
      } else {
        finalWebhookStatus = PrismaWebhookStatus.IGNORED;
      }
    }, attempt.tenantId);

    await this.prisma.runAsSystemAdmin((adminDb) =>
      adminDb.webhookEvent.update({
        where: { id: prep.eventRowId },
        data: {
          tenantId: attempt.tenantId,
          status: finalWebhookStatus,
          processedAt: new Date(),
        },
      }),
    );

    return { received: true, status: finalWebhookStatus };
  }

  async issueRefund(
    principal: AuthenticatedPrincipal,
    billId: string,
    dto: CreateRefundDto,
  ) {
    const ctx = requireOutletContext(principal);
    if (!PAYMENT_STAFF_ROLES.has(ctx.role)) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Only Owner, Manager, or Cashier can issue refunds.',
      });
    }
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    const pre = await this.prisma.runInTenantTx(async (tx) => {
      const bill = await tx.bill.findFirst({
        where: { id: billId, outletId: ctx.outletId },
        include: {
          session: { select: { id: true, status: true, tableId: true } },
        },
      });
      if (!bill) {
        throw new NotFoundException({
          code: ErrorCode.BILL_NOT_FOUND,
          message: 'Bill not found.',
        });
      }

      const attempt = await tx.paymentAttempt.findFirst({
        where: { id: dto.paymentAttemptId, billId: bill.id },
        include: {
          refunds: { where: { status: { not: PrismaRefundStatus.FAILED } } },
        },
      });
      if (!attempt || attempt.status !== PrismaPaymentStatus.SUCCEEDED) {
        throw new ConflictException({
          code: ErrorCode.CONFLICT,
          message: 'Only succeeded payment attempts on this bill can be refunded.',
        });
      }

      const alreadyRefundedOnAttempt = attempt.refunds.reduce((s, r) => s + r.amountPaise, 0);
      const refundableAttemptPaise = Math.max(0, attempt.amountPaise - alreadyRefundedOnAttempt);
      const netPaidBillPaise = Math.max(0, bill.paidPaise - bill.refundedPaise);
      const maxAllowed = Math.min(refundableAttemptPaise, netPaidBillPaise);
      const refundAmount = dto.amountPaise ?? maxAllowed;

      if (refundAmount <= 0 || refundAmount > maxAllowed) {
        throw new BadRequestException({
          code: ErrorCode.REFUND_EXCEEDS_PAID,
          message: `Refund amount (${refundAmount} paise) exceeds refundable balance (${maxAllowed} paise).`,
        });
      }

      return { bill, attempt, refundAmount };
    }, ctx.tenantId);

    let gatewayRefundId: string | null = null;
    if (
      pre.attempt.provider === PrismaPaymentProvider.RAZORPAY &&
      pre.attempt.gatewayPaymentId
    ) {
      const gwRefund = await this.razorpayClient.createRefund(
        pre.attempt.gatewayPaymentId,
        pre.refundAmount,
        dto.reason.trim(),
      );
      gatewayRefundId = gwRefund.gatewayRefundId;
    }

    const createdRefund = await this.prisma.runInTenantTx(async (tx) => {
      const now = new Date();
      const refundRow = await tx.refund.create({
        data: {
          tenantId: ctx.tenantId,
          billId: pre.bill.id,
          paymentAttemptId: pre.attempt.id,
          amountPaise: pre.refundAmount,
          reason: dto.reason.trim(),
          status: PrismaRefundStatus.SUCCEEDED,
          gatewayRefundId,
          initiatedByMembershipId: ctx.membershipId ?? null,
          processedAt: now,
        },
      });

      const nextRefundedPaise = pre.bill.refundedPaise + pre.refundAmount;
      const progress = computeBillPaymentProgress({
        totalPaise: pre.bill.totalPaise,
        succeededAllocatedPaise: pre.bill.paidPaise,
        refundedPaise: nextRefundedPaise,
      });

      await tx.bill.update({
        where: { id: pre.bill.id },
        data: {
          refundedPaise: nextRefundedPaise,
          status: progress.status as unknown as PrismaBillStatus,
          ...(progress.status !== BillStatus.PAID ? { paidAt: null } : {}),
        },
      });

      if (
        progress.status !== BillStatus.PAID &&
        pre.bill.session.status === PrismaDiningSessionStatus.SETTLED
      ) {
        await tx.diningSession.update({
          where: { id: pre.bill.sessionId },
          data: {
            status: PrismaDiningSessionStatus.BILL_REQUESTED,
            settledAt: null,
            settledByMembershipId: null,
          },
        });

        await tx.restaurantTable?.update?.({
          where: { id: pre.bill.session.tableId },
          data: { status: PrismaTableStatus.OCCUPIED },
        });
      }

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'BILL_REFUND_ISSUED',
          entityType: 'Refund',
          entityId: refundRow.id,
          afterJson: {
            billId: pre.bill.id,
            paymentAttemptId: pre.attempt.id,
            refundAmountPaise: pre.refundAmount,
            reason: dto.reason.trim(),
            billStatusAfter: progress.status,
          },
          ipAddress,
        },
      });

      await this.emitPaymentOutbox(tx, {
        tenantId: ctx.tenantId,
        outletId: ctx.outletId,
        topic: 'refund.processed',
        aggregateType: 'Bill',
        aggregateId: pre.bill.id,
        payload: {
          billId: pre.bill.id,
          sessionId: pre.bill.sessionId,
          tableId: pre.bill.session.tableId,
          refundId: refundRow.id,
          amountPaise: pre.refundAmount,
          billStatus: progress.status,
        },
      });

      return refundRow;
    }, ctx.tenantId);

    const updatedBill = await this.billingService.getBill(principal, pre.bill.id);
    return { refund: createdRefund, bill: updatedBill };
  }
}
