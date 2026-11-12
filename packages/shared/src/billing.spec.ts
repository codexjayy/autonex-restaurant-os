import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateBillTotalsPaise,
  computeBillPaymentProgress,
  computeItemWiseGstBreakdown,
  formatSequentialBillNumber,
} from './billing';
import { BillStatus, TaxMode } from './enums';

test('calculateBillTotalsPaise computes EXCLUSIVE, INCLUSIVE, and NONE tax modes with integer paise & optional round-off', () => {
  // 1. EXCLUSIVE 5% GST after ₹50 discount on ₹1000 subtotal => taxable ₹950, CGST ₹23.75, SGST ₹23.75 => ₹997.50
  const excl = calculateBillTotalsPaise({
    itemsSubtotalPaise: 100000,
    discountPaise: 5000,
    gstRateBps: 500,
    taxMode: TaxMode.EXCLUSIVE,
    roundOffEnabled: false,
  });
  assert.equal(excl.taxablePaise, 95000);
  assert.equal(excl.cgstPaise, 2375);
  assert.equal(excl.sgstPaise, 2375);
  assert.equal(excl.totalTaxPaise, 4750);
  assert.equal(excl.roundOffPaise, 0);
  assert.equal(excl.totalPaise, 99750);

  // With round-off enabled: ₹997.50 rounds half-up to ₹998.00 (+50 paise)
  const exclRounded = calculateBillTotalsPaise({
    itemsSubtotalPaise: 100000,
    discountPaise: 5000,
    gstRateBps: 500,
    taxMode: TaxMode.EXCLUSIVE,
    roundOffEnabled: true,
  });
  assert.equal(exclRounded.roundOffPaise, 50);
  assert.equal(exclRounded.totalPaise, 99800);

  // 2. INCLUSIVE 5% GST on ₹1050 menu total => taxable ₹1000, total GST ₹50, grand total stays ₹1050
  const incl = calculateBillTotalsPaise({
    itemsSubtotalPaise: 105000,
    discountPaise: 0,
    gstRateBps: 500,
    taxMode: TaxMode.INCLUSIVE,
    roundOffEnabled: false,
  });
  assert.equal(incl.taxablePaise, 100000);
  assert.equal(incl.cgstPaise + incl.sgstPaise, 5000);
  assert.equal(incl.taxablePaise + incl.totalTaxPaise, 105000);
  assert.equal(incl.totalPaise, 105000);

  // 3. NONE tax mode charges zero GST even if outlet gstRateBps > 0
  const nonGst = calculateBillTotalsPaise({
    itemsSubtotalPaise: 42000,
    discountPaise: 2000,
    gstRateBps: 500,
    taxMode: TaxMode.NONE,
  });
  assert.equal(nonGst.cgstPaise, 0);
  assert.equal(nonGst.sgstPaise, 0);
  assert.equal(nonGst.totalPaise, 40000);
});

test('computeBillPaymentProgress tracks partial payments, refunds, and full settlement cleanly', () => {
  const partial = computeBillPaymentProgress({
    totalPaise: 100000,
    succeededAllocatedPaise: 40000,
    refundedPaise: 0,
  });
  assert.equal(partial.netPaidPaise, 40000);
  assert.equal(partial.duePaise, 60000);
  assert.equal(partial.status, BillStatus.PARTIALLY_PAID);

  const paid = computeBillPaymentProgress({
    totalPaise: 100000,
    succeededAllocatedPaise: 100000,
    refundedPaise: 0,
  });
  assert.equal(paid.duePaise, 0);
  assert.equal(paid.status, BillStatus.PAID);

  const refunded = computeBillPaymentProgress({
    totalPaise: 100000,
    succeededAllocatedPaise: 100000,
    refundedPaise: 25000,
  });
  assert.equal(refunded.netPaidPaise, 75000);
  assert.equal(refunded.duePaise, 25000);
  assert.equal(refunded.status, BillStatus.PARTIALLY_PAID);

  assert.equal(
    formatSequentialBillNumber(42, new Date('2026-11-11T12:00:00Z')),
    'INV-202611-00042',
  );
});

test('computeItemWiseGstBreakdown reconciles item-level taxable, discount, CGST and SGST paise to bill totals', () => {
  const totals = calculateBillTotalsPaise({
    itemsSubtotalPaise: 70000,
    discountPaise: 5000,
    gstRateBps: 500,
    taxMode: TaxMode.EXCLUSIVE,
    roundOffEnabled: false,
  });

  const rows = computeItemWiseGstBreakdown({
    itemLines: [
      {
        id: 'l1',
        orderItemId: 'oi1',
        description: 'Paneer Tikka',
        quantity: 1,
        unitAmountPaise: 29900,
        lineAmountPaise: 29900,
      },
      {
        id: 'l2',
        orderItemId: 'oi2',
        description: 'Dal Makhani',
        quantity: 2,
        unitAmountPaise: 20050,
        lineAmountPaise: 40100,
      },
    ],
    discountPaise: totals.discountPaise,
    taxMode: TaxMode.EXCLUSIVE,
    gstRateBps: 500,
    cgstPaise: totals.cgstPaise,
    sgstPaise: totals.sgstPaise,
  });

  assert.equal(rows.length, 2);
  assert.equal(rows.reduce((s, r) => s + r.discountSharePaise, 0), totals.discountPaise);
  assert.equal(rows.reduce((s, r) => s + r.taxablePaise, 0), totals.taxablePaise);
  assert.equal(rows.reduce((s, r) => s + r.cgstPaise, 0), totals.cgstPaise);
  assert.equal(rows.reduce((s, r) => s + r.sgstPaise, 0), totals.sgstPaise);
});


