import { createHmac } from 'node:crypto';
import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import {
  BillStatus,
  DiningSessionStatus,
  ErrorCode,
  PaymentMethod,
  PaymentProvider,
  PaymentStatus,
  RefundStatus,
  StaffRole,
  TaxMode,
  TenantStatus,
  WebhookStatus,
} from '@autonex/shared';
import { PaymentsService } from '../src/modules/payments/payments.service';
import { RazorpayClientService } from '../src/modules/payments/razorpay-client.service';
import { ReconciliationService } from '../src/modules/payments/reconciliation.service';

describe('PaymentsService, RazorpayClientService & ReconciliationService — Phase 6 Payments, Webhooks, Refunds & Reconcile', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const outletId = '22222222-2222-4222-8222-222222222222';
  const tableId = '33333333-3333-4333-8333-333333333333';
  const sessionId = '44444444-4444-4444-8444-444444444444';
  const billId = '55555555-5555-4555-8555-555555555555';
  const webhookSecret = 'rzp_webhook_super_secret_key_for_tests';
  const keySecret = 'rzp_key_super_secret_for_tests';

  const makePrincipal = (role: StaffRole, userId: string, membershipId: string) => ({
    userId,
    tenantId,
    outletId,
    membershipId,
    role,
    tenantStatus: TenantStatus.ACTIVE,
    isSuperAdmin: false,
    mfaVerified: false,
  });

  const cashierPrincipal = makePrincipal(StaffRole.CASHIER, 'u-cashier', 'm-cashier');

  function signWebhookRaw(rawBody: Buffer, secret = webhookSecret): string {
    return createHmac('sha256', secret).update(rawBody).digest('hex');
  }

  function signCheckout(orderId: string, paymentId: string, secret = keySecret): string {
    return createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
  }

  function createPaymentsHarness(totalPaise = 50000) {
    let seq = 1;
    const nextUuid = () => `bbbbbbbb-bbbb-4bbb-8bbb-${String(seq++).padStart(12, '0')}`;

    const state = {
      session: {
        id: sessionId,
        tenantId,
        outletId,
        tableId,
        status: DiningSessionStatus.BILL_REQUESTED,
        settledAt: null as Date | null,
        settledByMembershipId: null as string | null,
      },
      table: {
        id: tableId,
        tableNumber: '7',
        label: 'Terrace 7',
      },
      bill: {
        id: billId,
        tenantId,
        outletId,
        sessionId,
        billNumber: 'INV-202611-00001',
        status: BillStatus.OPEN,
        subtotalPaise: totalPaise,
        discountPaise: 0,
        discountReason: null,
        taxMode: TaxMode.EXCLUSIVE,
        gstRateBps: 0,
        cgstPaise: 0,
        sgstPaise: 0,
        roundOffPaise: 0,
        totalPaise,
        paidPaise: 0,
        refundedPaise: 0,
        gstinSnapshot: null,
        outletNameSnapshot: 'Test Cafe',
        outletAddressSnapshot: 'MG Road',
        voidReason: null,
        finalizedAt: new Date('2026-11-11T12:00:00Z'),
        paidAt: null as Date | null,
        createdAt: new Date('2026-11-11T12:00:00Z'),
      },
      paymentAttempts: [] as Array<Record<string, unknown>>,
      paymentAllocations: [] as Array<Record<string, unknown>>,
      refunds: [] as Array<Record<string, unknown>>,
      webhookEvents: [] as Array<Record<string, unknown>>,
      auditLogs: [] as Array<Record<string, unknown>>,
      outboxEvents: [] as Array<Record<string, unknown>>,
    };

    const hydrateAttempt = (a: Record<string, unknown>) => ({
      ...a,
      refunds: state.refunds.filter(
        (r) =>
          r.paymentAttemptId === a.id &&
          (r.status === RefundStatus.PENDING || r.status === RefundStatus.SUCCEEDED),
      ),
      bill: {
        ...state.bill,
        session: {
          id: state.session.id,
          status: state.session.status,
          table: state.table,
        },
      },
    });

    const hydrateBill = () => ({
      ...state.bill,
      session: {
        id: state.session.id,
        status: state.session.status,
        table: state.table,
      },
      lines: [],
      paymentAttempts: state.paymentAttempts.filter((a) => a.billId === state.bill.id),
      refunds: state.refunds.filter((r) => r.billId === state.bill.id),
    });

    const matchesStatusFilter = (val: unknown, filter: unknown): boolean => {
      if (!filter) return true;
      if (typeof filter === 'string') return val === filter;
      if (typeof filter === 'object') {
        const obj = filter as { in?: unknown[]; not?: unknown };
        if (obj.in) return obj.in.includes(val);
        if (obj.not !== undefined) return val !== obj.not;
      }
      return true;
    };

    const dbClient = {
      bill: {
        findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          if (where.id && where.id !== state.bill.id) return null;
          if (where.outletId && where.outletId !== state.bill.outletId) return null;
          return hydrateBill();
        }),
        update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          if (where.id !== state.bill.id) throw new Error('Bill not found');
          Object.assign(state.bill, data);
          return hydrateBill();
        }),
      },
      diningSession: {
        findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          if (where.id && where.id !== state.session.id) return null;
          return state.session;
        }),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(state.session, data);
          return state.session;
        }),
      },
      paymentAttempt: {
        findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          const found = state.paymentAttempts.find(
            (a) =>
              (!where.id || a.id === where.id) &&
              (!where.billId || a.billId === where.billId) &&
              (!where.outletId || a.outletId === where.outletId) &&
              (!where.idempotencyKey || a.idempotencyKey === where.idempotencyKey) &&
              (!where.gatewayOrderId || a.gatewayOrderId === where.gatewayOrderId) &&
              (!where.gatewayPaymentId || a.gatewayPaymentId === where.gatewayPaymentId),
          );
          return found ? hydrateAttempt(found) : null;
        }),
        findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          const lteDate = (where.createdAt as { lte?: Date } | undefined)?.lte;
          return state.paymentAttempts
            .filter(
              (a) =>
                (!where.provider || a.provider === where.provider) &&
                (!where.outletId || a.outletId === where.outletId) &&
                matchesStatusFilter(a.status, where.status) &&
                (!lteDate || (a.createdAt as Date) <= lteDate),
            )
            .map((a) => ({ ...a }));
        }),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = {
            id: nextUuid(),
            reconcileAttempts: 0,
            lastReconciledAt: null,
            completedAt: null,
            createdAt: new Date(),
            gatewayOrderId: null,
            gatewayPaymentId: null,
            qrPayloadUrl: null,
            receiptRef: null,
            failureReason: null,
            ...data,
          };
          state.paymentAttempts.push(row);
          return hydrateAttempt(row);
        }),
        update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = state.paymentAttempts.find((a) => a.id === where.id);
          if (!row) throw new Error('PaymentAttempt not found');
          Object.assign(row, data);
          return hydrateAttempt(row);
        }),
      },
      paymentAllocation: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: nextUuid(), createdAt: new Date(), ...data };
          state.paymentAllocations.push(row);
          return row;
        }),
      },
      refund: {
        findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          return (
            state.refunds.find(
              (r) => !where.gatewayRefundId || r.gatewayRefundId === where.gatewayRefundId,
            ) ?? null
          );
        }),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: nextUuid(), createdAt: new Date(), ...data };
          state.refunds.push(row);
          return row;
        }),
        update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = state.refunds.find((r) => r.id === where.id);
          if (!row) throw new Error('Refund not found');
          Object.assign(row, data);
          return row;
        }),
      },
      webhookEvent: {
        findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          return (
            state.webhookEvents.find(
              (w) =>
                (!where.provider || w.provider === where.provider) &&
                (!where.providerEventId || w.providerEventId === where.providerEventId),
            ) ?? null
          );
        }),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: nextUuid(), createdAt: new Date(), ...data };
          state.webhookEvents.push(row);
          return row;
        }),
        update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = state.webhookEvents.find((w) => w.id === where.id);
          if (!row) throw new Error('WebhookEvent not found');
          Object.assign(row, data);
          return row;
        }),
      },
      auditLog: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          state.auditLogs.push({ id: nextUuid(), ...data });
          return data;
        }),
      },
      outboxEvent: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          state.outboxEvents.push({ id: nextUuid(), ...data });
          return data;
        }),
      },
    };

    const prismaService = {
      runInTenantTx: jest.fn(async <T>(fn: (tx: typeof dbClient) => Promise<T>) => fn(dbClient)),
      runAsSystemAdmin: jest.fn(async <T>(fn: (adminDb: typeof dbClient) => Promise<T>) =>
        fn(dbClient),
      ),
    };

    const configValues: Record<string, unknown> = {
      NODE_ENV: 'test',
      RAZORPAY_KEY_ID: 'rzp_test_livekey_123',
      RAZORPAY_KEY_SECRET: keySecret,
      RAZORPAY_WEBHOOK_SECRET: webhookSecret,
      RAZORPAY_MOCK_MODE: true,
      PAYMENT_RECONCILE_STALE_MINUTES: 2,
    };

    const configService = {
      get: jest.fn((key: string) => configValues[key]),
    };

    const razorpayClient = new RazorpayClientService(configService as never);
    const tenantContext = { get: jest.fn(() => ({ ipAddress: '10.1.1.5' })) };
    const tablesService = { verifyQrTokenAndGetTable: jest.fn() };
    const billingService = {
      getBill: jest.fn(async () => hydrateBill()),
    };

    const paymentsService = new PaymentsService(
      prismaService as never,
      tenantContext as never,
      tablesService as never,
      billingService as never,
      razorpayClient,
    );

    const reconciliationService = new ReconciliationService(
      prismaService as never,
      configService as never,
      razorpayClient,
      paymentsService,
    );

    return {
      state,
      razorpayClient,
      paymentsService,
      reconciliationService,
    };
  }

  it('records partial and split manual payments with idempotency, transitioning session to SETTLED only at full payment', async () => {
    const { state, paymentsService } = createPaymentsHarness(50000);

    // Partial payment 1: ₹200 Cash
    const part1 = await paymentsService.recordManualPayment(
      cashierPrincipal,
      billId,
      { method: PaymentMethod.CASH, amountPaise: 20000, receiptRef: 'CASH-PART-1' },
      'idem-manual-split-1',
    );
    expect(part1.idempotentReplay).toBe(false);
    expect(state.bill.paidPaise).toBe(20000);
    expect(state.bill.status).toBe(BillStatus.PARTIALLY_PAID);
    expect(state.session.status).toBe(DiningSessionStatus.BILL_REQUESTED); // Not yet settled!

    // Idempotent retry with same Idempotency-Key does NOT double-credit
    const replay = await paymentsService.recordManualPayment(
      cashierPrincipal,
      billId,
      { method: PaymentMethod.CASH, amountPaise: 20000 },
      'idem-manual-split-1',
    );
    expect(replay.idempotentReplay).toBe(true);
    expect(state.bill.paidPaise).toBe(20000);

    // Attempting to pay more than remaining ₹300 is rejected
    await expect(
      paymentsService.recordManualPayment(
        cashierPrincipal,
        billId,
        { method: PaymentMethod.UPI_MANUAL, amountPaise: 35000 },
        'idem-exceed-due-1',
      ),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.PAYMENT_EXCEEDS_DUE },
    });

    // Partial payment 2: ₹300 Counter UPI finishes balance -> Bill PAID & Session SETTLED
    await paymentsService.recordManualPayment(
      cashierPrincipal,
      billId,
      { method: PaymentMethod.UPI_MANUAL, amountPaise: 30000, receiptRef: 'UTR-998877' },
      'idem-manual-split-2',
    );
    expect(state.bill.paidPaise).toBe(50000);
    expect(state.bill.status).toBe(BillStatus.PAID);
    expect(state.session.status).toBe(DiningSessionStatus.SETTLED);
    expect(state.paymentAllocations).toHaveLength(2);
  });

  it('enforces raw-body HMAC-SHA256 webhook signature verification, deduplicates replays, and never closes session on payment.failed', async () => {
    const { state, paymentsService } = createPaymentsHarness(50000);

    const order = await paymentsService.createRazorpayOrder(
      cashierPrincipal,
      billId,
      { amountPaise: 50000 },
      'idem-rzp-order-01',
    );
    expect(order.gatewayOrderId).toBeTruthy();

    // 1. Missing or forged signature throws 401 INVALID_WEBHOOK_SIGNATURE
    const failPayload = Buffer.from(
      JSON.stringify({
        event: 'payment.failed',
        payload: {
          payment: {
            entity: {
              id: 'pay_fail_001',
              order_id: order.gatewayOrderId,
              error_description: 'Insufficient funds in UPI bank account',
            },
          },
        },
      }),
    );

    await expect(
      paymentsService.handleRazorpayWebhook({
        rawBody: failPayload,
        signatureHeader: 'deadbeef'.repeat(8),
        eventIdHeader: 'evt_forged_1',
      }),
    ).rejects.toThrow(UnauthorizedException);

    // 2. Valid HMAC webhook for payment.failed marks attempt FAILED & NEVER closes or settles session
    const validFailRes = await paymentsService.handleRazorpayWebhook({
      rawBody: failPayload,
      signatureHeader: signWebhookRaw(failPayload),
      eventIdHeader: 'evt_fail_1',
    });
    expect(validFailRes.status).toBe(WebhookStatus.PROCESSED);
    expect(state.paymentAttempts[0]!.status).toBe(PaymentStatus.FAILED);
    expect(state.bill.paidPaise).toBe(0);
    expect(state.bill.status).toBe(BillStatus.OPEN);
    expect(state.session.status).toBe(DiningSessionStatus.BILL_REQUESTED);

    // 3. Diner creates fresh retry order -> webhook delivers payment.captured + duplicate replay ignored
    const retryOrder = await paymentsService.createRazorpayOrder(
      cashierPrincipal,
      billId,
      { amountPaise: 50000 },
      'idem-rzp-order-02',
    );

    const capturePayload = Buffer.from(
      JSON.stringify({
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_success_002',
              order_id: retryOrder.gatewayOrderId,
              status: 'captured',
            },
          },
        },
      }),
    );
    const captureSig = signWebhookRaw(capturePayload);

    const captureRes = await paymentsService.handleRazorpayWebhook({
      rawBody: capturePayload,
      signatureHeader: captureSig,
      eventIdHeader: 'evt_capture_2',
    });
    expect(captureRes.status).toBe(WebhookStatus.PROCESSED);
    expect(state.bill.paidPaise).toBe(50000);
    expect(state.bill.status).toBe(BillStatus.PAID);
    expect(state.session.status).toBe(DiningSessionStatus.SETTLED);

    // Duplicate webhook with same event ID is ignored cleanly
    const dupRes = await paymentsService.handleRazorpayWebhook({
      rawBody: capturePayload,
      signatureHeader: captureSig,
      eventIdHeader: 'evt_capture_2',
    });
    expect(dupRes).toEqual({ received: true, duplicate: true, status: 'DUPLICATE_IGNORED' });
    expect(state.paymentAllocations).toHaveLength(1);
  });

  it('verifies checkout HMAC signatures and safely reconciles a late webhook after counter cash settlement without double-counting', async () => {
    const { state, paymentsService } = createPaymentsHarness(45000);

    const gwOrder = await paymentsService.createRazorpayOrder(
      cashierPrincipal,
      billId,
      { amountPaise: 45000 },
      'idem-late-rzp-order',
    );

    // Forged checkout signature rejected cleanly
    await expect(
      paymentsService.verifyRazorpayPayment(cashierPrincipal, {
        razorpayOrderId: gwOrder.gatewayOrderId!,
        razorpayPaymentId: 'pay_test_999',
        razorpaySignature: '0'.repeat(64),
      }),
    ).rejects.toThrow(ForbiddenException);

    // Cashier accepts CASH at the counter while UPI gateway was still spinning
    await paymentsService.recordManualPayment(
      cashierPrincipal,
      billId,
      { method: PaymentMethod.CASH, amountPaise: 45000 },
      'idem-counter-cash-override',
    );
    expect(state.bill.paidPaise).toBe(45000);
    expect(state.bill.status).toBe(BillStatus.PAID);

    // Later, Razorpay checkout succeeds / webhook fires for the old order
    const validSig = signCheckout(gwOrder.gatewayOrderId!, 'pay_late_999');
    const verifyRes = await paymentsService.verifyRazorpayPayment(cashierPrincipal, {
      razorpayOrderId: gwOrder.gatewayOrderId!,
      razorpayPaymentId: 'pay_late_999',
      razorpaySignature: validSig,
    });

    expect(verifyRes.lateWebhookOverpayment).toBe(true);
    expect(state.bill.paidPaise).toBe(45000); // NOT double-counted!
    expect(
      state.auditLogs.some((a) => a.action === 'PAYMENT_LATE_WEBHOOK_RECONCILED'),
    ).toBe(true);
  });

  it('processes partial and full refunds, reverts bill/session status when balance reopens, and validates refund bounds', async () => {
    const { state, paymentsService } = createPaymentsHarness(30000);

    await paymentsService.recordManualPayment(
      cashierPrincipal,
      billId,
      { method: PaymentMethod.CARD, amountPaise: 30000, receiptRef: 'POS-888' },
      'idem-card-full-1',
    );
    const attemptId = state.paymentAttempts[0]!.id as string;
    expect(state.bill.status).toBe(BillStatus.PAID);
    expect(state.session.status).toBe(DiningSessionStatus.SETTLED);

    // Exceeding paid amount throws BadRequestException (REFUND_EXCEEDS_PAID)
    await expect(
      paymentsService.issueRefund(cashierPrincipal, billId, {
        paymentAttemptId: attemptId,
        amountPaise: 35000,
        reason: 'Too much refund',
      }),
    ).rejects.toThrow(BadRequestException);

    // Partial refund ₹100 -> Bill reverts to PARTIALLY_PAID & session reopens to BILL_REQUESTED
    const refundRes = await paymentsService.issueRefund(cashierPrincipal, billId, {
      paymentAttemptId: attemptId,
      amountPaise: 10000,
      reason: 'Spilled drink complimentary refund',
    });

    expect(refundRes.refund.status).toBe(RefundStatus.SUCCEEDED);
    expect(state.bill.refundedPaise).toBe(10000);
    expect(state.bill.status).toBe(BillStatus.PARTIALLY_PAID);
    expect(state.session.status).toBe(DiningSessionStatus.BILL_REQUESTED);
    expect(state.auditLogs.some((a) => a.action === 'BILL_REFUND_ISSUED')).toBe(true);
  });

  it('reconciles stale pending Razorpay attempts via ReconciliationService', async () => {
    const { state, razorpayClient, reconciliationService } = createPaymentsHarness(25000);

    // Seed two stale gateway attempts created 5 minutes ago and 20 minutes ago
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000);
    const twentyMinAgo = new Date(Date.now() - 20 * 60_000);

    state.paymentAttempts.push(
      {
        id: 'att-stale-captured',
        tenantId,
        outletId,
        billId,
        method: PaymentMethod.UPI_GATEWAY,
        provider: PaymentProvider.RAZORPAY,
        amountPaise: 25000,
        status: PaymentStatus.PENDING,
        gatewayOrderId: 'order_stale_cap',
        gatewayPaymentId: null,
        reconcileAttempts: 0,
        lastReconciledAt: null,
        createdAt: fiveMinAgo,
      },
      {
        id: 'att-stale-expired',
        tenantId,
        outletId,
        billId,
        method: PaymentMethod.UPI_GATEWAY,
        provider: PaymentProvider.RAZORPAY,
        amountPaise: 25000,
        status: PaymentStatus.INITIATED,
        gatewayOrderId: 'order_stale_exp',
        gatewayPaymentId: null,
        reconcileAttempts: 0,
        lastReconciledAt: null,
        createdAt: twentyMinAgo,
      },
    );

    jest.spyOn(razorpayClient, 'fetchOrderPayments').mockImplementation(async (orderId) => {
      if (orderId === 'order_stale_cap') {
        return [{ id: 'pay_rec_101', order_id: orderId, amount: 25000, status: 'captured' }];
      }
      return [];
    });

    const stats = await reconciliationService.runManualReconcile(cashierPrincipal);

    expect(stats.scanned).toBe(2);
    expect(stats.capturedCount).toBe(1);
    expect(stats.failedCount).toBe(1);
    expect(state.bill.paidPaise).toBe(25000);
    expect(state.bill.status).toBe(BillStatus.PAID);
    expect(state.session.status).toBe(DiningSessionStatus.SETTLED);
    expect(state.paymentAttempts[1]!.status).toBe(PaymentStatus.FAILED);
  });
});
