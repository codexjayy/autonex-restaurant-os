'use client';

import {
  DiningSessionStatus,
  GuestJoinStatus,
  KitchenStatus,
  SessionLifecycleStage,
  StaffRole,
  formatInrFromPaise,
} from '@autonex/shared';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  Ban,
  Check,
  CheckCircle2,
  ChefHat,
  Clock,
  CreditCard,
  Edit3,
  KeyRound,
  Minus,
  Play,
  Plus,
  Receipt,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Unlock,
  UserCheck,
  Utensils,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { DashboardShell } from '@/components/dashboard-shell';
import {
  ApiError,
  FloorSessionTableDto,
  OrderDto,
  WS_BASE_URL,
  apiRequest,
  ensureFreshAccessToken,
  getStoredSession,
} from '@/lib/api-client';

interface OutletPolicyState {
  tablePinEnabled: boolean;
  requireWaiterApproval: boolean;
}

interface ItemEditTarget {
  sessionId: string;
  tableNumber: string;
  order: OrderDto;
}

const STAGE_BADGE_MAP: Record<SessionLifecycleStage, { label: string; className: string }> = {
  AVAILABLE: { label: 'AVAILABLE', className: 'bg-slate-100 text-slate-700' },
  OPEN: { label: 'OPEN', className: 'bg-emerald-100 text-emerald-800' },
  CHECKOUT_LOCKED: { label: 'CHECKOUT LOCKED', className: 'bg-purple-100 text-purple-800' },
  SETTLED: { label: 'SETTLED • READY TO RESET', className: 'bg-sky-100 text-sky-800' },
  CLOSED: { label: 'CLOSED', className: 'bg-slate-200 text-slate-700' },
};

const KOT_STATUS_BADGE: Record<string, string> = {
  NEW: 'bg-amber-100 text-amber-800',
  PREPARING: 'bg-blue-100 text-blue-800',
  READY: 'bg-emerald-100 text-emerald-800',
  SERVED: 'bg-slate-200 text-slate-700',
  CANCELLED: 'bg-rose-100 text-rose-700 line-through',
};

function formatTimeRemaining(expiresIso?: string | null): string {
  if (!expiresIso) return 'Revoked / inactive';
  const diffMs = new Date(expiresIso).getTime() - Date.now();
  if (diffMs <= 0) return 'Expired — rotate for new code';
  const mins = Math.ceil(diffMs / 60_000);
  return `Valid ~${mins}m`;
}

export default function LiveFloorPage() {
  const [tables, setTables] = useState<FloorSessionTableDto[]>([]);
  const [stageFilter, setStageFilter] = useState<'ALL' | SessionLifecycleStage>('ALL');
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [userRole, setUserRole] = useState<string>(StaffRole.WAITER);
  const [policy, setPolicy] = useState<OutletPolicyState | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null,
  );

  // Pre-prep order item edit modal state
  const [editTarget, setEditTarget] = useState<ItemEditTarget | null>(null);
  const [editQuantities, setEditQuantities] = useState<Record<string, number>>({});
  const [overrideReason, setOverrideReason] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  const socketRef = useRef<Socket | null>(null);

  const loadFloor = useCallback(async () => {
    try {
      const data = await apiRequest<FloorSessionTableDto[]>('/sessions');
      setTables(data);
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Unable to load live table floor',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPolicyIfPermitted = useCallback(async (role: string) => {
    if (![StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER].includes(role as StaffRole)) {
      return;
    }
    try {
      const res = await apiRequest<{
        outlet?: { tablePinEnabled?: boolean; requireWaiterApproval?: boolean };
      }>('/outlet/profile');
      setPolicy({
        tablePinEnabled: res.outlet?.tablePinEnabled ?? true,
        requireWaiterApproval: res.outlet?.requireWaiterApproval ?? true,
      });
    } catch {
      // Non-blocking
    }
  }, []);

  useEffect(() => {
    const auth = getStoredSession();
    const role = auth?.user?.role ?? StaffRole.WAITER;
    setUserRole(role);
    void loadFloor();
    void loadPolicyIfPermitted(role);
  }, [loadFloor, loadPolicyIfPermitted]);

  // Real-time Socket.IO floor & KDS subscription with 5s polling fallback
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
        void loadFloor();
      });

      socket.on('disconnect', () => {
        if (!active) return;
        setWsConnected(false);
      });

      socket.on('floor.event', () => {
        if (active) void loadFloor();
      });

      socket.on('billing.event', () => {
        if (active) void loadFloor();
      });

      socket.on('kds.event', () => {
        if (active) void loadFloor();
      });

      socketRef.current = socket;
    };

    void connectSocket();
    const fallbackTimer = window.setInterval(() => {
      void loadFloor();
    }, 5000);

    return () => {
      active = false;
      window.clearInterval(fallbackTimer);
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, [loadFloor]);

  const canSettleOrOverride =
    userRole === StaffRole.OWNER ||
    userRole === StaffRole.MANAGER ||
    userRole === StaffRole.CASHIER;
  const isOwner = userRole === StaffRole.OWNER;

  const runAction = async (key: string, fn: () => Promise<void>) => {
    setBusyKey(key);
    setFeedback(null);
    try {
      await fn();
      await loadFloor();
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Action failed',
      });
    } finally {
      setBusyKey(null);
    }
  };

  const openItemEditor = (sessionId: string, tableNumber: string, order: OrderDto) => {
    const initial: Record<string, number> = {};
    for (const item of order.items) {
      initial[item.id] = item.quantity;
    }
    setEditQuantities(initial);
    setOverrideReason('');
    setEditTarget({ sessionId, tableNumber, order });
  };

  const submitOrderItemEdit = async () => {
    if (!editTarget) return;
    const changes = editTarget.order.items
      .filter((item) => editQuantities[item.id] !== undefined && editQuantities[item.id] !== item.quantity)
      .map((item) => ({
        orderItemId: item.id,
        quantity: editQuantities[item.id]!,
      }));

    if (changes.length === 0) {
      setEditTarget(null);
      return;
    }

    setSavingEdit(true);
    setFeedback(null);
    try {
      const res = await apiRequest<{ cancelledWholeOrder: boolean }>(
        `/sessions/${editTarget.sessionId}/orders/${editTarget.order.id}/items`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            items: changes,
            ...(overrideReason.trim() ? { reason: overrideReason.trim() } : {}),
          }),
        },
      );
      setEditTarget(null);
      setFeedback({
        type: 'success',
        text: res.cancelledWholeOrder
          ? `Order KOT #${editTarget.order.kotNumber} cancelled before preparation.`
          : `Updated KOT #${editTarget.order.kotNumber} items on Table ${editTarget.tableNumber}.`,
      });
      await loadFloor();
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Unable to modify order items',
      });
    } finally {
      setSavingEdit(false);
    }
  };

  const toggleOutletPolicy = async (field: keyof OutletPolicyState) => {
    if (!policy || !isOwner) return;
    const nextValue = !policy[field];
    await runAction(`policy-${field}`, async () => {
      await apiRequest('/outlet/profile', {
        method: 'PATCH',
        body: JSON.stringify({ [field]: nextValue }),
      });
      setPolicy((prev) => (prev ? { ...prev, [field]: nextValue } : prev));
      setFeedback({
        type: 'success',
        text: `Updated outlet QR join policy (${field === 'tablePinEnabled' ? 'Table PIN' : 'Waiter Approval'} ${nextValue ? 'enabled' : 'disabled'}).`,
      });
    });
  };

  const stageCounts = useMemo(() => {
    const counts: Record<SessionLifecycleStage, number> = {
      AVAILABLE: 0,
      OPEN: 0,
      CHECKOUT_LOCKED: 0,
      SETTLED: 0,
      CLOSED: 0,
    };
    for (const table of tables) {
      const stage: SessionLifecycleStage =
        table.lifecycleStage ??
        (table.activeSession
          ? table.activeSession.status === DiningSessionStatus.BILL_REQUESTED
            ? 'CHECKOUT_LOCKED'
            : table.activeSession.status === DiningSessionStatus.SETTLED
              ? 'SETTLED'
              : 'OPEN'
          : 'AVAILABLE');
      counts[stage] += 1;
    }
    return counts;
  }, [tables]);

  const readyPickups = useMemo(() => {
    const pickups: Array<{ tableNumber: string; order: OrderDto }> = [];
    for (const t of tables) {
      for (const order of t.activeSession?.orders ?? []) {
        if (order.kitchenStatus === KitchenStatus.READY) {
          pickups.push({ tableNumber: t.tableNumber, order });
        }
      }
    }
    return pickups;
  }, [tables]);

  const filteredTables = useMemo(() => {
    if (stageFilter === 'ALL') return tables;
    return tables.filter((t) => {
      const stage: SessionLifecycleStage =
        t.lifecycleStage ??
        (t.activeSession
          ? t.activeSession.status === DiningSessionStatus.BILL_REQUESTED
            ? 'CHECKOUT_LOCKED'
            : t.activeSession.status === DiningSessionStatus.SETTLED
              ? 'SETTLED'
              : 'OPEN'
          : 'AVAILABLE');
      return stage === stageFilter;
    });
  }, [tables, stageFilter]);

  return (
    <DashboardShell
      title="Live Table Floor & Session Lifecycle"
      subtitle="Seat parties, approve QR guests, manage pre-prep edits, lock bills during checkout, settle counters, and reset tables cleanly."
    >
      {/* Top Status Bar & Filters */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          {(
            [
              { id: 'ALL', label: `All (${tables.length})` },
              { id: 'OPEN', label: `Open (${stageCounts.OPEN})` },
              { id: 'CHECKOUT_LOCKED', label: `Checkout Locked (${stageCounts.CHECKOUT_LOCKED})` },
              { id: 'SETTLED', label: `Settled (${stageCounts.SETTLED})` },
              { id: 'AVAILABLE', label: `Available (${stageCounts.AVAILABLE})` },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setStageFilter(tab.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                stageFilter === tab.id
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
              wsConnected ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800'
            }`}
          >
            {wsConnected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
            {wsConnected ? 'Real-Time Stream' : '5s Poll Fallback'}
          </span>

          <button
            type="button"
            onClick={() => void loadFloor()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
      </div>

      {/* Owner Quick QR Join Security Policy Toggles */}
      {isOwner && policy && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs">
          <div className="flex items-center gap-2 font-semibold text-slate-700">
            <ShieldCheck className="h-4 w-4 text-brand-600" />
            <span>QR Guest Security Policy (Owner):</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busyKey === 'policy-tablePinEnabled'}
              onClick={() => void toggleOutletPolicy('tablePinEnabled')}
              className={`rounded-lg border px-3 py-1 font-semibold ${
                policy.tablePinEnabled
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                  : 'border-slate-300 bg-white text-slate-600'
              }`}
            >
              4-Digit Table PIN: {policy.tablePinEnabled ? 'ON' : 'OFF'}
            </button>
            <button
              type="button"
              disabled={busyKey === 'policy-requireWaiterApproval'}
              onClick={() => void toggleOutletPolicy('requireWaiterApproval')}
              className={`rounded-lg border px-3 py-1 font-semibold ${
                policy.requireWaiterApproval
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                  : 'border-slate-300 bg-white text-slate-600'
              }`}
            >
              Waiter Approval Option: {policy.requireWaiterApproval ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>
      )}

      {/* Ready-to-Serve Kitchen Pickup Alert Strip */}
      {readyPickups.length > 0 && (
        <div className="mb-4 rounded-2xl border border-emerald-300 bg-emerald-50 p-4 shadow-sm">
          <div className="flex items-center gap-2 text-sm font-bold text-emerald-900">
            <ChefHat className="h-4 w-4 text-emerald-700" />
            Ready-to-Serve Kitchen Pickups ({readyPickups.length})
          </div>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {readyPickups.map(({ tableNumber, order }) => (
              <div
                key={order.id}
                className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-white px-3 py-2 text-xs shadow-sm"
              >
                <span className="font-bold text-slate-900">
                  Table {tableNumber} • KOT #{order.kotNumber}
                </span>
                <button
                  type="button"
                  disabled={busyKey === `serve-${order.id}`}
                  onClick={() =>
                    void runAction(`serve-${order.id}`, async () => {
                      await apiRequest(`/kds/orders/${order.id}/status`, {
                        method: 'POST',
                        body: JSON.stringify({ kitchenStatus: KitchenStatus.SERVED }),
                      });
                      setFeedback({
                        type: 'success',
                        text: `Marked Table ${tableNumber} KOT #${order.kotNumber} as Served.`,
                      });
                    })
                  }
                  className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 font-bold text-white hover:bg-emerald-700"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Mark Served
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Flash Feedback */}
      {feedback && (
        <div
          className={`mb-4 flex items-center justify-between rounded-xl px-4 py-3 text-sm ${
            feedback.type === 'error'
              ? 'border border-rose-200 bg-rose-50 text-rose-700'
              : 'border border-emerald-200 bg-emerald-50 text-emerald-800'
          }`}
        >
          <span>{feedback.text}</span>
          <button type="button" onClick={() => setFeedback(null)}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Floor Table Grid */}
      {loading ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          Loading live dining sessions...
        </div>
      ) : filteredTables.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          No tables match the selected stage filter.
        </div>
      ) : (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {filteredTables.map((table) => {
            const session = table.activeSession;
            const stage: SessionLifecycleStage =
              table.lifecycleStage ??
              (session
                ? session.status === DiningSessionStatus.BILL_REQUESTED
                  ? 'CHECKOUT_LOCKED'
                  : session.status === DiningSessionStatus.SETTLED
                    ? 'SETTLED'
                    : 'OPEN'
                : 'AVAILABLE');
            const badge = STAGE_BADGE_MAP[stage];
            const activeOrdersCount = session?.balance?.activeOrdersCount ?? 0;

            return (
              <article
                key={table.id}
                className={`flex flex-col justify-between rounded-2xl border bg-white p-5 shadow-sm ${
                  stage === 'CHECKOUT_LOCKED'
                    ? 'border-purple-300 ring-1 ring-purple-200'
                    : stage === 'SETTLED'
                      ? 'border-sky-300 ring-1 ring-sky-200'
                      : stage === 'OPEN'
                        ? 'border-emerald-200'
                        : 'border-slate-200'
                }`}
              >
                <div>
                  {/* Card Header */}
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h2 className="text-lg font-extrabold text-slate-900">
                        Table {table.tableNumber}
                      </h2>
                      <p className="text-xs text-slate-500">
                        {table.label || `Seats ${table.capacity}`}
                      </p>
                    </div>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${badge.className}`}
                    >
                      {badge.label}
                    </span>
                  </div>

                  {!session ? (
                    <div className="mt-6 rounded-xl bg-slate-50 p-4 text-center">
                      <Utensils className="mx-auto h-7 w-7 text-slate-400" />
                      <p className="mt-2 text-xs text-slate-600">
                        Clean & available. Seat a party to generate a rotating QR join PIN.
                      </p>
                      <button
                        type="button"
                        disabled={busyKey === `open-${table.id}`}
                        onClick={() =>
                          void runAction(`open-${table.id}`, async () => {
                            await apiRequest('/sessions/open', {
                              method: 'POST',
                              body: JSON.stringify({ tableId: table.id }),
                            });
                            setFeedback({
                              type: 'success',
                              text: `Table ${table.tableNumber} opened for dining.`,
                            });
                          })
                        }
                        className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-brand-700"
                      >
                        <Play className="h-4 w-4" />
                        Seat Party & Open Table
                      </button>
                    </div>
                  ) : (
                    <div className="mt-4 space-y-3">
                      {/* Join Code Strip (Active Only) */}
                      {stage === 'OPEN' && (
                        <div className="rounded-xl bg-orange-50/90 p-3 ring-1 ring-orange-200">
                          <div className="flex items-center justify-between gap-2">
                            <div>
                              <p className="text-[11px] font-semibold uppercase tracking-wide text-orange-900">
                                Rotating Join PIN
                              </p>
                              <p className="text-2xl font-black tracking-widest text-slate-900">
                                {session.joinCode ?? 'REVOKED'}
                              </p>
                              <p className="inline-flex items-center gap-1 text-[11px] text-orange-800">
                                <Clock className="h-3 w-3" />
                                {formatTimeRemaining(session.joinCodeExpiresAt)}
                              </p>
                            </div>
                            <div className="flex flex-col gap-1.5">
                              <button
                                type="button"
                                disabled={busyKey === `rotate-${session.id}`}
                                onClick={() =>
                                  void runAction(`rotate-${session.id}`, async () => {
                                    await apiRequest(`/sessions/${session.id}/rotate-join-code`, {
                                      method: 'POST',
                                    });
                                    setFeedback({
                                      type: 'success',
                                      text: `Rotated join code for Table ${table.tableNumber}.`,
                                    });
                                  })
                                }
                                className="inline-flex items-center gap-1 rounded-lg bg-white px-2.5 py-1 text-xs font-bold text-slate-800 shadow-sm hover:bg-slate-50"
                              >
                                <KeyRound className="h-3 w-3" /> Rotate
                              </button>
                              {session.joinCode && (
                                <button
                                  type="button"
                                  disabled={busyKey === `revoke-code-${session.id}`}
                                  onClick={() =>
                                    void runAction(`revoke-code-${session.id}`, async () => {
                                      await apiRequest(`/sessions/${session.id}/revoke-join-code`, {
                                        method: 'POST',
                                      });
                                      setFeedback({
                                        type: 'success',
                                        text: `Join code revoked on Table ${table.tableNumber}. Existing approved guests stay seated.`,
                                      });
                                    })
                                  }
                                  className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-white px-2.5 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                                >
                                  <Ban className="h-3 w-3" /> Revoke PIN
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Guests Approval & Revocation */}
                      {session.guests.length > 0 && (
                        <div className="rounded-xl border border-slate-200 p-3">
                          <div className="flex items-center justify-between text-xs font-bold text-slate-700">
                            <span className="inline-flex items-center gap-1.5">
                              <UserCheck className="h-3.5 w-3.5 text-brand-600" />
                              Party Guests ({session.guests.length})
                            </span>
                            {session.pendingGuestsCount > 0 && (
                              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">
                                {session.pendingGuestsCount} Pending
                              </span>
                            )}
                          </div>
                          <ul className="mt-2 space-y-1.5">
                            {session.guests.map((g) => (
                              <li
                                key={g.id}
                                className="flex items-center justify-between rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs"
                              >
                                <span className="font-medium text-slate-800">
                                  {g.displayLabel || 'Guest'}
                                </span>
                                {stage === 'OPEN' ? (
                                  g.status === GuestJoinStatus.PENDING_APPROVAL ? (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        void runAction(`approve-${g.id}`, async () => {
                                          await apiRequest(
                                            `/sessions/${session.id}/guests/${g.id}/approve`,
                                            { method: 'POST' },
                                          );
                                        })
                                      }
                                      className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2 py-0.5 text-[11px] font-bold text-white"
                                    >
                                      <Check className="h-3 w-3" /> Approve
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        void runAction(`revoke-guest-${g.id}`, async () => {
                                          await apiRequest(
                                            `/sessions/${session.id}/guests/${g.id}/revoke`,
                                            { method: 'POST' },
                                          );
                                        })
                                      }
                                      className="text-[11px] font-semibold text-rose-600 hover:underline"
                                    >
                                      Revoke
                                    </button>
                                  )
                                ) : (
                                  <span className="text-[11px] font-semibold text-slate-500">
                                    {g.status}
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Order Rounds + Pre-Prep Edit Trigger */}
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-xs font-bold text-slate-700">
                          <span>Order Rounds ({session.orders.length})</span>
                          <span>Opened {new Date(session.openedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                        {session.orders.length === 0 ? (
                          <p className="rounded-xl bg-slate-50 p-3 text-center text-xs text-slate-500">
                            No orders punched yet.
                          </p>
                        ) : (
                          <div className="max-h-56 space-y-2 overflow-y-auto pr-0.5">
                            {session.orders.map((order) => {
                              const canPrePrepEdit =
                                stage === 'OPEN' &&
                                (order.kitchenStatus === KitchenStatus.NEW ||
                                  order.kitchenStatus === KitchenStatus.PREPARING);
                              return (
                                <div
                                  key={order.id}
                                  className="rounded-xl border border-slate-200 bg-slate-50/70 p-2.5 text-xs"
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="font-bold text-slate-900">
                                      Round {order.roundNumber}
                                      {order.isAddOn ? ' (ADD-ON)' : ''} • KOT #{order.kotNumber}
                                    </span>
                                    <span
                                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                                        KOT_STATUS_BADGE[order.kitchenStatus] ??
                                        'bg-slate-100 text-slate-700'
                                      }`}
                                    >
                                      {order.kitchenStatus}
                                    </span>
                                  </div>
                                  <ul className="mt-1.5 space-y-0.5 text-[11px] text-slate-600">
                                    {order.items.map((item) => (
                                      <li
                                        key={item.id}
                                        className={`flex justify-between ${
                                          item.status === 'CANCELLED' ? 'line-through opacity-50' : ''
                                        }`}
                                      >
                                        <span>
                                          {item.quantity} × {item.itemNameSnapshot}
                                        </span>
                                        <span>{formatInrFromPaise(item.lineTotalPaise)}</span>
                                      </li>
                                    ))}
                                  </ul>
                                  <div className="mt-1.5 flex items-center justify-between border-t border-slate-200 pt-1.5">
                                    <span className="font-bold text-slate-900">
                                      {formatInrFromPaise(order.subtotalPaise)}
                                    </span>
                                    {canPrePrepEdit && (
                                      <button
                                        type="button"
                                        onClick={() => openItemEditor(session.id, table.tableNumber, order)}
                                        className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-100"
                                      >
                                        <Edit3 className="h-3 w-3" /> Edit / Cancel
                                      </button>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      {/* Consolidated Running Balance */}
                      <div className="rounded-xl bg-slate-900 p-3 text-xs text-slate-200">
                        <div className="flex items-center justify-between">
                          <span>Subtotal ({activeOrdersCount} active rounds)</span>
                          <span className="font-bold text-white">
                            {formatInrFromPaise(
                              session.balance?.subtotalPaise ?? session.runningTotalPaise,
                            )}
                          </span>
                        </div>
                        {session.activeBill ? (
                          <>
                            <div className="mt-1 flex items-center justify-between text-emerald-300">
                              <span>
                                Finalized {session.activeBill.billNumber} ({session.activeBill.status})
                              </span>
                              <span>{formatInrFromPaise(session.activeBill.totalPaise)}</span>
                            </div>
                            <div className="mt-1 flex items-center justify-between text-slate-300">
                              <span>Paid: {formatInrFromPaise(session.activeBill.netPaidPaise)}</span>
                              <span className="font-bold text-amber-300">
                                Due: {formatInrFromPaise(session.activeBill.duePaise)}
                              </span>
                            </div>
                          </>
                        ) : (
                          session.balance && (
                            <>
                              <div className="mt-1 flex items-center justify-between text-slate-400">
                                <span>GST ({session.balance.gstRateBps / 100}%)</span>
                                <span>{formatInrFromPaise(session.balance.totalTaxPaise)}</span>
                              </div>
                              <div className="mt-2 flex items-center justify-between border-t border-slate-700 pt-1.5 text-sm font-extrabold text-white">
                                <span>Estimated Bill Total</span>
                                <span>
                                  {formatInrFromPaise(session.balance.estimatedTotalPaise)}
                                </span>
                              </div>
                            </>
                          )
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Lifecycle Actions Footer */}
                {session && (
                  <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
                    {stage === 'OPEN' && (
                      <>
                        <Link
                          href="/dashboard/staff-order"
                          className="inline-flex flex-1 items-center justify-center gap-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-800 hover:bg-slate-50"
                        >
                          <Plus className="h-3.5 w-3.5" /> Add Round
                        </Link>
                        {activeOrdersCount > 0 ? (
                          <button
                            type="button"
                            disabled={busyKey === `lock-${session.id}`}
                            onClick={() =>
                              void runAction(`lock-${session.id}`, async () => {
                                await apiRequest(`/sessions/${session.id}/request-bill`, {
                                  method: 'POST',
                                });
                                setFeedback({
                                  type: 'success',
                                  text: `Table ${table.tableNumber} locked for billing (Request Bill).`,
                                });
                              })
                            }
                            className="inline-flex flex-1 items-center justify-center gap-1 rounded-xl bg-purple-700 px-3 py-2 text-xs font-bold text-white hover:bg-purple-800"
                          >
                            <Receipt className="h-3.5 w-3.5" /> Request Bill
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={busyKey === `close-${session.id}`}
                            onClick={() =>
                              void runAction(`close-${session.id}`, async () => {
                                await apiRequest(`/sessions/${session.id}/close`, {
                                  method: 'POST',
                                  body: JSON.stringify({ reason: 'Empty session closed by staff' }),
                                });
                                setFeedback({
                                  type: 'success',
                                  text: `Empty Table ${table.tableNumber} closed and reset to Available.`,
                                });
                              })
                            }
                            className="inline-flex flex-1 items-center justify-center gap-1 rounded-xl border border-slate-300 bg-slate-100 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-200"
                          >
                            <RotateCcw className="h-3.5 w-3.5" /> Close Empty Table
                          </button>
                        )}
                      </>
                    )}

                    {stage === 'CHECKOUT_LOCKED' && (
                      <>
                        <button
                          type="button"
                          disabled={busyKey === `reopen-${session.id}`}
                          onClick={() =>
                            void runAction(`reopen-${session.id}`, async () => {
                              await apiRequest(`/sessions/${session.id}/reopen`, {
                                method: 'POST',
                              });
                              setFeedback({
                                type: 'success',
                                text: `Table ${table.tableNumber} reopened for additional orders.`,
                              });
                            })
                          }
                          className="inline-flex flex-1 items-center justify-center gap-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-800 hover:bg-slate-50"
                        >
                          <Unlock className="h-3.5 w-3.5" /> Reopen
                        </button>

                        {!session.activeBill ? (
                          <button
                            type="button"
                            disabled={busyKey === `genbill-${session.id}`}
                            onClick={() =>
                              void runAction(`genbill-${session.id}`, async () => {
                                const res = await apiRequest<{
                                  bill: { billNumber: string };
                                  alreadyExisted: boolean;
                                }>(
                                  `/billing/sessions/${session.id}/bill`,
                                  {
                                    method: 'POST',
                                    body: JSON.stringify({}),
                                  },
                                );
                                setFeedback({
                                  type: 'success',
                                  text: `Generated ${res.bill.billNumber} for Table ${table.tableNumber}.`,
                                });
                              })
                            }
                            className="inline-flex flex-1 items-center justify-center gap-1 rounded-xl bg-brand-600 px-3 py-2 text-xs font-bold text-white hover:bg-brand-700"
                          >
                            <Receipt className="h-3.5 w-3.5" /> Generate Bill
                          </button>
                        ) : (
                          <Link
                            href={`/dashboard/billing?billId=${encodeURIComponent(session.activeBill.id)}`}
                            className="inline-flex flex-1 items-center justify-center gap-1 rounded-xl bg-brand-600 px-3 py-2 text-xs font-bold text-white hover:bg-brand-700"
                          >
                            <CreditCard className="h-3.5 w-3.5" /> Collect Payment
                          </Link>
                        )}

                        {canSettleOrOverride && !session.activeBill && (
                          <button
                            type="button"
                            disabled={busyKey === `settle-${session.id}`}
                            onClick={() =>
                              void runAction(`settle-${session.id}`, async () => {
                                await apiRequest(`/sessions/${session.id}/settle`, {
                                  method: 'POST',
                                  body: JSON.stringify({ note: 'Counter payment verified' }),
                                });
                                setFeedback({
                                  type: 'success',
                                  text: `Table ${table.tableNumber} marked SETTLED. You can now close and reset for next party.`,
                                });
                              })
                            }
                            className="inline-flex flex-1 items-center justify-center gap-1 rounded-xl bg-sky-600 px-3 py-2 text-xs font-bold text-white hover:bg-sky-700"
                          >
                            <CreditCard className="h-3.5 w-3.5" /> Quick Settle
                          </button>
                        )}
                      </>
                    )}

                    {stage === 'SETTLED' && (
                      <button
                        type="button"
                        disabled={busyKey === `close-${session.id}`}
                        onClick={() =>
                          void runAction(`close-${session.id}`, async () => {
                            const res = await apiRequest<{ revokedGuestsCount: number }>(
                              `/sessions/${session.id}/close`,
                              {
                                method: 'POST',
                                body: JSON.stringify({ reason: 'Settled session closed cleanly' }),
                              },
                            );
                            setFeedback({
                              type: 'success',
                              text: `Table ${table.tableNumber} closed & reset to AVAILABLE (${res.revokedGuestsCount} guest token(s) revoked).`,
                            });
                          })
                        }
                        className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-emerald-700"
                      >
                        <RotateCcw className="h-4 w-4" /> Close & Reset Table for Next Party
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {/* Pre-Prep Order Item Edit / Cancel Modal */}
      {editTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h2 className="text-lg font-bold text-slate-900">
                  Edit Table {editTarget.tableNumber} • KOT #{editTarget.order.kotNumber}
                </h2>
                <p className="text-xs text-slate-500">
                  Kitchen Status: {editTarget.order.kitchenStatus} • Reduce qty or set 0 to cancel line
                </p>
              </div>
              <button type="button" onClick={() => setEditTarget(null)}>
                <X className="h-5 w-5 text-slate-400" />
              </button>
            </div>

            {editTarget.order.kitchenStatus === KitchenStatus.PREPARING && !canSettleOrOverride ? (
              <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs font-medium text-rose-800">
                Kitchen has already started preparing KOT #{editTarget.order.kotNumber}. Waiter item edits are locked — ask Manager or Cashier to override if required.
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                {editTarget.order.items.map((item) => {
                  const qty = editQuantities[item.id] ?? item.quantity;
                  return (
                    <div
                      key={item.id}
                      className="flex items-center justify-between rounded-xl border border-slate-200 p-3 text-sm"
                    >
                      <div>
                        <p className="font-semibold text-slate-900">{item.itemNameSnapshot}</p>
                        <p className="text-xs text-slate-500">
                          {formatInrFromPaise(item.unitPricePaise)} each
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            setEditQuantities((prev) => ({
                              ...prev,
                              [item.id]: Math.max(0, (prev[item.id] ?? item.quantity) - 1),
                            }))
                          }
                          className="rounded-lg border border-slate-300 p-1.5 hover:bg-slate-100"
                        >
                          <Minus className="h-3.5 w-3.5" />
                        </button>
                        <span className="w-7 text-center font-bold text-slate-900">{qty}</span>
                        <button
                          type="button"
                          onClick={() =>
                            setEditQuantities((prev) => ({
                              ...prev,
                              [item.id]: Math.min(50, (prev[item.id] ?? item.quantity) + 1),
                            }))
                          }
                          className="rounded-lg border border-slate-300 p-1.5 hover:bg-slate-100"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}

                {editTarget.order.kitchenStatus === KitchenStatus.PREPARING && (
                  <div>
                    <label className="block text-xs font-semibold uppercase text-slate-600">
                      Manager/Cashier Override Reason (Required)
                    </label>
                    <input
                      value={overrideReason}
                      onChange={(e) => setOverrideReason(e.target.value)}
                      maxLength={200}
                      placeholder="e.g. Diner allergic to ingredient / wrong entry"
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                )}

                <div className="flex gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setEditTarget(null)}
                    className="flex-1 rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={savingEdit}
                    onClick={() => void submitOrderItemEdit()}
                    className="flex-1 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-brand-700 disabled:opacity-50"
                  >
                    {savingEdit ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </DashboardShell>
  );
}

