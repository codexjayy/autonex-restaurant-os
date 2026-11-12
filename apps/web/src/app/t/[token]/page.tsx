'use client';

import {
  DietaryType,
  DiningSessionStatus,
  ErrorCode,
  GuestJoinStatus,
  KitchenStatus,
  formatInrFromPaise,
} from '@autonex/shared';
import { useParams } from 'next/navigation';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChefHat,
  Clock,
  CreditCard,
  Download,
  Lock,
  Minus,
  Plus,
  Receipt,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { DietaryBadge } from '@/components/dietary-badge';
import { MenuItemCustomizerModal } from '@/components/menu-item-customizer-modal';
import {
  API_BASE_URL,
  ApiError,
  BillStatus,
  BillSummaryDto,
  CustomerSessionStateResponse,
  JoinSessionResponse,
  ModifierOptionDto,
  OrderDto,
  PlaceOrderResponse,
  PublicMenuItemDto,
  PublicQrResponse,
  RazorpayOrderResponse,
  TaxMode,
} from '@/lib/api-client';
import {
  CartLineItem,
  StoredGuestAuth,
  addOrIncrementCartLine,
  clearGuestAuth,
  clearIdempotencyKey,
  computeCartTotals,
  getOrCreateIdempotencyKey,
  loadCartFromStorage,
  loadGuestAuth,
  reconcileCartWithLiveMenu,
  saveCartToStorage,
  saveGuestAuth,
  updateCartLineQuantity,
} from '@/lib/cart-storage';

const KITCHEN_STATUS_STYLE: Record<string, { label: string; className: string }> = {
  [KitchenStatus.NEW]: {
    label: 'Sent to Kitchen',
    className: 'bg-sky-50 text-sky-700 ring-1 ring-sky-200',
  },
  [KitchenStatus.ACKNOWLEDGED]: {
    label: 'Accepted by Kitchen',
    className: 'bg-cyan-50 text-cyan-700 ring-1 ring-cyan-200',
  },
  [KitchenStatus.PREPARING]: {
    label: 'Preparing',
    className: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
  },
  [KitchenStatus.READY]: {
    label: 'Ready to Serve',
    className: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  },
  [KitchenStatus.SERVED]: {
    label: 'Served',
    className: 'bg-slate-100 text-slate-700',
  },
  [KitchenStatus.CANCELLED]: {
    label: 'Cancelled',
    className: 'bg-rose-50 text-rose-700',
  },
};

export default function CustomerQrOrderingPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token;

  const [qrData, setQrData] = useState<PublicQrResponse | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ type: 'info' | 'error' | 'success'; text: string } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);

  const [vegOnly, setVegOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [activeCategoryId, setActiveCategoryId] = useState<string>('ALL');

  const [cart, setCart] = useState<CartLineItem[]>([]);
  const [orderNotes, setOrderNotes] = useState('');
  const [customizingItem, setCustomizingItem] = useState<PublicMenuItemDto | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [ordersOpen, setOrdersOpen] = useState(false);

  const [guestAuth, setGuestAuth] = useState<StoredGuestAuth | null>(null);
  const [sessionState, setSessionState] = useState<CustomerSessionStateResponse | null>(null);
  const [joinModalOpen, setJoinModalOpen] = useState(false);
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [guestLabelInput, setGuestLabelInput] = useState('');
  const [joining, setJoining] = useState(false);
  const [submittingOrder, setSubmittingOrder] = useState(false);
  const [requestingBill, setRequestingBill] = useState(false);
  const [customerBill, setCustomerBill] = useState<BillSummaryDto | null>(null);
  const [onlinePayOrder, setOnlinePayOrder] = useState<RazorpayOrderResponse | null>(null);
  const [processingPayment, setProcessingPayment] = useState(false);

  const cartInitializedForTable = useRef<string | null>(null);
  const hadApprovedSessionRef = useRef(false);

  const fetchQrAndMenu = useCallback(async (): Promise<PublicQrResponse | null> => {
    if (!token) return null;
    try {
      const res = await fetch(`${API_BASE_URL}/public/qr/${encodeURIComponent(token)}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message || 'This QR code is invalid or no longer active.');
      }
      const parsed = (await res.json()) as PublicQrResponse;
      setQrData(parsed);

      const tableId = parsed.table.id;
      if (cartInitializedForTable.current !== tableId) {
        const storedCart = loadCartFromStorage(tableId);
        const reconciled = reconcileCartWithLiveMenu(storedCart, parsed.categories);
        setCart(reconciled);
        saveCartToStorage(tableId, reconciled);
        cartInitializedForTable.current = tableId;
      } else {
        setCart((prev) => {
          const reconciled = reconcileCartWithLiveMenu(prev, parsed.categories);
          saveCartToStorage(tableId, reconciled);
          return reconciled;
        });
      }

      if (!parsed.sessionPolicy.hasActiveSession && token) {
        clearGuestAuth(token);
        setGuestAuth(null);
        setSessionState(null);
      }

      return parsed;
    } catch (err) {
      setFatalError(err instanceof Error ? err.message : 'Unable to load menu');
      return null;
    } finally {
      setLoading(false);
    }
  }, [token]);

  const fetchCustomerBill = useCallback(
    async (auth: StoredGuestAuth | null) => {
      if (!token || !auth?.guestToken) return;
      try {
        const res = await fetch(`${API_BASE_URL}/public/qr/${encodeURIComponent(token)}/bill`, {
          headers: { 'X-Guest-Token': auth.guestToken },
        });
        if (!res.ok) return;
        const body = (await res.json()) as { bill: BillSummaryDto | null };
        setCustomerBill(body.bill ?? null);
      } catch {
        // Non-blocking on transient cellular drops
      }
    },
    [token],
  );

  const fetchSessionState = useCallback(
    async (auth: StoredGuestAuth | null) => {
      if (!token || !auth?.guestToken) return;
      try {
        const res = await fetch(`${API_BASE_URL}/public/qr/${encodeURIComponent(token)}/session`, {
          headers: { 'X-Guest-Token': auth.guestToken },
        });
        if (!res.ok) return;
        const state = (await res.json()) as CustomerSessionStateResponse;
        setSessionState(state);

        if (!state.hasActiveSession || state.guestStatus === GuestJoinStatus.REVOKED) {
          clearGuestAuth(token);
          setGuestAuth(null);
          setCustomerBill(null);
          setOnlinePayOrder(null);
          if (!state.hasActiveSession) {
            setCart([]);
            if (qrData?.table.id) {
              saveCartToStorage(qrData.table.id, []);
              clearIdempotencyKey(qrData.table.id);
            }
            if (hadApprovedSessionRef.current) {
              hadApprovedSessionRef.current = false;
              setOrdersOpen(false);
              setCartOpen(false);
              setBanner({
                type: 'info',
                text: 'Your dining session has been settled and closed. Thank you for dining with us!',
              });
            }
            void fetchQrAndMenu();
          } else if (state.guestStatus === GuestJoinStatus.REVOKED) {
            hadApprovedSessionRef.current = false;
            setOrdersOpen(false);
            setCartOpen(false);
            setBanner({
              type: 'error',
              text: 'Your table session access was revoked by restaurant staff.',
            });
          }
        } else if (state.guestStatus === GuestJoinStatus.APPROVED) {
          hadApprovedSessionRef.current = true;
          if (
            state.activeBill ||
            state.sessionStatus === DiningSessionStatus.BILL_REQUESTED ||
            state.sessionStatus === DiningSessionStatus.SETTLED
          ) {
            void fetchCustomerBill(auth);
          }
        }
      } catch {
        // Ignore transient 4G polling drops gracefully
      }
    },
    [token, qrData?.table.id, fetchQrAndMenu, fetchCustomerBill],
  );

  useEffect(() => {
    if (!token) return;
    const savedGuest = loadGuestAuth(token);
    if (savedGuest) {
      setGuestAuth(savedGuest);
    }
    fetchQrAndMenu().then((loaded) => {
      if (loaded?.sessionPolicy.hasActiveSession && savedGuest) {
        fetchSessionState(savedGuest);
      }
    });
  }, [token, fetchQrAndMenu, fetchSessionState]);

  // Live polling: 3s while awaiting approval, 4s while monitoring kitchen order status, 10s if waiting for table activation
  useEffect(() => {
    if (!token || !qrData) return;
    if (guestAuth && sessionState?.guestStatus !== GuestJoinStatus.REVOKED) {
      const intervalMs =
        sessionState?.guestStatus === GuestJoinStatus.PENDING_APPROVAL ? 3000 : 4500;
      const timer = window.setInterval(() => {
        fetchSessionState(guestAuth);
      }, intervalMs);
      return () => window.clearInterval(timer);
    }

    if (!qrData.sessionPolicy.hasActiveSession) {
      const timer = window.setInterval(() => {
        fetchQrAndMenu();
      }, 10000);
      return () => window.clearInterval(timer);
    }
  }, [token, qrData, guestAuth, sessionState?.guestStatus, fetchSessionState, fetchQrAndMenu]);

  const tableId = qrData?.table.id ?? '';
  const updateCart = (next: CartLineItem[]) => {
    setCart(next);
    if (tableId) {
      saveCartToStorage(tableId, next);
      clearIdempotencyKey(tableId);
    }
  };

  const isTenantOrderingBlocked = Boolean(
    qrData?.orderingBlocked || qrData?.sessionPolicy?.orderingBlocked,
  );

  const isSessionCheckoutLocked =
    sessionState?.sessionStatus === DiningSessionStatus.BILL_REQUESTED ||
    sessionState?.sessionStatus === DiningSessionStatus.SETTLED ||
    qrData?.sessionPolicy.activeSessionStatus === DiningSessionStatus.BILL_REQUESTED ||
    qrData?.sessionPolicy.activeSessionStatus === DiningSessionStatus.SETTLED;

  const handleQuickOrCustomAdd = (item: PublicMenuItemDto) => {
    if (!item.inStock) return;
    if (isTenantOrderingBlocked) {
      setBanner({
        type: 'info',
        text: 'New ordering is currently paused at this restaurant. Seated guests can still view bills and complete payment.',
      });
      return;
    }
    if (isSessionCheckoutLocked) {
      setBanner({
        type: 'info',
        text: 'Checkout is locked for billing. Ask your waiter to reopen the table if you need more items.',
      });
      return;
    }
    if (item.modifierGroups.length > 0) {
      setCustomizingItem(item);
      return;
    }
    const next = addOrIncrementCartLine(cart, item, [], 1, '');
    updateCart(next);
    setBanner({ type: 'success', text: `Added ${item.name} to cart` });
  };

  const handleConfirmCustomItem = (
    selectedOptions: ModifierOptionDto[],
    quantity: number,
    prepNotes: string,
  ) => {
    if (!customizingItem) return;
    const next = addOrIncrementCartLine(cart, customizingItem, selectedOptions, quantity, prepNotes);
    updateCart(next);
    setCustomizingItem(null);
    setBanner({ type: 'success', text: `Added ${customizingItem.name} to cart` });
  };

  const handleRequestBill = async () => {
    if (!token || !guestAuth || !qrData) return;
    setRequestingBill(true);
    setBanner(null);

    try {
      const res = await fetch(
        `${API_BASE_URL}/public/qr/${encodeURIComponent(token)}/bill`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Guest-Token': guestAuth.guestToken,
          },
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        bill?: BillSummaryDto;
        message?: string;
      };
      if (!res.ok || !body.bill) {
        throw new ApiError(body.message || 'Unable to generate bill right now.', res.status);
      }

      setCustomerBill(body.bill);
      setCartOpen(false);
      await Promise.all([fetchSessionState(guestAuth), fetchQrAndMenu()]);
      setOrdersOpen(true);
      setBanner({
        type: 'success',
        text: `Bill ${body.bill.billNumber} generated for Table ${qrData.table.tableNumber}! You can pay online below or pay at the counter.`,
      });
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to generate bill',
      });
    } finally {
      setRequestingBill(false);
    }
  };

  const handleInitiateOnlinePayment = async () => {
    if (!token || !guestAuth || !customerBill) return;
    setProcessingPayment(true);
    setBanner(null);

    try {
      const idemKey = `guest-rzp-${customerBill.id}-${customerBill.duePaise}-${Date.now()}`;
      const res = await fetch(
        `${API_BASE_URL}/public/qr/${encodeURIComponent(token)}/payments/razorpay/order`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Guest-Token': guestAuth.guestToken,
            'Idempotency-Key': idemKey,
          },
          body: JSON.stringify({ amountPaise: customerBill.duePaise }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as RazorpayOrderResponse & {
        message?: string;
      };
      if (!res.ok) {
        throw new ApiError(body.message || 'Unable to start online payment.', res.status);
      }
      setOnlinePayOrder(body);
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to start online payment',
      });
    } finally {
      setProcessingPayment(false);
    }
  };

  const handleCompleteMockOnlinePayment = async () => {
    if (!token || !guestAuth || !onlinePayOrder?.mockCheckoutHint) return;
    setProcessingPayment(true);
    setBanner(null);

    try {
      const res = await fetch(
        `${API_BASE_URL}/public/qr/${encodeURIComponent(token)}/payments/razorpay/verify`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Guest-Token': guestAuth.guestToken,
          },
          body: JSON.stringify({
            razorpayOrderId: onlinePayOrder.mockCheckoutHint.razorpayOrderId,
            razorpayPaymentId: onlinePayOrder.mockCheckoutHint.razorpayPaymentId,
            razorpaySignature: onlinePayOrder.mockCheckoutHint.razorpaySignature,
          }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        throw new ApiError(body.message || 'Payment verification failed.', res.status);
      }
      setOnlinePayOrder(null);
      await Promise.all([
        fetchCustomerBill(guestAuth),
        fetchSessionState(guestAuth),
        fetchQrAndMenu(),
      ]);
      setBanner({
        type: 'success',
        text: 'Payment successful! Your GST receipt is ready to download below.',
      });
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Payment verification failed',
      });
    } finally {
      setProcessingPayment(false);
    }
  };

  const handleSimulateFailedPayment = async () => {
    if (!token || !guestAuth || !onlinePayOrder?.gatewayOrderId) return;
    setProcessingPayment(true);
    setBanner(null);

    try {
      await fetch(
        `${API_BASE_URL}/public/qr/${encodeURIComponent(token)}/payments/razorpay/fail`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Guest-Token': guestAuth.guestToken,
          },
          body: JSON.stringify({
            razorpayOrderId: onlinePayOrder.gatewayOrderId,
            reason: 'UPI payment cancelled by customer',
          }),
        },
      );
      setOnlinePayOrder(null);
      await fetchCustomerBill(guestAuth);
      setBanner({
        type: 'error',
        text: 'Payment failed — your table session remains open so you can retry online or pay at the counter.',
      });
    } finally {
      setProcessingPayment(false);
    }
  };

  const handleJoinSession = async (mode: 'CODE' | 'APPROVAL', e?: FormEvent) => {
    e?.preventDefault();
    if (!token) return;
    setJoining(true);
    setBanner(null);

    try {
      const res = await fetch(`${API_BASE_URL}/public/qr/${encodeURIComponent(token)}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(mode === 'CODE' && joinCodeInput.trim() ? { joinCode: joinCodeInput.trim() } : {}),
          ...(guestLabelInput.trim() ? { displayLabel: guestLabelInput.trim() } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as JoinSessionResponse & {
        message?: string;
      };
      if (!res.ok) {
        throw new ApiError(body.message || 'Could not join table session', res.status);
      }

      const authRecord: StoredGuestAuth = {
        guestToken: body.guestToken,
        guestId: body.guestId,
        sessionId: body.sessionId,
        displayLabel: body.displayLabel,
      };
      saveGuestAuth(token, authRecord);
      setGuestAuth(authRecord);
      setJoinModalOpen(false);
      setJoinCodeInput('');
      await fetchSessionState(authRecord);

      setBanner({
        type: body.status === GuestJoinStatus.APPROVED ? 'success' : 'info',
        text:
          body.status === GuestJoinStatus.APPROVED
            ? `Joined Table ${body.tableNumber} as ${body.displayLabel}`
            : 'Approval request sent — waiter will approve your phone shortly.',
      });
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to join table',
      });
    } finally {
      setJoining(false);
    }
  };

  const cartSummary = useMemo(() => computeCartTotals(cart), [cart]);

  const handlePlaceOrder = async () => {
    if (!token || !qrData || cart.length === 0) return;

    if (isSessionCheckoutLocked) {
      setCartOpen(false);
      setOrdersOpen(true);
      setBanner({
        type: 'error',
        text: 'Bill has already been requested — new orders are locked during checkout.',
      });
      return;
    }

    if (!guestAuth) {
      setCartOpen(false);
      setJoinModalOpen(true);
      return;
    }
    if (sessionState?.guestStatus !== GuestJoinStatus.APPROVED) {
      setBanner({
        type: 'info',
        text: 'Waiting for waiter approval before sending orders to the kitchen.',
      });
      return;
    }

    if (cartSummary.hasStockIssues) {
      setBanner({
        type: 'error',
        text: 'Remove out-of-stock items highlighted in red before placing your order.',
      });
      return;
    }

    setSubmittingOrder(true);
    setBanner(null);

    const idemKey = getOrCreateIdempotencyKey(qrData.table.id);

    try {
      const res = await fetch(`${API_BASE_URL}/public/qr/${encodeURIComponent(token)}/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Guest-Token': guestAuth.guestToken,
          'Idempotency-Key': idemKey,
        },
        body: JSON.stringify({
          items: cart.map((line) => ({
            menuItemId: line.menuItemId,
            quantity: line.quantity,
            selectedOptionIds: line.selectedOptionIds,
            ...(line.prepNotes ? { prepNotes: line.prepNotes } : {}),
          })),
          ...(orderNotes.trim() ? { notes: orderNotes.trim() } : {}),
          expectedSubtotalPaise: cartSummary.subtotalPaise,
        }),
      });

      const body = (await res.json().catch(() => ({}))) as PlaceOrderResponse & {
        code?: string;
        message?: string;
      };

      if (!res.ok) {
        if (body.code === ErrorCode.STALE_MENU_PRICE || body.code === ErrorCode.OUT_OF_STOCK) {
          clearIdempotencyKey(qrData.table.id);
          const refreshed = await fetchQrAndMenu();
          if (refreshed) {
            setCart((prev) => {
              const reconciled = reconcileCartWithLiveMenu(prev, refreshed.categories);
              saveCartToStorage(qrData.table.id, reconciled);
              return reconciled;
            });
          }
        }
        throw new ApiError(body.message || 'Could not place order', res.status, body.code);
      }

      clearIdempotencyKey(qrData.table.id);
      saveCartToStorage(qrData.table.id, []);
      setCart([]);
      setOrderNotes('');
      setCartOpen(false);
      await fetchSessionState(guestAuth);
      setOrdersOpen(true);

      setBanner({
        type: 'success',
        text: `Order confirmed! KOT #${body.order.kotNumber} (Round ${body.order.roundNumber}) sent to kitchen.`,
      });
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Order failed — tap Place Order to safely retry.',
      });
    } finally {
      setSubmittingOrder(false);
    }
  };

  const handleRepeatOrderIntoCart = (order: OrderDto) => {
    if (!qrData) return;
    const itemMap = new Map<string, PublicMenuItemDto>();
    for (const cat of qrData.categories) {
      for (const item of cat.menuItems) itemMap.set(item.id, item);
    }

    let nextCart = [...cart];
    let skippedCount = 0;

    for (const oldItem of order.items) {
      const liveItem = itemMap.get(oldItem.menuItemId);
      if (!liveItem || !liveItem.inStock) {
        skippedCount += 1;
        continue;
      }

      const oldOptionIds = (oldItem.modifiersSnapshotJson ?? []).map((m) => m.optionId);
      const validOptions: ModifierOptionDto[] = [];
      let optionUnavailable = false;

      for (const id of oldOptionIds) {
        const opt = liveItem.modifierGroups
          .flatMap((g) => g.options)
          .find((o) => o.id === id && o.inStock);
        if (!opt) {
          optionUnavailable = true;
        } else {
          validOptions.push(opt);
        }
      }

      if (optionUnavailable) {
        skippedCount += 1;
        continue;
      }

      nextCart = addOrIncrementCartLine(
        nextCart,
        liveItem,
        validOptions,
        oldItem.quantity,
        oldItem.prepNotes ?? '',
      );
    }

    updateCart(nextCart);
    setOrdersOpen(false);
    setCartOpen(true);
    setBanner({
      type: skippedCount > 0 ? 'info' : 'success',
      text:
        skippedCount > 0
          ? `Added available items from Round ${order.roundNumber}. ${skippedCount} unavailable item(s) skipped.`
          : `Added Round ${order.roundNumber} items to your cart at live menu prices.`,
    });
  };

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <p className="text-sm text-slate-500">Loading digital menu...</p>
      </main>
    );
  }

  if (fatalError || !qrData) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <div className="max-w-md rounded-2xl border border-rose-200 bg-white p-6 text-center shadow-sm">
          <AlertTriangle className="mx-auto h-10 w-10 text-rose-500" />
          <h1 className="mt-3 text-lg font-bold text-slate-900">QR Code Unavailable</h1>
          <p className="mt-2 text-sm text-slate-600">{fatalError}</p>
          <p className="mt-4 text-xs text-slate-400">
            Please ask restaurant staff for an updated table QR code.
          </p>
        </div>
      </main>
    );
  }

  const q = search.trim().toLowerCase();
  const isApproved = sessionState?.guestStatus === GuestJoinStatus.APPROVED;
  const isPendingApproval = sessionState?.guestStatus === GuestJoinStatus.PENDING_APPROVAL;
  const placedOrdersCount = sessionState?.orders.length ?? 0;

  return (
    <main className="min-h-screen bg-slate-50 pb-28">
      {/* Top Header */}
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto max-w-2xl px-4 pb-3 pt-3.5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-lg font-extrabold tracking-tight text-slate-900">
                {qrData.restaurant.outletName}
              </h1>
              {qrData.restaurant.address && (
                <p className="text-xs text-slate-500">{qrData.restaurant.address}</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {isApproved && (
                <button
                  type="button"
                  onClick={() => setOrdersOpen(true)}
                  className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-800 hover:bg-slate-50"
                >
                  <Receipt className="h-3.5 w-3.5 text-brand-600" />
                  Orders ({placedOrdersCount})
                </button>
              )}
              <span className="shrink-0 rounded-full bg-brand-600 px-3 py-1 text-xs font-bold text-white">
                Table {qrData.table.tableNumber}
              </span>
            </div>
          </div>

          {/* Session Join Status Strip */}
          <div className="mt-2.5">
            {isTenantOrderingBlocked && !guestAuth ? (
              <div className="flex items-center justify-between gap-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800 ring-1 ring-rose-200">
                <span className="font-medium">
                  Menu preview only • New table ordering is temporarily paused at this restaurant.
                </span>
              </div>
            ) : !qrData.sessionPolicy.hasActiveSession ? (
              <div className="flex items-center justify-between gap-2 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700">
                <span>Browse menu freely. Ask your waiter to open Table {qrData.table.tableNumber} to order.</span>
                <button
                  type="button"
                  onClick={() => fetchQrAndMenu()}
                  className="inline-flex shrink-0 items-center gap-1 font-semibold text-brand-700 hover:underline"
                >
                  <RefreshCw className="h-3 w-3" /> Check
                </button>
              </div>
            ) : isSessionCheckoutLocked ? (
              <div className="flex items-center justify-between gap-2 rounded-lg bg-purple-50 px-3 py-2 text-xs text-purple-900 ring-1 ring-purple-200">
                <span className="inline-flex items-center gap-1.5 font-semibold">
                  <Lock className="h-3.5 w-3.5 text-purple-700" />
                  {sessionState?.sessionStatus === DiningSessionStatus.SETTLED
                    ? 'Payment Settled • Thank you for dining with us!'
                    : 'Checkout Locked (Bill Requested) • Ordering paused for billing'}
                </span>
                <button
                  type="button"
                  onClick={() => setOrdersOpen(true)}
                  className="shrink-0 font-bold text-purple-800 underline"
                >
                  View Bill
                </button>
              </div>
            ) : !guestAuth ? (
              <div className="flex items-center justify-between gap-2 rounded-lg bg-orange-50 px-3 py-2 text-xs text-brand-700 ring-1 ring-orange-200">
                <span className="font-medium">
                  Table {qrData.table.tableNumber} is open! Join with table code or waiter approval.
                </span>
                <button
                  type="button"
                  onClick={() => setJoinModalOpen(true)}
                  className="shrink-0 rounded-md bg-brand-600 px-2.5 py-1 text-xs font-bold text-white hover:bg-brand-700"
                >
                  Join Table
                </button>
              </div>
            ) : isPendingApproval ? (
              <div className="flex items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <Clock className="h-3.5 w-3.5 animate-pulse" />
                  Waiting for waiter approval on your phone...
                </span>
                <button
                  type="button"
                  onClick={() => {
                    clearGuestAuth(token!);
                    setGuestAuth(null);
                    setJoinModalOpen(true);
                  }}
                  className="shrink-0 font-semibold underline"
                >
                  Enter Code
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2 rounded-lg bg-emerald-50 px-3 py-1.5 text-xs text-emerald-800 ring-1 ring-emerald-200">
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                  Seated ({guestAuth.displayLabel}) • Running Total:{' '}
                  {formatInrFromPaise(sessionState?.runningTotalPaise ?? 0)}
                </span>
                <button
                  type="button"
                  onClick={() => setOrdersOpen(true)}
                  className="font-semibold text-emerald-700 underline"
                >
                  Track Orders
                </button>
              </div>
            )}
          </div>

          {/* Search & Pure Veg Filter */}
          <div className="mt-2.5 flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search dishes..."
                className="w-full rounded-lg border border-slate-300 bg-slate-50 py-1.5 pl-9 pr-3 text-sm focus:border-brand-500 focus:bg-white focus:outline-none"
              />
            </div>
            <button
              type="button"
              onClick={() => setVegOnly((v) => !v)}
              className={`shrink-0 rounded-lg border px-3 py-1.5 text-xs font-semibold ${
                vegOnly
                  ? 'border-emerald-600 bg-emerald-50 text-emerald-700'
                  : 'border-slate-300 bg-white text-slate-700'
              }`}
            >
              Pure Veg
            </button>
          </div>

          {/* Horizontal Category Pills */}
          {qrData.categories.length > 1 && (
            <div className="mt-2.5 flex gap-1.5 overflow-x-auto pb-0.5">
              <button
                type="button"
                onClick={() => setActiveCategoryId('ALL')}
                className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${
                  activeCategoryId === 'ALL'
                    ? 'bg-slate-900 text-white'
                    : 'bg-slate-100 text-slate-700'
                }`}
              >
                All
              </button>
              {qrData.categories.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setActiveCategoryId(cat.id)}
                  className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${
                    activeCategoryId === cat.id
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-700'
                  }`}
                >
                  {cat.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </header>

      {/* Flash Banner */}
      {banner && (
        <div className="mx-auto max-w-2xl px-4 pt-3">
          <div
            className={`flex items-center justify-between rounded-xl px-3.5 py-2.5 text-xs font-medium shadow-sm ${
              banner.type === 'error'
                ? 'border border-rose-200 bg-rose-50 text-rose-800'
                : banner.type === 'success'
                  ? 'border border-emerald-200 bg-emerald-50 text-emerald-800'
                  : 'border border-orange-200 bg-orange-50 text-brand-700'
            }`}
          >
            <span>{banner.text}</span>
            <button type="button" onClick={() => setBanner(null)}>
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Menu Catalog */}
      <div className="mx-auto max-w-2xl space-y-6 px-4 pt-4">
        {qrData.categories.length === 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
            Menu items are being updated. Please check back shortly.
          </div>
        ) : (
          qrData.categories
            .filter((cat) => activeCategoryId === 'ALL' || cat.id === activeCategoryId)
            .map((category) => {
              const items = category.menuItems.filter((item) => {
                if (vegOnly && item.dietaryType !== DietaryType.VEG) return false;
                if (
                  q &&
                  !item.name.toLowerCase().includes(q) &&
                  !(item.description ?? '').toLowerCase().includes(q)
                ) {
                  return false;
                }
                return true;
              });

              if (items.length === 0) return null;

              return (
                <section key={category.id}>
                  <h2 className="mb-2.5 px-1 text-base font-bold text-slate-900">
                    {category.name}
                  </h2>
                  <div className="space-y-3">
                    {items.map((item) => (
                      <article
                        key={item.id}
                        className={`flex justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm ${
                          !item.inStock ? 'opacity-65' : ''
                        }`}
                      >
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <DietaryBadge type={item.dietaryType} />
                            <h3 className="font-semibold text-slate-900">{item.name}</h3>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <p className="text-sm font-bold text-slate-900">
                              {formatInrFromPaise(item.basePricePaise)}
                            </p>
                            {item.prepTimeMinutes && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                                <Clock className="h-3 w-3" />
                                ~{item.prepTimeMinutes} min
                              </span>
                            )}
                            {item.taxMode === 'INCLUSIVE' && (
                              <span className="text-[11px] text-slate-500">Incl. GST</span>
                            )}
                          </div>
                          {item.description && (
                            <p className="mt-1 text-xs text-slate-500">{item.description}</p>
                          )}
                          {item.modifierGroups.length > 0 && (
                            <p className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-brand-700">
                              <Sparkles className="h-3 w-3" /> Customizable (
                              {item.modifierGroups.map((g) => g.name).join(', ')})
                            </p>
                          )}
                        </div>

                        <div className="flex shrink-0 flex-col items-center justify-between gap-2">
                          {item.imageUrl && (
                            <img
                              src={item.imageUrl}
                              alt={item.name}
                              onClick={() => item.inStock && setCustomizingItem(item)}
                              className="h-20 w-20 cursor-pointer rounded-xl border border-slate-200 object-cover"
                            />
                          )}
                          {item.inStock ? (
                            <button
                              type="button"
                              disabled={isSessionCheckoutLocked}
                              onClick={() => handleQuickOrCustomAdd(item)}
                              className="inline-flex min-w-[84px] items-center justify-center gap-1 rounded-lg border border-brand-600 bg-orange-50 px-3 py-1.5 text-xs font-bold text-brand-700 hover:bg-brand-600 hover:text-white disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-100 disabled:text-slate-400"
                            >
                              <Plus className="h-3.5 w-3.5" />
                              {item.modifierGroups.length > 0 ? 'Customize' : 'Add'}
                            </button>
                          ) : (
                            <span className="rounded-lg bg-rose-50 px-2.5 py-1 text-[11px] font-semibold text-rose-700">
                              Out of Stock
                            </span>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              );
            })
        )}
      </div>

      {/* Persistent Bottom Cart Bar */}
      {(cartSummary.totalItems > 0 || placedOrdersCount > 0) && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 p-3 shadow-lg backdrop-blur">
          <div className="mx-auto flex max-w-2xl items-center gap-3">
            {cartSummary.totalItems > 0 ? (
              <button
                type="button"
                onClick={() => setCartOpen(true)}
                className="flex flex-1 items-center justify-between rounded-xl bg-brand-600 px-4 py-3 text-sm font-bold text-white shadow hover:bg-brand-700"
              >
                <span className="inline-flex items-center gap-2">
                  <ShoppingBag className="h-4 w-4" />
                  {cartSummary.totalItems} item{cartSummary.totalItems > 1 ? 's' : ''} •{' '}
                  {formatInrFromPaise(cartSummary.subtotalPaise)}
                </span>
                <span>View Cart →</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setOrdersOpen(true)}
                className="flex flex-1 items-center justify-between rounded-xl bg-slate-900 px-4 py-3 text-sm font-bold text-white"
              >
                <span className="inline-flex items-center gap-2">
                  <ChefHat className="h-4 w-4" />
                  {placedOrdersCount} Order Round{placedOrdersCount > 1 ? 's' : ''} Active
                </span>
                <span>
                  Running Bill: {formatInrFromPaise(sessionState?.runningTotalPaise ?? 0)}
                </span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Item Modifiers & Notes Modal */}
      {customizingItem && (
        <MenuItemCustomizerModal
          item={customizingItem}
          onClose={() => setCustomizingItem(null)}
          onConfirm={handleConfirmCustomItem}
        />
      )}

      {/* Join Table Session Modal */}
      {joinModalOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 sm:items-center sm:p-4">
          <div className="w-full max-w-md rounded-t-2xl bg-white p-6 shadow-2xl sm:rounded-2xl">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-slate-900">
                Join Table {qrData.table.tableNumber}
              </h2>
              <button type="button" onClick={() => setJoinModalOpen(false)}>
                <X className="h-5 w-5 text-slate-400" />
              </button>
            </div>
            <p className="mt-1 text-xs text-slate-600">
              Enter the 4-digit table code shared by your waiter to start ordering right away, or
              request waiter approval.
            </p>

            <form onSubmit={(e) => handleJoinSession('CODE', e)} className="mt-4 space-y-3">
              <div>
                <label className="block text-xs font-semibold uppercase text-slate-600">
                  Your Name (optional)
                </label>
                <input
                  value={guestLabelInput}
                  onChange={(e) => setGuestLabelInput(e.target.value)}
                  maxLength={40}
                  placeholder="e.g. Rohan"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase text-slate-600">
                  4-Digit Table Join Code
                </label>
                <input
                  value={joinCodeInput}
                  onChange={(e) => setJoinCodeInput(e.target.value)}
                  pattern="\d{4,6}"
                  inputMode="numeric"
                  placeholder="Ask your waiter (e.g. 4829)"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base font-bold tracking-widest"
                />
              </div>

              <button
                type="submit"
                disabled={joining || joinCodeInput.trim().length < 4}
                className="w-full rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {joining ? 'Verifying...' : 'Join with Code'}
              </button>
            </form>

            <div className="mt-3 border-t border-slate-100 pt-3 text-center">
              <button
                type="button"
                disabled={joining}
                onClick={() => handleJoinSession('APPROVAL')}
                className="text-xs font-semibold text-brand-700 hover:underline"
              >
                Don&apos;t have the code? Ask waiter to approve this phone
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Slide-Up Cart Drawer */}
      {cartOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 sm:items-center sm:p-4">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-2xl sm:rounded-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h2 className="text-lg font-bold text-slate-900">
                Your Cart (Table {qrData.table.tableNumber})
              </h2>
              <button type="button" onClick={() => setCartOpen(false)}>
                <X className="h-5 w-5 text-slate-500" />
              </button>
            </div>

            {cartSummary.hasPriceUpdates && (
              <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
                Some menu prices were updated since you added items — totals reflect current prices.
              </div>
            )}

            <div className="mt-4 divide-y divide-slate-100">
              {cart.map((line) => (
                <div key={line.lineKey} className="flex items-start justify-between gap-3 py-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <DietaryBadge type={line.dietaryType} />
                      <span className="text-sm font-semibold text-slate-900">{line.itemName}</span>
                    </div>
                    {line.modifiers.length > 0 && (
                      <p className="mt-0.5 text-xs text-slate-500">
                        {line.modifiers.map((m) => m.optionName).join(', ')}
                      </p>
                    )}
                    {line.prepNotes && (
                      <p className="mt-0.5 text-xs italic text-slate-500">Note: {line.prepNotes}</p>
                    )}
                    {line.outOfStock && (
                      <p className="mt-1 text-xs font-semibold text-rose-600">
                        Item unavailable — remove to proceed
                      </p>
                    )}
                    <p className="mt-1 text-xs font-bold text-slate-700">
                      {formatInrFromPaise(line.unitPricePaise * line.quantity)}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <div className="inline-flex items-center rounded-lg border border-slate-300">
                      <button
                        type="button"
                        onClick={() =>
                          updateCart(updateCartLineQuantity(cart, line.lineKey, line.quantity - 1))
                        }
                        className="p-1.5 text-slate-600 hover:bg-slate-100"
                      >
                        <Minus className="h-3.5 w-3.5" />
                      </button>
                      <span className="w-7 text-center text-xs font-bold">{line.quantity}</span>
                      <button
                        type="button"
                        onClick={() =>
                          updateCart(updateCartLineQuantity(cart, line.lineKey, line.quantity + 1))
                        }
                        className="p-1.5 text-slate-600 hover:bg-slate-100"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => updateCart(updateCartLineQuantity(cart, line.lineKey, 0))}
                      className="p-1 text-slate-400 hover:text-rose-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-3">
              <input
                value={orderNotes}
                onChange={(e) => setOrderNotes(e.target.value)}
                maxLength={250}
                placeholder="Order note for kitchen (optional)..."
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4">
              <div>
                <p className="text-xs text-slate-500">Server-Verified Subtotal</p>
                <p className="text-lg font-extrabold text-slate-900">
                  {formatInrFromPaise(cartSummary.subtotalPaise)}
                </p>
              </div>
              <button
                type="button"
                disabled={
                  submittingOrder ||
                  isSessionCheckoutLocked ||
                  cart.length === 0 ||
                  cartSummary.hasStockIssues
                }
                onClick={handlePlaceOrder}
                className="rounded-xl bg-brand-600 px-6 py-3 text-sm font-bold text-white shadow hover:bg-brand-700 disabled:opacity-40"
              >
                {isSessionCheckoutLocked
                  ? 'Checkout Locked'
                  : submittingOrder
                    ? 'Sending Order...'
                    : !guestAuth
                      ? 'Join Table to Order'
                      : placedOrdersCount > 0
                        ? 'Place Repeat / Add-On Order'
                        : 'Place Order'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Session Orders & Status Polling Modal */}
      {ordersOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 sm:items-center sm:p-4">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-2xl sm:rounded-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h2 className="text-lg font-bold text-slate-900">
                  Table {qrData.table.tableNumber} Orders
                </h2>
                <p className="text-xs text-slate-500">
                  Auto-refreshing kitchen status • Running total{' '}
                  {formatInrFromPaise(sessionState?.runningTotalPaise ?? 0)}
                </p>
              </div>
              <button type="button" onClick={() => setOrdersOpen(false)}>
                <X className="h-5 w-5 text-slate-500" />
              </button>
            </div>

            <div className="mt-4 space-y-4">
              {!sessionState?.orders.length ? (
                <p className="py-6 text-center text-sm text-slate-500">
                  No orders placed yet for this table.
                </p>
              ) : (
                sessionState.orders.map((order) => {
                  const statusMeta = KITCHEN_STATUS_STYLE[order.kitchenStatus] ?? {
                    label: order.kitchenStatus,
                    className: 'bg-slate-100 text-slate-700',
                  };
                  return (
                    <div
                      key={order.id}
                      className="rounded-xl border border-slate-200 bg-slate-50/70 p-4"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <span className="text-xs font-bold uppercase text-slate-900">
                            Round {order.roundNumber}
                            {order.isAddOn ? ' (Add-On)' : ''} • KOT #{order.kotNumber}
                          </span>
                          <p className="text-[11px] text-slate-500">
                            {new Date(order.createdAt).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </p>
                        </div>
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${statusMeta.className}`}
                        >
                          {statusMeta.label}
                        </span>
                      </div>

                      <ul className="mt-3 space-y-1.5 border-t border-slate-200/70 pt-2.5 text-xs">
                        {order.items.map((item) => {
                          const cancelledLine = item.status === 'CANCELLED' || item.quantity === 0;
                          return (
                            <li
                              key={item.id}
                              className={`flex items-start justify-between gap-2 ${
                                cancelledLine ? 'text-slate-400 line-through' : ''
                              }`}
                            >
                              <div>
                                <span
                                  className={`font-semibold ${
                                    cancelledLine ? 'text-slate-400' : 'text-slate-900'
                                  }`}
                                >
                                  {item.quantity} × {item.itemNameSnapshot}
                                  {cancelledLine ? ' (Cancelled)' : ''}
                                </span>
                                {item.modifiersSnapshotJson?.length > 0 && (
                                  <span className="block text-[11px] text-slate-500">
                                    {item.modifiersSnapshotJson.map((m) => m.optionName).join(', ')}
                                  </span>
                                )}
                              </div>
                              <span
                                className={`font-semibold ${
                                  cancelledLine ? 'text-slate-400' : 'text-slate-800'
                                }`}
                              >
                                {formatInrFromPaise(item.lineTotalPaise)}
                              </span>
                            </li>
                          );
                        })}
                      </ul>

                      <div className="mt-3 flex items-center justify-between border-t border-slate-200/70 pt-2.5">
                        <span className="text-xs font-bold text-slate-900">
                          Round Total: {formatInrFromPaise(order.subtotalPaise)}
                        </span>
                        {!isSessionCheckoutLocked && (
                          <button
                            type="button"
                            onClick={() => handleRepeatOrderIntoCart(order)}
                            className="inline-flex items-center gap-1 rounded-lg border border-brand-600 bg-white px-2.5 py-1 text-xs font-semibold text-brand-700 hover:bg-orange-50"
                          >
                            <RotateCcw className="h-3 w-3" />
                            Repeat Items
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {customerBill ? (
              <div className="mt-4 rounded-xl border border-slate-200 bg-slate-900 p-4 text-xs text-slate-200">
                <div className="mb-2 flex items-center justify-between border-b border-slate-700 pb-2">
                  <span className="font-mono font-bold text-white">{customerBill.billNumber}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                      customerBill.status === BillStatus.PAID
                        ? 'bg-emerald-500/20 text-emerald-300'
                        : customerBill.status === BillStatus.PARTIALLY_PAID
                          ? 'bg-sky-500/20 text-sky-300'
                          : 'bg-amber-500/20 text-amber-300'
                    }`}
                  >
                    {customerBill.status.replace('_', ' ')}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Items Subtotal</span>
                  <span className="font-semibold text-white">
                    {formatInrFromPaise(customerBill.subtotalPaise)}
                  </span>
                </div>
                {customerBill.discountPaise > 0 && (
                  <div className="mt-1 flex items-center justify-between text-emerald-300">
                    <span>
                      Discount{customerBill.discountReason ? ` (${customerBill.discountReason})` : ''}
                    </span>
                    <span>-{formatInrFromPaise(customerBill.discountPaise)}</span>
                  </div>
                )}
                {customerBill.taxMode !== TaxMode.NONE && (
                  <>
                    <div className="mt-1 flex items-center justify-between text-slate-400">
                      <span>
                        CGST ({customerBill.gstRateBps / 200}%
                        {customerBill.taxMode === TaxMode.INCLUSIVE ? ' Incl.' : ''})
                      </span>
                      <span>{formatInrFromPaise(customerBill.cgstPaise)}</span>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-slate-400">
                      <span>SGST ({customerBill.gstRateBps / 200}%)</span>
                      <span>{formatInrFromPaise(customerBill.sgstPaise)}</span>
                    </div>
                  </>
                )}
                {customerBill.roundOffPaise !== 0 && (
                  <div className="mt-1 flex items-center justify-between text-slate-400">
                    <span>Round Off</span>
                    <span>
                      {customerBill.roundOffPaise > 0 ? '+' : ''}
                      {formatInrFromPaise(customerBill.roundOffPaise)}
                    </span>
                  </div>
                )}
                <div className="mt-2.5 flex items-center justify-between border-t border-slate-700 pt-2.5 text-sm font-extrabold text-white">
                  <span>Final Bill Total</span>
                  <span>{formatInrFromPaise(customerBill.totalPaise)}</span>
                </div>
                {customerBill.netPaidPaise > 0 && (
                  <div className="mt-1 flex items-center justify-between text-emerald-300">
                    <span>Paid So Far</span>
                    <span>{formatInrFromPaise(customerBill.netPaidPaise)}</span>
                  </div>
                )}
                <div className="mt-1 flex items-center justify-between text-sm font-bold text-amber-300">
                  <span>Balance Due</span>
                  <span>{formatInrFromPaise(customerBill.duePaise)}</span>
                </div>
              </div>
            ) : (
              sessionState?.balance &&
              sessionState.balance.activeOrdersCount > 0 && (
                <div className="mt-4 rounded-xl border border-slate-200 bg-slate-900 p-4 text-xs text-slate-200">
                  <div className="flex items-center justify-between">
                    <span>Items Subtotal ({sessionState.balance.activeOrdersCount} rounds)</span>
                    <span className="font-semibold text-white">
                      {formatInrFromPaise(sessionState.balance.subtotalPaise)}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-slate-400">
                    <span>Est. CGST ({sessionState.balance.gstRateBps / 200}%)</span>
                    <span>{formatInrFromPaise(sessionState.balance.cgstPaise)}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-slate-400">
                    <span>Est. SGST ({sessionState.balance.gstRateBps / 200}%)</span>
                    <span>{formatInrFromPaise(sessionState.balance.sgstPaise)}</span>
                  </div>
                  <div className="mt-2.5 flex items-center justify-between border-t border-slate-700 pt-2.5 text-sm font-extrabold text-white">
                    <span>Estimated Payable Total</span>
                    <span>{formatInrFromPaise(sessionState.balance.estimatedTotalPaise)}</span>
                  </div>
                </div>
              )
            )}

            {/* Online Razorpay Payment Box when Customer Bill has Balance Due */}
            {onlinePayOrder && customerBill && customerBill.duePaise > 0 && (
              <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50 p-3.5 text-xs text-sky-900">
                <p className="font-bold">
                  Online Checkout Ready • {formatInrFromPaise(onlinePayOrder.amountPaise)}
                </p>
                <p className="mt-0.5 font-mono text-[11px] text-sky-700">
                  Order: {onlinePayOrder.gatewayOrderId}
                </p>
                {onlinePayOrder.isMock && onlinePayOrder.mockCheckoutHint ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={processingPayment}
                      onClick={handleCompleteMockOnlinePayment}
                      className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      <ShieldCheck className="h-4 w-4" />
                      Complete Test UPI / Card
                    </button>
                    <button
                      type="button"
                      disabled={processingPayment}
                      onClick={handleSimulateFailedPayment}
                      className="rounded-lg border border-rose-300 bg-white px-3 py-2 text-xs font-bold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                    >
                      Simulate Fail
                    </button>
                  </div>
                ) : (
                  onlinePayOrder.qrPayloadUrl && (
                    <a
                      href={onlinePayOrder.qrPayloadUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2 inline-flex items-center gap-1 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-bold text-white"
                    >
                      Open UPI / Razorpay App
                    </a>
                  )
                )}
              </div>
            )}

            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              {!isSessionCheckoutLocked && (
                <button
                  type="button"
                  onClick={() => setOrdersOpen(false)}
                  className="flex-1 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-bold text-slate-800 hover:bg-slate-50"
                >
                  Order More Items
                </button>
              )}

              {!isSessionCheckoutLocked ? (
                <button
                  type="button"
                  disabled={
                    requestingBill ||
                    (sessionState?.balance?.activeOrdersCount ?? placedOrdersCount) === 0
                  }
                  onClick={handleRequestBill}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-brand-700 disabled:opacity-40"
                >
                  <Receipt className="h-4 w-4" />
                  {requestingBill ? 'Generating Final Bill...' : 'Request Bill'}
                </button>
              ) : !customerBill ? (
                <button
                  type="button"
                  disabled={requestingBill}
                  onClick={handleRequestBill}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-purple-700 px-4 py-2.5 text-sm font-bold text-white hover:bg-purple-800 disabled:opacity-40"
                >
                  <Receipt className="h-4 w-4" />
                  {requestingBill ? 'Loading Bill...' : 'View Finalized Bill'}
                </button>
              ) : customerBill.duePaise > 0 && customerBill.status !== BillStatus.VOID ? (
                !onlinePayOrder && (
                  <button
                    type="button"
                    disabled={processingPayment}
                    onClick={handleInitiateOnlinePayment}
                    className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-emerald-700 disabled:opacity-40"
                  >
                    <CreditCard className="h-4 w-4" />
                    {processingPayment
                      ? 'Preparing Gateway...'
                      : `Pay Online ${formatInrFromPaise(customerBill.duePaise)}`}
                  </button>
                )
              ) : (
                <a
                  href={`${API_BASE_URL}/public/qr/${encodeURIComponent(token)}/receipt.pdf?guestToken=${encodeURIComponent(guestAuth?.guestToken ?? '')}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-emerald-700"
                >
                  <Download className="h-4 w-4" />
                  Download GST Receipt (PDF)
                </a>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
