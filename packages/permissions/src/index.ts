import {
  ActorRole,
  RoleDefinitionDto,
  StaffRole,
  SYSTEM_ROLE_SUPER_ADMIN,
} from '@autonex/types';

export const Permissions = {
  TENANT_READ: 'tenant:read',
  TENANT_UPDATE: 'tenant:update',
  OUTLET_CREATE: 'outlet:create',
  OUTLET_READ: 'outlet:read',
  OUTLET_UPDATE: 'outlet:update',
  USER_READ: 'user:read',
  STAFF_READ: 'staff:read',
  STAFF_MANAGE: 'staff:manage',
  INVITATION_MANAGE: 'invitation:manage',
  ROLE_READ: 'role:read',
  SESSION_MANAGE: 'session:manage',
  MENU_READ: 'menu:read',
  MENU_WRITE: 'menu:write',
  TABLE_READ: 'table:read',
  TABLE_WRITE: 'table:write',
  ORDER_CREATE: 'order:create',
  ORDER_READ: 'order:read',
  KITCHEN_UPDATE: 'kitchen:update',
  BILLING_MANAGE: 'billing:manage',
  PAYMENT_MANAGE: 'payment:manage',
  ADMIN_PLATFORM: 'admin:platform',
} as const;

export type Permission = (typeof Permissions)[keyof typeof Permissions];

export const PERMISSION_CATALOG: Array<{
  code: Permission;
  name: string;
  module: string;
  description: string;
}> = [
  { code: Permissions.TENANT_READ, name: 'View Restaurant', module: 'tenancy', description: 'View restaurant tenant details and settings' },
  { code: Permissions.TENANT_UPDATE, name: 'Update Restaurant', module: 'tenancy', description: 'Update restaurant profile and tenant settings' },
  { code: Permissions.OUTLET_CREATE, name: 'Create Outlet', module: 'outlets', description: 'Create new restaurant outlets or branches' },
  { code: Permissions.OUTLET_READ, name: 'View Outlets', module: 'outlets', description: 'List and inspect outlet configurations' },
  { code: Permissions.OUTLET_UPDATE, name: 'Update Outlets', module: 'outlets', description: 'Modify outlet profile, GST, and service settings' },
  { code: Permissions.USER_READ, name: 'View Profile', module: 'users', description: 'View own user profile and active memberships' },
  { code: Permissions.STAFF_READ, name: 'View Staff', module: 'staff', description: 'List outlet staff memberships' },
  { code: Permissions.STAFF_MANAGE, name: 'Manage Staff', module: 'staff', description: 'Create, update, and deactivate staff accounts' },
  { code: Permissions.INVITATION_MANAGE, name: 'Manage Invitations', module: 'staff', description: 'Create and revoke staff invitations' },
  { code: Permissions.ROLE_READ, name: 'View Roles', module: 'rbac', description: 'Inspect available roles and permission matrix' },
  { code: Permissions.SESSION_MANAGE, name: 'Manage Auth Sessions', module: 'auth', description: 'Inspect and revoke active login sessions' },
  { code: Permissions.MENU_READ, name: 'View Menu', module: 'menus', description: 'Browse categories and menu items' },
  { code: Permissions.MENU_WRITE, name: 'Edit Menu', module: 'menus', description: 'Create and modify categories, items, and stock' },
  { code: Permissions.TABLE_READ, name: 'View Tables', module: 'tables', description: 'View dining floor tables and QR status' },
  { code: Permissions.TABLE_WRITE, name: 'Manage Tables & QR', module: 'tables', description: 'Create tables and generate/rotate QR codes' },
  { code: Permissions.ORDER_CREATE, name: 'Place Orders', module: 'ordering', description: 'Submit and modify customer or staff orders' },
  { code: Permissions.ORDER_READ, name: 'View Orders', module: 'ordering', description: 'View table session orders' },
  { code: Permissions.KITCHEN_UPDATE, name: 'Update Kitchen Tickets', module: 'kitchen', description: 'Acknowledge and advance KDS ticket states' },
  { code: Permissions.BILLING_MANAGE, name: 'Manage Bills', module: 'billing', description: 'Generate consolidated bills and discounts' },
  { code: Permissions.PAYMENT_MANAGE, name: 'Record Payments', module: 'payments', description: 'Process cash/card/UPI settlements and refunds' },
  { code: Permissions.ADMIN_PLATFORM, name: 'Platform Super Admin', module: 'admin', description: 'Manage tenants, plans, and platform telemetry' },
];

export const SYSTEM_ROLE_PERMISSIONS: Record<ActorRole, Permission[]> = {
  [StaffRole.OWNER]: Object.values(Permissions).filter((p) => p !== Permissions.ADMIN_PLATFORM),
  [StaffRole.MANAGER]: [
    Permissions.TENANT_READ,
    Permissions.OUTLET_READ,
    Permissions.OUTLET_UPDATE,
    Permissions.USER_READ,
    Permissions.STAFF_READ,
    Permissions.STAFF_MANAGE,
    Permissions.INVITATION_MANAGE,
    Permissions.ROLE_READ,
    Permissions.SESSION_MANAGE,
    Permissions.MENU_READ,
    Permissions.MENU_WRITE,
    Permissions.TABLE_READ,
    Permissions.TABLE_WRITE,
    Permissions.ORDER_CREATE,
    Permissions.ORDER_READ,
    Permissions.KITCHEN_UPDATE,
    Permissions.BILLING_MANAGE,
    Permissions.PAYMENT_MANAGE,
  ],
  [StaffRole.CASHIER]: [
    Permissions.TENANT_READ,
    Permissions.OUTLET_READ,
    Permissions.USER_READ,
    Permissions.ROLE_READ,
    Permissions.MENU_READ,
    Permissions.TABLE_READ,
    Permissions.ORDER_CREATE,
    Permissions.ORDER_READ,
    Permissions.BILLING_MANAGE,
    Permissions.PAYMENT_MANAGE,
  ],
  [StaffRole.WAITER]: [
    Permissions.USER_READ,
    Permissions.MENU_READ,
    Permissions.TABLE_READ,
    Permissions.ORDER_CREATE,
    Permissions.ORDER_READ,
    Permissions.KITCHEN_UPDATE,
  ],
  [StaffRole.KITCHEN]: [
    Permissions.USER_READ,
    Permissions.MENU_READ,
    Permissions.MENU_WRITE,
    Permissions.ORDER_READ,
    Permissions.KITCHEN_UPDATE,
  ],
  [SYSTEM_ROLE_SUPER_ADMIN]: Object.values(Permissions),
};

export const SYSTEM_ROLE_DEFINITIONS: RoleDefinitionDto[] = [
  {
    code: StaffRole.OWNER,
    name: 'Restaurant Owner',
    description: 'Full access across restaurant tenant, outlets, billing, settings, and staff.',
    isSystem: true,
    permissions: SYSTEM_ROLE_PERMISSIONS[StaffRole.OWNER],
  },
  {
    code: StaffRole.MANAGER,
    name: 'Outlet Manager',
    description: 'Manages daily outlet operations, non-owner staff, menus, tables, and settlements.',
    isSystem: true,
    permissions: SYSTEM_ROLE_PERMISSIONS[StaffRole.MANAGER],
  },
  {
    code: StaffRole.CASHIER,
    name: 'Counter Cashier',
    description: 'Handles consolidated billing, GST invoices, and cash/card/UPI settlement.',
    isSystem: true,
    permissions: SYSTEM_ROLE_PERMISSIONS[StaffRole.CASHIER],
  },
  {
    code: StaffRole.WAITER,
    name: 'Waiter / Captain',
    description: 'Activates dining tables, assists ordering, and serves ready kitchen tickets.',
    isSystem: true,
    permissions: SYSTEM_ROLE_PERMISSIONS[StaffRole.WAITER],
  },
  {
    code: StaffRole.KITCHEN,
    name: 'Kitchen Staff',
    description: 'Operates KDS tickets and out-of-stock toggles in real time.',
    isSystem: true,
    permissions: SYSTEM_ROLE_PERMISSIONS[StaffRole.KITCHEN],
  },
];

export function getPermissionsForRole(role: ActorRole | string | undefined): Permission[] {
  if (!role) return [];
  return SYSTEM_ROLE_PERMISSIONS[role as ActorRole] ?? [];
}

export function hasPermission(role: ActorRole | string | undefined, permission: Permission): boolean {
  const perms = getPermissionsForRole(role);
  return perms.includes(permission);
}

export function hasAllPermissions(
  role: ActorRole | string | undefined,
  required: Permission[],
): boolean {
  if (required.length === 0) return true;
  const perms = getPermissionsForRole(role);
  return required.every((p) => perms.includes(p));
}

