import {
  BillAuditEntryDto,
  BillItemGstDto,
  BillLineDto,
  BillStatus,
  BillSummaryDto,
  BillingAnalyticsDto,
  BillingPeriodBucketDto,
  DietaryType,
  DiningSessionStatus,
  GuestJoinStatus,
  KdsBoardPayload,
  KdsTicketPayload,
  KitchenStation,
  KitchenStatus,
  OrderSource,
  PaymentAttemptDto,
  PaymentMethod,
  PaymentStatus,
  PlanDto,
  PlatformOverviewDto,
  RefundDto,
  RestaurantUsageTelemetryDto,
  SelectionType,
  SessionBalanceSummary,
  SessionLifecycleStage,
  SubscriptionBillingCycle,
  SubscriptionInvoiceDto,
  SubscriptionInvoiceStatus,
  SubscriptionStatus,
  SubscriptionSummaryDto,
  SupportCaseCategory,
  SupportCaseDto,
  SupportCaseNoteDto,
  SupportCasePriority,
  SupportCaseStatus,
  TaxMode,
  TenantStatus,
} from '@autonex/shared';

export {
  BillStatus,
  PaymentMethod,
  PaymentStatus,
  SubscriptionBillingCycle,
  SubscriptionInvoiceStatus,
  SubscriptionStatus,
  SupportCaseCategory,
  SupportCasePriority,
  SupportCaseStatus,
  TaxMode,
  TenantStatus,
};
export type {
  BillAuditEntryDto,
  BillItemGstDto,
  BillLineDto,
  BillSummaryDto,
  BillingAnalyticsDto,
  BillingPeriodBucketDto,
  PaymentAttemptDto,
  PlanDto,
  PlatformOverviewDto,
  RefundDto,
  RestaurantUsageTelemetryDto,
  SubscriptionInvoiceDto,
  SubscriptionSummaryDto,
  SupportCaseDto,
  SupportCaseNoteDto,
};

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/+$/, '') || 'http://localhost:4000/api/v1';

export const WS_BASE_URL = API_BASE_URL.replace(/\/api\/v1$/, '');

const STORAGE_KEY = 'autonex_auth_session';
const SUPER_ADMIN_STORAGE_KEY = 'autonex_super_admin_session';
const WORKSPACE_SYNC_CHANNEL = 'autonex_workspace_sync';
const WORKSPACE_SYNC_STORAGE_KEY = 'autonex_workspace_sync_ts';

export type SessionScope = 'tenant' | 'super-admin';

function resolveSessionScope(scopeOrPath?: SessionScope | string): SessionScope {
  if (scopeOrExplicitIsScope(scopeOrPath)) return scopeOrPath;
  if (typeof scopeOrPath === 'string') {
    if (scopeOrPath.startsWith('/admin') || scopeOrPath.startsWith('/auth/super-admin')) {
      return 'super-admin';
    }
    return 'tenant';
  }
  if (typeof window !== 'undefined' && window.location.pathname.startsWith('/super-admin')) {
    return 'super-admin';
  }
  return 'tenant';
}

function scopeOrExplicitIsScope(v: unknown): v is SessionScope {
  return v === 'tenant' || v === 'super-admin';
}

export interface AuthSession {
  accessToken: string;
  user: {
    id: string;
    name: string;
    email?: string | null;
    phone: string;
    role: string;
    isSuperAdmin?: boolean;
    requiresPasswordChange?: boolean;
    tenantId?: string;
    outletId?: string;
    tenantStatus?: string;
  };
  tenant?: {
    id: string;
    name: string;
    slug: string;
    status: TenantStatus;
  };
  outlet?: {
    id: string;
    name: string;
    timezone: string;
  };
}

export interface OnboardingChecklistResponse {
  tenantStatus: TenantStatus;
  steps: {
    profileComplete: boolean;
    adminApproved: boolean;
    staffAdded: boolean;
    menuConfigured: boolean;
    tablesConfigured: boolean;
    qrGenerated: boolean;
  };
  counts?: {
    staffCount: number;
    menuItemsCount: number;
    tablesCount: number;
    activeQrCount: number;
  };
  goLiveReady: boolean;
}

export interface ModifierOptionDto {
  id: string;
  name: string;
  priceDeltaPaise: number;
  inStock: boolean;
  isDefault: boolean;
  sortOrder: number;
}

export interface ModifierGroupDto {
  id: string;
  name: string;
  selectionType: SelectionType;
  isRequired: boolean;
  minSelect: number;
  maxSelect: number;
  sortOrder: number;
  options: ModifierOptionDto[];
}

export interface MenuItemDto {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  dietaryType: DietaryType;
  kitchenStation?: KitchenStation;
  basePricePaise: number;
  imageUrl: string | null;
  prepTimeMinutes: number | null;
  gstRateBps: number | null;
  taxMode: TaxMode | null;
  inStock: boolean;
  isActive: boolean;
  sortOrder: number;
  modifierGroups: ModifierGroupDto[];
}

export interface MenuCategoryDto {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  menuItems: MenuItemDto[];
}

export interface TableDto {
  id: string;
  tableNumber: string;
  label: string | null;
  floorSection: string | null;
  capacity: number;
  status: string;
  isActive: boolean;
  activeQr: {
    id: string;
    qrVersion: number;
    qrUrl: string;
    createdAt: string;
  } | null;
}

export interface PublicQrResponse {
  restaurant: {
    name: string;
    outletName: string;
    address: string | null;
    logoUrl: string | null;
  };
  table: {
    id: string;
    tableNumber: string;
    label: string | null;
    qrVersion: number;
  };
  tenantStatus?: TenantStatus;
  orderingBlocked?: boolean;
  sessionPolicy: {
    sessionCreatedOnScan: boolean;
    hasActiveSession: boolean;
    activeSessionStatus: DiningSessionStatus | null;
    requireWaiterApproval: boolean;
    tablePinEnabled: boolean;
    orderingBlocked?: boolean;
  };
  categories: Array<{
    id: string;
    name: string;
    sortOrder: number;
    menuItems: PublicMenuItemDto[];
  }>;
}

export type PublicMenuItemDto = Omit<MenuItemDto, 'categoryId' | 'isActive'>;

export interface ModifierSnapshotItem {
  groupId: string;
  groupName: string;
  optionId: string;
  optionName: string;
  priceDeltaPaise: number;
}

export interface OrderItemSnapshotDto {
  id: string;
  menuItemId: string;
  itemNameSnapshot: string;
  dietaryTypeSnapshot: DietaryType;
  basePricePaiseSnapshot: number;
  modifiersSnapshotJson: ModifierSnapshotItem[];
  unitPricePaise: number;
  quantity: number;
  lineTotalPaise: number;
  prepNotes: string | null;
  status: string;
}

export interface OrderDto {
  id: string;
  sessionId: string;
  roundNumber: number;
  kotNumber: number;
  isAddOn: boolean;
  source: OrderSource;
  kitchenStatus: KitchenStatus;
  subtotalPaise: number;
  notes: string | null;
  createdAt: string;
  items: OrderItemSnapshotDto[];
}

export interface JoinSessionResponse {
  guestToken: string;
  guestId: string;
  displayLabel: string;
  status: GuestJoinStatus;
  sessionId: string;
  tableNumber: string;
}

export interface ActiveBillBriefDto {
  id: string;
  billNumber: string;
  status: BillStatus | string;
  subtotalPaise: number;
  discountPaise: number;
  taxMode: TaxMode | string;
  gstRateBps: number;
  cgstPaise: number;
  sgstPaise: number;
  roundOffPaise: number;
  totalPaise: number;
  paidPaise: number;
  refundedPaise: number;
  netPaidPaise: number;
  duePaise: number;
}

export interface RazorpayOrderResponse {
  attemptId: string;
  billId?: string;
  gatewayOrderId: string | null;
  keyId?: string;
  amountPaise: number;
  currency: 'INR';
  qrPayloadUrl: string | null;
  isMock: boolean;
  mockCheckoutHint?: {
    razorpayOrderId: string;
    razorpayPaymentId?: string;
    razorpaySignature?: string;
  };
  idempotentReplay: boolean;
}

export interface VerifyPaymentResponse {
  attempt: PaymentAttemptDto;
  idempotentReplay: boolean;
  lateWebhookOverpayment: boolean;
}

export interface ReconcileResultDto {
  scanned: number;
  capturedCount: number;
  failedCount: number;
  stillPendingCount: number;
}

export interface CustomerSessionStateResponse {
  hasActiveSession: boolean;
  sessionId?: string;
  lifecycleStage?: SessionLifecycleStage;
  sessionStatus: DiningSessionStatus | null;
  billRequestedAt?: string | null;
  settledAt?: string | null;
  guestStatus: GuestJoinStatus | null;
  displayLabel?: string;
  orders: OrderDto[];
  runningTotalPaise: number;
  balance?: SessionBalanceSummary;
  activeBill?: ActiveBillBriefDto | null;
}

export interface RequestBillResponse {
  id: string;
  tableId: string;
  status: DiningSessionStatus;
  lifecycleStage: SessionLifecycleStage;
  billRequestedAt: string | null;
  balance: SessionBalanceSummary;
  alreadyLocked: boolean;
}

export interface PlaceOrderResponse {
  order: OrderDto;
  idempotentReplay: boolean;
}

export type KdsBoardResponse = KdsBoardPayload;

export interface KdsAcknowledgeResponse {
  order: KdsTicketPayload;
  alreadyAcknowledged: boolean;
}

export interface KdsTransitionResponse {
  order: KdsTicketPayload;
  idempotentReplay: boolean;
}

export interface FloorSessionTableDto {
  id: string;
  tableNumber: string;
  label: string | null;
  floorSection?: string | null;
  capacity: number;
  tableStatus: string;
  lifecycleStage?: SessionLifecycleStage;
  activeSession: {
    id: string;
    status: DiningSessionStatus;
    lifecycleStage?: SessionLifecycleStage;
    joinCode: string | null;
    joinCodeExpiresAt?: string | null;
    openedAt: string;
    billRequestedAt?: string | null;
    settledAt?: string | null;
    runningTotalPaise: number;
    balance?: SessionBalanceSummary | null;
    activeBill?: ActiveBillBriefDto | null;
    readyToServeCount?: number;
    unackedCount?: number;
    pendingGuestsCount: number;
    guests: Array<{
      id: string;
      displayLabel: string | null;
      status: GuestJoinStatus;
      joinedAt: string;
      approvedAt: string | null;
    }>;
    orders: OrderDto[];
  } | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function getStoredSession(scope?: SessionScope): AuthSession | null {
  if (typeof window === 'undefined') return null;
  const resolved = resolveSessionScope(scope);
  const storageKey = resolved === 'super-admin' ? SUPER_ADMIN_STORAGE_KEY : STORAGE_KEY;
  const raw = window.localStorage.getItem(storageKey);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AuthSession;
    // Heal legacy mixed storage: never return a tenant-less Super Admin token for tenant dashboard calls
    if (resolved === 'tenant' && parsed?.user?.isSuperAdmin && !parsed.user?.tenantId) {
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function setStoredSession(session: AuthSession, scope?: SessionScope): void {
  if (typeof window === 'undefined') return;
  const resolved =
    scope ??
    (session.user?.isSuperAdmin && !session.user?.tenantId
      ? 'super-admin'
      : resolveSessionScope());
  const storageKey = resolved === 'super-admin' ? SUPER_ADMIN_STORAGE_KEY : STORAGE_KEY;
  window.localStorage.setItem(storageKey, JSON.stringify(session));
}

export function clearStoredSession(scope?: SessionScope): void {
  if (typeof window === 'undefined') return;
  const resolved = resolveSessionScope(scope);
  const storageKey = resolved === 'super-admin' ? SUPER_ADMIN_STORAGE_KEY : STORAGE_KEY;
  window.localStorage.removeItem(storageKey);
}

export async function ensureFreshAccessToken(scope?: SessionScope): Promise<string | null> {
  return tryRefreshAccessToken(scope);
}

function decodeJwtClaims(token: string): {
  sub?: string;
  role?: string;
  isSuperAdmin?: boolean;
  tenantId?: string | null;
  outletId?: string | null;
  tenantStatus?: TenantStatus;
} | null {
  try {
    const segment = token.split('.')[1];
    if (!segment || typeof atob !== 'function') return null;
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    return JSON.parse(atob(padded)) as {
      sub?: string;
      role?: string;
      isSuperAdmin?: boolean;
      tenantId?: string | null;
      outletId?: string | null;
      tenantStatus?: TenantStatus;
    };
  } catch {
    return null;
  }
}

const inFlightRefresh: Partial<Record<SessionScope, Promise<string | null>>> = {};

async function tryRefreshAccessToken(scope?: SessionScope): Promise<string | null> {
  const resolved = resolveSessionScope(scope);
  const existingPromise = inFlightRefresh[resolved];
  if (existingPromise) {
    return existingPromise;
  }

  const refreshTask = (async (): Promise<string | null> => {
    try {
      const csrfCookieName = resolved === 'super-admin' ? 'anx_sa_csrf' : 'anx_csrf';
      const refreshEndpoint =
        resolved === 'super-admin' ? '/auth/super-admin/refresh' : '/auth/refresh';
      const csrfToken = readCookie(csrfCookieName);
      if (!csrfToken) return null;
      const res = await fetch(`${API_BASE_URL}${refreshEndpoint}`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({}),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { accessToken?: string };
      if (!data.accessToken) return null;
      const claims = decodeJwtClaims(data.accessToken);
      if (resolved === 'tenant' && (!claims?.tenantId || claims?.isSuperAdmin)) {
        clearStoredSession('tenant');
        return null;
      }
      const current = getStoredSession(resolved);
      if (current) {
        setStoredSession(
          {
            ...current,
            accessToken: data.accessToken,
            user: {
              ...current.user,
              ...(claims?.role ? { role: claims.role } : {}),
              ...(claims?.isSuperAdmin !== undefined ? { isSuperAdmin: claims.isSuperAdmin } : {}),
              ...(claims?.tenantId ? { tenantId: claims.tenantId } : {}),
              ...(claims?.outletId ? { outletId: claims.outletId } : {}),
              ...(claims?.tenantStatus ? { tenantStatus: claims.tenantStatus } : {}),
            },
            ...(claims?.tenantStatus && current.tenant
              ? {
                  tenant: {
                    ...current.tenant,
                    status: claims.tenantStatus,
                  },
                }
              : {}),
          },
          resolved,
        );
      } else if (claims?.sub && claims?.role) {
        setStoredSession(
          {
            accessToken: data.accessToken,
            user: {
              id: claims.sub,
              name: claims.isSuperAdmin ? 'Super Admin' : 'User',
              phone: '',
              role: claims.role,
              isSuperAdmin: claims.isSuperAdmin === true,
              ...(claims.tenantId ? { tenantId: claims.tenantId } : {}),
              ...(claims.outletId ? { outletId: claims.outletId } : {}),
              ...(claims.tenantStatus ? { tenantStatus: claims.tenantStatus } : {}),
            },
          },
          resolved,
        );
      }
      return data.accessToken;
    } catch {
      return null;
    } finally {
      delete inFlightRefresh[resolved];
    }
  })();

  inFlightRefresh[resolved] = refreshTask;
  return refreshTask;
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit & { auth?: boolean } = {},
): Promise<T> {
  const { auth = true, headers, ...rest } = options;
  const scope = resolveSessionScope(path);
  const session = auth ? getStoredSession(scope) : null;

  const buildHeaders = (token?: string): HeadersInit => {
    const isFormData = typeof FormData !== 'undefined' && rest.body instanceof FormData;
    const csrfCookieName = scope === 'super-admin' ? 'anx_sa_csrf' : 'anx_csrf';
    const csrfToken = readCookie(csrfCookieName);
    return {
      ...(!isFormData ? { 'Content-Type': 'application/json' } : {}),
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers ?? {}),
    };
  };

  const performFetch = async (token?: string): Promise<Response> => {
    try {
      return await fetch(`${API_BASE_URL}${path}`, {
        ...rest,
        credentials: 'include',
        headers: buildHeaders(token),
      });
    } catch {
      throw new ApiError(
        `Cannot reach AutoNex API at ${API_BASE_URL}. Ensure the backend server and PostgreSQL are running.`,
        0,
        'NETWORK_ERROR',
      );
    }
  };

  let res = await performFetch(session?.accessToken);

  if (auth && res.status === 401) {
    const nextToken = await tryRefreshAccessToken(scope);
    if (nextToken) {
      res = await performFetch(nextToken);
    } else {
      clearStoredSession(scope);
    }
  }

  if (!res.ok) {
    let errBody: { message?: string; code?: string; details?: unknown } = {};
    try {
      errBody = (await res.json()) as { message?: string; code?: string; details?: unknown };
    } catch {
      errBody = {};
    }
    const rawDetail =
      Array.isArray(errBody.details) && errBody.details.length > 0
        ? errBody.details[0]
        : null;
    const firstDetail =
      typeof rawDetail === 'string'
        ? rawDetail
        : rawDetail &&
            typeof rawDetail === 'object' &&
            'message' in rawDetail &&
            typeof (rawDetail as { message?: unknown }).message === 'string'
          ? (rawDetail as { message: string }).message
          : null;
    const baseMessage = errBody.message || `Request failed (${res.status})`;
    const message =
      firstDetail && firstDetail !== baseMessage
        ? `${baseMessage}: ${firstDetail}`
        : baseMessage;
    throw new ApiError(
      message,
      res.status,
      errBody.code,
      errBody.details,
    );
  }

  return (await res.json()) as T;
}

export async function downloadProtectedPdf(path: string, fallbackFilename: string): Promise<void> {
  const session = getStoredSession();
  let res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'GET',
    credentials: 'include',
    headers: session?.accessToken ? { Authorization: `Bearer ${session.accessToken}` } : {},
  });

  if (res.status === 401) {
    const nextToken = await tryRefreshAccessToken();
    if (nextToken) {
      res = await fetch(`${API_BASE_URL}${path}`, {
        method: 'GET',
        credentials: 'include',
        headers: { Authorization: `Bearer ${nextToken}` },
      });
    }
  }

  if (!res.ok) {
    throw new ApiError(`Failed to generate PDF (${res.status})`, res.status);
  }

  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') ?? '';
  const match = disposition.match(/filename="?([^"]+)"?/i);
  const filename = match?.[1] || fallbackFilename;

  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(url);
}


export interface TenantSettingsRecord {
  id: string;
  tenantId: string;
  currency: string;
  locale: string;
  defaultTimezone: string;
  onboardingCompleted: boolean;
  onboardingStep: number;
}

export interface TenantCurrentDto {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  approvedAt: string | null;
  outletCount?: number;
  settings?: TenantSettingsRecord | null;
}

export interface OutletSettingsRecord {
  id: string;
  tenantId: string;
  outletId: string;
  taxMode: 'EXCLUSIVE' | 'INCLUSIVE' | 'NONE';
  gstRateBps: number;
  roundOffEnabled: boolean;
  requireWaiterApproval: boolean;
  tablePinEnabled: boolean;
  kdsLanguage: string;
  receiptFooter: string | null;
}

export interface OutletRecordDto {
  id: string;
  tenantId: string;
  name: string;
  contactPhone: string;
  address: string | null;
  logoUrl: string | null;
  timezone: string;
  gstin: string | null;
  gstRateBps: number;
  taxMode: 'EXCLUSIVE' | 'INCLUSIVE' | 'NONE';
  roundOffEnabled: boolean;
  requireWaiterApproval: boolean;
  tablePinEnabled: boolean;
  isActive: boolean;
  settings?: OutletSettingsRecord | null;
}

export interface UserMeProfileDto {
  id: string;
  name: string;
  email: string | null;
  phone: string;
  isSuperAdmin: boolean;
  requiresPasswordChange?: boolean;
  mfaEnabled: boolean;
  tenantId?: string;
  outletId?: string;
  membershipId?: string;
  role: string;
  tenantStatus?: string;
  permissions: string[];
  memberships: Array<{
    membershipId: string;
    tenantId: string;
    tenantName: string;
    tenantStatus: string;
    outletId: string;
    outletName: string;
    role: string;
  }>;
}

export interface RoleMatrixDto {
  id?: string;
  code: string;
  name: string;
  description: string;
  isSystem: boolean;
  permissions: string[];
}

export interface InvitationRecordDto {
  id: string;
  tenantId: string;
  outletId: string;
  email: string | null;
  phone: string;
  name: string;
  role: string;
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface AuthSessionRecordDto {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  isActive: boolean;
}

export function getUsersMe() {
  return apiRequest<UserMeProfileDto>('/users/me');
}

export async function updateUsersMe(payload: { name?: string; email?: string }) {
  const res = await apiRequest<UserMeProfileDto>('/users/me', {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  notifyWorkspaceUpdated();
  return res;
}

function notifyWorkspaceUpdated(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('autonex:workspace-updated'));
  }
}

export function broadcastWorkspaceSync(tenantId?: string): void {
  notifyWorkspaceUpdated();
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      WORKSPACE_SYNC_STORAGE_KEY,
      JSON.stringify({ ts: Date.now(), tenantId: tenantId ?? null }),
    );
  } catch {
    // Ignore storage quota issues
  }
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      const ch = new BroadcastChannel(WORKSPACE_SYNC_CHANNEL);
      ch.postMessage({ type: 'WORKSPACE_SYNC', tenantId: tenantId ?? null, ts: Date.now() });
      ch.close();
    } catch {
      // Ignore BroadcastChannel errors
    }
  }
}

export function subscribeWorkspaceSync(onSync: (tenantId?: string | null) => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const handleLocalEvent = () => onSync(undefined);
  const handleStorageEvent = (e: StorageEvent) => {
    if (e.key === WORKSPACE_SYNC_STORAGE_KEY && e.newValue) {
      try {
        const parsed = JSON.parse(e.newValue) as { tenantId?: string | null };
        onSync(parsed.tenantId);
      } catch {
        onSync(undefined);
      }
    }
  };
  const handleVisibility = () => {
    if (document.visibilityState === 'visible') onSync(undefined);
  };
  const handleFocus = () => onSync(undefined);

  window.addEventListener('autonex:workspace-updated', handleLocalEvent);
  window.addEventListener('storage', handleStorageEvent);
  window.addEventListener('focus', handleFocus);
  document.addEventListener('visibilitychange', handleVisibility);

  let channel: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      channel = new BroadcastChannel(WORKSPACE_SYNC_CHANNEL);
      channel.onmessage = (ev: MessageEvent<{ tenantId?: string | null }>) => {
        onSync(ev.data?.tenantId);
      };
    } catch {
      channel = null;
    }
  }

  return () => {
    window.removeEventListener('autonex:workspace-updated', handleLocalEvent);
    window.removeEventListener('storage', handleStorageEvent);
    window.removeEventListener('focus', handleFocus);
    document.removeEventListener('visibilitychange', handleVisibility);
    channel?.close();
  };
}

export function getCurrentTenant() {
  return apiRequest<TenantCurrentDto>('/tenants/current');
}

export async function updateCurrentTenant(payload: {
  name?: string;
  currency?: string;
  locale?: string;
  defaultTimezone?: string;
  onboardingCompleted?: boolean;
  onboardingStep?: number;
}) {
  const res = await apiRequest<TenantCurrentDto>('/tenants/current', {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  notifyWorkspaceUpdated();
  return res;
}

export function listOutlets() {
  return apiRequest<OutletRecordDto[]>('/outlets');
}

export async function createOutlet(payload: {
  name: string;
  contactPhone: string;
  address?: string;
  timezone?: string;
  gstin?: string;
  gstRateBps?: number;
  taxMode?: 'EXCLUSIVE' | 'INCLUSIVE' | 'NONE';
  roundOffEnabled?: boolean;
  requireWaiterApproval?: boolean;
  tablePinEnabled?: boolean;
  kdsLanguage?: 'en' | 'gu' | 'hi';
  receiptFooter?: string;
}) {
  const res = await apiRequest<OutletRecordDto>('/outlets', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  notifyWorkspaceUpdated();
  return res;
}

export async function updateOutlet(
  outletId: string,
  payload: Partial<{
    name: string;
    contactPhone: string;
    address: string;
    timezone: string;
    gstin: string;
    gstRateBps: number;
    taxMode: 'EXCLUSIVE' | 'INCLUSIVE' | 'NONE';
    roundOffEnabled: boolean;
    requireWaiterApproval: boolean;
    tablePinEnabled: boolean;
    isActive: boolean;
    kdsLanguage: 'en' | 'gu' | 'hi';
    receiptFooter: string;
  }>,
) {
  const res = await apiRequest<OutletRecordDto>(`/outlets/${outletId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  notifyWorkspaceUpdated();
  return res;
}

export async function softDeleteOutlet(outletId: string) {
  const res = await apiRequest<{ id: string; deletedAt: string }>(`/outlets/${outletId}`, {
    method: 'DELETE',
  });
  notifyWorkspaceUpdated();
  return res;
}

export async function switchOutlet(outletId: string) {
  const res = await apiRequest<{
    accessToken: string;
    refreshToken: string;
    outlet: { id: string; name: string; timezone: string };
    role: string;
    permissions: string[];
  }>('/auth/switch-outlet', {
    method: 'POST',
    body: JSON.stringify({ outletId }),
  });

  const current = getStoredSession();
  if (current) {
    setStoredSession({
      ...current,
      accessToken: res.accessToken,
      outlet: res.outlet,
      user: {
        ...current.user,
        outletId: res.outlet.id,
        role: res.role,
      },
    });
  }
  notifyWorkspaceUpdated();
  return res;
}

export function listRoles() {
  return apiRequest<RoleMatrixDto[]>('/roles');
}

export function listInvitations() {
  return apiRequest<InvitationRecordDto[]>('/auth/invitations');
}

export function createInvitation(payload: {
  outletId?: string;
  name: string;
  phone: string;
  email?: string;
  role: string;
}) {
  return apiRequest<{ invitation: InvitationRecordDto; inviteToken: string }>(
    '/auth/invitations',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  );
}

export function revokeInvitation(invitationId: string) {
  return apiRequest<{ id: string; status: string; revokedAt: string }>(
    `/auth/invitations/${invitationId}/revoke`,
    { method: 'POST' },
  );
}

export function listAuthSessions() {
  return apiRequest<AuthSessionRecordDto[]>('/auth/sessions');
}

export function revokeAuthSession(sessionId: string) {
  return apiRequest<{ id: string; revokedAt: string }>(`/auth/sessions/${sessionId}/revoke`, {
    method: 'POST',
  });
}

export async function logoutSession(scope?: SessionScope): Promise<void> {
  const resolved = resolveSessionScope(scope);
  const endpoint = resolved === 'super-admin' ? '/auth/super-admin/logout' : '/auth/logout';
  try {
    await apiRequest<{ ok: boolean }>(endpoint, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  } catch {
    // Clear client session even if token was already expired/revoked
  } finally {
    clearStoredSession(resolved);
  }
}

export function getBillingAnalytics() {
  return apiRequest<BillingAnalyticsDto>('/billing/analytics');
}

export function getBillAuditLogs(billId: string) {
  return apiRequest<BillAuditEntryDto[]>(`/billing/bills/${billId}/audit`);
}

export function generateSessionBill(
  sessionId: string,
  payload: {
    discountPaise?: number;
    discountPercentBps?: number;
    discountReason?: string;
    refresh?: boolean;
  } = {},
) {
  return apiRequest<{ bill: BillSummaryDto; alreadyExisted: boolean }>(
    `/billing/sessions/${sessionId}/bill`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  );
}

export function applyBillDiscount(
  billId: string,
  payload: {
    discountPaise?: number;
    discountPercentBps?: number;
    reason: string;
  },
) {
  return apiRequest<BillSummaryDto>(`/billing/bills/${billId}/discount`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function reopenDiningSession(sessionId: string) {
  return apiRequest<{ status: string }>(`/sessions/${sessionId}/reopen`, {
    method: 'POST',
  });
}

export function modifySessionOrderItems(
  sessionId: string,
  orderId: string,
  payload: {
    items: Array<{ orderItemId: string; quantity: number }>;
    reason?: string;
  },
) {
  return apiRequest<{ order: OrderDto; cancelledWholeOrder: boolean }>(
    `/sessions/${sessionId}/orders/${orderId}/items`,
    {
      method: 'PATCH',
      body: JSON.stringify(payload),
    },
  );
}

export interface AdminRestaurantOwnerSummary {
  id: string;
  name: string;
  email: string | null;
  phone: string;
}

export interface AdminOutletSummary {
  id: string;
  name: string;
  contactPhone: string;
  address: string;
  gstin?: string | null;
  gstRateBps?: number;
  taxMode?: string;
  timezone: string;
  isActive: boolean;
  requireWaiterApproval?: boolean;
  tablePinEnabled?: boolean;
}

export interface AdminRestaurantRow {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  approvedAt: string | null;
  rejectedAt?: string | null;
  rejectionReason?: string | null;
  suspendedAt?: string | null;
  suspensionReason?: string | null;
  pendingSuspensionAfterService?: boolean;
  createdAt: string;
  owner?: AdminRestaurantOwnerSummary | null;
  revenueTotalPaise?: number;
  activeOpenSessionsCount?: number;
  outlets: AdminOutletSummary[];
  subscription?: {
    id: string;
    status: SubscriptionStatus;
    billingCycle: SubscriptionBillingCycle;
    trialEndsAt: string | null;
    currentPeriodEnd: string | null;
    plan: PlanDto;
  } | null;
  _count: {
    memberships: number;
    diningSessions: number;
    orders: number;
    supportCases: number;
  };
}

export interface AdminRestaurantDetail extends AdminRestaurantRow {
  approvedByUser?: { id: string; name: string; email: string | null } | null;
  rejectedByUser?: { id: string; name: string; email: string | null } | null;
  memberships: Array<{
    id: string;
    role: string;
    isActive: boolean;
    createdAt: string;
    user: AdminRestaurantOwnerSummary;
  }>;
  telemetry: RestaurantUsageTelemetryDto | null;
  subscriptionInvoices: SubscriptionInvoiceDto[];
  supportCases: SupportCaseDto[];
  auditLogs: Array<{
    id: string;
    action: string;
    actorRole: string;
    createdAt: string;
    afterJson?: unknown;
  }>;
}

export interface AdminOverviewResponse {
  overview: PlatformOverviewDto;
  restaurantsTelemetry: Array<{
    tenantId: string;
    tenantName: string;
    status: TenantStatus;
    planName: string | null;
    subscriptionStatus: SubscriptionStatus | null;
    telemetry: RestaurantUsageTelemetryDto;
  }>;
}

export interface AdminAuditLogEntry {
  id: string;
  tenantId: string;
  action: string;
  actorRole: string;
  entityType: string;
  entityId: string;
  createdAt: string;
  afterJson?: unknown;
  tenant?: { id: string; name: string } | null;
  actorUser?: { id: string; name: string; email: string | null } | null;
}

export function getAdminPlatformOverview() {
  return apiRequest<AdminOverviewResponse>('/admin/analytics/overview');
}

export function listAdminRestaurants(status?: string) {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  return apiRequest<AdminRestaurantRow[]>(`/admin/restaurants${qs}`);
}

export function getAdminRestaurantDetail(tenantId: string) {
  return apiRequest<AdminRestaurantDetail>(`/admin/restaurants/${tenantId}`);
}

export function approveAdminRestaurant(
  tenantId: string,
  payload: { targetStatus?: 'ACTIVE' | 'TRIAL'; note?: string } = { targetStatus: 'ACTIVE' },
) {
  return apiRequest(`/admin/restaurants/${tenantId}/approve`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function rejectAdminRestaurant(tenantId: string, reason: string) {
  return apiRequest(`/admin/restaurants/${tenantId}/reject`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export function suspendAdminRestaurant(tenantId: string, reason: string) {
  return apiRequest(`/admin/restaurants/${tenantId}/suspend`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export function reactivateAdminRestaurant(
  tenantId: string,
  payload: { targetStatus?: 'ACTIVE' | 'TRIAL' | 'GRACE'; reason?: string } = {},
) {
  return apiRequest(`/admin/restaurants/${tenantId}/reactivate`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function offboardAdminRestaurant(tenantId: string, reason: string) {
  return apiRequest(`/admin/restaurants/${tenantId}/offboard`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export interface SuperAdminSetupStatus {
  initialized: boolean;
  requiresSetupToken: boolean;
}

export interface SuperAdminAuthResponse {
  accessToken: string;
  user: AuthSession['user'];
}

export function getSuperAdminSetupStatus() {
  return apiRequest<SuperAdminSetupStatus>('/auth/super-admin/setup-status', {
    auth: false,
  });
}

export function setupInitialSuperAdmin(payload: {
  name: string;
  email: string;
  phone: string;
  password: string;
  setupToken?: string;
}) {
  return apiRequest<SuperAdminAuthResponse>('/auth/super-admin/setup', {
    method: 'POST',
    auth: false,
    body: JSON.stringify(payload),
  });
}

export function superAdminLogin(payload: { identifier: string; password: string }) {
  return apiRequest<SuperAdminAuthResponse>('/auth/super-admin/login', {
    method: 'POST',
    auth: false,
    body: JSON.stringify(payload),
  });
}

export function requestSuperAdminPasswordReset(identifier: string) {
  return apiRequest<{ ok: boolean; message: string }>('/auth/super-admin/forgot-password', {
    method: 'POST',
    auth: false,
    body: JSON.stringify({ identifier }),
  });
}

export function resetSuperAdminPassword(payload: { token: string; newPassword: string }) {
  return apiRequest<{ ok: boolean; message: string }>('/auth/super-admin/reset-password', {
    method: 'POST',
    auth: false,
    body: JSON.stringify(payload),
  });
}

export function getAdminMe() {
  return apiRequest<UserMeProfileDto>('/admin/me');
}

export function changeSuperAdminPassword(payload: {
  currentPassword: string;
  newPassword: string;
}) {
  return apiRequest<{ ok: boolean; message: string }>('/admin/security/change-password', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export interface WorkspaceOverviewResponse {
  tenant: {
    id: string;
    name: string;
    slug: string;
    status: TenantStatus;
    createdAt: string;
    approvedAt: string | null;
    rejectedAt: string | null;
    rejectionReason: string | null;
    suspendedAt: string | null;
    suspensionReason: string | null;
    pendingSuspensionAfterService: boolean;
    settings: {
      currency?: string;
      locale?: string;
      defaultTimezone?: string;
    } | null;
  };
  activeOutlet: {
    id: string;
    name: string;
    contactPhone: string;
    address: string | null;
    gstin: string | null;
    gstRateBps: number;
    taxMode: string;
    timezone: string;
  };
  outletsCount: number;
  subscription: {
    id: string;
    status: SubscriptionStatus | string;
    billingCycle: SubscriptionBillingCycle | string;
    planName: string;
    planCode: string;
    startedAt: string;
    trialEndsAt: string | null;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    graceEndsAt: string | null;
    expiryDate: string | null;
    daysRemaining: number | null;
    maxOutlets: number;
    maxTables: number;
    maxStaff: number;
  } | null;
  metrics: {
    staffCount: number;
    pendingInvitationsCount: number;
    totalTables: number;
    availableTables: number;
    occupiedTables: number;
    reservedTables: number;
    activeQrCount: number;
    categoriesCount: number;
    menuItemsCount: number;
    ordersTodayCount: number;
    activeKitchenOrdersCount: number;
    revenueTodayPaise: number;
    sessionsTodayCount: number;
    activeSessionsCount: number;
  };
  checklist: {
    steps: {
      profileComplete: boolean;
      adminApproved: boolean;
      staffAdded: boolean;
      menuConfigured: boolean;
      tablesConfigured: boolean;
      qrGenerated: boolean;
    };
    completedCount: number;
    totalCount: number;
    progressPercent: number;
    goLiveReady: boolean;
  };
  recentActivity: Array<{
    id: string;
    action: string;
    entityType: string;
    entityId: string;
    actorRole: string;
    actorName: string;
    createdAt: string;
  }>;
}

export function getWorkspaceOverview() {
  return apiRequest<WorkspaceOverviewResponse>('/outlet/overview');
}

export interface AdminSubscriptionRow {
  id: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  tenantStatus: TenantStatus;
  plan: PlanDto;
  status: SubscriptionStatus;
  billingCycle: SubscriptionBillingCycle;
  startedAt: string;
  trialEndsAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  graceEndsAt: string | null;
  autoRenew: boolean;
}

export interface AdminPaymentsResponse {
  summary: {
    mrrPaise: number;
    totalSubscriptionRevenuePaise: number;
    pendingSubscriptionRevenuePaise: number;
    todayRestaurantRevenuePaise: number;
    last30DaysRestaurantRevenuePaise: number;
  };
  subscriptionInvoices: Array<
    SubscriptionInvoiceDto & {
      tenantId: string;
      tenantName: string;
      tenantStatus: TenantStatus;
    }
  >;
  restaurantRevenueBreakdown: Array<{
    tenantId: string;
    tenantName: string;
    status: TenantStatus;
    todayRevenuePaise: number;
    todayBillsCount: number;
    last30DaysRevenuePaise: number;
    last30DaysBillsCount: number;
  }>;
}

export interface AdminPlatformUserDto {
  id: string;
  name: string;
  email: string | null;
  phone: string;
  isSuperAdmin: boolean;
  isActive: boolean;
  lastLoginAt: string | null;
  failedLoginAttempts: number;
  lockedUntil: string | null;
  createdAt: string;
  memberships: Array<{
    id: string;
    role: string;
    isActive: boolean;
    tenantId: string;
    tenantName: string;
    tenantStatus: TenantStatus;
    outletId: string;
    outletName: string;
  }>;
}

export interface PlatformSettingsDto {
  id: string;
  platformName: string;
  supportEmail: string;
  supportPhone: string;
  defaultTrialDays: number;
  defaultGraceDays: number;
  saasGstRateBps: number;
  autoApproveRegistrations: boolean;
  maintenanceMode: boolean;
  maintenanceMessage: string | null;
  updatedByUserId: string | null;
  updatedAt: string;
}

export function listAdminSubscriptions() {
  return apiRequest<AdminSubscriptionRow[]>('/admin/subscriptions');
}

export function updateAdminPlan(planId: string, payload: Partial<PlanDto>) {
  return apiRequest<PlanDto>(`/admin/plans/${planId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function extendAdminTrial(tenantId: string, days: number, reason?: string) {
  return apiRequest(`/admin/restaurants/${tenantId}/trial/extend`, {
    method: 'POST',
    body: JSON.stringify({ days, ...(reason ? { reason } : {}) }),
  });
}

export function runAdminSubscriptionSweep() {
  return apiRequest<{ transitionedCount?: number }>('/admin/subscriptions/sweep', {
    method: 'POST',
  });
}

export function getAdminPayments() {
  return apiRequest<AdminPaymentsResponse>('/admin/payments');
}

export function markAdminInvoicePaid(
  invoiceId: string,
  payload: { paymentRef?: string; notes?: string } = {},
) {
  return apiRequest<SubscriptionInvoiceDto>(`/admin/payments/invoices/${invoiceId}/mark-paid`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function listAdminUsers(params?: {
  scope?: 'all' | 'super_admins' | 'tenant_users';
  role?: string;
  search?: string;
}) {
  const sp = new URLSearchParams();
  if (params?.scope) sp.set('scope', params.scope);
  if (params?.role) sp.set('role', params.role);
  if (params?.search) sp.set('search', params.search);
  const qs = sp.toString();
  return apiRequest<AdminPlatformUserDto[]>(`/admin/users${qs ? `?${qs}` : ''}`);
}

export function createSuperAdminAccount(payload: {
  name: string;
  email: string;
  phone: string;
  password: string;
}) {
  return apiRequest<AdminPlatformUserDto>('/admin/users/super-admin', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updateAdminUserStatus(
  userId: string,
  payload: { isActive: boolean; reason?: string },
) {
  return apiRequest(`/admin/users/${userId}/status`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function getAdminPlatformSettings() {
  return apiRequest<PlatformSettingsDto>('/admin/settings');
}

export function updateAdminPlatformSettings(
  payload: Partial<
    Pick<
      PlatformSettingsDto,
      | 'platformName'
      | 'supportEmail'
      | 'supportPhone'
      | 'defaultTrialDays'
      | 'defaultGraceDays'
      | 'saasGstRateBps'
      | 'autoApproveRegistrations'
      | 'maintenanceMode'
      | 'maintenanceMessage'
    >
  >,
) {
  return apiRequest<PlatformSettingsDto>('/admin/settings', {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export type PlatformRealtimeEventType =
  | 'restaurant.approved'
  | 'restaurant.rejected'
  | 'restaurant.suspended'
  | 'restaurant.reactivated'
  | 'outlet.created'
  | 'outlet.updated'
  | 'subscription.updated'
  | 'trial.updated'
  | 'menu.updated'
  | 'order.created'
  | 'order.updated'
  | 'payment.updated';

export interface PlatformRealtimeEvent {
  id: string;
  type: PlatformRealtimeEventType;
  tenantId: string;
  outletId?: string | null;
  timestamp: string;
  payload: Record<string, unknown>;
}

const REALTIME_EVENT_TYPES: PlatformRealtimeEventType[] = [
  'restaurant.approved',
  'restaurant.rejected',
  'restaurant.suspended',
  'restaurant.reactivated',
  'outlet.created',
  'outlet.updated',
  'subscription.updated',
  'trial.updated',
  'menu.updated',
  'order.created',
  'order.updated',
  'payment.updated',
];

export function subscribeRealtimeStream(
  scope: SessionScope,
  onEvent: (event: PlatformRealtimeEvent) => void,
): () => void {
  if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
    return () => {};
  }

  let closed = false;
  let source: EventSource | null = null;
  let retryTimer: number | null = null;

  const connect = async (refreshFirst = false) => {
    if (closed) return;
    const token = refreshFirst
      ? await ensureFreshAccessToken(scope)
      : (getStoredSession(scope)?.accessToken ?? (await ensureFreshAccessToken(scope)));

    if (closed || !token) return;

    try {
      source?.close();
      const url = `${API_BASE_URL}/events/stream?token=${encodeURIComponent(token)}`;
      const es = new EventSource(url, { withCredentials: true });
      source = es;

      for (const eventType of REALTIME_EVENT_TYPES) {
        es.addEventListener(eventType, (evt) => {
          try {
            const parsed = JSON.parse((evt as MessageEvent<string>).data) as PlatformRealtimeEvent;
            onEvent(parsed);
            window.dispatchEvent(new CustomEvent('autonex:realtime', { detail: parsed }));
          } catch {
            // ignore malformed event payload
          }
        });
      }

      es.onerror = () => {
        es.close();
        source = null;
        if (!closed && retryTimer === null) {
          retryTimer = window.setTimeout(() => {
            retryTimer = null;
            void connect(true);
          }, 5000);
        }
      };
    } catch {
      if (!closed && retryTimer === null) {
        retryTimer = window.setTimeout(() => {
          retryTimer = null;
          void connect(true);
        }, 5000);
      }
    }
  };

  void connect(false);

  return () => {
    closed = true;
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
    source?.close();
    source = null;
  };
}




