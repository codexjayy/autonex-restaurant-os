import { ConflictException, ForbiddenException } from '@nestjs/common';
import {
  BillLineType,
  BillStatus,
  DiningSessionStatus,
  ErrorCode,
  GuestJoinStatus,
  KitchenStatus,
  StaffRole,
  TaxMode,
  TenantStatus,
} from '@autonex/shared';
import { BillingService } from '../src/modules/billing/billing.service';
import { ReceiptPdfService } from '../src/modules/billing/receipt-pdf.service';
import { sha256Hex } from '../src/common/security/crypto.util';

describe('BillingService & ReceiptPdfService — Phase 6 Consolidated Billing, Tax, Discounts, Void & PDF', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const outletId = '22222222-2222-4222-8222-222222222222';
  const tableId = '33333333-3333-4333-8333-333333333333';
  const sessionId = '44444444-4444-4444-8444-444444444444';
  const rawQrToken = 'qr-billing-table-5-secret-token-123456';
  const guestRawToken = 'guest-secret-token-value-1234567890abcdef';

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
  const waiterPrincipal = makePrincipal(StaffRole.WAITER, 'u-waiter', 'm-waiter');

  function createBillingHarness(overrides?: {
    taxMode?: TaxMode;
    gstRateBps?: number;
    roundOffEnabled?: boolean;
  }) {
    let idSeq = 1;
    const nextUuid = () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(idSeq++).padStart(12, '0')}`;

    const state = {
      outlet: {
        id: outletId,
        tenantId,
        name: 'Shreeji Kathiyawadi Kitchen',
        address: 'CG Road, Ahmedabad',
        gstin: '24ABCDE1234F1Z5',
        gstRateBps: overrides?.gstRateBps ?? 500,
        taxMode: overrides?.taxMode ?? TaxMode.EXCLUSIVE,
        roundOffEnabled: overrides?.roundOffEnabled ?? false,
        timezone: 'Asia/Kolkata',
        invoiceSeq: 0,
      },
      table: {
        id: tableId,
        tenantId,
        outletId,
        tableNumber: '5',
        label: 'Window Corner',
        status: 'OCCUPIED',
      },
      session: {
        id: sessionId,
        tenantId,
        outletId,
        tableId,
        status: DiningSessionStatus.ACTIVE,
        billRequestedAt: null as Date | null,
        settledAt: null as Date | null,
        settledByMembershipId: null as string | null,
      },
      guests: [
        {
          id: 'guest-1',
          tenantId,
          sessionId,
          guestTokenHash: sha256Hex(guestRawToken),
          status: GuestJoinStatus.APPROVED,
        },
      ] as Array<Record<string, unknown>>,
      orders: [
        {
          id: 'order-1',
          sessionId,
          outletId,
          roundNumber: 1,
          kotNumber: 101,
          kitchenStatus: KitchenStatus.SERVED,
          subtotalPaise: 32000,
          createdAt: new Date('2026-11-11T12:00:00Z'),
          items: [
            {
              id: 'oi-1',
              orderId: 'order-1',
              itemNameSnapshot: 'Kathiyawadi Thali',
              modifiersSnapshotJson: [{ optionName: 'Less Spicy' }],
              quantity: 1,
              unitPricePaise: 32000,
              lineTotalPaise: 32000,
              status: 'ACTIVE',
              createdAt: new Date('2026-11-11T12:00:00Z'),
            },
          ],
        },
        {
          id: 'order-2',
          sessionId,
          outletId,
          roundNumber: 2,
          kotNumber: 102,
          kitchenStatus: KitchenStatus.READY,
          subtotalPaise: 12000,
          createdAt: new Date('2026-11-11T12:15:00Z'),
          items: [
            {
              id: 'oi-2',
              orderId: 'order-2',
              itemNameSnapshot: 'Chaas & Papad',
              modifiersSnapshotJson: [],
              quantity: 2,
              unitPricePaise: 6000,
              lineTotalPaise: 12000,
              status: 'ACTIVE',
              createdAt: new Date('2026-11-11T12:15:00Z'),
            },
          ],
        },
        {
          id: 'order-cancelled',
          sessionId,
          outletId,
          roundNumber: 3,
          kotNumber: 103,
          kitchenStatus: KitchenStatus.CANCELLED,
          subtotalPaise: 99000,
          createdAt: new Date('2026-11-11T12:20:00Z'),
          items: [
            {
              id: 'oi-3',
              orderId: 'order-cancelled',
              itemNameSnapshot: 'Cancelled Platter',
              modifiersSnapshotJson: [],
              quantity: 1,
              unitPricePaise: 99000,
              lineTotalPaise: 99000,
              status: 'CANCELLED',
              createdAt: new Date('2026-11-11T12:20:00Z'),
            },
          ],
        },
      ],
      bills: [] as Array<Record<string, unknown>>,
      billLines: [] as Array<Record<string, unknown>>,
      paymentAttempts: [] as Array<Record<string, unknown>>,
      refunds: [] as Array<Record<string, unknown>>,
      auditLogs: [] as Array<Record<string, unknown>>,
      outboxEvents: [] as Array<Record<string, unknown>>,
    };

    const hydrateBill = (bill: Record<string, unknown>) => ({
      ...bill,
      session: {
        id: state.session.id,
        status: state.session.status,
        table: {
          id: state.table.id,
          tableNumber: state.table.tableNumber,
          label: state.table.label,
        },
      },
      lines: state.billLines.filter((l) => l.billId === bill.id),
      paymentAttempts: state.paymentAttempts.filter((p) => p.billId === bill.id),
      refunds: state.refunds.filter((r) => r.billId === bill.id),
    });

    const matchesNotFilter = (val: unknown, clause: unknown): boolean => {
      if (clause && typeof clause === 'object' && 'not' in (clause as Record<string, unknown>)) {
        return val !== (clause as { not: unknown }).not;
      }
      if (clause === undefined) return true;
      return val === clause;
    };

    const tx = {
      outlet: {
        findFirst: jest.fn(async () => ({ ...state.outlet })),
        update: jest.fn(async ({ data }: { data: { invoiceSeq?: { increment: number } } }) => {
          if (data.invoiceSeq?.increment) {
            state.outlet.invoiceSeq += data.invoiceSeq.increment;
          }
          return { ...state.outlet };
        }),
      },
      diningSession: {
        findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          const matchesId = !where.id || where.id === state.session.id;
          const matchesTable = !where.tableId || where.tableId === state.session.tableId;
          const matchesStatus = matchesNotFilter(state.session.status, where.status);
          if (!matchesId || !matchesTable || !matchesStatus) return null;

          return {
            ...state.session,
            outlet: state.outlet,
            table: state.table,
            orders: state.orders
              .filter((o) => matchesNotFilter(o.kitchenStatus, KitchenStatus.CANCELLED ? { not: KitchenStatus.CANCELLED } : undefined))
              .map((o) => ({
                ...o,
                items: o.items.filter((i) => i.status === 'ACTIVE' && i.quantity > 0),
              })),
          };
        }),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(state.session, data);
          return state.session;
        }),
      },
      sessionGuest: {
        findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          return (
            state.guests.find(
              (g) => g.sessionId === where.sessionId && g.guestTokenHash === where.guestTokenHash,
            ) ?? null
          );
        }),
      },
      bill: {
        findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          const found = state.bills.find(
            (b) =>
              (!where.id || b.id === where.id) &&
              (!where.sessionId || b.sessionId === where.sessionId) &&
              (!where.outletId || b.outletId === where.outletId) &&
              matchesNotFilter(b.status, where.status),
          );
          return found ? hydrateBill(found) : null;
        }),
        findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          return state.bills
            .filter(
              (b) =>
                (!where.outletId || b.outletId === where.outletId) &&
                (!where.status || b.status === where.status),
            )
            .map(hydrateBill);
        }),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const activeExists = state.bills.some(
            (b) => b.sessionId === data.sessionId && b.status !== BillStatus.VOID,
          );
          if (activeExists) {
            const err = new Error('Unique constraint failed') as Error & { code: string };
            err.code = 'P2002';
            throw err;
          }
          const created = {
            id: nextUuid(),
            createdAt: new Date(),
            voidReason: null,
            ...data,
          };
          state.bills.push(created);
          return created;
        }),
        update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const bill = state.bills.find((b) => b.id === where.id);
          if (!bill) throw new Error('Bill not found');
          Object.assign(bill, data);
          return bill;
        }),
      },
      billLine: {
        createMany: jest.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
          for (const row of data) {
            state.billLines.push({ id: nextUuid(), createdAt: new Date(), ...row });
          }
          return { count: data.length };
        }),
        deleteMany: jest.fn(async ({ where }: { where: { billId: string; lineType?: { not: unknown } } }) => {
          const before = state.billLines.length;
          state.billLines = state.billLines.filter((l) => {
            if (l.billId !== where.billId) return true;
            if (where.lineType?.not !== undefined) {
              return l.lineType === where.lineType.not;
            }
            return false;
          });
          return { count: before - state.billLines.length };
        }),
      },
      restaurantTable: {
        update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          if (where.id === state.table.id) Object.assign(state.table, data);
          return state.table;
        }),
      },
      paymentAttempt: {
        findMany: jest.fn(async () => state.paymentAttempts),
      },
      refund: {
        findMany: jest.fn(async () => state.refunds),
      },
      auditLog: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: nextUuid(), createdAt: new Date(), ...data };
          state.auditLogs.push(row);
          return row;
        }),
        findMany: jest.fn(async () => [...state.auditLogs].reverse()),
      },
      outboxEvent: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          state.outboxEvents.push({ id: nextUuid(), ...data });
          return data;
        }),
      },
    };

    const prismaService = {
      runInTenantTx: jest.fn(async <T>(fn: (client: typeof tx) => Promise<T>) => fn(tx)),
    };
    const tenantContext = {
      get: jest.fn(() => ({ ipAddress: '10.0.0.15' })),
    };
    const tablesService = {
      verifyQrTokenAndGetTable: jest.fn(async (token: string) => {
        if (token !== rawQrToken) {
          throw new ForbiddenException('Invalid QR token');
        }
        return { tenant_id: tenantId, outlet_id: outletId, table_id: tableId };
      }),
    };
    const receiptPdfService = new ReceiptPdfService();

    const service = new BillingService(
      prismaService as never,
      tenantContext as never,
      tablesService as never,
      receiptPdfService,
    );

    return { state, service, receiptPdfService };
  }

  it('consolidates multi-round active orders (excluding cancelled), enforces integer paise, assigns sequential billNumber, and locks session', async () => {
    const { state, service } = createBillingHarness({ taxMode: TaxMode.EXCLUSIVE, gstRateBps: 500 });

    const res = await service.generateOrRefreshBill(cashierPrincipal, sessionId, {});

    expect(res.alreadyExisted).toBe(false);
    // Round 1 (32000) + Round 2 (12000) = 44000 paise; cancelled order 99000 excluded
    expect(res.bill.subtotalPaise).toBe(44000);
    // 5% GST on 44000 = 2200 -> 1100 CGST + 1100 SGST = 46200 paise
    expect(res.bill.cgstPaise).toBe(1100);
    expect(res.bill.sgstPaise).toBe(1100);
    expect(res.bill.totalPaise).toBe(46200);
    expect(res.bill.duePaise).toBe(46200);
    expect(res.bill.status).toBe(BillStatus.OPEN);
    expect(res.bill.billNumber).toMatch(/^INV-\d{6}-00001$/);
    expect(state.session.status).toBe(DiningSessionStatus.BILL_REQUESTED);
    expect(state.auditLogs).toHaveLength(1);
    expect(state.auditLogs[0]!.action).toBe('BILL_GENERATED');
    expect(state.outboxEvents[0]!.topic).toBe('bill.generated');

    // Second call on same active session returns the existing bill cleanly without incrementing invoiceSeq
    const replay = await service.generateOrRefreshBill(cashierPrincipal, sessionId, {});
    expect(replay.alreadyExisted).toBe(true);
    expect(replay.bill.id).toBe(res.bill.id);
    expect(state.outlet.invoiceSeq).toBe(1);
  });

  it('supports INCLUSIVE GST extraction and NONE tax mode + round-off accurately in integer paise', async () => {
    const inclusive = createBillingHarness({ taxMode: TaxMode.INCLUSIVE, gstRateBps: 500 });
    const incBill = (await inclusive.service.generateOrRefreshBill(cashierPrincipal, sessionId, {})).bill;
    // Price already includes 5% GST -> total stays 44000 paise, tax extracted cleanly
    expect(incBill.totalPaise).toBe(44000);
    expect(incBill.cgstPaise + incBill.sgstPaise).toBe(2095);

    const taxFree = createBillingHarness({ taxMode: TaxMode.NONE, gstRateBps: 500 });
    const exemptBill = (await taxFree.service.generateOrRefreshBill(cashierPrincipal, sessionId, {})).bill;
    expect(exemptBill.cgstPaise).toBe(0);
    expect(exemptBill.sgstPaise).toBe(0);
    expect(exemptBill.totalPaise).toBe(44000);
  });

  it('applies audited discounts with GST recalculation, enforces permission guards, and blocks reducing total below netPaidPaise', async () => {
    const { state, service } = createBillingHarness();
    const { bill } = await service.generateOrRefreshBill(cashierPrincipal, sessionId, {});

    // Waiter is forbidden from applying financial discounts
    await expect(
      service.applyAuditedDiscount(waiterPrincipal, bill.id, {
        discountPaise: 4000,
        reason: 'Waiter discount attempt',
      }),
    ).rejects.toThrow(ForbiddenException);

    // Cashier applies ₹40.00 (4000 paise) goodwill discount -> taxable = 40000, 5% GST = 2000 -> total = 42000
    const updated = await service.applyAuditedDiscount(cashierPrincipal, bill.id, {
      discountPaise: 4000,
      reason: 'Festival regular customer discount',
    });

    expect(updated.discountPaise).toBe(4000);
    expect(updated.cgstPaise).toBe(1000);
    expect(updated.sgstPaise).toBe(1000);
    expect(updated.totalPaise).toBe(42000);
    expect(state.auditLogs.some((l) => l.action === 'BILL_DISCOUNT_APPLIED')).toBe(true);
    expect(
      updated.lines.some((l) => l.lineType === BillLineType.DISCOUNT && l.lineAmountPaise === -4000),
    ).toBe(true);

    // Simulate ₹300 already paid -> discounting ₹300 would make total ₹147 < ₹300 netPaid -> blocked!
    state.bills[0]!.paidPaise = 30000;
    await expect(
      service.applyAuditedDiscount(cashierPrincipal, bill.id, {
        discountPaise: 30000,
        reason: 'Too high after partial payment',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('blocks voiding a bill with netPaidPaise > 0 and allows clean replacement bill generation after voiding an unpaid bill', async () => {
    const { state, service } = createBillingHarness();
    const { bill: firstBill } = await service.generateOrRefreshBill(cashierPrincipal, sessionId, {});

    // Paid bill cannot be voided
    state.bills[0]!.paidPaise = 10000;
    await expect(
      service.voidBill(cashierPrincipal, firstBill.id, { reason: 'Wrong GST rate' }),
    ).rejects.toThrow(ConflictException);

    // Unpaid bill can be voided with reason, and next bill increments invoiceSeq cleanly
    state.bills[0]!.paidPaise = 0;
    const voided = await service.voidBill(cashierPrincipal, firstBill.id, {
      reason: 'Wrong table tax configuration',
    });
    expect(voided.status).toBe(BillStatus.VOID);
    expect(voided.voidReason).toBe('Wrong table tax configuration');
    expect(state.auditLogs.some((l) => l.action === 'BILL_VOIDED')).toBe(true);

    const replacement = await service.generateOrRefreshBill(cashierPrincipal, sessionId, {});
    expect(replacement.alreadyExisted).toBe(false);
    expect(replacement.bill.id).not.toBe(firstBill.id);
    expect(replacement.bill.billNumber).toMatch(/^INV-\d{6}-00002$/);
  });

  it('generates valid binary PDF receipt buffer and enforces approved guest token for customer bill & receipt endpoints', async () => {
    const { state, service } = createBillingHarness();
    const { bill } = await service.generateOrRefreshBill(cashierPrincipal, sessionId, {});

    // Staff PDF download starts with %PDF-
    const staffPdf = await service.buildBillReceiptPdf(cashierPrincipal, bill.id);
    expect(staffPdf.filename).toBe(`${bill.billNumber}.pdf`);
    expect(staffPdf.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');

    // Approved guest reads bill and downloads PDF receipt
    const customerRes = await service.getCustomerBill(rawQrToken, guestRawToken);
    expect(customerRes.bill?.billNumber).toBe(bill.billNumber);

    const guestPdf = await service.buildCustomerReceiptPdf(rawQrToken, guestRawToken);
    expect(guestPdf.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');

    // Revoked guest is strictly blocked
    state.guests[0]!.status = GuestJoinStatus.REVOKED;
    await expect(service.getCustomerBill(rawQrToken, guestRawToken)).rejects.toThrow(
      ForbiddenException,
    );

    // Unknown/forged error code sanity when bill doesn't exist
    await expect(
      service.getBill(cashierPrincipal, '99999999-9999-4999-8999-999999999999'),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.BILL_NOT_FOUND },
    });
  });

  it('supports percentage discounts, item-wise GST breakup, open-bill refresh after item edits, audit trail, and revenue analytics', async () => {
    const { state, service } = createBillingHarness();
    const first = await service.generateOrRefreshBill(cashierPrincipal, sessionId, {});
    expect(first.bill.itemGstBreakdown).toBeDefined();
    const gstSumCgst = (first.bill.itemGstBreakdown ?? []).reduce((s, r) => s + r.cgstPaise, 0);
    expect(gstSumCgst).toBe(first.bill.cgstPaise);

    // Simulate adding ₹100 item to order before finalizing payment, then refresh OPEN bill
    state.orders[0]!.items.push({
      id: 'oi-new',
      orderId: 'order-1',
      itemNameSnapshot: 'Gulab Jamun',
      modifiersSnapshotJson: [],
      quantity: 2,
      unitPricePaise: 5000,
      lineTotalPaise: 10000,
      status: 'ACTIVE',
      createdAt: new Date(),
    });

    const refreshed = await service.generateOrRefreshBill(cashierPrincipal, sessionId, {
      refresh: true,
    });
    expect(refreshed.bill.subtotalPaise).toBe(first.bill.subtotalPaise + 10000);

    // Apply 10% percentage discount (1000 bps)
    const discounted = await service.applyAuditedDiscount(cashierPrincipal, refreshed.bill.id, {
      discountPercentBps: 1000,
      reason: 'Festival 10% offer',
    });
    expect(discounted.discountPaise).toBe(Math.round(refreshed.bill.subtotalPaise * 0.1));
    expect((discounted.itemGstBreakdown ?? []).reduce((s, r) => s + r.cgstPaise, 0)).toBe(
      discounted.cgstPaise,
    );

    const audit = await service.getBillAuditLogs(cashierPrincipal, discounted.id);
    expect(audit.some((a) => a.action === 'BILL_DISCOUNT_APPLIED')).toBe(true);
    expect(audit.some((a) => a.action === 'BILL_REFRESHED_FROM_ORDERS')).toBe(true);

    // Analytics computes today's pending due, daily/weekly/monthly buckets cleanly
    state.paymentAttempts.push({
      id: 'pa-1',
      billId: discounted.id,
      method: 'CASH',
      provider: 'MANUAL',
      amountPaise: 10000,
      status: 'SUCCEEDED',
      completedAt: new Date(),
      createdAt: new Date(),
    });
    const analytics = await service.getBillingAnalytics(cashierPrincipal);
    expect(analytics.today.cashCollectedPaise).toBe(10000);
    expect(analytics.daily).toHaveLength(14);
    expect(analytics.weekly.length).toBeGreaterThanOrEqual(7);
    expect(analytics.monthly).toHaveLength(6);
  });
});
