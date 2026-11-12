export enum TenantStatus {
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  TRIAL = 'TRIAL',
  ACTIVE = 'ACTIVE',
  GRACE = 'GRACE',
  LOCKED = 'LOCKED',
  SUSPENDED = 'SUSPENDED',
  REJECTED = 'REJECTED',
}

export enum StaffRole {
  OWNER = 'OWNER',
  MANAGER = 'MANAGER',
  CASHIER = 'CASHIER',
  WAITER = 'WAITER',
  KITCHEN = 'KITCHEN',
}

export enum InvitationStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  REVOKED = 'REVOKED',
  EXPIRED = 'EXPIRED',
}

export enum TaxMode {
  EXCLUSIVE = 'EXCLUSIVE',
  INCLUSIVE = 'INCLUSIVE',
  NONE = 'NONE',
}

export const SYSTEM_ROLE_SUPER_ADMIN = 'SUPER_ADMIN' as const;
export type ActorRole = StaffRole | typeof SYSTEM_ROLE_SUPER_ADMIN;

export interface AccessJwtPayload {
  sub: string;
  tenantId?: string;
  outletId?: string;
  membershipId?: string;
  role: ActorRole;
  isSuperAdmin: boolean;
  tenantStatus?: TenantStatus;
}

export interface AuthenticatedPrincipal {
  userId: string;
  tenantId?: string;
  outletId?: string;
  membershipId?: string;
  role: ActorRole;
  isSuperAdmin: boolean;
  tenantStatus?: TenantStatus;
}

export interface TenantSettingsDto {
  id: string;
  tenantId: string;
  currency: string;
  locale: string;
  defaultTimezone: string;
  onboardingCompleted: boolean;
  onboardingStep: number;
}

export interface TenantSummaryDto {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  approvedAt: string | null;
  settings?: TenantSettingsDto | null;
}

export interface OutletSettingsDto {
  id: string;
  tenantId: string;
  outletId: string;
  taxMode: TaxMode;
  gstRateBps: number;
  roundOffEnabled: boolean;
  requireWaiterApproval: boolean;
  tablePinEnabled: boolean;
  kdsLanguage: string;
  receiptFooter: string | null;
}

export interface OutletSummaryDto {
  id: string;
  tenantId: string;
  name: string;
  contactPhone: string;
  address: string | null;
  logoUrl: string | null;
  timezone: string;
  gstin: string | null;
  gstRateBps: number;
  taxMode: TaxMode;
  roundOffEnabled: boolean;
  requireWaiterApproval: boolean;
  tablePinEnabled: boolean;
  isActive: boolean;
  settings?: OutletSettingsDto | null;
}

export interface MembershipSummaryDto {
  membershipId: string;
  tenantId: string;
  tenantName: string;
  tenantStatus: TenantStatus;
  outletId: string;
  outletName: string;
  role: ActorRole;
}

export interface UserMeDto {
  id: string;
  name: string;
  email: string | null;
  phone: string;
  isSuperAdmin: boolean;
  mfaEnabled: boolean;
  tenantId?: string;
  outletId?: string;
  membershipId?: string;
  role: ActorRole;
  tenantStatus?: TenantStatus;
  permissions: string[];
  memberships: MembershipSummaryDto[];
}

export interface InvitationDto {
  id: string;
  tenantId: string;
  outletId: string;
  email: string | null;
  phone: string;
  name: string;
  role: StaffRole;
  status: InvitationStatus;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface RoleDefinitionDto {
  code: string;
  name: string;
  description: string;
  isSystem: boolean;
  permissions: string[];
}

