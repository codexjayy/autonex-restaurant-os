import assert from 'node:assert/strict';
import test from 'node:test';
import { StaffRole, SYSTEM_ROLE_SUPER_ADMIN } from '@autonex/types';
import { getPermissionsForRole, hasAllPermissions, hasPermission, Permissions } from './index';

test('OWNER receives full tenant & outlet permissions without platform admin', () => {
  assert.equal(hasPermission(StaffRole.OWNER, Permissions.TENANT_UPDATE), true);
  assert.equal(hasPermission(StaffRole.OWNER, Permissions.OUTLET_CREATE), true);
  assert.equal(hasPermission(StaffRole.OWNER, Permissions.ADMIN_PLATFORM), false);
});

test('WAITER is restricted from tenant/outlet administration and billing', () => {
  assert.equal(hasPermission(StaffRole.WAITER, Permissions.ORDER_CREATE), true);
  assert.equal(hasPermission(StaffRole.WAITER, Permissions.OUTLET_CREATE), false);
  assert.equal(hasPermission(StaffRole.WAITER, Permissions.BILLING_MANAGE), false);
});

test('hasAllPermissions validates multi-permission checks cleanly', () => {
  assert.equal(
    hasAllPermissions(StaffRole.MANAGER, [Permissions.OUTLET_READ, Permissions.STAFF_MANAGE]),
    true,
  );
  assert.equal(
    hasAllPermissions(StaffRole.MANAGER, [Permissions.OUTLET_CREATE]),
    false,
  );
  assert.ok(getPermissionsForRole(SYSTEM_ROLE_SUPER_ADMIN).includes(Permissions.ADMIN_PLATFORM));
});

