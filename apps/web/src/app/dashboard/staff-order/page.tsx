'use client';

import {
  DietaryType,
  GuestJoinStatus,
  KitchenStatus,
  formatInrFromPaise,
} from '@autonex/shared';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  KeyRound,
  Minus,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Trash2,
  UserCheck,
  X,
} from 'lucide-react';
import { DashboardShell } from '@/components/dashboard-shell';
import { DietaryBadge } from '@/components/dietary-badge';
import { MenuItemCustomizerModal } from '@/components/menu-item-customizer-modal';
import {
  ApiError,
  FloorSessionTableDto,
  MenuCategoryDto,
  MenuItemDto,
  ModifierOptionDto,
  PlaceOrderResponse,
  apiRequest,
} from '@/lib/api-client';
import {
  CartLineItem,
  addOrIncrementCartLine,
  clearIdempotencyKey,
  computeCartTotals,
  getOrCreateIdempotencyKey,
  updateCartLineQuantity,
} from '@/lib/cart-storage';

export default function StaffAssistedOrderingPage() {
  const [floorTables, setFloorTables] = useState<FloorSessionTableDto[]>([]);
  const [categories, setCategories] = useState<MenuCategoryDto[]>([]);
  const [selectedTableId, setSelectedTableId] = useState<string>('');
  const [search, setSearch] = useState('');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('ALL');

  const [staffCart, setStaffCart] = useState<CartLineItem[]>([]);
  const [orderNotes, setOrderNotes] = useState('');
  const [customizingItem, setCustomizingItem] = useState<MenuItemDto | null>(null);

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'error' | 'success'; text: string } | null>(
    null,
  );

  const loadAll = useCallback(async () => {
    try {
      const [tablesData, menuData] = await Promise.all([
        apiRequest<FloorSessionTableDto[]>('/sessions'),
        apiRequest<{ categories: MenuCategoryDto[] }>('/menus'),
      ]);
      setFloorTables(tablesData);
      setCategories(menuData.categories);
      setSelectedTableId((prev) => prev || tablesData[0]?.id || '');
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Unable to load floor tables or menu',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
    const timer = window.setInterval(() => {
      apiRequest<FloorSessionTableDto[]>('/sessions')
        .then(setFloorTables)
        .catch(() => {});
    }, 5000);
    return () => window.clearInterval(timer);
  }, [loadAll]);

  const selectedTable = floorTables.find((t) => t.id === selectedTableId) ?? null;

  const handleOpenSession = async (tableId: string) => {
    setFeedback(null);
    try {
      await apiRequest('/sessions/open', {
        method: 'POST',
        body: JSON.stringify({ tableId }),
      });
      setFeedback({ type: 'success', text: 'Dining session opened — join code ready for guests.' });
      await loadAll();
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Could not open session',
      });
    }
  };

  const handleRotateCode = async (sessionId: string) => {
    try {
      const updated = await apiRequest<{ joinCode: string }>(`/sessions/${sessionId}/rotate-join-code`, {
        method: 'POST',
      });
      setFeedback({ type: 'success', text: `New table join code: ${updated.joinCode}` });
      await loadAll();
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Could not rotate join code',
      });
    }
  };

  const handleGuestAction = async (
    sessionId: string,
    guestId: string,
    action: 'approve' | 'revoke',
  ) => {
    try {
      await apiRequest(`/sessions/${sessionId}/guests/${guestId}/${action}`, {
        method: 'POST',
      });
      await loadAll();
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : `Failed to ${action} guest`,
      });
    }
  };

  const addMenuItem = (item: MenuItemDto) => {
    if (!item.inStock) return;
    if (item.modifierGroups.length > 0) {
      setCustomizingItem(item);
      return;
    }
    setStaffCart((prev) => addOrIncrementCartLine(prev, item, [], 1, ''));
  };

  const handleConfirmCustom = (
    selectedOptions: ModifierOptionDto[],
    quantity: number,
    prepNotes: string,
  ) => {
    if (!customizingItem) return;
    setStaffCart((prev) =>
      addOrIncrementCartLine(prev, customizingItem, selectedOptions, quantity, prepNotes),
    );
    setCustomizingItem(null);
  };

  const cartSummary = useMemo(() => computeCartTotals(staffCart), [staffCart]);

  const handleSubmitStaffOrder = async () => {
    if (!selectedTable || staffCart.length === 0) return;
    setSubmitting(true);
    setFeedback(null);

    const idemScope = `staff_${selectedTable.id}`;
    const idemKey = getOrCreateIdempotencyKey(idemScope);

    try {
      const res = await apiRequest<PlaceOrderResponse>('/orders/staff', {
        method: 'POST',
        headers: { 'Idempotency-Key': idemKey },
        body: JSON.stringify({
          tableId: selectedTable.id,
          openIfAvailable: true,
          items: staffCart.map((line) => ({
            menuItemId: line.menuItemId,
            quantity: line.quantity,
            selectedOptionIds: line.selectedOptionIds,
            ...(line.prepNotes ? { prepNotes: line.prepNotes } : {}),
          })),
          ...(orderNotes.trim() ? { notes: orderNotes.trim() } : {}),
          expectedSubtotalPaise: cartSummary.subtotalPaise,
        }),
      });

      clearIdempotencyKey(idemScope);
      setStaffCart([]);
      setOrderNotes('');
      setFeedback({
        type: 'success',
        text: `Staff order placed for Table ${selectedTable.tableNumber}: KOT #${res.order.kotNumber} (Round ${res.order.roundNumber}).`,
      });
      await loadAll();
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'STALE_MENU_PRICE' || err.code === 'OUT_OF_STOCK')) {
        clearIdempotencyKey(idemScope);
        await loadAll();
      }
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Staff order failed — retry safely.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const q = search.trim().toLowerCase();

  return (
    <DashboardShell
      title="Waiter & Staff-Assisted Ordering"
      subtitle="Activate dining tables, share rotating join codes, approve QR guests, and place orders on behalf of customers."
    >
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

      {loading ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          Loading floor tables and menu...
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-12">
          {/* Left: Floor Tables + Session Controls */}
          <section className="space-y-4 lg:col-span-5">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-slate-900">Floor Tables</h2>
                <div className="flex items-center gap-3">
                  <Link
                    href="/dashboard/floor"
                    className="text-xs font-semibold text-brand-700 hover:underline"
                  >
                    Live Floor →
                  </Link>
                  <button
                    type="button"
                    onClick={loadAll}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-slate-600 hover:text-slate-900"
                  >
                    <RefreshCw className="h-3.5 w-3.5" /> Refresh
                  </button>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-2">
                {floorTables.map((t) => {
                  const selected = t.id === selectedTableId;
                  const pending = t.activeSession?.pendingGuestsCount ?? 0;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setSelectedTableId(t.id)}
                      className={`rounded-xl border p-3 text-left transition ${
                        selected
                          ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-500'
                          : 'border-slate-200 bg-white hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-slate-900">Table {t.tableNumber}</span>
                        <span
                          className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                            t.activeSession
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {t.activeSession ? 'OPEN' : 'FREE'}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {t.activeSession
                          ? `Bill: ${formatInrFromPaise(t.activeSession.runningTotalPaise)}`
                          : `${t.capacity} seats`}
                      </p>
                      {pending > 0 && (
                        <p className="mt-1 text-[11px] font-bold text-amber-700">
                          {pending} guest waiting approval
                        </p>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {selectedTable && (
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-bold text-slate-900">
                      Table {selectedTable.tableNumber} Control
                    </h3>
                    <p className="text-xs text-slate-500">
                      {selectedTable.label ? `${selectedTable.label} • ` : ''}
                      {selectedTable.capacity} seats
                    </p>
                  </div>
                  {!selectedTable.activeSession && (
                    <button
                      type="button"
                      onClick={() => handleOpenSession(selectedTable.id)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-brand-700"
                    >
                      <Play className="h-3.5 w-3.5" />
                      Open Table Session
                    </button>
                  )}
                </div>

                {selectedTable.activeSession ? (
                  <>
                    <div className="flex items-center justify-between rounded-xl bg-slate-900 px-4 py-3 text-white">
                      <div>
                        <p className="text-[11px] uppercase tracking-wider text-slate-300">
                          Customer Join Code
                        </p>
                        <p className="inline-flex items-center gap-2 text-xl font-extrabold tracking-widest">
                          <KeyRound className="h-4 w-4 text-orange-400" />
                          {selectedTable.activeSession.joinCode || '----'}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRotateCode(selectedTable.activeSession!.id)}
                        className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-100 hover:bg-slate-700"
                      >
                        Rotate Code
                      </button>
                    </div>

                    {selectedTable.activeSession.guests.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold uppercase text-slate-500">
                          Table Guests ({selectedTable.activeSession.guests.length})
                        </h4>
                        <div className="mt-2 space-y-1.5">
                          {selectedTable.activeSession.guests.map((g) => (
                            <div
                              key={g.id}
                              className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-xs"
                            >
                              <span className="inline-flex items-center gap-1.5 font-medium text-slate-800">
                                <UserCheck className="h-3.5 w-3.5 text-slate-400" />
                                {g.displayLabel || 'Guest'}
                              </span>
                              <div className="flex items-center gap-2">
                                {g.status === GuestJoinStatus.PENDING_APPROVAL ? (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleGuestAction(
                                        selectedTable.activeSession!.id,
                                        g.id,
                                        'approve',
                                      )
                                    }
                                    className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2 py-1 font-bold text-white hover:bg-emerald-700"
                                  >
                                    <Check className="h-3 w-3" /> Approve
                                  </button>
                                ) : (
                                  <span className="rounded bg-emerald-50 px-2 py-0.5 font-semibold text-emerald-700">
                                    Approved
                                  </span>
                                )}
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleGuestAction(
                                      selectedTable.activeSession!.id,
                                      g.id,
                                      'revoke',
                                    )
                                  }
                                  className="text-rose-600 hover:underline"
                                >
                                  Revoke
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {selectedTable.activeSession.orders.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold uppercase text-slate-500">
                          Active Rounds ({selectedTable.activeSession.orders.length})
                        </h4>
                        <div className="mt-2 space-y-2">
                          {selectedTable.activeSession.orders.map((order) => (
                            <div
                              key={order.id}
                              className="rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs"
                            >
                              <div className="flex items-center justify-between font-semibold text-slate-900">
                                <span>
                                  Round {order.roundNumber} • KOT #{order.kotNumber} (
                                  {order.source === 'STAFF_POS' ? 'Waiter' : 'QR'})
                                </span>
                                <span className="flex items-center gap-2">
                                  <span
                                    className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                                      order.kitchenStatus === KitchenStatus.READY
                                        ? 'bg-emerald-100 text-emerald-800'
                                        : order.kitchenStatus === KitchenStatus.PREPARING
                                          ? 'bg-amber-100 text-amber-800'
                                          : order.kitchenStatus === KitchenStatus.ACKNOWLEDGED
                                            ? 'bg-cyan-100 text-cyan-800'
                                            : order.kitchenStatus === KitchenStatus.SERVED
                                              ? 'bg-slate-200 text-slate-700'
                                              : 'bg-sky-100 text-sky-800'
                                    }`}
                                  >
                                    {order.kitchenStatus}
                                  </span>
                                  <span>{formatInrFromPaise(order.subtotalPaise)}</span>
                                </span>
                              </div>
                              <p className="mt-1 text-slate-600">
                                {order.items
                                  .map((it) => `${it.quantity}× ${it.itemNameSnapshot}`)
                                  .join(', ')}
                              </p>
                              {order.kitchenStatus === KitchenStatus.READY && (
                                <button
                                  type="button"
                                  onClick={async () => {
                                    try {
                                      await apiRequest(`/kds/orders/${order.id}/status`, {
                                        method: 'PATCH',
                                        body: JSON.stringify({ status: KitchenStatus.SERVED }),
                                      });
                                      setFeedback({
                                        type: 'success',
                                        text: `KOT #${order.kotNumber} marked SERVED.`,
                                      });
                                      await loadAll();
                                    } catch (err) {
                                      setFeedback({
                                        type: 'error',
                                        text:
                                          err instanceof ApiError
                                            ? err.message
                                            : 'Failed to mark order served',
                                      });
                                    }
                                  }}
                                  className="mt-2 inline-flex items-center gap-1 rounded bg-emerald-600 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-emerald-700"
                                >
                                  <Check className="h-3 w-3" /> Mark Served
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-slate-500">
                    Open the table session to generate a rotating guest join code, or add items on
                    the right to open and place Round 1 together.
                  </p>
                )}
              </div>
            )}
          </section>

          {/* Right: Menu Pad & Staff Cart */}
          <section className="space-y-4 lg:col-span-7">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-center gap-3">
                <div className="relative flex-1 min-w-[200px]">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search dish for waiter order..."
                    className="w-full rounded-lg border border-slate-300 py-1.5 pl-9 pr-3 text-sm"
                  />
                </div>
                <select
                  value={selectedCategoryId}
                  onChange={(e) => setSelectedCategoryId(e.target.value)}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                >
                  <option value="ALL">All Categories</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mt-4 max-h-[380px] space-y-4 overflow-y-auto pr-1">
                {categories
                  .filter((c) => selectedCategoryId === 'ALL' || c.id === selectedCategoryId)
                  .map((cat) => {
                    const items = cat.menuItems.filter(
                      (i) => i.isActive && (!q || i.name.toLowerCase().includes(q)),
                    );
                    if (items.length === 0) return null;
                    return (
                      <div key={cat.id}>
                        <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">
                          {cat.name}
                        </h3>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {items.map((item) => (
                            <button
                              key={item.id}
                              type="button"
                              disabled={!item.inStock}
                              onClick={() => addMenuItem(item)}
                              className={`flex items-center justify-between rounded-xl border p-3 text-left transition ${
                                item.inStock
                                  ? 'border-slate-200 hover:border-brand-500 hover:bg-orange-50/40'
                                  : 'cursor-not-allowed border-slate-100 bg-slate-50 opacity-50'
                              }`}
                            >
                              <div className="min-w-0 pr-2">
                                <div className="flex items-center gap-1.5">
                                  <DietaryBadge type={item.dietaryType as DietaryType} />
                                  <span className="truncate text-sm font-semibold text-slate-900">
                                    {item.name}
                                  </span>
                                </div>
                                <p className="mt-0.5 text-xs font-bold text-slate-700">
                                  {formatInrFromPaise(item.basePricePaise)}
                                  {item.modifierGroups.length > 0 ? ' • Custom' : ''}
                                </p>
                              </div>
                              <Plus className="h-4 w-4 shrink-0 text-brand-600" />
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>

            {/* Waiter Order Cart */}
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h3 className="text-sm font-bold text-slate-900">
                Waiter Order Cart{' '}
                {selectedTable ? `— Table ${selectedTable.tableNumber}` : ''}
              </h3>

              {staffCart.length === 0 ? (
                <p className="mt-3 text-xs text-slate-500">
                  Tap dishes above to add items on behalf of the guest.
                </p>
              ) : (
                <>
                  <div className="mt-3 divide-y divide-slate-100">
                    {staffCart.map((line) => (
                      <div key={line.lineKey} className="flex items-center justify-between py-2.5">
                        <div>
                          <p className="text-sm font-semibold text-slate-900">{line.itemName}</p>
                          {line.modifiers.length > 0 && (
                            <p className="text-xs text-slate-500">
                              {line.modifiers.map((m) => m.optionName).join(', ')}
                            </p>
                          )}
                          {line.prepNotes && (
                            <p className="text-xs italic text-slate-500">{line.prepNotes}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-xs font-bold text-slate-800">
                            {formatInrFromPaise(line.unitPricePaise * line.quantity)}
                          </span>
                          <div className="inline-flex items-center rounded-lg border border-slate-300">
                            <button
                              type="button"
                              onClick={() =>
                                setStaffCart((prev) =>
                                  updateCartLineQuantity(prev, line.lineKey, line.quantity - 1),
                                )
                              }
                              className="p-1 text-slate-600"
                            >
                              <Minus className="h-3 w-3" />
                            </button>
                            <span className="w-6 text-center text-xs font-bold">
                              {line.quantity}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                setStaffCart((prev) =>
                                  updateCartLineQuantity(prev, line.lineKey, line.quantity + 1),
                                )
                              }
                              className="p-1 text-slate-600"
                            >
                              <Plus className="h-3 w-3" />
                            </button>
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              setStaffCart((prev) => updateCartLineQuantity(prev, line.lineKey, 0))
                            }
                            className="text-slate-400 hover:text-rose-600"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  <input
                    value={orderNotes}
                    onChange={(e) => setOrderNotes(e.target.value)}
                    placeholder="Kitchen notes (optional)..."
                    className="mt-3 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />

                  <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3">
                    <span className="text-base font-extrabold text-slate-900">
                      Total: {formatInrFromPaise(cartSummary.subtotalPaise)}
                    </span>
                    <button
                      type="button"
                      disabled={submitting || !selectedTable}
                      onClick={handleSubmitStaffOrder}
                      className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-brand-700 disabled:opacity-50"
                    >
                      <Send className="h-4 w-4" />
                      {submitting ? 'Placing...' : 'Place Order for Table'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </section>
        </div>
      )}

      {customizingItem && (
        <MenuItemCustomizerModal
          item={customizingItem}
          onClose={() => setCustomizingItem(null)}
          onConfirm={handleConfirmCustom}
        />
      )}
    </DashboardShell>
  );
}

