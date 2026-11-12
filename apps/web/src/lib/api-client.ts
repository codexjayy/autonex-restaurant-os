import {
  BillLineDto,
  BillStatus,
  BillSummaryDto,
  DietaryType,
  DiningSessionStatus,
  GuestJoinStatus,
  KdsBoardPayload,
  KdsTicketPayload,
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
  BillLineDto,
  BillSummaryDto,
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

export interface AuthSession {
  accessToken: string;
  user: {
    id: string;
    name: string;
    email: string | null;
    phone: string;
    role: string;
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
  basePricePaise: number;
  imageUrl: string | null;
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

export function getStoredSession(): AuthSession | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthSession;
  } catch {
    return null;
  }
}

export function setStoredSession(session: AuthSession): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearStoredSession(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(STORAGE_KEY);
}

export async function ensureFreshAccessToken(): Promise<string | null> {
  return tryRefreshAccessToken();
}

async function tryRefreshAccessToken(): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { accessToken?: string };
    if (!data.accessToken) return null;
    const current = getStoredSession();
    if (current) {
      setStoredSession({ ...current, accessToken: data.accessToken });
    }
    return data.accessToken;
  } catch {
    return null;
  }
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit & { auth?: boolean } = {},
): Promise<T> {
  const { auth = true, headers, ...rest } = options;
  const session = auth ? getStoredSession() : null;

  const buildHeaders = (token?: string): HeadersInit => {
    const isFormData = typeof FormData !== 'undefined' && rest.body instanceof FormData;
    return {
      ...(!isFormData ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers ?? {}),
    };
  };

  let res = await fetch(`${API_BASE_URL}${path}`, {
    ...rest,
    credentials: 'include',
    headers: buildHeaders(session?.accessToken),
  });

  if (auth && res.status === 401) {
    const nextToken = await tryRefreshAccessToken();
    if (nextToken) {
      res = await fetch(`${API_BASE_URL}${path}`, {
        ...rest,
        credentials: 'include',
        headers: buildHeaders(nextToken),
      });
    } else {
      clearStoredSession();
    }
  }

  if (!res.ok) {
    let errBody: { message?: string; code?: string; details?: unknown } = {};
    try {
      errBody = (await res.json()) as { message?: string; code?: string; details?: unknown };
    } catch {
      errBody = {};
    }
    throw new ApiError(
      errBody.message || `Request failed (${res.status})`,
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

