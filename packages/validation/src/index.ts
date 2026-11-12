import { z } from 'zod';
import { StaffRole, TaxMode } from '@autonex/types';

export const PHONE_REGEX = /^\+?[1-9]\d{9,14}$/;
export const PIN_REGEX = /^\d{4,6}$/;

export const registerRestaurantSchema = z.object({
  restaurantName: z.string().trim().min(2, 'Restaurant name must be at least 2 characters').max(120),
  outletName: z.string().trim().min(2, 'Outlet name must be at least 2 characters').max(120),
  ownerName: z.string().trim().min(2, 'Owner name must be at least 2 characters').max(100),
  email: z.string().trim().email('Enter a valid email address').max(160),
  phone: z.string().trim().regex(PHONE_REGEX, 'Enter a valid 10-15 digit phone number (e.g. +919876543210)'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(72, 'Password cannot exceed 72 characters'),
  pin: z.string().trim().regex(PIN_REGEX, 'PIN must be 4 to 6 digits'),
  address: z.string().trim().min(5, 'Address must be at least 5 characters').max(300).optional(),
  logoUrl: z.string().url('Enter a valid URL').optional(),
  timezone: z.string().trim().min(3).max(60).optional(),
  gstin: z.string().trim().min(10).max(20).optional(),
  gstRateBps: z.number().int().min(0).max(2800).optional(),
  currency: z.string().trim().min(3).max(10).optional(),
  locale: z.string().trim().min(2).max(20).optional(),
});

export const loginSchema = z.object({
  identifier: z.string().trim().min(4, 'Enter your email or phone number').max(160),
  password: z.string().min(6, 'Password must be at least 6 characters').max(72),
  outletId: z.string().uuid().optional(),
});

export const staffPinLoginSchema = z.object({
  outletId: z.string().uuid('Valid outlet ID required'),
  phone: z.string().trim().regex(PHONE_REGEX, 'Enter a valid 10-15 digit phone number'),
  pin: z.string().trim().regex(PIN_REGEX, 'PIN must be 4 to 6 digits'),
});

export const switchOutletSchema = z.object({
  outletId: z.string().uuid('Valid outlet ID required'),
});

export const updateTenantSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  currency: z.string().trim().min(3).max(10).optional(),
  locale: z.string().trim().min(2).max(20).optional(),
  defaultTimezone: z.string().trim().min(3).max(60).optional(),
  onboardingCompleted: z.boolean().optional(),
  onboardingStep: z.number().int().min(1).max(10).optional(),
});

export const createOutletSchema = z.object({
  name: z.string().trim().min(2, 'Outlet name must be at least 2 characters').max(120),
  contactPhone: z.string().trim().regex(PHONE_REGEX, 'Enter a valid 10-15 digit contact phone'),
  address: z.string().trim().min(5).max(300).optional(),
  timezone: z.string().trim().min(3).max(60).optional(),
  gstin: z.string().trim().min(10).max(20).optional(),
  gstRateBps: z.number().int().min(0).max(2800).optional(),
  taxMode: z.nativeEnum(TaxMode).optional(),
  roundOffEnabled: z.boolean().optional(),
  requireWaiterApproval: z.boolean().optional(),
  tablePinEnabled: z.boolean().optional(),
  kdsLanguage: z.enum(['en', 'gu', 'hi']).optional(),
  receiptFooter: z.string().trim().max(240).optional(),
});

export const updateOutletSchema = createOutletSchema.partial().extend({
  isActive: z.boolean().optional(),
  logoUrl: z.string().url().optional(),
});

export const createInvitationSchema = z.object({
  outletId: z.string().uuid().optional(),
  name: z.string().trim().min(2).max(100),
  phone: z.string().trim().regex(PHONE_REGEX, 'Enter a valid 10-15 digit phone number'),
  email: z.string().trim().email().max(160).optional(),
  role: z.nativeEnum(StaffRole),
});

export const acceptInvitationSchema = z.object({
  token: z.string().trim().min(16).max(256),
  name: z.string().trim().min(2).max(100).optional(),
  password: z.string().min(8).max(72).optional(),
  pin: z.string().trim().regex(PIN_REGEX, 'PIN must be 4 to 6 digits'),
});

export type RegisterRestaurantInput = z.infer<typeof registerRestaurantSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type StaffPinLoginInput = z.infer<typeof staffPinLoginSchema>;
export type SwitchOutletInput = z.infer<typeof switchOutletSchema>;
export type UpdateTenantInput = z.infer<typeof updateTenantSchema>;
export type CreateOutletInput = z.infer<typeof createOutletSchema>;
export type UpdateOutletInput = z.infer<typeof updateOutletSchema>;
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;

