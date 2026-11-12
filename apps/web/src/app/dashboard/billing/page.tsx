'use client';

import {
  formatInrFromPaise,
  StaffRole,
} from '@autonex/shared';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  AlertTriangle,
  Banknote,
  Ban,
  CheckCircle2,
  CreditCard,
  Download,
  Percent,
  QrCode,
  RefreshCw,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Smartphone,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { DashboardShell } from '@/components/dashboard-shell';
import {
  ApiError,
  apiRequest,
  BillStatus,
  BillSummaryDto,
  downloadProtectedPdf,
  ensureFreshAccessToken,
  FloorSessionTableDto,
  getStoredSession,
  PaymentMethod,
  PaymentStatus,
  RazorpayOrderResponse,
  ReconcileResultDto,
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

interface OutletTaxSettings {
  taxMode: TaxMode;
  gstRateBps: number;
  roundOffEnabled: boolean;
  gstin: string;
}

function rupeesStrToPaise(input: string): number {
  const cleaned = Number(input.trim());
  if (!Number.isFinite(cleaned) || cleaned <= 0) return 0;
  return Math.round(cleaned * 100);
}

export default function BillingAndPaymentsPage() {
  const [bills, setBills] = useState<BillSummaryDto[]>([]);
  const [tables, setTables] = useState<FloorSessionTableDto[]>([]);
  const [selectedBillId, setSelectedBillId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'ALL' | BillStatus>('ALL');
  const [loading, setLoading] = useState(true);
  const [wsConnected, setWsConnected] = useState(false);
  const [userRole, setUserRole] = useState<string>(StaffRole.WAITER);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null,
  );
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Tax settings drawer state
  const [showTaxSettings, setShowTaxSettings] = useState(false);
  const [taxForm, setTaxForm] = useState<OutletTaxSettings>({
    taxMode: TaxMode.EXCLUSIVE,
    gstRateBps: 500,
    roundOffEnabled: false,
    gstin: '',
  });

  // Payment collection form state
  const [payMethod, setPayMethod] = useState<
    PaymentMethod.CASH | PaymentMethod.UPI_MANUAL | PaymentMethod.CARD
  >(PaymentMethod.CASH);
  const [payAmountRupees, setPayAmountRupees] = useState('');
  const [receiptRef, setReceiptRef] = useState('');
  const [gatewayOrder, setGatewayOrder] = useState<RazorpayOrderResponse | null>(null);

  // Audited Discount / Void / Refund modals
  const [showDiscountModal, setShowDiscountModal] = useState(false);
  const [discountRupees, setDiscountRupees] = useState('');
  const [discountReason, setDiscountReason] = useState('');

  const [showVoidModal, setShowVoidModal] = useState(false);
  const [voidReason, setVoidReason] = useState('');

  const [refundTarget, setRefundTarget] = useState<{
    attemptId: string;
    maxPaise: number;
    method: string;
  } | null>(null);
  const [refundRupees, setRefundRupees] = useState('');
  const [refundReason, setRefundReason] = useState('');

  const socketRef = useRef<Socket | null>(null);

  const canManagePayments = [
    StaffRole.OWNER,
    StaffRole.MANAGER,
    StaffRole.CASHIER,
  ].includes(userRole as StaffRole);

  const isOwner = userRole === StaffRole.OWNER;

  const loadData = useCallback(async () => {
    try {
      const [billsRes, sessionsRes] = await Promise.all([
        apiRequest<BillSummaryDto[]>('/billing/bills?limit=60'),
        apiRequest<FloorSessionTableDto[]>('/sessions'),
      ]);
      setBills(billsRes);
      setTables(sessionsRes);
      setSelectedBillId((prev) => {
        if (prev && billsRes.some((b) => b.id === prev)) return prev;
        return billsRes[0]?.id ?? null;
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Unable to load billing workspace',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTaxSettings = useCallback(async (role: string) => {
    if (![StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER].includes(role as StaffRole)) {
      return;
    }
    try {
      const profile = await apiRequest<{
        outlet?: {
          taxMode?: TaxMode;
          gstRateBps?: number;
          roundOffEnabled?: boolean;
          gstin?: string | null;
        };
      }>('/outlet/profile');
      if (profile.outlet) {
        setTaxForm({
          taxMode: profile.outlet.taxMode ?? TaxMode.EXCLUSIVE,
          gstRateBps: profile.outlet.gstRateBps ?? 500,
          roundOffEnabled: Boolean(profile.outlet.roundOffEnabled),
          gstin: profile.outlet.gstin ?? '',
        });
      }
    } catch {
      // Non-blocking
    }
  }, []);

  useEffect(() => {
    const auth = getStoredSession();
    const role = auth?.user?.role ?? StaffRole.WAITER;
    setUserRole(role);

    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const qBillId = params.get('billId');
      if (qBillId) setSelectedBillId(qBillId);
    }

    void loadData();
    void loadTaxSettings(role);
  }, [loadData, loadTaxSettings]);

  // Real-time WebSocket updates + 8s polling fallback
  useEffect(() => {
    let active = true;
    const connectSocket = async () => {
      const current = getStoredSession();
      const token = current?.accessToken || (await ensureFreshAccessToken());
      if (!active || !token) return;

      const socket = io(`${WS_BASE_URL}/kds`, {
        transports: ['websocket', 'polling'],
        auth: { token },
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 8000,
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

      socketRef.current = socket;
    };

    void connectSocket();
    const timer = window.setInterval(() => {
      void loadData();
    }, 8000);

    return () => {
      active = false;
      window.clearInterval(timer);
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, [loadData]);

  const selectedBill = useMemo(
    () => bills.find((b) => b.id === selectedBillId) ?? null,
    [bills, selectedBillId],
  );

  // Sync default payment amount when switching bills
  useEffect(() => {
    if (selectedBill) {
      setPayAmountRupees((selectedBill.duePaise / 100).toFixed(2));
      setGatewayOrder(null);
      setReceiptRef('');
    }
  }, [selectedBill?.id, selectedBill?.duePaise]);

  const filteredBills = useMemo(() => {
    if (statusFilter === 'ALL') return bills;
    return bills.filter((b) => b.status === statusFilter);
  }, [bills, statusFilter]);

  // Active tables with orders that don't yet have an active non-VOID bill
  const unbilledActiveTables = useMemo(
    () =>
      tables.filter(
        (t) =>
          t.activeSession &&
          !t.activeSession.activeBill &&
          t.activeSession.orders.some((o) => o.kitchenStatus !== 'CANCELLED'),
      ),
    [tables],
  );

  const runAction = async (key: string, fn: () => Promise<void>) => {
    setBusyKey(key);
    setFeedback(null);
    try {
      await fn();
      await loadData();
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Action failed. Please try again.',
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleSaveTaxSettings = async (e: FormEvent) => {
    e.preventDefault();
    await runAction('tax-save', async () => {
      await apiRequest('/outlet/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          taxMode: taxForm.taxMode,
          gstRateBps: Number(taxForm.gstRateBps),
          roundOffEnabled: taxForm.roundOffEnabled,
          ...(taxForm.gstin.trim() ? { gstin: taxForm.gstin.trim().toUpperCase() } : {}),
        }),
      });
      setShowTaxSettings(false);
      setFeedback({
        type: 'success',
        text: 'Outlet GST & Round-Off settings saved for all new bills.',
      });
    });
  };

  const handleManualPayment = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedBill) return;
    const amountPaise = rupeesStrToPaise(payAmountRupees);
    if (amountPaise <= 0) {
      setFeedback({ type: 'error', text: 'Enter a valid payment amount greater than zero.' });
      return;
    }

    await runAction('manual-pay', async () => {
      const idemKey = `manual-${selectedBill.id}-${payMethod}-${amountPaise}-${Date.now()}`;
      await apiRequest(`/payments/bills/${selectedBill.id}/manual`, {
        method: 'POST',
        headers: { 'Idempotency-Key': idemKey },
        body: JSON.stringify({
          method: payMethod,
          amountPaise,
          ...(receiptRef.trim() ? { receiptRef: receiptRef.trim() } : {}),
        }),
      });
      setReceiptRef('');
      setFeedback({
        type: 'success',
        text: `Recorded ${payMethod.replace('_', ' ')} payment of ${formatInrFromPaise(amountPaise)} on ${selectedBill.billNumber}.`,
      });
    });
  };

  const handleCreateRazorpayOrder = async () => {
    if (!selectedBill) return;
    const amountPaise = rupeesStrToPaise(payAmountRupees) || selectedBill.duePaise;

    await runAction('rzp-order', async () => {
      const idemKey = `rzp-${selectedBill.id}-${amountPaise}-${Date.now()}`;
      const order = await apiRequest<RazorpayOrderResponse>(
        `/payments/bills/${selectedBill.id}/razorpay/order`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': idemKey },
          body: JSON.stringify({ amountPaise }),
        },
      );
      setGatewayOrder(order);
      setFeedback({
        type: 'success',
        text: `Online payment order ${order.gatewayOrderId} created (${formatInrFromPaise(order.amountPaise)}).`,
      });
    });
  };

  const handleVerifyMockRazorpay = async () => {
    if (!gatewayOrder?.mockCheckoutHint) return;
    await runAction('rzp-verify', async () => {
      await apiRequest('/payments/razorpay/verify', {
        method: 'POST',
        body: JSON.stringify({
          razorpayOrderId: gatewayOrder.mockCheckoutHint!.razorpayOrderId,
          razorpayPaymentId: gatewayOrder.mockCheckoutHint!.razorpayPaymentId,
          razorpaySignature: gatewayOrder.mockCheckoutHint!.razorpaySignature,
        }),
      });
      setGatewayOrder(null);
      setFeedback({
        type: 'success',
        text: 'Online Razorpay payment verified & allocated to the bill!',
      });
    });
  };

  const handleApplyDiscount = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedBill) return;
    const rawPaise = discountRupees.trim() === '0' ? 0 : rupeesStrToPaise(discountRupees);
    if (discountRupees.trim() !== '0' && rawPaise <= 0) {
      setFeedback({ type: 'error', text: 'Enter a valid discount in ₹ (or 0 to clear).' });
      return;
    }

    await runAction('apply-discount', async () => {
      await apiRequest(`/billing/bills/${selectedBill.id}/discount`, {
        method: 'POST',
        body: JSON.stringify({
          discountPaise: rawPaise,
          reason: discountReason.trim(),
        }),
      });
      setShowDiscountModal(false);
      setDiscountReason('');
      setFeedback({
        type: 'success',
        text: `Audited discount applied to ${selectedBill.billNumber}.`,
      });
    });
  };

  const handleVoidBill = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedBill) return;
    await runAction('void-bill', async () => {
      await apiRequest(`/billing/bills/${selectedBill.id}/void`, {
        method: 'POST',
        body: JSON.stringify({ reason: voidReason.trim() }),
      });
      setShowVoidModal(false);
      setVoidReason('');
      setFeedback({
        type: 'success',
        text: `Bill ${selectedBill.billNumber} has been voided.`,
      });
    });
  };

  const handleIssueRefund = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedBill || !refundTarget) return;
    const amountPaise = rupeesStrToPaise(refundRupees);
    if (amountPaise <= 0 || amountPaise > refundTarget.maxPaise) {
      setFeedback({
        type: 'error',
        text: `Refund must be between ₹0.01 and ${formatInrFromPaise(refundTarget.maxPaise)}.`,
      });
      return;
    }

    await runAction('issue-refund', async () => {
      await apiRequest(`/payments/bills/${selectedBill.id}/refunds`, {
        method: 'POST',
        body: JSON.stringify({
          paymentAttemptId: refundTarget.attemptId,
          amountPaise,
          reason: refundReason.trim(),
        }),
      });
      setRefundTarget(null);
      setRefundReason('');
      setFeedback({
        type: 'success',
        text: `Refund of ${formatInrFromPaise(amountPaise)} processed for ${selectedBill.billNumber}.`,
      });
    });
  };

  return (
    <DashboardShell
      title="Billing & Payments"
      subtitle="Consolidate multi-order session bills, apply audited discounts, collect Cash/UPI/Card or Razorpay, reconcile pending attempts, and issue GST receipts."
    >
      {/* Top Toolbar */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm">
        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              { key: 'ALL', label: `All (${bills.length})` },
              { key: BillStatus.OPEN, label: 'Open' },
              { key: BillStatus.PARTIALLY_PAID, label: 'Partial' },
              { key: BillStatus.PAID, label: 'Paid' },
              { key: BillStatus.VOID, label: 'Voided' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setStatusFilter(tab.key)}
              className={`rounded-xl px-3 py-1.5 text-xs font-semibold transition ${
                statusFilter === tab.key
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
              wsConnected ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
            }`}
          >
            {wsConnected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
            {wsConnected ? 'Live Sync' : 'Polling'}
          </span>

          {canManagePayments && (
            <button
              type="button"
              disabled={busyKey === 'reconcile'}
              onClick={() =>
                void runAction('reconcile', async () => {
                  const res = await apiRequest<ReconcileResultDto>('/payments/reconcile', {
                    method: 'POST',
                  });
                  setFeedback({
                    type: 'success',
                    text: `Reconciliation complete: scanned ${res.scanned}, captured ${res.capturedCount}, failed ${res.failedCount}, still pending ${res.stillPendingCount}.`,
                  });
                })
              }
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${busyKey === 'reconcile' ? 'animate-spin' : ''}`} />
              Reconcile Pending
            </button>
          )}

          <button
            type="button"
            onClick={() => setShowTaxSettings((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            <Settings2 className="h-3.5 w-3.5" />
            Tax Config ({taxForm.gstRateBps / 100}% {taxForm.taxMode})
          </button>
        </div>
      </div>

      {/* Feedback Banner */}
      {feedback && (
        <div
          className={`mb-4 flex items-center justify-between rounded-xl border px-4 py-3 text-sm ${
            feedback.type === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-rose-200 bg-rose-50 text-rose-800'
          }`}
        >
          <span className="flex items-center gap-2">
            {feedback.type === 'success' ? (
              <CheckCircle2 className="h-4 w-4 shrink-0" />
            ) : (
              <AlertTriangle className="h-4 w-4 shrink-0" />
            )}
            {feedback.text}
          </span>
          <button type="button" onClick={() => setFeedback(null)}>
            <X className="h-4 w-4 opacity-70" />
          </button>
        </div>
      )}

      {/* Outlet Tax Treatment Settings Panel */}
      {showTaxSettings && (
        <form
          onSubmit={handleSaveTaxSettings}
          className="mb-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <div>
              <h2 className="text-sm font-bold text-slate-900">Outlet Tax & Rounding Configuration</h2>
              <p className="text-xs text-slate-500">
                Applies to newly consolidated bills. Existing paid or finalized bills retain their GST snapshot.
              </p>
            </div>
            <button type="button" onClick={() => setShowTaxSettings(false)}>
              <X className="h-4 w-4 text-slate-400" />
            </button>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700">Tax Mode</label>
              <select
                disabled={!isOwner}
                value={taxForm.taxMode}
                onChange={(e) => setTaxForm({ ...taxForm, taxMode: e.target.value as TaxMode })}
                className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-xs font-medium text-slate-900 disabled:bg-slate-100"
              >
                {Object.entries(TAX_MODE_LABEL).map(([val, label]) => (
                  <option key={val} value={val}>
                    {label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">GST Rate</label>
              <select
                disabled={!isOwner || taxForm.taxMode === TaxMode.NONE}
                value={taxForm.gstRateBps}
                onChange={(e) => setTaxForm({ ...taxForm, gstRateBps: Number(e.target.value) })}
                className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-xs font-medium text-slate-900 disabled:bg-slate-100"
              >
                <option value={0}>0% (No GST)</option>
                <option value={500}>5% (2.5% CGST + 2.5% SGST)</option>
                <option value={1200}>12% (6% CGST + 6% SGST)</option>
                <option value={1800}>18% (9% CGST + 9% SGST)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">GSTIN (Optional)</label>
              <input
                type="text"
                disabled={!isOwner}
                value={taxForm.gstin}
                onChange={(e) => setTaxForm({ ...taxForm, gstin: e.target.value })}
                placeholder="24ABCDE1234F1Z5"
                className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-xs font-medium uppercase text-slate-900 disabled:bg-slate-100"
              />
            </div>

            <div className="flex flex-col justify-end">
              <label className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700">
                <input
                  type="checkbox"
                  disabled={!isOwner}
                  checked={taxForm.roundOffEnabled}
                  onChange={(e) =>
                    setTaxForm({ ...taxForm, roundOffEnabled: e.target.checked })
                  }
                />
                Round Off Total to Nearest ₹1
              </label>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between">
            <span className="text-[11px] text-slate-500">
              {isOwner
                ? 'You have Owner permission to update outlet tax settings.'
                : 'Only the Outlet Owner can modify tax treatment settings.'}
            </span>
            {isOwner && (
              <button
                type="submit"
                disabled={busyKey === 'tax-save'}
                className="rounded-xl bg-brand-600 px-4 py-2 text-xs font-bold text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {busyKey === 'tax-save' ? 'Saving...' : 'Save Tax Settings'}
              </button>
            )}
          </div>
        </form>
      )}

      {/* Tables with Active Orders Ready to Generate Bill */}
      {unbilledActiveTables.length > 0 && (
        <section className="mb-5 rounded-2xl border border-purple-200 bg-purple-50/60 p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-wide text-purple-900">
              Active Tables Without Final Bill ({unbilledActiveTables.length})
            </h2>
            <span className="text-[11px] text-purple-700">
              Generating a bill automatically locks the session for checkout
            </span>
          </div>
          <div className="flex flex-wrap gap-2.5">
            {unbilledActiveTables.map((t) => {
              const session = t.activeSession!;
              const estTotal =
                session.balance?.estimatedTotalPaise ?? session.runningTotalPaise;
              return (
                <div
                  key={t.id}
                  className="flex items-center gap-3 rounded-xl border border-purple-200 bg-white px-3.5 py-2 shadow-sm"
                >
                  <div>
                    <p className="text-xs font-bold text-slate-900">
                      Table {t.tableNumber}
                      {session.status === 'BILL_REQUESTED' ? ' • Bill Requested' : ''}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      Est. {formatInrFromPaise(estTotal)}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={busyKey === `gen-${session.id}`}
                    onClick={() =>
                      void runAction(`gen-${session.id}`, async () => {
                        const res = await apiRequest<{
                          bill: BillSummaryDto;
                          alreadyExisted: boolean;
                        }>(`/billing/sessions/${session.id}/bill`, {
                          method: 'POST',
                          body: JSON.stringify({}),
                        });
                        setSelectedBillId(res.bill.id);
                        setFeedback({
                          type: 'success',
                          text: `Consolidated ${res.bill.billNumber} for Table ${t.tableNumber}.`,
                        });
                      })
                    }
                    className="rounded-lg bg-purple-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-purple-800 disabled:opacity-50"
                  >
                    Generate Bill
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Main Split Workspace: Bills List + Detailed Cashier Console */}
      {loading ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          Loading bills and payment ledgers...
        </div>
      ) : bills.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center">
          <CreditCard className="mx-auto h-10 w-10 text-slate-300" />
          <h3 className="mt-3 text-base font-bold text-slate-900">No Bills Generated Yet</h3>
          <p className="mt-1 text-xs text-slate-500">
            Seat a table and place orders, then click Generate Bill above or from the Live Floor.
          </p>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-12">
          {/* Left Column: Bill Selector */}
          <div className="space-y-2.5 lg:col-span-5">
            {filteredBills.map((bill) => {
              const badge = getBillStatusBadge(bill.status);
              const isSelected = bill.id === selectedBill?.id;
              return (
                <button
                  key={bill.id}
                  type="button"
                  onClick={() => setSelectedBillId(bill.id)}
                  className={`w-full rounded-2xl border p-4 text-left transition ${
                    isSelected
                      ? 'border-brand-500 bg-white ring-2 ring-brand-500/20 shadow-sm'
                      : 'border-slate-200 bg-white hover:border-slate-300'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-mono text-xs font-bold text-slate-900">
                        {bill.billNumber}
                      </p>
                      <p className="mt-0.5 text-sm font-bold text-slate-900">
                        Table {bill.tableNumber}
                        {bill.tableLabel ? ` • ${bill.tableLabel}` : ''}
                      </p>
                    </div>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold ${badge.className}`}
                    >
                      {badge.label}
                    </span>
                  </div>

                  <div className="mt-3 flex items-center justify-between text-xs">
                    <span className="text-slate-500">
                      Total: <strong className="text-slate-900">{formatInrFromPaise(bill.totalPaise)}</strong>
                    </span>
                    {bill.duePaise > 0 && bill.status !== BillStatus.VOID ? (
                      <span className="font-bold text-amber-700">
                        Due {formatInrFromPaise(bill.duePaise)}
                      </span>
                    ) : bill.netPaidPaise > 0 ? (
                      <span className="font-semibold text-emerald-700">
                        Paid {formatInrFromPaise(bill.netPaidPaise)}
                      </span>
                    ) : (
                      <span className="text-slate-400">
                        {new Date(bill.finalizedAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Right Column: Selected Bill Details & Payment Terminal */}
          <div className="lg:col-span-7">
            {!selectedBill ? (
              <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
                Select a bill from the left to view line items, apply discounts, or collect payments.
              </div>
            ) : (
              <div className="space-y-5">
                {/* Bill Invoice Card */}
                <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="font-mono text-lg font-extrabold text-slate-900">
                          {selectedBill.billNumber}
                        </h2>
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${getBillStatusBadge(selectedBill.status).className}`}
                        >
                          {getBillStatusBadge(selectedBill.status).label}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-slate-500">
                        Table {selectedBill.tableNumber} •{' '}
                        {new Date(selectedBill.finalizedAt).toLocaleString()}
                        {selectedBill.gstinSnapshot ? ` • GSTIN ${selectedBill.gstinSnapshot}` : ''}
                      </p>
                      {selectedBill.voidReason && (
                        <p className="mt-1 text-xs font-semibold text-rose-700">
                          Void Reason: {selectedBill.voidReason}
                        </p>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          void downloadProtectedPdf(
                            `/billing/bills/${selectedBill.id}/receipt.pdf`,
                            `${selectedBill.billNumber}.pdf`,
                          )
                        }
                        className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50"
                      >
                        <Download className="h-3.5 w-3.5" /> Receipt PDF
                      </button>

                      {canManagePayments &&
                        selectedBill.status !== BillStatus.VOID &&
                        selectedBill.status !== BillStatus.PAID && (
                          <button
                            type="button"
                            onClick={() => {
                              setDiscountRupees((selectedBill.discountPaise / 100).toFixed(2));
                              setDiscountReason(selectedBill.discountReason ?? '');
                              setShowDiscountModal(true);
                            }}
                            className="inline-flex items-center gap-1 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50"
                          >
                            <Percent className="h-3.5 w-3.5" /> Discount
                          </button>
                        )}

                      {canManagePayments &&
                        selectedBill.status !== BillStatus.VOID &&
                        selectedBill.netPaidPaise === 0 && (
                          <button
                            type="button"
                            onClick={() => setShowVoidModal(true)}
                            className="inline-flex items-center gap-1 rounded-xl border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-bold text-rose-700 hover:bg-rose-100"
                          >
                            <Ban className="h-3.5 w-3.5" /> Void
                          </button>
                        )}
                    </div>
                  </div>

                  {/* Consolidated Line Items */}
                  <div className="mt-4">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-slate-100 text-left text-[11px] uppercase tracking-wide text-slate-400">
                          <th className="pb-2">Item</th>
                          <th className="pb-2 text-center">Qty</th>
                          <th className="pb-2 text-right">Rate</th>
                          <th className="pb-2 text-right">Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {selectedBill.lines.map((line) => (
                          <tr key={line.id}>
                            <td className="py-2 pr-2 font-medium text-slate-800">
                              {line.description}
                            </td>
                            <td className="py-2 text-center text-slate-600">{line.quantity}</td>
                            <td className="py-2 text-right text-slate-600">
                              {formatInrFromPaise(line.unitAmountPaise)}
                            </td>
                            <td className="py-2 text-right font-semibold text-slate-900">
                              {formatInrFromPaise(line.lineAmountPaise)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Integer Paise Tax & Total Breakdown */}
                  <div className="mt-4 space-y-1.5 rounded-xl bg-slate-900 p-4 text-xs text-slate-300">
                    <div className="flex justify-between">
                      <span>Items Subtotal</span>
                      <span className="font-semibold text-white">
                        {formatInrFromPaise(selectedBill.subtotalPaise)}
                      </span>
                    </div>
                    {selectedBill.discountPaise > 0 && (
                      <div className="flex justify-between text-emerald-300">
                        <span>
                          Discount{selectedBill.discountReason ? ` (${selectedBill.discountReason})` : ''}
                        </span>
                        <span>-{formatInrFromPaise(selectedBill.discountPaise)}</span>
                      </div>
                    )}
                    <div className="flex justify-between text-slate-400">
                      <span>
                        CGST ({selectedBill.gstRateBps / 200}%) •{' '}
                        {selectedBill.taxMode === TaxMode.INCLUSIVE ? 'Incl.' : selectedBill.taxMode}
                      </span>
                      <span>{formatInrFromPaise(selectedBill.cgstPaise)}</span>
                    </div>
                    <div className="flex justify-between text-slate-400">
                      <span>SGST ({selectedBill.gstRateBps / 200}%)</span>
                      <span>{formatInrFromPaise(selectedBill.sgstPaise)}</span>
                    </div>
                    {selectedBill.roundOffPaise !== 0 && (
                      <div className="flex justify-between text-slate-400">
                        <span>Round Off</span>
                        <span>
                          {selectedBill.roundOffPaise > 0 ? '+' : ''}
                          {formatInrFromPaise(selectedBill.roundOffPaise)}
                        </span>
                      </div>
                    )}
                    <div className="flex justify-between border-t border-slate-700 pt-2 text-sm font-extrabold text-white">
                      <span>Grand Total</span>
                      <span>{formatInrFromPaise(selectedBill.totalPaise)}</span>
                    </div>
                    <div className="flex justify-between pt-1 text-emerald-300">
                      <span>Net Paid (Paid {formatInrFromPaise(selectedBill.paidPaise)} − Refunded {formatInrFromPaise(selectedBill.refundedPaise)})</span>
                      <span className="font-bold">{formatInrFromPaise(selectedBill.netPaidPaise)}</span>
                    </div>
                    <div className="flex justify-between text-sm font-bold text-amber-300">
                      <span>Balance Due</span>
                      <span>{formatInrFromPaise(selectedBill.duePaise)}</span>
                    </div>
                  </div>
                </div>

                {/* Payment Collection Panel */}
                {canManagePayments &&
                  selectedBill.status !== BillStatus.VOID &&
                  selectedBill.duePaise > 0 && (
                    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                      <h3 className="text-sm font-bold text-slate-900">
                        Collect Counter / Online Payment (Supports Split / Partial Settlement)
                      </h3>

                      <div className="mt-3 flex flex-wrap items-end gap-3">
                        <div className="flex-1 min-w-[160px]">
                          <label className="block text-xs font-semibold text-slate-700">
                            Amount to Collect (₹)
                          </label>
                          <input
                            type="number"
                            step="0.01"
                            min="0.01"
                            value={payAmountRupees}
                            onChange={(e) => setPayAmountRupees(e.target.value)}
                            className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-bold text-slate-900"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            setPayAmountRupees((selectedBill.duePaise / 100).toFixed(2))
                          }
                          className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          Full Due
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setPayAmountRupees(
                              (Math.ceil(selectedBill.duePaise / 2) / 100).toFixed(2),
                            )
                          }
                          className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          50% Split
                        </button>
                      </div>

                      <form onSubmit={handleManualPayment} className="mt-4 space-y-3 border-t border-slate-100 pt-4">
                        <div className="grid grid-cols-3 gap-2">
                          {(
                            [
                              { method: PaymentMethod.CASH, label: 'Cash', icon: Banknote },
                              { method: PaymentMethod.UPI_MANUAL, label: 'Counter UPI', icon: Smartphone },
                              { method: PaymentMethod.CARD, label: 'Card POS', icon: CreditCard },
                            ] as const
                          ).map((opt) => {
                            const Icon = opt.icon;
                            const active = payMethod === opt.method;
                            return (
                              <button
                                key={opt.method}
                                type="button"
                                onClick={() => setPayMethod(opt.method)}
                                className={`flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2.5 text-xs font-bold transition ${
                                  active
                                    ? 'border-brand-600 bg-brand-50 text-brand-700'
                                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                                }`}
                              >
                                <Icon className="h-4 w-4" />
                                {opt.label}
                              </button>
                            );
                          })}
                        </div>

                        <div className="flex flex-wrap gap-2">
                          <input
                            type="text"
                            value={receiptRef}
                            onChange={(e) => setReceiptRef(e.target.value)}
                            placeholder="Optional UPI UTR / POS Slip Ref"
                            className="flex-1 min-w-[180px] rounded-xl border border-slate-300 px-3 py-2 text-xs"
                          />
                          <button
                            type="submit"
                            disabled={busyKey === 'manual-pay'}
                            className="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
                          >
                            {busyKey === 'manual-pay' ? 'Recording...' : 'Record Counter Payment'}
                          </button>
                        </div>
                      </form>

                      {/* Online Razorpay Order Section */}
                      <div className="mt-4 border-t border-slate-100 pt-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <p className="text-xs font-bold text-slate-900">
                              Online Razorpay / Dynamic QR Checkout
                            </p>
                            <p className="text-[11px] text-slate-500">
                              Generates gateway order for the specified amount; verified via HMAC or webhook.
                            </p>
                          </div>
                          <button
                            type="button"
                            disabled={busyKey === 'rzp-order'}
                            onClick={() => void handleCreateRazorpayOrder()}
                            className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-3.5 py-2 text-xs font-bold text-white hover:bg-slate-800 disabled:opacity-50"
                          >
                            <QrCode className="h-3.5 w-3.5" />
                            Generate Razorpay Order
                          </button>
                        </div>

                        {gatewayOrder && (
                          <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs text-sky-900">
                            <p className="font-bold">
                              Order ID: <span className="font-mono">{gatewayOrder.gatewayOrderId}</span> •{' '}
                              {formatInrFromPaise(gatewayOrder.amountPaise)}
                            </p>
                            {gatewayOrder.qrPayloadUrl && (
                              <p className="mt-1 break-all font-mono text-[11px] text-sky-700">
                                Payment Link / QR: {gatewayOrder.qrPayloadUrl}
                              </p>
                            )}
                            {gatewayOrder.isMock && gatewayOrder.mockCheckoutHint && (
                              <div className="mt-2 flex items-center justify-between gap-2">
                                <span className="text-[11px] font-semibold">
                                  Mock Sandbox Mode active
                                </span>
                                <button
                                  type="button"
                                  disabled={busyKey === 'rzp-verify'}
                                  onClick={() => void handleVerifyMockRazorpay()}
                                  className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700"
                                >
                                  <ShieldCheck className="h-3.5 w-3.5" />
                                  Simulate Captured Payment
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                {/* Payment Attempts & Refunds Ledger */}
                <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h3 className="text-sm font-bold text-slate-900">
                    Payments & Refunds Ledger ({selectedBill.paymentAttempts.length})
                  </h3>

                  {selectedBill.paymentAttempts.length === 0 ? (
                    <p className="mt-2 text-xs text-slate-500">
                      No payment attempts recorded yet for this bill.
                    </p>
                  ) : (
                    <div className="mt-3 space-y-2">
                      {selectedBill.paymentAttempts.map((pa) => (
                        <div
                          key={pa.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-100 bg-slate-50 px-3.5 py-2.5 text-xs"
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-slate-900">
                                {pa.method.replace('_', ' ')} ({pa.provider})
                              </span>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                                  pa.status === PaymentStatus.SUCCEEDED
                                    ? 'bg-emerald-100 text-emerald-800'
                                    : pa.status === PaymentStatus.FAILED
                                      ? 'bg-rose-100 text-rose-800'
                                      : 'bg-amber-100 text-amber-800'
                                }`}
                              >
                                {pa.status}
                              </span>
                            </div>
                            <p className="mt-0.5 text-[11px] text-slate-500">
                              {pa.receiptRef ? `Ref: ${pa.receiptRef} • ` : ''}
                              {pa.gatewayOrderId ? `Order: ${pa.gatewayOrderId} • ` : ''}
                              {pa.failureReason ? `Failed: ${pa.failureReason} • ` : ''}
                              {new Date(pa.createdAt).toLocaleTimeString()}
                            </p>
                          </div>

                          <div className="flex items-center gap-3">
                            <span className="font-bold text-slate-900">
                              {formatInrFromPaise(pa.amountPaise)}
                            </span>
                            {canManagePayments &&
                              pa.status === PaymentStatus.SUCCEEDED &&
                              selectedBill.netPaidPaise > 0 && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    const maxPaise = Math.min(
                                      pa.amountPaise,
                                      selectedBill.netPaidPaise,
                                    );
                                    setRefundTarget({
                                      attemptId: pa.id,
                                      maxPaise,
                                      method: pa.method,
                                    });
                                    setRefundRupees((maxPaise / 100).toFixed(2));
                                    setRefundReason('');
                                  }}
                                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-bold text-slate-700 hover:bg-slate-100"
                                >
                                  <RotateCcw className="h-3 w-3" /> Refund
                                </button>
                              )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {selectedBill.refunds.length > 0 && (
                    <div className="mt-4 border-t border-slate-100 pt-3">
                      <h4 className="text-xs font-bold uppercase tracking-wide text-slate-500">
                        Processed Refunds ({selectedBill.refunds.length})
                      </h4>
                      <div className="mt-2 space-y-1.5">
                        {selectedBill.refunds.map((rf) => (
                          <div
                            key={rf.id}
                            className="flex items-center justify-between rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-900"
                          >
                            <span>
                              <strong>{formatInrFromPaise(rf.amountPaise)}</strong> — {rf.reason}
                              {rf.gatewayRefundId ? ` (${rf.gatewayRefundId})` : ''}
                            </span>
                            <span className="font-semibold">{rf.status}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Audited Discount Modal */}
      {showDiscountModal && selectedBill && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <form
            onSubmit={handleApplyDiscount}
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">
                Audited Discount • {selectedBill.billNumber}
              </h3>
              <button type="button" onClick={() => setShowDiscountModal(false)}>
                <X className="h-4 w-4 text-slate-400" />
              </button>
            </div>
            <div className="mt-4 space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Discount Amount (₹) — Max {formatInrFromPaise(selectedBill.subtotalPaise)}
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  value={discountRupees}
                  onChange={(e) => setDiscountRupees(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-bold"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Audit Reason (Required)
                </label>
                <input
                  type="text"
                  required
                  minLength={3}
                  value={discountReason}
                  onChange={(e) => setDiscountReason(e.target.value)}
                  placeholder="e.g. Regular customer goodwill 10% off"
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowDiscountModal(false)}
                className="rounded-xl border border-slate-300 px-4 py-2 text-xs font-bold text-slate-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busyKey === 'apply-discount'}
                className="rounded-xl bg-brand-600 px-4 py-2 text-xs font-bold text-white hover:bg-brand-700"
              >
                Apply & Recalculate GST
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Audited Void Modal */}
      {showVoidModal && selectedBill && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <form
            onSubmit={handleVoidBill}
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-rose-700">
                Void Bill • {selectedBill.billNumber}
              </h3>
              <button type="button" onClick={() => setShowVoidModal(false)}>
                <X className="h-4 w-4 text-slate-400" />
              </button>
            </div>
            <p className="mt-3 text-xs text-slate-600">
              Voiding marks this invoice immutable in audit logs and allows generating a replacement bill for the session.
            </p>
            <div className="mt-3">
              <label className="block text-xs font-semibold text-slate-700">
                Void Reason (Required)
              </label>
              <input
                type="text"
                required
                minLength={3}
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
                placeholder="e.g. Incorrect GST setting selected"
                className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowVoidModal(false)}
                className="rounded-xl border border-slate-300 px-4 py-2 text-xs font-bold text-slate-700"
              >
                Keep Bill
              </button>
              <button
                type="submit"
                disabled={busyKey === 'void-bill'}
                className="rounded-xl bg-rose-600 px-4 py-2 text-xs font-bold text-white hover:bg-rose-700"
              >
                Confirm Void
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Refund Modal */}
      {refundTarget && selectedBill && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <form
            onSubmit={handleIssueRefund}
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">
                Issue Refund ({refundTarget.method.replace('_', ' ')})
              </h3>
              <button type="button" onClick={() => setRefundTarget(null)}>
                <X className="h-4 w-4 text-slate-400" />
              </button>
            </div>
            <div className="mt-4 space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Refund Amount (₹) — Max {formatInrFromPaise(refundTarget.maxPaise)}
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  value={refundRupees}
                  onChange={(e) => setRefundRupees(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-bold"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Refund Reason (Required)
                </label>
                <input
                  type="text"
                  required
                  minLength={3}
                  value={refundReason}
                  onChange={(e) => setRefundReason(e.target.value)}
                  placeholder="e.g. Duplicate UPI debit / spilled dish"
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRefundTarget(null)}
                className="rounded-xl border border-slate-300 px-4 py-2 text-xs font-bold text-slate-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busyKey === 'issue-refund'}
                className="rounded-xl bg-rose-600 px-4 py-2 text-xs font-bold text-white hover:bg-rose-700"
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
