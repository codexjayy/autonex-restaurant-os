import assert from 'node:assert/strict';
import test from 'node:test';
import { SubscriptionStatus, TenantStatus } from './enums';
import {
  evaluateSubscriptionLifecycle,
  formatSubscriptionInvoiceNumber,
  formatSupportCaseNumber,
} from './subscriptions';

test('evaluateSubscriptionLifecycle handles 14d trial -> 3d grace -> locked transition cleanly', () => {
  const baseNow = new Date('2026-11-15T12:00:00.000Z');

  // 1. Active trial with 5 days remaining
  const trialRes = evaluateSubscriptionLifecycle({
    subscriptionStatus: SubscriptionStatus.TRIAL,
    tenantStatus: TenantStatus.TRIAL,
    trialEndsAt: new Date(baseNow.getTime() + 5 * 24 * 60 * 60 * 1000),
    currentPeriodEnd: null,
    graceEndsAt: null,
    now: baseNow,
  });
  assert.equal(trialRes.effectiveSubscriptionStatus, SubscriptionStatus.TRIAL);
  assert.equal(trialRes.targetTenantStatus, TenantStatus.TRIAL);
  assert.equal(trialRes.daysRemaining, 5);
  assert.equal(trialRes.orderingBlocked, false);

  // 2. Trial expired 1 day ago -> 2 days left in 3-day grace period
  const graceRes = evaluateSubscriptionLifecycle({
    subscriptionStatus: SubscriptionStatus.TRIAL,
    tenantStatus: TenantStatus.TRIAL,
    trialEndsAt: new Date(baseNow.getTime() - 1 * 24 * 60 * 60 * 1000),
    currentPeriodEnd: null,
    graceEndsAt: null,
    graceDays: 3,
    now: baseNow,
  });
  assert.equal(graceRes.effectiveSubscriptionStatus, SubscriptionStatus.GRACE);
  assert.equal(graceRes.targetTenantStatus, TenantStatus.GRACE);
  assert.equal(graceRes.inGracePeriod, true);
  assert.equal(graceRes.graceDaysRemaining, 2);
  assert.equal(graceRes.orderingBlocked, false);

  // 3. Trial expired 5 days ago -> Grace period over -> EXPIRED / LOCKED read-only (settlement still enabled!)
  const lockedRes = evaluateSubscriptionLifecycle({
    subscriptionStatus: SubscriptionStatus.TRIAL,
    tenantStatus: TenantStatus.GRACE,
    trialEndsAt: new Date(baseNow.getTime() - 5 * 24 * 60 * 60 * 1000),
    currentPeriodEnd: null,
    graceEndsAt: null,
    graceDays: 3,
    now: baseNow,
  });
  assert.equal(lockedRes.effectiveSubscriptionStatus, SubscriptionStatus.EXPIRED);
  assert.equal(lockedRes.targetTenantStatus, TenantStatus.LOCKED);
  assert.equal(lockedRes.isReadOnlyLocked, true);
  assert.equal(lockedRes.orderingBlocked, true);
  assert.equal(lockedRes.canSettleExistingSessions, true);
});

test('evaluateSubscriptionLifecycle protects live mid-meal service when suspension is pending or active with open tables', () => {
  const drainRes = evaluateSubscriptionLifecycle({
    subscriptionStatus: SubscriptionStatus.ACTIVE,
    tenantStatus: TenantStatus.ACTIVE,
    trialEndsAt: null,
    currentPeriodEnd: new Date('2026-12-01T00:00:00.000Z'),
    graceEndsAt: null,
    pendingSuspensionAfterService: true,
    activeOpenSessionsCount: 3,
  });
  assert.equal(drainRes.targetTenantStatus, TenantStatus.LOCKED);
  assert.equal(drainRes.orderingBlocked, true);
  assert.equal(drainRes.canSettleExistingSessions, true);

  const drainedRes = evaluateSubscriptionLifecycle({
    subscriptionStatus: SubscriptionStatus.ACTIVE,
    tenantStatus: TenantStatus.ACTIVE,
    trialEndsAt: null,
    currentPeriodEnd: new Date('2026-12-01T00:00:00.000Z'),
    graceEndsAt: null,
    pendingSuspensionAfterService: true,
    activeOpenSessionsCount: 0,
  });
  assert.equal(drainedRes.targetTenantStatus, TenantStatus.SUSPENDED);
  assert.equal(drainedRes.canSettleExistingSessions, false);

  assert.equal(formatSupportCaseNumber(7, new Date('2026-11-11T00:00:00Z')), 'SUP-202611-0007');
  assert.equal(
    formatSubscriptionInvoiceNumber(12, new Date('2026-11-11T00:00:00Z')),
    'SUB-202611-00012',
  );
});

