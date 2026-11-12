'use client';

import {
  calculateBillTotalsPaise,
  formatInrFromPaise,
  StaffRole,
} from '@autonex/shared';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { io, Socket } from 'socket.io-client';
import {
  AlertTriangle,
  Banknote,
  Ban,
  BarChart3,
  CheckCircle2,
  CreditCard,
  Download,
  Edit3,
  History,
  Minus,
  Percent,
  Plus,
  Printer,
  QrCode,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Share2,
  ShieldCheck,
  Smartphone,
  Trash2,
  UtensilsCrossed,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { DashboardShell } from '@/components/dashboard-shell';
import {
  ApiError,
  apiRequest,
  applyBillDiscount,
  BillAuditEntryDto,
  BillingAnalyticsDto,
  BillingPeriodBucketDto,
  BillStatus,
  BillSummaryDto,
  downloadProtectedPdf,
  ensureFreshAccessToken,
  FloorSessionTableDto,
  generateSessionBill,
  getBillAuditLogs,
  getBillingAnalytics,
  getStoredSession,
  MenuCategoryDto,
  MenuItemDto,
  modifySessionOrderItems,
  OutletRecordDto,
  PaymentMethod,
  PaymentStatus,
  RazorpayOrderResponse,
  ReconcileResultDto,
  reopenDiningSession,
  subscribeWorkspaceSync,
  TaxMode,
  WS_BASE_URL,
} from '@/lib/api-client';

const DEFAULT_BILL_BADGE = {
  label: 'OPEN • DUE',
  className: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
};

const BILL_STATUS_BADGE: Record<string, { label: string; className: string }> = {
  [BillStatus.OPEN]: DEFAULT_BILL_BADGE,
  [BillStatus.PARTIALLY_PAID]: {
    label: 'PARTIALLY PAID',
    className: 'bg-sky-50 text-sky-800 ring-1 ring-sky-200',
  },
  [BillStatus.PAID]: {
    label: 'PAID',
    className: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200',
  },
  [BillStatus.VOID]: {
    label: 'VOIDED',
    className: 'bg-slate-200 text-slate-600',
  },
};

function getBillStatusBadge(status: string): { label: string; className: string } {
  return BILL_STATUS_BADGE[status] ?? DEFAULT_BILL_BADGE;
}

const TAX_MODE_LABEL: Record<string, string> = {
  [TaxMode.EXCLUSIVE]: 'GST Exclusive (+Tax added on top)',
  [TaxMode.INCLUSIVE]: 'GST Inclusive (Tax inside menu price)',
  [TaxMode.NONE]: 'No Tax / Composite Scheme Exempt',
};

const EDITABLE_KITCHEN_STATUSES = new Set(['NEW', 'ACKNOWLEDGED', 'PREPARING']);

interface OutletTaxSettings {
  taxMode: TaxMode;
  gstRateBps: number;
  roundOffEnabled: boolean;
  gstin: string;
}

type PaymentMethodTab = 'CASH' | 'UPI_MANUAL' | 'CARD' | 'RAZORPAY';
type SplitModeTab = 'FULL' | 'HALF' | 'THIRD' | 'QUARTER' | 'CUSTOM';
type ReportPeriodTab = 'DAILY' | 'WEEKLY' | 'MONTHLY';

function rupeesStrToPaise(input: string): number {
  const cleaned = Number(input.trim());
  if (!Number.isFinite(cleaned) || cleaned <= 0) return 0;
  return Math.round(cleaned * 100);
}

function makeIdempotencyKey(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 12)
      : Math.random().toString(36).slice(2, 12);
  return `${prefix}-${Date.now()}-${rand}`;
}

export default function BillingAndPaymentsPage() {
  const [bills, setBills] = useState<BillSummaryDto[]>([]);
  const [tables, setTables] = useState<FloorSessionTableDto[]>([]);
  const [analytics, setAnalytics] = useState<BillingAnalyticsDto | null>(null);
  const [menuCategories, setMenuCategories] = useState<MenuCategoryDto[]>([]);
  const [selectedBillId, setSelectedBillId] = useState<string | null>(null);
  const [billAuditLogs, setBillAuditLogs] = useState<BillAuditEntryDto[]>([]);
  const [loadingAudit, setLoadingAudit] = useState(false);

  const [statusFilter, setStatusFilter] = useState<'ALL' | BillStatus>('ALL');
  const [billSearchQuery, setBillSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [wsConnected, setWsConnected] = useState(false);
  const [userRole, setUserRole] = useState<string>(StaffRole.WAITER);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null,
  );
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Revenue reports panel state
  const [reportsOpen, setReportsOpen] = useState(false);
  const [reportPeriod, setReportPeriod] = useState<ReportPeriodTab>('DAILY');

  // Tax Configuration Drawer state
  const [taxDrawerOpen, setTaxDrawerOpen] = useState(false);
  const [outletId, setOutletId] = useState<string | null>(null);
  const [taxSettings, setTaxSettings] = useState<OutletTaxSettings>({
    taxMode: TaxMode.EXCLUSIVE,
    gstRateBps: 500,
    roundOffEnabled: true,
    gstin: '',
  });
  const [savingTax, setSavingTax] = useState(false);

  // Payment terminal state
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodTab>('CASH');
  const [splitMode, setSplitMode] = useState<SplitModeTab>('FULL');
  const [customSplitRupees, setCustomSplitRupees] = useState('');
  const [receiptRef, setReceiptRef] = useState('');
  const [razorpayOrder, setRazorpayOrder] = useState<RazorpayOrderResponse | null>(null);
  const [razorpayQrDataUrl, setRazorpayQrDataUrl] = useState<string | null>(null);

  // Generate New Bill / Pre-Bill Composer modal state
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerTableId, setComposerTableId] = useState<string>('');
  const [composerEditingBillId, setComposerEditingBillId] = useState<string | null>(null);
  const [composerMenuSearch, setComposerMenuSearch] = useState('');
  const [composerCart, setComposerCart] = useState<Record<string, number>>({});
  const [composerModifiers, setComposerModifiers] = useState<Record<string, string[]>>({});
  const [composerOrderNotes, setComposerOrderNotes] = useState('');
  const [composerOverrideReason, setComposerOverrideReason] = useState('');
  const [composerDiscountMode, setComposerDiscountMode] = useState<'NONE' | 'FIXED' | 'PERCENT'>(
    'NONE',
  );
  const [composerDiscountInput, setComposerDiscountInput] = useState('');
  const [composerDiscountReason, setComposerDiscountReason] = useState('');
  const [composerError, setComposerError] = useState<string | null>(null);

  // Discount / Void / Refund modals
  const [discountModalOpen, setDiscountModalOpen] = useState(false);
  const [discountType, setDiscountType] = useState<'PERCENT' | 'FIXED'>('PERCENT');
  const [discountAmountInput, setDiscountAmountInput] = useState('');
  const [discountReason, setDiscountReason] = useState('');

  const [voidModalOpen, setVoidModalOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');

  const [refundTargetAttemptId, setRefundTargetAttemptId] = useState<string | null>(null);
  const [refundRupees, setRefundRupees] = useState('');
  const [refundReason, setRefundReason] = useState('');

  const socketRef = useRef<Socket | null>(null);

  const canHandleMoney =
    userRole === StaffRole.OWNER ||
    userRole === StaffRole.MANAGER ||
    userRole === StaffRole.CASHIER;

  const canEditTaxSettings = userRole === StaffRole.OWNER || userRole === StaffRole.MANAGER;

  const loadData = useCallback(async () => {
    try {
      const stored = getStoredSession();
      if (stored?.user?.role) {
        setUserRole(stored.user.role);
      }
      const staffCanFinance =
        stored?.user?.role === StaffRole.OWNER ||
        stored?.user?.role === StaffRole.MANAGER ||
        stored?.user?.role === StaffRole.CASHIER;

      const [billList, floorTables, outlets, analyticsData, menuData] = await Promise.all([
        apiRequest<BillSummaryDto[]>('/billing/bills?limit=100'),
        apiRequest<FloorSessionTableDto[]>('/sessions'),
        apiRequest<OutletRecordDto[]>('/outlets').catch(() => [] as OutletRecordDto[]),
        staffCanFinance
          ? getBillingAnalytics().catch(() => null)
          : Promise.resolve(null),
        apiRequest<{ categories: MenuCategoryDto[] }>('/menus').catch(() => ({
          categories: [] as MenuCategoryDto[],
        })),
      ]);

      setBills(billList);
      setTables(floorTables);
      setAnalytics(analyticsData);
      setMenuCategories(menuData.categories);

      const currentOutlet =
        outlets.find((o) => o.id === stored?.user?.outletId) ?? outlets[0] ?? null;
      if (currentOutlet) {
        setOutletId(currentOutlet.id);
        setTaxSettings({
          taxMode: (currentOutlet.settings?.taxMode ??
            currentOutlet.taxMode ??
            'EXCLUSIVE') as TaxMode,
          gstRateBps: currentOutlet.settings?.gstRateBps ?? currentOutlet.gstRateBps ?? 500,
          roundOffEnabled:
            currentOutlet.settings?.roundOffEnabled ?? currentOutlet.roundOffEnabled ?? true,
          gstin: currentOutlet.gstin ?? '',
        });
      }

      setSelectedBillId((prev) => {
        if (prev && billList.some((b) => b.id === prev)) return prev;
        return billList[0]?.id ?? null;
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Unable to load billing workspace.',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
    return subscribeWorkspaceSync(() => {
      void loadData();
    });
  }, [loadData]);

  useEffect(() => {
    let active = true;
    async function connectWs() {
      const token =
        getStoredSession('tenant')?.accessToken || (await ensureFreshAccessToken('tenant'));
      if (!active || !token) return;

      const socket = io(`${WS_BASE_URL}/kds`, {
        transports: ['websocket', 'polling'],
        auth: { token },
        reconnection: true,
        reconnectionDelay: 1000,
      });

      socket.on('connect', () => {
        if (!active) return;
        setWsConnected(true);
        void loadData();
      });

      socket.on('disconnect', () => {
        if (!active) return;
        setWsConnected(false);
      });

      socket.on('billing.event', () => {
        if (active) void loadData();
      });

      socket.on('floor.event', () => {
        if (active) void loadData();
      });

      socket.on('kds.event', () => {
        if (active) void loadData();
      });

      socketRef.current = socket;
    }

    void connectWs();

    return () => {
      active = false;
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, [loadData]);

  const selectedBill = useMemo(
    () => bills.find((b) => b.id === selectedBillId) ?? bills[0] ?? null,
    [bills, selectedBillId],
  );

  // Load audit logs for selected bill
  useEffect(() => {
    if (!selectedBill || !canHandleMoney) {
      setBillAuditLogs([]);
      return;
    }
    let cancelled = false;
    setLoadingAudit(true);
    getBillAuditLogs(selectedBill.id)
      .then((logs) => {
        if (!cancelled) setBillAuditLogs(logs);
      })
      .catch(() => {
        if (!cancelled) setBillAuditLogs([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingAudit(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedBill, canHandleMoney]);

  // Render QR Code DataURL whenever Razorpay order updates
  useEffect(() => {
    let active = true;
    if (!razorpayOrder?.qrPayloadUrl) {
      setRazorpayQrDataUrl(null);
      return;
    }
    QRCode.toDataURL(razorpayOrder.qrPayloadUrl, {
      width: 200,
      margin: 1,
      color: { dark: '#0f172a', light: '#ffffff' },
    })
      .then((url) => {
        if (active) setRazorpayQrDataUrl(url);
      })
      .catch(() => {
        if (active) setRazorpayQrDataUrl(null);
      });
    return () => {
      active = false;
    };
  }, [razorpayOrder?.qrPayloadUrl]);

  const billCounts = useMemo(() => {
    let open = 0;
    let partial = 0;
    let paid = 0;
    let voided = 0;
    for (const b of bills) {
      if (b.status === BillStatus.OPEN) open += 1;
      else if (b.status === BillStatus.PARTIALLY_PAID) partial += 1;
      else if (b.status === BillStatus.PAID) paid += 1;
      else if (b.status === BillStatus.VOID) voided += 1;
    }
    return { ALL: bills.length, open, partial, paid, voided };
  }, [bills]);

  const filteredBills = useMemo(() => {
    const q = billSearchQuery.trim().toLowerCase();
    return bills.filter((b) => {
      if (statusFilter !== 'ALL' && b.status !== statusFilter) return false;
      if (!q) return true;
      return (
        b.billNumber.toLowerCase().includes(q) ||
        b.tableNumber.toLowerCase().includes(q) ||
        (b.tableLabel ?? '').toLowerCase().includes(q)
      );
    });
  }, [bills, statusFilter, billSearchQuery]);

  // Active tables that have orders and don't yet have a non-VOID bill
  const unbilledActiveTables = useMemo(() => {
    const billedSessionIds = new Set(
      bills.filter((b) => b.status !== BillStatus.VOID).map((b) => b.sessionId),
    );
    return tables.filter(
      (t) =>
        t.activeSession &&
        t.activeSession.orders.some(
          (o) => o.kitchenStatus !== 'CANCELLED' && o.items.some((i) => i.status === 'ACTIVE' && i.quantity > 0),
        ) &&
        !billedSessionIds.has(t.activeSession.id),
    );
  }, [bills, tables]);

  // Detect if selected OPEN bill's dining session has new unbilled items added after bill creation
  const selectedBillNeedsSync = useMemo(() => {
    if (!selectedBill || selectedBill.status !== BillStatus.OPEN || selectedBill.paidPaise > 0) {
      return false;
    }
    const matchingTable = tables.find((t) => t.activeSession?.id === selectedBill.sessionId);
    if (!matchingTable?.activeSession) return false;
    const sessionActiveSubtotal = matchingTable.activeSession.orders
      .filter((o) => o.kitchenStatus !== 'CANCELLED')
      .flatMap((o) => o.items)
      .filter((i) => i.status === 'ACTIVE' && i.quantity > 0)
      .reduce((s, i) => s + i.lineTotalPaise, 0);
    return sessionActiveSubtotal !== selectedBill.subtotalPaise;
  }, [selectedBill, tables]);

  const effectivePayPaise = useMemo(() => {
    if (!selectedBill || selectedBill.duePaise <= 0) return 0;
    const due = selectedBill.duePaise;
    if (splitMode === 'FULL') return due;
    if (splitMode === 'HALF') return Math.max(1, Math.min(due, Math.ceil(due / 2)));
    if (splitMode === 'THIRD') return Math.max(1, Math.min(due, Math.ceil(due / 3)));
    if (splitMode === 'QUARTER') return Math.max(1, Math.min(due, Math.ceil(due / 4)));
    return rupeesStrToPaise(customSplitRupees);
  }, [selectedBill, splitMode, customSplitRupees]);

  const composerTable = useMemo(
    () => tables.find((t) => t.id === composerTableId) ?? null,
    [tables, composerTableId],
  );

  const flatAvailableMenuItems = useMemo(() => {
    const query = composerMenuSearch.trim().toLowerCase();
    const list: Array<MenuItemDto & { categoryName: string }> = [];
    for (const cat of menuCategories) {
      for (const item of cat.menuItems) {
        if (!item.isActive || !item.inStock) continue;
        if (query && !item.name.toLowerCase().includes(query) && !cat.name.toLowerCase().includes(query)) {
          continue;
        }
        list.push({ ...item, categoryName: cat.name });
      }
    }
    return list;
  }, [menuCategories, composerMenuSearch]);

  const composerPreviewTotals = useMemo(() => {
    const existingItemsSubtotal = (composerTable?.activeSession?.orders ?? [])
      .filter((o) => o.kitchenStatus !== 'CANCELLED')
      .flatMap((o) => o.items)
      .filter((i) => i.status === 'ACTIVE' && i.quantity > 0)
      .reduce((sum, i) => sum + i.lineTotalPaise, 0);

    let cartSubtotal = 0;
    for (const cat of menuCategories) {
      for (const item of cat.menuItems) {
        const qty = composerCart[item.id] ?? 0;
        if (qty > 0) {
          const pickedIds = new Set(composerModifiers[item.id] ?? []);
          const modsDelta = (item.modifierGroups ?? [])
            .flatMap((g) => g.options)
            .filter((o) => pickedIds.has(o.id))
            .reduce((s, o) => s + o.priceDeltaPaise, 0);
          cartSubtotal += (item.basePricePaise + modsDelta) * qty;
        }
      }
    }

    const subtotal = existingItemsSubtotal + cartSubtotal;
    let discountPaise = 0;
    if (composerDiscountMode === 'FIXED') {
      discountPaise = Math.min(subtotal, rupeesStrToPaise(composerDiscountInput));
    } else if (composerDiscountMode === 'PERCENT') {
      const pct = Number(composerDiscountInput);
      if (Number.isFinite(pct) && pct > 0) {
        const bps = Math.min(10000, Math.round(pct * 100));
        discountPaise = Math.round((subtotal * bps) / 10000);
      }
    }

    const totals = calculateBillTotalsPaise({
      itemsSubtotalPaise: subtotal,
      discountPaise,
      gstRateBps: taxSettings.gstRateBps,
      taxMode: taxSettings.taxMode,
      roundOffEnabled: taxSettings.roundOffEnabled,
    });

    return { existingItemsSubtotal, cartSubtotal, totals };
  }, [
    composerTable,
    menuCategories,
    composerCart,
    composerModifiers,
    composerDiscountMode,
    composerDiscountInput,
    taxSettings,
  ]);

  const openBillComposer = (opts?: { tableId?: string; editingBill?: BillSummaryDto }) => {
    setComposerError(null);
    setComposerCart({});
    setComposerModifiers({});
    setComposerMenuSearch('');
    setComposerOrderNotes('');
    setComposerOverrideReason('');

    if (opts?.editingBill) {
      const matchingTable = tables.find(
        (t) => t.activeSession?.id === opts.editingBill!.sessionId,
      );
      setComposerTableId(matchingTable?.id ?? tables[0]?.id ?? '');
      setComposerEditingBillId(opts.editingBill.id);
      if (opts.editingBill.discountPaise > 0) {
        setComposerDiscountMode('FIXED');
        setComposerDiscountInput((opts.editingBill.discountPaise / 100).toFixed(2));
        setComposerDiscountReason(opts.editingBill.discountReason ?? '');
      } else {
        setComposerDiscountMode('NONE');
        setComposerDiscountInput('');
        setComposerDiscountReason('');
      }
    } else {
      const preferredTable =
        (opts?.tableId ? tables.find((t) => t.id === opts.tableId) : undefined) ??
        unbilledActiveTables[0] ??
        tables.find((t) => t.activeSession) ??
        tables[0];
      setComposerTableId(preferredTable?.id ?? '');
      setComposerEditingBillId(null);
      setComposerDiscountMode('NONE');
      setComposerDiscountInput('');
      setComposerDiscountReason('');
    }
    setComposerOpen(true);
  };

  const handleAdjustExistingOrderItem = async (
    sessionId: string,
    orderId: string,
    orderKitchenStatus: string,
    orderItemId: string,
    nextQuantity: number,
  ) => {
    if (!EDITABLE_KITCHEN_STATUSES.has(orderKitchenStatus)) {
      setComposerError(
        `Items in ${orderKitchenStatus} orders can no longer be modified from billing.`,
      );
      return;
    }
    if (orderKitchenStatus === 'PREPARING' && composerOverrideReason.trim().length < 3) {
      setComposerError(
        'Enter an override reason (min 3 chars) above to modify an order already PREPARING in kitchen.',
      );
      return;
    }

    setBusyKey(`edit-item:${orderItemId}`);
    setComposerError(null);
    try {
      const currentSessionStatus = composerTable?.activeSession?.status;
      if (currentSessionStatus === 'BILL_REQUESTED') {
        await reopenDiningSession(sessionId);
      }

      await modifySessionOrderItems(sessionId, orderId, {
        items: [{ orderItemId, quantity: Math.max(0, nextQuantity) }],
        ...(orderKitchenStatus === 'PREPARING'
          ? { reason: composerOverrideReason.trim() }
          : {}),
      });

      if (composerEditingBillId) {
        const res = await generateSessionBill(sessionId, { refresh: true });
        setComposerEditingBillId(res.bill.id);
        setSelectedBillId(res.bill.id);
      }
      await loadData();
    } catch (err) {
      setComposerError(
        err instanceof ApiError ? err.message : 'Unable to update item quantity.',
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleAddComposerCartAndGenerateBill = async (e: FormEvent) => {
    e.preventDefault();
    if (!composerTable) {
      setComposerError('Please select a dining table first.');
      return;
    }

    const cartEntries = Object.entries(composerCart).filter(([, qty]) => qty > 0);
    const hasExistingItems = composerPreviewTotals.existingItemsSubtotal > 0;
    if (cartEntries.length === 0 && !hasExistingItems) {
      setComposerError('Add at least one menu item to this table before generating a bill.');
      return;
    }

    const discountPayload: {
      discountPaise?: number;
      discountPercentBps?: number;
      discountReason?: string;
    } = {};

    if (composerDiscountMode !== 'NONE' && composerDiscountInput.trim()) {
      if (composerDiscountReason.trim().length < 3) {
        setComposerError('Please enter a discount reason (minimum 3 characters).');
        return;
      }
      discountPayload.discountReason = composerDiscountReason.trim();
      if (composerDiscountMode === 'FIXED') {
        const dp = rupeesStrToPaise(composerDiscountInput);
        if (dp <= 0 || dp > composerPreviewTotals.totals.itemsSubtotalPaise) {
          setComposerError('Fixed discount must be between ₹0.01 and the item subtotal.');
          return;
        }
        discountPayload.discountPaise = dp;
      } else {
        const pct = Number(composerDiscountInput);
        if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
          setComposerError('Discount percentage must be between 0.1% and 100%.');
          return;
        }
        discountPayload.discountPercentBps = Math.round(pct * 100);
      }
    }

    setBusyKey('composer-submit');
    setComposerError(null);
    setFeedback(null);

    try {
      let activeSessionId = composerTable.activeSession?.id ?? null;

      // If table has an active session in BILL_REQUESTED and we are adding new cart items, reopen first
      if (
        cartEntries.length > 0 &&
        composerTable.activeSession &&
        composerTable.activeSession.status === 'BILL_REQUESTED'
      ) {
        await reopenDiningSession(composerTable.activeSession.id);
      }

      // Send newly added cart items to DiningSession + Kitchen KDS via staff POS order endpoint
      if (cartEntries.length > 0) {
        const placed = await apiRequest<{ order: { sessionId: string } }>('/orders/staff', {
          method: 'POST',
          headers: { 'Idempotency-Key': makeIdempotencyKey('pos-bill-add') },
          body: JSON.stringify({
            tableId: composerTable.id,
            openIfAvailable: true,
            notes: composerOrderNotes.trim() || undefined,
            items: cartEntries.map(([menuItemId, quantity]) => {
              const selectedOptionIds = composerModifiers[menuItemId] ?? [];
              return {
                menuItemId,
                quantity,
                ...(selectedOptionIds.length > 0 ? { selectedOptionIds } : {}),
              };
            }),
          }),
        });
        activeSessionId = placed.order.sessionId;
      }

      if (!activeSessionId) {
        setComposerError('Unable to resolve active table dining session.');
        return;
      }

      const generated = await generateSessionBill(activeSessionId, {
        ...discountPayload,
        refresh: Boolean(composerEditingBillId) || cartEntries.length > 0,
      });

      await loadData();
      setSelectedBillId(generated.bill.id);
      setComposerOpen(false);
      setFeedback({
        type: 'success',
        text: composerEditingBillId
          ? `Bill ${generated.bill.billNumber} updated (${formatInrFromPaise(generated.bill.totalPaise)}).`
          : generated.alreadyExisted
            ? `Loaded active bill ${generated.bill.billNumber}.`
            : `GST Bill ${generated.bill.billNumber} generated (${formatInrFromPaise(generated.bill.totalPaise)}).`,
      });
    } catch (err) {
      setComposerError(
        err instanceof ApiError ? err.message : 'Unable to generate bill from selection.',
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleQuickGenerateBill = async (sessionId: string) => {
    setBusyKey(`gen:${sessionId}`);
    setFeedback(null);
    try {
      const res = await generateSessionBill(sessionId, {});
      await loadData();
      setSelectedBillId(res.bill.id);
      setFeedback({
        type: 'success',
        text: res.alreadyExisted
          ? `Loaded existing bill ${res.bill.billNumber}.`
          : `Consolidated bill ${res.bill.billNumber} generated (${formatInrFromPaise(res.bill.totalPaise)}).`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Unable to generate consolidated bill.',
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleSyncOpenBillWithOrders = async (bill: BillSummaryDto) => {
    setBusyKey(`sync:${bill.id}`);
    setFeedback(null);
    try {
      const res = await generateSessionBill(bill.sessionId, { refresh: true });
      await loadData();
      setSelectedBillId(res.bill.id);
      setFeedback({
        type: 'success',
        text: `Bill ${res.bill.billNumber} synced with latest table orders (${formatInrFromPaise(res.bill.totalPaise)}).`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Unable to sync bill with latest orders.',
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleSaveTaxSettings = async (e: FormEvent) => {
    e.preventDefault();
    if (!outletId) return;
    setSavingTax(true);
    setFeedback(null);
    try {
      await apiRequest(`/outlets/${outletId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          taxMode: taxSettings.taxMode,
          gstRateBps: taxSettings.gstRateBps,
          roundOffEnabled: taxSettings.roundOffEnabled,
          gstin: taxSettings.gstin.trim() || undefined,
        }),
      });
      await loadData();
      setTaxDrawerOpen(false);
      setFeedback({
        type: 'success',
        text: 'Outlet GST & invoice settings updated for future bills.',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Unable to update outlet GST settings.',
      });
    } finally {
      setSavingTax(false);
    }
  };

  const handleManualPayment = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedBill || paymentMethod === 'RAZORPAY') return;
    if (effectivePayPaise <= 0 || effectivePayPaise > selectedBill.duePaise) {
      setFeedback({
        type: 'error',
        text: `Enter a valid payment amount between ₹1 and ${formatInrFromPaise(selectedBill.duePaise)}.`,
      });
      return;
    }

    const mappedMethod =
      paymentMethod === 'CASH'
        ? PaymentMethod.CASH
        : paymentMethod === 'UPI_MANUAL'
          ? PaymentMethod.UPI_MANUAL
          : PaymentMethod.CARD;

    setBusyKey(`pay-manual:${selectedBill.id}`);
    setFeedback(null);
    try {
      const res = await apiRequest<{ bill: BillSummaryDto }>(
        `/payments/bills/${selectedBill.id}/manual`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': makeIdempotencyKey('pos-manual') },
          body: JSON.stringify({
            method: mappedMethod,
            amountPaise: effectivePayPaise,
            receiptRef: receiptRef.trim() || undefined,
          }),
        },
      );
      setReceiptRef('');
      setCustomSplitRupees('');
      setSplitMode('FULL');
      await loadData();
      setFeedback({
        type: 'success',
        text:
          res.bill.duePaise === 0
            ? `Bill ${res.bill.billNumber} settled in full! Table ${res.bill.tableNumber} marked Available.`
            : `Recorded ${formatInrFromPaise(effectivePayPaise)} (${paymentMethod}). Remaining due: ${formatInrFromPaise(res.bill.duePaise)}.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Unable to record manual payment.',
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleCreateRazorpayOrder = async () => {
    if (!selectedBill) return;
    if (effectivePayPaise <= 0 || effectivePayPaise > selectedBill.duePaise) {
      setFeedback({
        type: 'error',
        text: `Select a valid amount up to ${formatInrFromPaise(selectedBill.duePaise)}.`,
      });
      return;
    }

    setBusyKey(`rzp-order:${selectedBill.id}`);
    setFeedback(null);
    try {
      const orderRes = await apiRequest<RazorpayOrderResponse>(
        `/payments/bills/${selectedBill.id}/razorpay/order`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': makeIdempotencyKey('pos-rzp') },
          body: JSON.stringify({ amountPaise: effectivePayPaise }),
        },
      );
      setRazorpayOrder(orderRes);
      await loadData();
      setFeedback({
        type: 'success',
        text: `Razorpay order ${orderRes.gatewayOrderId ?? ''} created (${formatInrFromPaise(orderRes.amountPaise)}). Scan QR or complete checkout to capture.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Unable to create Razorpay payment order.',
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleVerifyRazorpayCheckout = async () => {
    if (!razorpayOrder?.mockCheckoutHint?.razorpaySignature || !razorpayOrder.gatewayOrderId) return;
    setBusyKey(`rzp-verify:${razorpayOrder.gatewayOrderId}`);
    setFeedback(null);
    try {
      await apiRequest('/payments/razorpay/verify', {
        method: 'POST',
        body: JSON.stringify({
          razorpayOrderId: razorpayOrder.gatewayOrderId,
          razorpayPaymentId: razorpayOrder.mockCheckoutHint.razorpayPaymentId,
          razorpaySignature: razorpayOrder.mockCheckoutHint.razorpaySignature,
        }),
      });
      setRazorpayOrder(null);
      setSplitMode('FULL');
      await loadData();
      setFeedback({
        type: 'success',
        text: 'Razorpay payment verified via HMAC signature and allocated cleanly.',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Unable to verify Razorpay signature.',
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleApplyDiscount = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedBill) return;
    if (discountReason.trim().length < 3) {
      setFeedback({
        type: 'error',
        text: 'Please provide an audit reason for applying a discount.',
      });
      return;
    }

    const payload: {
      discountPaise?: number;
      discountPercentBps?: number;
      reason: string;
    } = { reason: discountReason.trim() };

    if (discountType === 'FIXED') {
      const paise = rupeesStrToPaise(discountAmountInput);
      if (discountAmountInput.trim() !== '0' && paise <= 0) {
        setFeedback({ type: 'error', text: 'Enter a valid fixed discount amount in ₹.' });
        return;
      }
      payload.discountPaise = discountAmountInput.trim() === '0' ? 0 : paise;
    } else {
      const pct = Number(discountAmountInput);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        setFeedback({ type: 'error', text: 'Percentage discount must be between 0% and 100%.' });
        return;
      }
      payload.discountPercentBps = Math.round(pct * 100);
    }

    setBusyKey(`discount:${selectedBill.id}`);
    setFeedback(null);
    try {
      const updated = await applyBillDiscount(selectedBill.id, payload);
      setDiscountModalOpen(false);
      setDiscountAmountInput('');
      setDiscountReason('');
      await loadData();
      setFeedback({
        type: 'success',
        text: `Discount updated & logged. New payable total: ${formatInrFromPaise(updated.totalPaise)}.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Unable to apply discount.',
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleVoidBill = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedBill) return;
    setBusyKey(`void:${selectedBill.id}`);
    setFeedback(null);
    try {
      const voided = await apiRequest<BillSummaryDto>(`/billing/bills/${selectedBill.id}/void`, {
        method: 'POST',
        body: JSON.stringify({ reason: voidReason.trim() }),
      });
      setVoidModalOpen(false);
      setVoidReason('');
      await loadData();
      setFeedback({
        type: 'success',
        text: `Bill ${voided.billNumber} voided. You can generate a clean replacement bill anytime.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Unable to void bill.',
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleRefundSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedBill || !refundTargetAttemptId) return;
    const paise = rupeesStrToPaise(refundRupees);
    if (paise <= 0) {
      setFeedback({ type: 'error', text: 'Enter a positive refund amount in rupees.' });
      return;
    }
    setBusyKey(`refund:${refundTargetAttemptId}`);
    setFeedback(null);
    try {
      await apiRequest(`/payments/bills/${selectedBill.id}/refunds`, {
        method: 'POST',
        body: JSON.stringify({
          paymentAttemptId: refundTargetAttemptId,
          amountPaise: paise,
          reason: refundReason.trim(),
        }),
      });
      setRefundTargetAttemptId(null);
      setRefundRupees('');
      setRefundReason('');
      await loadData();
      setFeedback({
        type: 'success',
        text: `Refund of ${formatInrFromPaise(paise)} processed and ledger updated.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Unable to process refund.',
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleReconcile = async () => {
    setBusyKey('reconcile');
    setFeedback(null);
    try {
      const res = await apiRequest<ReconcileResultDto>('/payments/reconcile', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      await loadData();
      setFeedback({
        type: 'success',
        text: `Reconciliation complete: scanned ${res.scanned}, captured ${res.capturedCount}, failed ${res.failedCount}, still pending ${res.stillPendingCount}.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Reconciliation check failed.',
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleShareInvoice = async (bill: BillSummaryDto) => {
    const linesText = bill.lines
      .filter((l) => l.lineType === 'ITEM')
      .map((l) => `${l.quantity}x ${l.description} — ${formatInrFromPaise(l.lineAmountPaise)}`)
      .join('\n');

    const summaryText = [
      `${bill.outletNameSnapshot}`,
      bill.gstinSnapshot ? `GSTIN: ${bill.gstinSnapshot}` : '',
      `Tax Invoice: ${bill.billNumber} | Table ${bill.tableNumber}`,
      `Date: ${new Date(bill.finalizedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
      '---',
      linesText,
      '---',
      `Subtotal: ${formatInrFromPaise(bill.subtotalPaise)}`,
      bill.discountPaise > 0 ? `Discount: -${formatInrFromPaise(bill.discountPaise)}` : '',
      bill.cgstPaise + bill.sgstPaise > 0
        ? `GST (CGST+SGST): ${formatInrFromPaise(bill.cgstPaise + bill.sgstPaise)}`
        : '',
      `Grand Total: ${formatInrFromPaise(bill.totalPaise)} (${bill.status})`,
    ]
      .filter(Boolean)
      .join('\n');

    try {
      if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({
          title: `Invoice ${bill.billNumber} - ${bill.outletNameSnapshot}`,
          text: summaryText,
        });
        setFeedback({ type: 'success', text: `Shared invoice ${bill.billNumber}.` });
      } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(summaryText);
        setFeedback({
          type: 'success',
          text: `Invoice ${bill.billNumber} summary copied to clipboard for sharing.`,
        });
      }
    } catch {
      // User dismissed native share sheet; do nothing
    }
  };

  const handlePrintReceipt = () => {
    if (typeof window !== 'undefined') {
      window.print();
    }
  };

  const activeReportBuckets: BillingPeriodBucketDto[] = useMemo(() => {
    if (!analytics) return [];
    if (reportPeriod === 'DAILY') return analytics.daily;
    if (reportPeriod === 'WEEKLY') return analytics.weekly;
    return analytics.monthly;
  }, [analytics, reportPeriod]);

  const maxBucketSales = useMemo(
    () =>
      Math.max(
        1,
        ...activeReportBuckets.map((b) => Math.max(b.grossSalesPaise, b.netRevenuePaise)),
      ),
    [activeReportBuckets],
  );

  return (
    <DashboardShell
      title="Billing, GST Invoices & Payments"
      subtitle="Generate consolidated multi-round GST bills, add/adjust items before checkout, collect Cash/UPI/Card/Razorpay, and track daily collections."
      onOutletChanged={() => void loadData()}
      actions={
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 ${
              wsConnected
                ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                : 'bg-amber-50 text-amber-800 ring-amber-200'
            }`}
          >
            {wsConnected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
            {wsConnected ? 'Billing Live' : 'Reconnecting'}
          </span>

          <button
            type="button"
            onClick={() => openBillComposer()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-orange-700"
          >
            <Plus className="h-4 w-4" />
            Generate New Bill
          </button>

          {canHandleMoney && (
            <button
              type="button"
              onClick={() => setReportsOpen((prev) => !prev)}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition ${
                reportsOpen
                  ? 'border-orange-300 bg-orange-50 text-orange-700'
                  : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              <BarChart3 className="h-3.5 w-3.5" />
              Revenue Reports
            </button>
          )}

          {canHandleMoney && (
            <button
              type="button"
              disabled={busyKey === 'reconcile'}
              onClick={() => void handleReconcile()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {busyKey === 'reconcile' ? 'Reconciling...' : 'Reconcile Pending'}
            </button>
          )}

          {canEditTaxSettings && (
            <button
              type="button"
              onClick={() => setTaxDrawerOpen((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
            >
              <Settings2 className="h-3.5 w-3.5" />
              GST Config
            </button>
          )}

          <button
            type="button"
            onClick={() => void loadData()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
      }
    >
      {feedback && (
        <div
          className={`mb-4 flex items-center justify-between rounded-xl px-4 py-3 text-sm font-medium print:hidden ${
            feedback.type === 'success'
              ? 'border border-emerald-200 bg-emerald-50 text-emerald-900'
              : 'border border-rose-200 bg-rose-50 text-rose-900'
          }`}
        >
          <span>{feedback.text}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="rounded p-1 hover:bg-black/5"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Real PostgreSQL Today's Collections & Sales KPI Strip */}
      {analytics && (
        <section className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6 print:hidden">
          <div className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Today&apos;s Sales
            </p>
            <p className="mt-1 text-lg font-bold text-slate-900">
              {formatInrFromPaise(analytics.today.totalSalesPaise)}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {analytics.today.completedBillsCount} completed bills
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Cash Collected
            </p>
            <p className="mt-1 text-lg font-bold text-emerald-700">
              {formatInrFromPaise(analytics.today.cashCollectedPaise)}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-500">Counter drawer</p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              UPI Collections
            </p>
            <p className="mt-1 text-lg font-bold text-orange-700">
              {formatInrFromPaise(analytics.today.upiCollectedPaise)}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-500">
              QR: {formatInrFromPaise(analytics.today.razorpayOnlinePaise)} • UTR:{' '}
              {formatInrFromPaise(analytics.today.upiManualPaise)}
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Card Collections
            </p>
            <p className="mt-1 text-lg font-bold text-slate-900">
              {formatInrFromPaise(analytics.today.cardCollectedPaise)}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-500">POS debit / credit</p>
          </div>

          <div className="rounded-2xl border border-amber-200 bg-amber-50/40 p-3.5 shadow-sm">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-800">
              Pending Due
            </p>
            <p className="mt-1 text-lg font-bold text-amber-900">
              {formatInrFromPaise(analytics.today.pendingPaymentsPaise)}
            </p>
            <p className="mt-0.5 text-[11px] text-amber-700">
              {analytics.today.pendingBillsCount} unsettled bills
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              GST Billed Today
            </p>
            <p className="mt-1 text-lg font-bold text-slate-900">
              {formatInrFromPaise(analytics.today.gstCollectedPaise)}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-500">
              CGST + SGST ({taxSettings.gstRateBps / 100}%)
            </p>
          </div>
        </section>
      )}

      {/* Daily / Weekly / Monthly Revenue Reports Drawer */}
      {reportsOpen && analytics && (
        <section className="mb-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm print:hidden">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-slate-900">
                Revenue, GST &amp; Collection Reports ({analytics.timezone})
              </h2>
              <p className="text-xs text-slate-500">
                Lifetime collected net revenue: {formatInrFromPaise(analytics.allTime.totalNetCollectedPaise)}{' '}
                across {analytics.allTime.totalPaidBillsCount} paid invoices.
              </p>
            </div>
            <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1">
              {(['DAILY', 'WEEKLY', 'MONTHLY'] as const).map((period) => (
                <button
                  key={period}
                  type="button"
                  onClick={() => setReportPeriod(period)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                    reportPeriod === period
                      ? 'bg-orange-600 text-white shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {period === 'DAILY'
                    ? 'Daily (14d)'
                    : period === 'WEEKLY'
                      ? 'Weekly (8w)'
                      : 'Monthly (6m)'}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-[11px] font-semibold uppercase text-slate-500">
                  <th className="py-2 pr-3">Period</th>
                  <th className="px-3 py-2 text-right">Bills (Paid)</th>
                  <th className="px-3 py-2 text-right">Gross Billed</th>
                  <th className="px-3 py-2 text-right">Discounts</th>
                  <th className="px-3 py-2 text-right">GST</th>
                  <th className="px-3 py-2 text-right">Collected</th>
                  <th className="px-3 py-2 text-right">Refunds</th>
                  <th className="pl-3 py-2 text-right">Net Revenue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {[...activeReportBuckets].reverse().map((bucket) => {
                  const pct = Math.min(
                    100,
                    Math.round((Math.max(bucket.grossSalesPaise, bucket.netRevenuePaise) / maxBucketSales) * 100),
                  );
                  return (
                    <tr key={bucket.key} className="hover:bg-slate-50/80">
                      <td className="py-2.5 pr-3">
                        <div className="font-semibold text-slate-900">{bucket.label}</div>
                        <div className="mt-1 h-1.5 w-28 overflow-hidden rounded-full bg-slate-100">
                          <div
                            className="h-full rounded-full bg-orange-500"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-slate-700">
                        {bucket.billsCount} ({bucket.completedBillsCount})
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono font-medium text-slate-800">
                        {formatInrFromPaise(bucket.grossSalesPaise)}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-amber-700">
                        {formatInrFromPaise(bucket.discountPaise)}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-slate-600">
                        {formatInrFromPaise(bucket.gstPaise)}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-emerald-700">
                        {formatInrFromPaise(bucket.collectedPaise)}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-rose-700">
                        {formatInrFromPaise(bucket.refundedPaise)}
                      </td>
                      <td className="pl-3 py-2.5 text-right font-mono font-bold text-slate-900">
                        {formatInrFromPaise(bucket.netRevenuePaise)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Outlet GST & Invoice Settings Drawer */}
      {taxDrawerOpen && canEditTaxSettings && (
        <form
          onSubmit={handleSaveTaxSettings}
          className="mb-5 rounded-2xl border border-orange-200 bg-white p-5 shadow-sm print:hidden"
        >
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-base font-bold text-slate-900">
                Outlet GST &amp; Receipt Configuration
              </h2>
              <p className="text-xs text-slate-500">
                Applied automatically when consolidating future GST bills. Existing paid invoices
                keep their locked snapshot.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setTaxDrawerOpen(false)}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">Tax Mode</label>
              <select
                value={taxSettings.taxMode}
                onChange={(e) =>
                  setTaxSettings((s) => ({ ...s, taxMode: e.target.value as TaxMode }))
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                {Object.values(TaxMode).map((mode) => (
                  <option key={mode} value={mode}>
                    {TAX_MODE_LABEL[mode]}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                Total GST Rate
              </label>
              <select
                value={taxSettings.gstRateBps}
                onChange={(e) =>
                  setTaxSettings((s) => ({ ...s, gstRateBps: Number(e.target.value) }))
                }
                disabled={taxSettings.taxMode === TaxMode.NONE}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100"
              >
                <option value={0}>0% (Exempt)</option>
                <option value={500}>5% (2.5% CGST + 2.5% SGST)</option>
                <option value={1200}>12% (6% CGST + 6% SGST)</option>
                <option value={1800}>18% (9% CGST + 9% SGST)</option>
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                Outlet GSTIN
              </label>
              <input
                type="text"
                maxLength={20}
                placeholder="24ABCDE1234F1Z5"
                value={taxSettings.gstin}
                onChange={(e) =>
                  setTaxSettings((s) => ({ ...s, gstin: e.target.value.toUpperCase() }))
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
              />
            </div>

            <div className="flex items-end justify-between gap-3">
              <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-slate-700">
                <input
                  type="checkbox"
                  checked={taxSettings.roundOffEnabled}
                  onChange={(e) =>
                    setTaxSettings((s) => ({ ...s, roundOffEnabled: e.target.checked }))
                  }
                  className="h-4 w-4 rounded border-slate-300 text-orange-600 focus:ring-orange-500"
                />
                Round-Off to ₹1
              </label>
              <button
                type="submit"
                disabled={savingTax}
                className="rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-orange-700 disabled:opacity-50"
              >
                {savingTax ? 'Saving...' : 'Save Tax Config'}
              </button>
            </div>
          </div>
        </form>
      )}

      {/* Unbilled Active Dining Tables Strip */}
      {unbilledActiveTables.length > 0 && (
        <div className="mb-5 rounded-2xl border border-orange-200 bg-orange-50/70 p-4 print:hidden">
          <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-xs font-bold uppercase tracking-wide text-orange-900">
              Active Floor Tables Ready for Billing ({unbilledActiveTables.length})
            </h2>
            <span className="text-xs text-orange-700">
              Multi-round KOT orders automatically consolidated
            </span>
          </div>
          <div className="flex flex-wrap gap-2.5">
            {unbilledActiveTables.map((t) => (
              <div
                key={t.id}
                className="flex flex-wrap items-center gap-2 rounded-xl border border-orange-200 bg-white px-3.5 py-2 shadow-sm"
              >
                <div>
                  <span className="text-sm font-bold text-slate-900">Table {t.tableNumber}</span>
                  {t.floorSection && (
                    <span className="ml-1.5 text-[11px] font-medium text-slate-500">
                      ({t.floorSection})
                    </span>
                  )}
                  <span className="ml-2 text-xs font-medium text-slate-600">
                    • {t.activeSession?.orders.filter((o) => o.kitchenStatus !== 'CANCELLED').length ?? 0}{' '}
                    orders • Est.{' '}
                    <span className="font-semibold text-slate-900">
                      {formatInrFromPaise(
                        t.activeSession?.balance?.estimatedTotalPaise ??
                          t.activeSession?.runningTotalPaise ??
                          0,
                      )}
                    </span>
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => openBillComposer({ tableId: t.id })}
                    className="rounded-lg border border-orange-200 bg-orange-50 px-2.5 py-1 text-xs font-semibold text-orange-700 hover:bg-orange-100"
                  >
                    Review &amp; Edit
                  </button>
                  <button
                    type="button"
                    disabled={busyKey === `gen:${t.activeSession?.id}`}
                    onClick={() =>
                      t.activeSession && void handleQuickGenerateBill(t.activeSession.id)
                    }
                    className="rounded-lg bg-orange-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-orange-700 disabled:opacity-50"
                  >
                    {busyKey === `gen:${t.activeSession?.id}` ? 'Generating...' : 'Generate Bill'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main Split Workspace */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left Rail: Filter Tabs + Search + Bill List */}
        <aside className="space-y-3 lg:col-span-4 print:hidden">
          <div className="flex flex-wrap gap-1.5 rounded-xl border border-slate-200 bg-white p-1.5">
            {(
              [
                ['ALL', `All (${billCounts.ALL})`],
                [BillStatus.OPEN, `Open (${billCounts.open})`],
                [BillStatus.PARTIALLY_PAID, `Partial (${billCounts.partial})`],
                [BillStatus.PAID, `Paid (${billCounts.paid})`],
                [BillStatus.VOID, `Voided (${billCounts.voided})`],
              ] as const
            ).map(([val, label]) => (
              <button
                key={val}
                type="button"
                onClick={() => setStatusFilter(val)}
                className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
                  statusFilter === val
                    ? 'bg-orange-600 text-white shadow-sm'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={billSearchQuery}
              onChange={(e) => setBillSearchQuery(e.target.value)}
              placeholder="Search bill number or table #..."
              className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20"
            />
          </div>

          <div className="space-y-2.5">
            {loading ? (
              <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
                Loading bills and ledgers...
              </div>
            ) : filteredBills.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center">
                <p className="text-sm font-semibold text-slate-700">
                  {bills.length === 0 ? 'No Bills Generated Yet' : 'No Matching Bills Found'}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {bills.length === 0
                    ? 'Select an active table from Dining Floor or create an order to generate a GST invoice.'
                    : 'Try clearing the search query or switching bill status filter tabs.'}
                </p>
                <button
                  type="button"
                  onClick={() => openBillComposer()}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-orange-700"
                >
                  <Plus className="h-4 w-4" />
                  Generate New Bill
                </button>
              </div>
            ) : (
              filteredBills.map((bill) => {
                const badge = getBillStatusBadge(bill.status);
                const isSelected = selectedBill?.id === bill.id;
                return (
                  <button
                    key={bill.id}
                    type="button"
                    onClick={() => {
                      setSelectedBillId(bill.id);
                      setRazorpayOrder(null);
                      setSplitMode('FULL');
                    }}
                    className={`w-full rounded-2xl border p-4 text-left transition ${
                      isSelected
                        ? 'border-orange-500 bg-orange-50/40 ring-2 ring-orange-500/20'
                        : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-sm font-bold text-slate-900">
                          Table {bill.tableNumber}
                          <span className="ml-2 font-mono text-xs font-semibold text-slate-500">
                            {bill.billNumber}
                          </span>
                        </div>
                        <div className="mt-0.5 text-xs text-slate-500">
                          {new Date(bill.finalizedAt).toLocaleString('en-IN', {
                            timeZone: 'Asia/Kolkata',
                            day: '2-digit',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </div>
                      </div>
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold ${badge.className}`}
                      >
                        {badge.label}
                      </span>
                    </div>

                    <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2.5 text-xs">
                      <span className="text-slate-600">
                        Total:{' '}
                        <strong className="text-slate-900">
                          {formatInrFromPaise(bill.totalPaise)}
                        </strong>
                      </span>
                      {bill.duePaise > 0 && bill.status !== BillStatus.VOID ? (
                        <span className="font-bold text-rose-700">
                          Due: {formatInrFromPaise(bill.duePaise)}
                        </span>
                      ) : (
                        <span className="font-semibold text-emerald-700">
                          Paid: {formatInrFromPaise(bill.netPaidPaise)}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        {/* Right Workspace: GST Tax Invoice Detail, Payment Terminal & Audit Trail */}
        <section className="space-y-5 lg:col-span-8">
          {!selectedBill ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center print:hidden">
              <QrCode className="mx-auto h-10 w-10 text-orange-400" />
              <p className="mt-3 text-base font-semibold text-slate-800">
                Select an invoice or generate a new bill
              </p>
              <p className="mt-1 text-xs text-slate-500">
                View item-wise GST breakup, collect Cash / UPI / Card / Razorpay, download PDF,
                print receipt, or issue refunds.
              </p>
              <button
                type="button"
                onClick={() => openBillComposer()}
                className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-orange-700"
              >
                <Plus className="h-4 w-4" />
                Generate New Bill
              </button>
            </div>
          ) : (
            <>
              {/* Invoice Header & Actions */}
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2.5">
                      <h2 className="text-xl font-bold text-slate-900">{selectedBill.billNumber}</h2>
                      <span
                        className={`rounded-full px-3 py-0.5 text-xs font-bold ${
                          getBillStatusBadge(selectedBill.status).className
                        }`}
                      >
                        {getBillStatusBadge(selectedBill.status).label}
                      </span>
                      <span className="rounded-full bg-orange-50 px-2.5 py-0.5 text-xs font-semibold text-orange-700 ring-1 ring-orange-200">
                        Table {selectedBill.tableNumber}
                        {selectedBill.tableLabel ? ` (${selectedBill.tableLabel})` : ''}
                      </span>
                    </div>
                    <p className="mt-1.5 text-xs font-medium text-slate-700">
                      {selectedBill.outletNameSnapshot}
                      {selectedBill.gstinSnapshot ? ` • GSTIN: ${selectedBill.gstinSnapshot}` : ''}
                    </p>
                    {selectedBill.outletAddressSnapshot && (
                      <p className="text-xs text-slate-500">{selectedBill.outletAddressSnapshot}</p>
                    )}
                    <p className="mt-0.5 text-[11px] text-slate-400">
                      Invoice Date:{' '}
                      {new Date(selectedBill.finalizedAt).toLocaleString('en-IN', {
                        timeZone: 'Asia/Kolkata',
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 print:hidden">
                    {canHandleMoney &&
                      selectedBill.status === BillStatus.OPEN &&
                      selectedBill.paidPaise === 0 && (
                        <button
                          type="button"
                          onClick={() => openBillComposer({ editingBill: selectedBill })}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-orange-300 bg-orange-50 px-3 py-2 text-xs font-semibold text-orange-800 hover:bg-orange-100"
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                          Add / Edit Items
                        </button>
                      )}

                    <button
                      type="button"
                      onClick={() =>
                        void downloadProtectedPdf(
                          `/billing/bills/${selectedBill.id}/receipt.pdf`,
                          `${selectedBill.billNumber}.pdf`,
                        )
                      }
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Download PDF
                    </button>

                    <button
                      type="button"
                      onClick={handlePrintReceipt}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      <Printer className="h-3.5 w-3.5" />
                      Print Receipt
                    </button>

                    <button
                      type="button"
                      onClick={() => void handleShareInvoice(selectedBill)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      <Share2 className="h-3.5 w-3.5" />
                      Share
                    </button>

                    {canHandleMoney &&
                      selectedBill.status !== BillStatus.VOID &&
                      selectedBill.status !== BillStatus.PAID && (
                        <button
                          type="button"
                          onClick={() => {
                            setDiscountType('PERCENT');
                            setDiscountAmountInput('');
                            setDiscountReason(selectedBill.discountReason ?? '');
                            setDiscountModalOpen(true);
                          }}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 hover:bg-amber-100"
                        >
                          <Percent className="h-3.5 w-3.5" />
                          Apply Discount
                        </button>
                      )}

                    {canHandleMoney &&
                      selectedBill.netPaidPaise === 0 &&
                      selectedBill.status !== BillStatus.VOID && (
                        <button
                          type="button"
                          onClick={() => {
                            setVoidReason('');
                            setVoidModalOpen(true);
                          }}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-100"
                        >
                          <Ban className="h-3.5 w-3.5" />
                          Void Bill
                        </button>
                      )}
                  </div>
                </div>

                {/* Alert banner if new order items exist on OPEN unpaid bill */}
                {selectedBillNeedsSync && (
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-xs text-amber-900 print:hidden">
                    <span>
                      Orders on Table {selectedBill.tableNumber} changed after this bill was drafted.
                      Sync to include latest items &amp; GST.
                    </span>
                    <button
                      type="button"
                      disabled={busyKey === `sync:${selectedBill.id}`}
                      onClick={() => void handleSyncOpenBillWithOrders(selectedBill)}
                      className="rounded-lg bg-orange-600 px-3 py-1 font-semibold text-white hover:bg-orange-700 disabled:opacity-50"
                    >
                      {busyKey === `sync:${selectedBill.id}`
                        ? 'Syncing...'
                        : 'Sync Open Bill Totals'}
                    </button>
                  </div>
                )}

                {selectedBill.status === BillStatus.VOID && (
                  <div className="mt-4 flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-medium text-rose-800">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    VOIDED Invoice: {selectedBill.voidReason || 'No reason specified'}
                  </div>
                )}

                {/* Itemized GST Breakdown Table */}
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 text-[11px] font-semibold uppercase text-slate-500">
                        <th className="py-2 pr-3">Item Description</th>
                        <th className="px-2 py-2 text-right">Qty</th>
                        <th className="px-2 py-2 text-right">Rate</th>
                        <th className="px-2 py-2 text-right">Taxable</th>
                        {selectedBill.taxMode !== TaxMode.NONE && (
                          <>
                            <th className="px-2 py-2 text-right">
                              CGST ({(selectedBill.gstRateBps / 200).toFixed(2).replace(/\.00$/, '')}
                              %)
                            </th>
                            <th className="px-2 py-2 text-right">
                              SGST ({(selectedBill.gstRateBps / 200).toFixed(2).replace(/\.00$/, '')}
                              %)
                            </th>
                          </>
                        )}
                        <th className="pl-2 py-2 text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {selectedBill.itemGstBreakdown && selectedBill.itemGstBreakdown.length > 0
                        ? selectedBill.itemGstBreakdown.map((item, idx) => (
                            <tr key={item.lineId ?? idx}>
                              <td className="py-2.5 pr-3">
                                <span className="font-semibold text-slate-900">
                                  {item.description}
                                </span>
                                {item.discountSharePaise > 0 && (
                                  <span className="ml-2 text-[11px] text-amber-700">
                                    (-{formatInrFromPaise(item.discountSharePaise)} disc.)
                                  </span>
                                )}
                              </td>
                              <td className="px-2 py-2.5 text-right font-mono text-slate-700">
                                {item.quantity}
                              </td>
                              <td className="px-2 py-2.5 text-right font-mono text-slate-600">
                                {formatInrFromPaise(item.unitAmountPaise)}
                              </td>
                              <td className="px-2 py-2.5 text-right font-mono text-slate-700">
                                {formatInrFromPaise(item.taxablePaise)}
                              </td>
                              {selectedBill.taxMode !== TaxMode.NONE && (
                                <>
                                  <td className="px-2 py-2.5 text-right font-mono text-slate-600">
                                    {formatInrFromPaise(item.cgstPaise)}
                                  </td>
                                  <td className="px-2 py-2.5 text-right font-mono text-slate-600">
                                    {formatInrFromPaise(item.sgstPaise)}
                                  </td>
                                </>
                              )}
                              <td className="pl-2 py-2.5 text-right font-mono font-semibold text-slate-900">
                                {formatInrFromPaise(item.lineTotalWithTaxPaise)}
                              </td>
                            </tr>
                          ))
                        : selectedBill.lines
                            .filter((l) => l.lineType === 'ITEM')
                            .map((line) => (
                              <tr key={line.id}>
                                <td className="py-2.5 pr-3 font-semibold text-slate-900">
                                  {line.description}
                                </td>
                                <td className="px-2 py-2.5 text-right font-mono text-slate-700">
                                  {line.quantity}
                                </td>
                                <td className="px-2 py-2.5 text-right font-mono text-slate-600">
                                  {formatInrFromPaise(line.unitAmountPaise)}
                                </td>
                                <td className="px-2 py-2.5 text-right font-mono text-slate-700">
                                  {formatInrFromPaise(line.lineAmountPaise)}
                                </td>
                                {selectedBill.taxMode !== TaxMode.NONE && (
                                  <>
                                    <td className="px-2 py-2.5 text-right font-mono text-slate-600">
                                      ₹0.00
                                    </td>
                                    <td className="px-2 py-2.5 text-right font-mono text-slate-600">
                                      ₹0.00
                                    </td>
                                  </>
                                )}
                                <td className="pl-2 py-2.5 text-right font-mono font-semibold text-slate-900">
                                  {formatInrFromPaise(line.lineAmountPaise)}
                                </td>
                              </tr>
                            ))}
                    </tbody>
                  </table>
                </div>

                {/* Totals Block */}
                <div className="mt-4 space-y-1.5 rounded-xl bg-slate-50 p-4 text-sm">
                  <div className="flex justify-between text-slate-600">
                    <span>Items Subtotal</span>
                    <span className="font-mono">{formatInrFromPaise(selectedBill.subtotalPaise)}</span>
                  </div>
                  {selectedBill.discountPaise > 0 && (
                    <div className="flex justify-between text-amber-800">
                      <span>
                        Discount
                        {selectedBill.discountReason ? ` (${selectedBill.discountReason})` : ''}
                      </span>
                      <span className="font-mono">
                        -{formatInrFromPaise(selectedBill.discountPaise)}
                      </span>
                    </div>
                  )}
                  {selectedBill.taxMode !== TaxMode.NONE && (
                    <>
                      <div className="flex justify-between text-slate-600">
                        <span>
                          CGST ({(selectedBill.gstRateBps / 200).toFixed(2).replace(/\.00$/, '')}%{' '}
                          {selectedBill.taxMode === TaxMode.INCLUSIVE ? 'Included' : 'Extra'})
                        </span>
                        <span className="font-mono">
                          {formatInrFromPaise(selectedBill.cgstPaise)}
                        </span>
                      </div>
                      <div className="flex justify-between text-slate-600">
                        <span>
                          SGST ({(selectedBill.gstRateBps / 200).toFixed(2).replace(/\.00$/, '')}%{' '}
                          {selectedBill.taxMode === TaxMode.INCLUSIVE ? 'Included' : 'Extra'})
                        </span>
                        <span className="font-mono">
                          {formatInrFromPaise(selectedBill.sgstPaise)}
                        </span>
                      </div>
                    </>
                  )}
                  {selectedBill.roundOffPaise !== 0 && (
                    <div className="flex justify-between text-slate-600">
                      <span>Round-Off</span>
                      <span className="font-mono">
                        {formatInrFromPaise(selectedBill.roundOffPaise)}
                      </span>
                    </div>
                  )}

                  <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-bold text-slate-900">
                    <span>Grand Total</span>
                    <span className="font-mono">{formatInrFromPaise(selectedBill.totalPaise)}</span>
                  </div>

                  <div className="flex justify-between pt-1 text-xs font-medium text-emerald-700">
                    <span>Net Collected Payments</span>
                    <span className="font-mono">{formatInrFromPaise(selectedBill.netPaidPaise)}</span>
                  </div>
                  {selectedBill.refundedPaise > 0 && (
                    <div className="flex justify-between text-xs font-medium text-rose-700">
                      <span>Total Refunded</span>
                      <span className="font-mono">
                        -{formatInrFromPaise(selectedBill.refundedPaise)}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between text-sm font-bold text-slate-900">
                    <span>Balance Due</span>
                    <span
                      className={`font-mono ${
                        selectedBill.duePaise > 0 ? 'text-rose-700' : 'text-emerald-700'
                      }`}
                    >
                      {formatInrFromPaise(selectedBill.duePaise)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Payment Terminal (Split Bills + Cash / UPI Counter / Card / Razorpay QR) */}
              {canHandleMoney &&
                selectedBill.duePaise > 0 &&
                selectedBill.status !== BillStatus.VOID && (
                  <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm print:hidden">
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="text-base font-bold text-slate-900">
                          Collect Payment • Due {formatInrFromPaise(selectedBill.duePaise)}
                        </h3>
                        <p className="text-xs text-slate-500">
                          Split bills across guests or settle in full. Table releases to Available
                          only upon complete payment settlement.
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {(
                          [
                            ['FULL', 'Full Due'],
                            ['HALF', '1/2 (50%)'],
                            ['THIRD', '1/3 Split'],
                            ['QUARTER', '1/4 Split'],
                            ['CUSTOM', 'Custom ₹'],
                          ] as const
                        ).map(([mode, label]) => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => {
                              setSplitMode(mode);
                              setRazorpayOrder(null);
                            }}
                            className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
                              splitMode === mode
                                ? 'bg-orange-600 text-white shadow-sm'
                                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {splitMode === 'CUSTOM' && (
                      <div className="mb-4 max-w-xs">
                        <label className="mb-1 block text-xs font-semibold text-slate-700">
                          Split Amount (₹ INR — Max {formatInrFromPaise(selectedBill.duePaise)})
                        </label>
                        <input
                          type="number"
                          step="0.01"
                          min="1"
                          placeholder="e.g. 250.00"
                          value={customSplitRupees}
                          onChange={(e) => setCustomSplitRupees(e.target.value)}
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-orange-500 focus:outline-none"
                        />
                      </div>
                    )}

                    {/* Payment Method Selector Tabs */}
                    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                      {[
                        { id: 'CASH' as const, label: 'Cash', icon: Banknote },
                        { id: 'UPI_MANUAL' as const, label: 'UPI Counter', icon: Smartphone },
                        { id: 'CARD' as const, label: 'Debit / Credit Card', icon: CreditCard },
                        { id: 'RAZORPAY' as const, label: 'Razorpay Online / QR', icon: QrCode },
                      ].map((tab) => {
                        const Icon = tab.icon;
                        const active = paymentMethod === tab.id;
                        return (
                          <button
                            key={tab.id}
                            type="button"
                            onClick={() => {
                              setPaymentMethod(tab.id);
                              setRazorpayOrder(null);
                            }}
                            className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-xs font-semibold transition ${
                              active
                                ? 'border-orange-500 bg-orange-50 text-orange-800 ring-1 ring-orange-200'
                                : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                            }`}
                          >
                            <Icon className="h-4 w-4" />
                            {tab.label}
                          </button>
                        );
                      })}
                    </div>

                    {paymentMethod !== 'RAZORPAY' ? (
                      <form
                        onSubmit={handleManualPayment}
                        className="mt-4 flex flex-wrap items-end gap-3"
                      >
                        <div className="min-w-[220px] flex-1">
                          <label className="mb-1 block text-xs font-semibold text-slate-700">
                            {paymentMethod === 'UPI_MANUAL'
                              ? 'UPI UTR / Transaction Reference (Optional)'
                              : paymentMethod === 'CARD'
                                ? 'Card POS Auth Code / Last 4 Digits'
                                : 'Cash Drawer / Receipt Ref (Optional)'}
                          </label>
                          <input
                            type="text"
                            maxLength={100}
                            placeholder={
                              paymentMethod === 'UPI_MANUAL'
                                ? 'e.g. UTR-431982019'
                                : paymentMethod === 'CARD'
                                  ? 'e.g. VISA-4421 / AUTH-918'
                                  : 'e.g. TILL-01'
                            }
                            value={receiptRef}
                            onChange={(e) => setReceiptRef(e.target.value)}
                            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-orange-500 focus:outline-none"
                          />
                        </div>

                        <button
                          type="submit"
                          disabled={
                            busyKey === `pay-manual:${selectedBill.id}` || effectivePayPaise <= 0
                          }
                          className="inline-flex items-center gap-2 rounded-lg bg-orange-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-orange-700 disabled:opacity-50"
                        >
                          <CheckCircle2 className="h-4 w-4" />
                          Confirm {formatInrFromPaise(effectivePayPaise)} ({paymentMethod.replace('_MANUAL', '')})
                        </button>
                      </form>
                    ) : (
                      <div className="mt-4 space-y-3 rounded-xl border border-orange-200 bg-orange-50/40 p-4">
                        {!razorpayOrder ? (
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <p className="text-sm font-semibold text-slate-900">
                                Generate Razorpay Payment Order &amp; Dynamic UPI QR
                              </p>
                              <p className="text-xs text-slate-600">
                                Creates a server-verified Razorpay order for{' '}
                                <strong>{formatInrFromPaise(effectivePayPaise)}</strong> and displays
                                a scannable UPI QR code.
                              </p>
                            </div>
                            <button
                              type="button"
                              disabled={
                                busyKey === `rzp-order:${selectedBill.id}` || effectivePayPaise <= 0
                              }
                              onClick={() => void handleCreateRazorpayOrder()}
                              className="inline-flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-orange-700 disabled:opacity-50"
                            >
                              <QrCode className="h-4 w-4" />
                              Create Razorpay Order ({formatInrFromPaise(effectivePayPaise)})
                            </button>
                          </div>
                        ) : (
                          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                            {razorpayQrDataUrl && (
                              <div className="shrink-0 rounded-xl border border-slate-200 bg-white p-2.5 text-center shadow-sm">
                                <img
                                  src={razorpayQrDataUrl}
                                  alt="UPI Payment QR Code"
                                  className="h-40 w-40 object-contain"
                                />
                                <p className="mt-1 text-[10px] font-semibold uppercase text-slate-500">
                                  Scan via Any UPI App
                                </p>
                              </div>
                            )}

                            <div className="flex-1 space-y-2 text-xs">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="font-bold text-slate-900">
                                  Order: {razorpayOrder.gatewayOrderId}
                                </span>
                                <span className="rounded-full bg-orange-100 px-2.5 py-0.5 font-semibold text-orange-800">
                                  {formatInrFromPaise(razorpayOrder.amountPaise)}
                                </span>
                              </div>
                              {razorpayOrder.qrPayloadUrl && (
                                <p className="break-all font-mono text-[11px] text-slate-600">
                                  UPI Intent: {razorpayOrder.qrPayloadUrl}
                                </p>
                              )}

                              {razorpayOrder.isMock && razorpayOrder.mockCheckoutHint ? (
                                <div className="space-y-2 pt-1">
                                  <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
                                    <ShieldCheck className="h-3.5 w-3.5" />
                                    Razorpay Dev Sandbox Mode (Real HMAC Verification)
                                  </span>
                                  <div className="flex flex-wrap gap-2">
                                    <button
                                      type="button"
                                      disabled={
                                        busyKey === `rzp-verify:${razorpayOrder.gatewayOrderId}`
                                      }
                                      onClick={() => void handleVerifyRazorpayCheckout()}
                                      className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                                    >
                                      <CheckCircle2 className="h-3.5 w-3.5" />
                                      Verify Signed Dev Checkout
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setRazorpayOrder(null)}
                                      className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                                    >
                                      Cancel Preview
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <div className="space-y-2 pt-1">
                                  <p className="text-slate-600">
                                    Awaiting Razorpay capture webhook confirmation from gateway...
                                  </p>
                                  <button
                                    type="button"
                                    disabled={busyKey === 'reconcile'}
                                    onClick={() => void handleReconcile()}
                                    className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-orange-700 disabled:opacity-50"
                                  >
                                    <RotateCcw className="h-3.5 w-3.5" />
                                    Check / Reconcile Gateway Status
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

              {/* Payment & Refund History */}
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm print:hidden">
                <h3 className="text-sm font-bold text-slate-900">
                  Payment Attempts &amp; Refund History
                </h3>

                {selectedBill.paymentAttempts.length === 0 ? (
                  <p className="mt-2 text-xs text-slate-500">
                    No payment attempts recorded on this bill yet.
                  </p>
                ) : (
                  <div className="mt-3 space-y-2.5">
                    {selectedBill.paymentAttempts.map((attempt) => (
                      <div
                        key={attempt.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-4 py-3 text-xs"
                      >
                        <div>
                          <div className="flex flex-wrap items-center gap-2 font-semibold text-slate-900">
                            <span>{attempt.method.replace('_MANUAL', ' COUNTER')}</span>
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                                attempt.status === PaymentStatus.SUCCEEDED
                                  ? 'bg-emerald-50 text-emerald-700'
                                  : attempt.status === PaymentStatus.FAILED
                                    ? 'bg-rose-50 text-rose-700'
                                    : 'bg-amber-50 text-amber-800'
                              }`}
                            >
                              {attempt.status}
                            </span>
                            <span className="font-mono text-slate-700">
                              {formatInrFromPaise(attempt.amountPaise)}
                            </span>
                          </div>
                          <div className="mt-0.5 text-[11px] text-slate-500">
                            {new Date(attempt.createdAt).toLocaleString('en-IN', {
                              timeZone: 'Asia/Kolkata',
                            })}
                            {attempt.receiptRef ? ` • Ref: ${attempt.receiptRef}` : ''}
                            {attempt.gatewayOrderId ? ` • GW: ${attempt.gatewayOrderId}` : ''}
                            {attempt.failureReason ? ` • ${attempt.failureReason}` : ''}
                          </div>
                        </div>

                        {canHandleMoney &&
                          attempt.status === PaymentStatus.SUCCEEDED &&
                          selectedBill.netPaidPaise > 0 && (
                            <button
                              type="button"
                              onClick={() => {
                                setRefundTargetAttemptId(attempt.id);
                                setRefundRupees(
                                  (
                                    Math.min(attempt.amountPaise, selectedBill.netPaidPaise) / 100
                                  ).toFixed(2),
                                );
                                setRefundReason('');
                              }}
                              className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-100"
                            >
                              Issue Refund
                            </button>
                          )}
                      </div>
                    ))}
                  </div>
                )}

                {selectedBill.refunds.length > 0 && (
                  <div className="mt-4 border-t border-slate-100 pt-3">
                    <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-rose-800">
                      Issued Refunds
                    </h4>
                    <div className="space-y-2">
                      {selectedBill.refunds.map((refund) => (
                        <div
                          key={refund.id}
                          className="flex flex-wrap items-center justify-between rounded-xl border border-rose-200 bg-rose-50/50 px-3.5 py-2 text-xs text-rose-900"
                        >
                          <div>
                            <span className="font-semibold">
                              -{formatInrFromPaise(refund.amountPaise)}
                            </span>{' '}
                            • {refund.reason}
                          </div>
                          <span className="font-mono text-[11px]">{refund.status}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Discount & Billing Audit Trail */}
              {canHandleMoney && (
                <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm print:hidden">
                  <div className="flex items-center gap-2">
                    <History className="h-4 w-4 text-orange-600" />
                    <h3 className="text-sm font-bold text-slate-900">
                      Discount &amp; Financial Audit Trail
                    </h3>
                  </div>

                  {loadingAudit ? (
                    <p className="mt-2 text-xs text-slate-500">Loading audit logs...</p>
                  ) : billAuditLogs.length === 0 ? (
                    <p className="mt-2 text-xs text-slate-500">No audit entries recorded yet.</p>
                  ) : (
                    <div className="mt-3 space-y-2">
                      {billAuditLogs.map((entry) => {
                        const after = (entry.afterJson ?? {}) as Record<string, unknown>;
                        const reasonText =
                          typeof after.reason === 'string' ? after.reason : null;
                        return (
                          <div
                            key={entry.id}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-100 bg-slate-50 px-3.5 py-2 text-xs"
                          >
                            <div>
                              <span className="font-bold text-slate-800">
                                {entry.action.replace(/_/g, ' ')}
                              </span>
                              <span className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700">
                                {entry.actorRole}
                              </span>
                              {reasonText && (
                                <span className="ml-2 text-slate-600">• {reasonText}</span>
                              )}
                            </div>
                            <span className="text-[11px] text-slate-500">
                              {new Date(entry.createdAt).toLocaleString('en-IN', {
                                timeZone: 'Asia/Kolkata',
                              })}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {/* Interactive + Generate New Bill / Pre-Bill Order Composer Modal */}
      {composerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 print:hidden">
          <form
            onSubmit={handleAddComposerCartAndGenerateBill}
            className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  {composerEditingBillId
                    ? `Edit Bill Items — ${selectedBill?.billNumber ?? ''}`
                    : 'Generate New GST Bill — Table & Order Composer'}
                </h3>
                <p className="text-xs text-slate-500">
                  Fetch active Dining Floor sessions, add or modify food items before checkout,
                  apply optional discount, and finalize your GST invoice.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setComposerOpen(false)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="grid flex-1 grid-cols-1 gap-5 overflow-y-auto p-6 md:grid-cols-12">
              {/* Left side: Table selection + existing order items + discount */}
              <div className="space-y-4 md:col-span-6">
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-700">
                    Select Table
                  </label>
                  <select
                    value={composerTableId}
                    disabled={Boolean(composerEditingBillId)}
                    onChange={(e) => {
                      setComposerTableId(e.target.value);
                      setComposerCart({});
                      setComposerError(null);
                    }}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100"
                  >
                    {tables.map((t) => {
                      const activeCount =
                        t.activeSession?.orders.filter((o) => o.kitchenStatus !== 'CANCELLED')
                          .length ?? 0;
                      const estTotal =
                        t.activeSession?.balance?.estimatedTotalPaise ??
                        t.activeSession?.runningTotalPaise ??
                        0;
                      return (
                        <option key={t.id} value={t.id}>
                          Table {t.tableNumber}
                          {t.floorSection ? ` (${t.floorSection})` : ''} —{' '}
                          {activeCount > 0
                            ? `${activeCount} order(s) • Est. ${formatInrFromPaise(estTotal)}`
                            : t.tableStatus}
                        </option>
                      );
                    })}
                  </select>
                </div>

                {composerError && (
                  <div className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs font-medium text-rose-800">
                    {composerError}
                  </div>
                )}

                {/* Existing Multi-Round Orders on Selected Table */}
                <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wide text-slate-700">
                      Current Table Session Orders
                    </span>
                    <span className="text-xs font-semibold text-slate-600">
                      Subtotal: {formatInrFromPaise(composerPreviewTotals.existingItemsSubtotal)}
                    </span>
                  </div>

                  {!composerTable?.activeSession ||
                  composerTable.activeSession.orders.filter((o) => o.kitchenStatus !== 'CANCELLED')
                    .length === 0 ? (
                    <p className="py-3 text-center text-xs text-slate-500">
                      No active orders on this table yet. Pick dishes on the right to add an order
                      and generate a bill.
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {composerTable.activeSession.orders.some(
                        (o) => o.kitchenStatus === 'PREPARING',
                      ) && (
                        <input
                          type="text"
                          value={composerOverrideReason}
                          onChange={(e) => setComposerOverrideReason(e.target.value)}
                          placeholder="Override reason (required only if adjusting PREPARING items)"
                          className="w-full rounded-lg border border-amber-300 bg-white px-2.5 py-1.5 text-xs"
                        />
                      )}

                      {composerTable.activeSession.orders
                        .filter((o) => o.kitchenStatus !== 'CANCELLED')
                        .map((order) => {
                          const canModifyOrder = EDITABLE_KITCHEN_STATUSES.has(
                            order.kitchenStatus,
                          );
                          return (
                            <div
                              key={order.id}
                              className="rounded-lg border border-slate-200 bg-white p-2.5 text-xs"
                            >
                              <div className="mb-1.5 flex items-center justify-between text-[11px] font-semibold text-slate-500">
                                <span>
                                  KOT #{order.kotNumber} • Round {order.roundNumber}
                                </span>
                                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-700">
                                  {order.kitchenStatus}
                                </span>
                              </div>
                              <div className="space-y-1.5">
                                {order.items
                                  .filter((i) => i.status === 'ACTIVE' && i.quantity > 0)
                                  .map((item) => (
                                    <div
                                      key={item.id}
                                      className="flex items-center justify-between gap-2"
                                    >
                                      <div className="min-w-0 flex-1">
                                        <p className="truncate font-semibold text-slate-800">
                                          {item.itemNameSnapshot}
                                        </p>
                                        <p className="text-[11px] text-slate-500">
                                          {formatInrFromPaise(item.unitPricePaise)} × {item.quantity}{' '}
                                          = {formatInrFromPaise(item.lineTotalPaise)}
                                        </p>
                                      </div>

                                      {canModifyOrder ? (
                                        <div className="flex items-center gap-1">
                                          <button
                                            type="button"
                                            disabled={busyKey === `edit-item:${item.id}`}
                                            onClick={() =>
                                              void handleAdjustExistingOrderItem(
                                                composerTable.activeSession!.id,
                                                order.id,
                                                order.kitchenStatus,
                                                item.id,
                                                item.quantity - 1,
                                              )
                                            }
                                            className="rounded border border-slate-200 p-1 hover:bg-slate-100"
                                            title="Decrease quantity"
                                          >
                                            <Minus className="h-3 w-3" />
                                          </button>
                                          <span className="w-5 text-center font-mono font-bold">
                                            {item.quantity}
                                          </span>
                                          <button
                                            type="button"
                                            disabled={busyKey === `edit-item:${item.id}`}
                                            onClick={() =>
                                              void handleAdjustExistingOrderItem(
                                                composerTable.activeSession!.id,
                                                order.id,
                                                order.kitchenStatus,
                                                item.id,
                                                item.quantity + 1,
                                              )
                                            }
                                            className="rounded border border-slate-200 p-1 hover:bg-slate-100"
                                            title="Increase quantity"
                                          >
                                            <Plus className="h-3 w-3" />
                                          </button>
                                          <button
                                            type="button"
                                            disabled={busyKey === `edit-item:${item.id}`}
                                            onClick={() =>
                                              void handleAdjustExistingOrderItem(
                                                composerTable.activeSession!.id,
                                                order.id,
                                                order.kitchenStatus,
                                                item.id,
                                                0,
                                              )
                                            }
                                            className="rounded border border-rose-200 p-1 text-rose-600 hover:bg-rose-50"
                                            title="Remove item"
                                          >
                                            <Trash2 className="h-3 w-3" />
                                          </button>
                                        </div>
                                      ) : (
                                        <span className="text-[10px] font-medium text-slate-400">
                                          {order.kitchenStatus} (locked)
                                        </span>
                                      )}
                                    </div>
                                  ))}
                              </div>
                            </div>
                          );
                        })}
                    </div>
                  )}
                </div>

                {/* Pre-Bill Discount Options */}
                {canHandleMoney && (
                  <div className="rounded-xl border border-slate-200 p-3.5">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-800">
                        Optional Pre-Bill Discount
                      </span>
                      <div className="flex gap-1">
                        {(['NONE', 'PERCENT', 'FIXED'] as const).map((m) => (
                          <button
                            key={m}
                            type="button"
                            onClick={() => {
                              setComposerDiscountMode(m);
                              if (m === 'NONE') {
                                setComposerDiscountInput('');
                                setComposerDiscountReason('');
                              }
                            }}
                            className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                              composerDiscountMode === m
                                ? 'bg-orange-600 text-white'
                                : 'bg-slate-100 text-slate-600'
                            }`}
                          >
                            {m === 'NONE' ? 'No Disc' : m === 'PERCENT' ? '% Off' : '₹ Fixed'}
                          </button>
                        ))}
                      </div>
                    </div>

                    {composerDiscountMode !== 'NONE' && (
                      <div className="grid grid-cols-2 gap-2">
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          placeholder={
                            composerDiscountMode === 'PERCENT' ? 'e.g. 10 (%)' : 'e.g. 100 (₹)'
                          }
                          value={composerDiscountInput}
                          onChange={(e) => setComposerDiscountInput(e.target.value)}
                          className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                        />
                        <input
                          type="text"
                          maxLength={200}
                          placeholder="Audit reason (min 3 chars)"
                          value={composerDiscountReason}
                          onChange={(e) => setComposerDiscountReason(e.target.value)}
                          className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                        />
                      </div>
                    )}
                  </div>
                )}

                {/* Live Payable Summary Preview */}
                <div className="space-y-1 rounded-xl bg-slate-900 p-4 text-xs text-white">
                  <div className="flex justify-between text-slate-300">
                    <span>Subtotal (Existing + New Items)</span>
                    <span className="font-mono">
                      {formatInrFromPaise(composerPreviewTotals.totals.itemsSubtotalPaise)}
                    </span>
                  </div>
                  {composerPreviewTotals.totals.discountPaise > 0 && (
                    <div className="flex justify-between text-amber-300">
                      <span>Discount</span>
                      <span className="font-mono">
                        -{formatInrFromPaise(composerPreviewTotals.totals.discountPaise)}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between text-slate-300">
                    <span>
                      GST ({taxSettings.gstRateBps / 100}% • {taxSettings.taxMode})
                    </span>
                    <span className="font-mono">
                      {formatInrFromPaise(composerPreviewTotals.totals.totalTaxPaise)}
                    </span>
                  </div>
                  <div className="flex justify-between border-t border-slate-700 pt-1.5 text-sm font-bold text-orange-400">
                    <span>Estimated Final Payable</span>
                    <span className="font-mono">
                      {formatInrFromPaise(composerPreviewTotals.totals.totalPaise)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Right side: Add Food Items from Live Menu */}
              <div className="flex flex-col rounded-xl border border-slate-200 p-3.5 md:col-span-6">
                <div className="mb-2 flex items-center gap-2">
                  <UtensilsCrossed className="h-4 w-4 text-orange-600" />
                  <span className="text-xs font-bold uppercase tracking-wide text-slate-800">
                    Add Dishes Before Finalizing Bill
                  </span>
                </div>

                <div className="relative mb-2.5">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    value={composerMenuSearch}
                    onChange={(e) => setComposerMenuSearch(e.target.value)}
                    placeholder="Search active menu items..."
                    className="w-full rounded-lg border border-slate-300 py-1.5 pl-8 pr-2.5 text-xs focus:border-orange-500 focus:outline-none"
                  />
                </div>

                <div className="max-h-72 flex-1 space-y-1.5 overflow-y-auto pr-1">
                  {flatAvailableMenuItems.length === 0 ? (
                    <p className="py-6 text-center text-xs text-slate-500">
                      No matching available dishes on outlet menu.
                    </p>
                  ) : (
                    flatAvailableMenuItems.map((item) => {
                      const qty = composerCart[item.id] ?? 0;
                      return (
                        <div
                          key={item.id}
                          className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-2 text-xs ${
                            qty > 0
                              ? 'border-orange-300 bg-orange-50/50'
                              : 'border-slate-100 bg-white'
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-semibold text-slate-900">{item.name}</p>
                            <p className="text-[11px] text-slate-500">
                              {item.categoryName} •{' '}
                              <span className="font-mono font-semibold text-slate-700">
                                {formatInrFromPaise(item.basePricePaise)}
                              </span>
                            </p>
                          </div>

                          <div className="flex items-center gap-1">
                            {qty > 0 ? (
                              <>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setComposerCart((prev) => {
                                      const next = (prev[item.id] ?? 0) - 1;
                                      const copy = { ...prev };
                                      if (next <= 0) delete copy[item.id];
                                      else copy[item.id] = next;
                                      return copy;
                                    })
                                  }
                                  className="rounded border border-orange-300 bg-white p-1 text-orange-700 hover:bg-orange-100"
                                >
                                  <Minus className="h-3 w-3" />
                                </button>
                                <span className="w-5 text-center font-mono font-bold text-orange-800">
                                  {qty}
                                </span>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setComposerCart((prev) => ({
                                      ...prev,
                                      [item.id]: (prev[item.id] ?? 0) + 1,
                                    }))
                                  }
                                  className="rounded border border-orange-300 bg-white p-1 text-orange-700 hover:bg-orange-100"
                                >
                                  <Plus className="h-3 w-3" />
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                onClick={() => {
                                  setComposerCart((prev) => ({ ...prev, [item.id]: 1 }));
                                  setComposerModifiers((prev) => {
                                    if (prev[item.id]) return prev;
                                    const defaults = (item.modifierGroups ?? [])
                                      .filter((g) => g.isRequired || g.minSelect > 0)
                                      .flatMap((g) => {
                                        const avail = g.options.filter((o) => o.inStock);
                                        const preferred = avail.filter((o) => o.isDefault);
                                        const chosen =
                                          preferred.length >= Math.max(1, g.minSelect)
                                            ? preferred
                                            : avail;
                                        return chosen
                                          .slice(0, Math.max(1, g.minSelect))
                                          .map((o) => o.id);
                                      });
                                    return defaults.length > 0
                                      ? { ...prev, [item.id]: defaults }
                                      : prev;
                                  });
                                }}
                                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700"
                              >
                                <Plus className="h-3 w-3" />
                                Add
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                {Object.keys(composerCart).length > 0 && (
                  <div className="mt-3 border-t border-slate-100 pt-2.5">
                    <input
                      type="text"
                      maxLength={200}
                      placeholder="Kitchen / billing note for new items (optional)"
                      value={composerOrderNotes}
                      onChange={(e) => setComposerOrderNotes(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                    />
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-6 py-4">
              <span className="text-xs text-slate-500">
                New items are synced to Kitchen KDS and Dining Floor automatically.
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setComposerOpen(false)}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={busyKey === 'composer-submit'}
                  className="rounded-lg bg-orange-600 px-5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-orange-700 disabled:opacity-50"
                >
                  {busyKey === 'composer-submit'
                    ? 'Processing...'
                    : composerEditingBillId
                      ? 'Save & Update Open Bill'
                      : 'Finalize & Generate GST Bill'}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* Audited Discount Modal (% Percentage OR ₹ Fixed) */}
      {discountModalOpen && selectedBill && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 print:hidden">
          <form
            onSubmit={handleApplyDiscount}
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
          >
            <h3 className="text-base font-bold text-slate-900">
              Apply Audited Discount — {selectedBill.billNumber}
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              Item Subtotal: {formatInrFromPaise(selectedBill.subtotalPaise)}. GST and round-off
              recalculate cleanly on the server, and every change is logged.
            </p>

            <div className="mt-4 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setDiscountType('PERCENT');
                    setDiscountAmountInput('');
                  }}
                  className={`rounded-lg border py-2 text-xs font-semibold transition ${
                    discountType === 'PERCENT'
                      ? 'border-orange-500 bg-orange-50 text-orange-700'
                      : 'border-slate-200 text-slate-600'
                  }`}
                >
                  Percentage (%)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDiscountType('FIXED');
                    setDiscountAmountInput('');
                  }}
                  className={`rounded-lg border py-2 text-xs font-semibold transition ${
                    discountType === 'FIXED'
                      ? 'border-orange-500 bg-orange-50 text-orange-700'
                      : 'border-slate-200 text-slate-600'
                  }`}
                >
                  Fixed Amount (₹)
                </button>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700">
                  {discountType === 'PERCENT'
                    ? 'Discount Percentage (%)'
                    : 'Fixed Discount Amount (₹ INR)'}
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max={discountType === 'PERCENT' ? '100' : undefined}
                  required
                  placeholder={discountType === 'PERCENT' ? 'e.g. 10 for 10%' : 'e.g. 50.00'}
                  value={discountAmountInput}
                  onChange={(e) => setDiscountAmountInput(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-orange-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700">
                  Audit Reason (Required)
                </label>
                <input
                  type="text"
                  minLength={3}
                  maxLength={200}
                  required
                  placeholder="e.g. Corporate 10% offer / Manager comp"
                  value={discountReason}
                  onChange={(e) => setDiscountReason(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-orange-500 focus:outline-none"
                />
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDiscountModalOpen(false)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busyKey === `discount:${selectedBill.id}`}
                className="rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-700 disabled:opacity-50"
              >
                Save Discount
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Void Bill Modal */}
      {voidModalOpen && selectedBill && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 print:hidden">
          <form onSubmit={handleVoidBill} className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="text-base font-bold text-rose-700">
              Void Bill — {selectedBill.billNumber}
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              Voiding marks this invoice immutable as VOID so you can generate a corrected
              replacement bill cleanly.
            </p>
            <div className="mt-4">
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                Void Reason (Required)
              </label>
              <input
                type="text"
                minLength={3}
                maxLength={200}
                required
                placeholder="e.g. Wrong outlet GST mode before settlement"
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setVoidModalOpen(false)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busyKey === `void:${selectedBill.id}`}
                className="rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
              >
                Confirm Void
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Refund Modal */}
      {refundTargetAttemptId && selectedBill && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 print:hidden">
          <form onSubmit={handleRefundSubmit} className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="text-base font-bold text-rose-700">Issue Refund</h3>
            <p className="mt-1 text-xs text-slate-500">
              Maximum refundable net collected balance on {selectedBill.billNumber}:{' '}
              {formatInrFromPaise(selectedBill.netPaidPaise)}.
            </p>
            <div className="mt-4 space-y-3">
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700">
                  Refund Amount (₹ INR)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="1"
                  required
                  value={refundRupees}
                  onChange={(e) => setRefundRupees(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700">
                  Refund Reason (Required)
                </label>
                <input
                  type="text"
                  minLength={3}
                  maxLength={200}
                  required
                  placeholder="e.g. Cancelled item after payment / duplicate charge"
                  value={refundReason}
                  onChange={(e) => setRefundReason(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRefundTargetAttemptId(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busyKey === `refund:${refundTargetAttemptId}`}
                className="rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
              >
                Process Refund
              </button>
            </div>
          </form>
        </div>
      )}
    </DashboardShell>
  );
}
