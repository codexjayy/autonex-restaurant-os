import assert from 'node:assert/strict';
import test from 'node:test';
import { StaffRole } from '@autonex/types';
import {
  createInvitationSchema,
  createOutletSchema,
  loginSchema,
  registerRestaurantSchema,
} from './index';

test('registerRestaurantSchema accepts valid restaurant onboarding payload', () => {
  const parsed = registerRestaurantSchema.safeParse({
    restaurantName: 'Gujarat Thali House',
    outletName: 'CG Road Branch',
    ownerName: 'Mahesh Desai',
    email: 'mahesh@thali.in',
    phone: '+919825012345',
    password: 'StrongPassword123!',
    pin: '1234',
    address: 'CG Road, Ahmedabad',
  });
  assert.equal(parsed.success, true);
});

test('registerRestaurantSchema rejects invalid phone or short PIN', () => {
  const bad = registerRestaurantSchema.safeParse({
    restaurantName: 'Test',
    outletName: 'Main',
    ownerName: 'Owner',
    email: 'not-an-email',
    phone: '123',
    password: 'short',
    pin: '12',
  });
  assert.equal(bad.success, false);
});

test('loginSchema and createOutletSchema validate cleanly', () => {
  assert.equal(loginSchema.safeParse({ identifier: 'owner@thali.in', password: 'Password123' }).success, true);
  assert.equal(
    createOutletSchema.safeParse({ name: 'Satellite Branch', contactPhone: '+919876543210' }).success,
    true,
  );
  assert.equal(
    createInvitationSchema.safeParse({
      name: 'Ramesh',
      phone: '+919811112222',
      role: StaffRole.WAITER,
    }).success,
    true,
  );
});

