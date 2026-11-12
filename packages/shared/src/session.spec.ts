import assert from 'node:assert/strict';
import test from 'node:test';
import { DiningSessionStatus, KitchenStatus } from './enums';
import { computeSessionBalanceSummary, mapSessionStatusToStage } from './session';

test('mapSessionStatusToStage maps all dining session lifecycle stages accurately', () => {
  assert.equal(mapSessionStatusToStage(null), 'AVAILABLE');
  assert.equal(mapSessionStatusToStage(undefined), 'AVAILABLE');
  assert.equal(mapSessionStatusToStage(DiningSessionStatus.ACTIVE), 'OPEN');
  assert.equal(mapSessionStatusToStage(DiningSessionStatus.BILL_REQUESTED), 'CHECKOUT_LOCKED');
  assert.equal(mapSessionStatusToStage(DiningSessionStatus.SETTLED), 'SETTLED');
  assert.equal(mapSessionStatusToStage(DiningSessionStatus.CLOSED), 'CLOSED');
});

test('computeSessionBalanceSummary sums active rounds, excludes cancelled orders/items, and splits CGST/SGST', () => {
  const summary = computeSessionBalanceSummary(
    [
      {
        kitchenStatus: KitchenStatus.SERVED,
        subtotalPaise: 50000,
        items: [
          { quantity: 2, status: 'ACTIVE' },
          { quantity: 0, status: 'CANCELLED' },
        ],
      },
      {
        kitchenStatus: KitchenStatus.PREPARING,
        subtotalPaise: 25000,
        items: [{ quantity: 1, status: 'ACTIVE' }],
      },
      {
        kitchenStatus: KitchenStatus.CANCELLED,
        subtotalPaise: 40000,
        items: [{ quantity: 2, status: 'CANCELLED' }],
      },
    ],
    500, // 5% GST
  );

  assert.equal(summary.activeOrdersCount, 2);
  assert.equal(summary.activeItemsCount, 3);
  assert.equal(summary.subtotalPaise, 75000);
  assert.equal(summary.cgstPaise, 1875);
  assert.equal(summary.sgstPaise, 1875);
  assert.equal(summary.totalTaxPaise, 3750);
  assert.equal(summary.estimatedTotalPaise, 78750);
});

