'use client';

import {
  DiningSessionStatus,
  GuestJoinStatus,
  KitchenStatus,
  SessionLifecycleStage,
  StaffRole,
  TableStatus,
  formatInrFromPaise,
} from '@autonex/shared';
import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  AlertTriangle,
  Ban,
  BookmarkCheck,
  Check,
  CheckCircle2,
  ChefHat,
  Clock,
  CreditCard,
  Edit3,
  KeyRound,
  Layers,
  Minus,
  Pencil,
  Play,
  Plus,
  Receipt,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Unlock,
  UserCheck,
  Users,
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
  subscribeWorkspaceSync,
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

type FloorFilterKey = 'ALL' | 'AVAILABLE' | 'OCCUPIED' | 'RESERVED';
type EditableTableStatus = TableStatus.AVAILABLE | TableStatus.OCCUPIED | TableStatus.RESERVED;

const DEFAULT_FLOOR_SECTIONS = [
  'Main Hall',
  'Patio',
  'Window Side',
  'AC Lounge',
  'Rooftop',
  'Family Dining',
];

const FLOOR_STATUS_STYLE: Record<
  'AVAILABLE' | 'OCCUPIED' | 'RESERVED' | 'CHECKOUT_LOCKED' | 'SETTLED',
  {
    cardClass: string;
    barClass: string;
    badgeClass: string;
    label: string;
  }
> = {
  AVAILABLE: {
    cardClass: 'border-emerald-200 hover:border-emerald-300',
    barClass: 'bg-emerald-500',
    badgeClass: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
    label: 'AVAILABLE',
  },
  OCCUPIED: {
    cardClass: 'border-orange-300 ring-1 ring-orange-200/80',
    barClass: 'bg-primary',
    badgeClass: 'bg-orange-50 text-orange-700 ring-1 ring-orange-200',
    label: 'OCCUPIED',
  },
  RESERVED: {
    cardClass: 'border-amber-300 ring-1 ring-amber-200/80',
    barClass: 'bg-amber-500',
    badgeClass: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
    label: 'RESERVED',
  },
  CHECKOUT_LOCKED: {
    cardClass: 'border-purple-300 ring-1 ring-purple-200',
    barClass: 'bg-purple-600',
    badgeClass: 'bg-purple-100 text-purple-800',
    label: 'CHECKOUT LOCKED',
  },
  SETTLED: {
    cardClass: 'border-sky-300 ring-1 ring-sky-200',
    barClass: 'bg-sky-600',
    badgeClass: 'bg-sky-100 text-sky-800',
    label: 'SETTLED • RESET',
  },
};

function getFloorFilterCategory(table: FloorSessionTableDto): 'AVAILABLE' | 'OCCUPIED' | 'RESERVED' {
  if (
    table.activeSession ||
    table.tableStatus === TableStatus.OCCUPIED ||
    table.tableStatus === TableStatus.BILL_REQUESTED
  ) {
    return 'OCCUPIED';
  }
  if (table.tableStatus === TableStatus.RESERVED) {
    return 'RESERVED';
  }
  return 'AVAILABLE';
}

function getCardVisualKey(
  table: FloorSessionTableDto,
  stage: SessionLifecycleStage,
): keyof typeof FLOOR_STATUS_STYLE {
  if (stage === 'CHECKOUT_LOCKED') return 'CHECKOUT_LOCKED';
  if (stage === 'SETTLED') return 'SETTLED';
  return getFloorFilterCategory(table);
}

function validateFloorTableForm(
  rawNumber: string,
  rawCapacity: string,
  existingTables: FloorSessionTableDto[],
  excludeId?: string,
): string | null {
  const num = rawNumber.trim();
  if (!num) return 'Table number is required (e.g. T1, T2, Patio-1).';
  if (num.length > 20) return 'Table number must be 20 characters or fewer.';

  const duplicate = existingTables.find(
    (t) => t.id !== excludeId && t.tableNumber.trim().toLowerCase() === num.toLowerCase(),
  );
  if (duplicate) {
    return `Table "${num}" already exists in this outlet.`;
  }

  const parsedSeats = Number(rawCapacity.trim());
  if (
    !rawCapacity.trim() ||
    !Number.isInteger(parsedSeats) ||
    parsedSeats < 1 ||
    parsedSeats > 50
  ) {
    return 'Seating capacity must be a whole number between 1 and 50.';
  }

  return null;
}

const KOT_STATUS_BADGE: Record<string, string> = {
  NEW: 'bg-amber-100 text-amber-800',
  ACKNOWLEDGED: 'bg-cyan-100 text-cyan-800',
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
  const [statusFilter, setStatusFilter] = useState<FloorFilterKey>('ALL');
  const [sectionFilter, setSectionFilter] = useState<string>('ALL');
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [userRole, setUserRole] = useState<string>(StaffRole.WAITER);
  const [policy, setPolicy] = useState<OutletPolicyState | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null,
  );

  // Add / Edit Table modal state
  const [tableModalOpen, setTableModalOpen] = useState(false);
  const [editingFloorTable, setEditingFloorTable] = useState<FloorSessionTableDto | null>(null);
  const [formNumber, setFormNumber] = useState('');
  const [formLabel, setFormLabel] = useState('');
  const [formCapacity, setFormCapacity] = useState('4');
  const [formSection, setFormSection] = useState('');
  const [formStatus, setFormStatus] = useState<EditableTableStatus>(TableStatus.AVAILABLE);
  const [tableModalError, setTableModalError] = useState<string | null>(null);
  const [savingFloorTable, setSavingFloorTable] = useState(false);

  // Delete Table confirmation modal state
  const [deleteTargetTable, setDeleteTargetTable] = useState<FloorSessionTableDto | null>(null);
  const [deletingTable, setDeletingTable] = useState(false);

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
    const auth = getStoredSession('tenant');
    const role = auth?.user?.role ?? StaffRole.WAITER;
    setUserRole(role);
    void loadFloor();
    void loadPolicyIfPermitted(role);
    return subscribeWorkspaceSync(() => {
      const latestRole = getStoredSession('tenant')?.user?.role ?? role;
      void loadFloor();
      void loadPolicyIfPermitted(latestRole);
    });
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
  const canManageTables =
    userRole === StaffRole.OWNER || userRole === StaffRole.MANAGER;
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

  const openCreateTableModal = () => {
    setTableModalError(null);
    setEditingFloorTable(null);
    setFormNumber('');
    setFormLabel('');
    setFormCapacity('4');
    setFormSection(sectionFilter !== 'ALL' && sectionFilter !== '__UNASSIGNED__' ? sectionFilter : '');
    setFormStatus(TableStatus.AVAILABLE);
    setTableModalOpen(true);
  };

  const openEditTableModal = (table: FloorSessionTableDto) => {
    setTableModalError(null);
    setEditingFloorTable(table);
    setFormNumber(table.tableNumber);
    setFormLabel(table.label ?? '');
    setFormCapacity(String(table.capacity));
    setFormSection(table.floorSection ?? '');
    const initialStatus: EditableTableStatus =
      table.tableStatus === TableStatus.RESERVED
        ? TableStatus.RESERVED
        : table.activeSession ||
            table.tableStatus === TableStatus.OCCUPIED ||
            table.tableStatus === TableStatus.BILL_REQUESTED
          ? TableStatus.OCCUPIED
          : TableStatus.AVAILABLE;
    setFormStatus(initialStatus);
    setTableModalOpen(true);
  };

  const handleSaveFloorTable = async (e: FormEvent) => {
    e.preventDefault();
    setTableModalError(null);
    setFeedback(null);

    const validationError = validateFloorTableForm(
      formNumber,
      formCapacity,
      tables,
      editingFloorTable?.id,
    );
    if (validationError) {
      setTableModalError(validationError);
      return;
    }

    const trimmedNumber = formNumber.trim();
    const trimmedLabel = formLabel.trim();
    const trimmedSection = formSection.trim();
    const seats = Number(formCapacity.trim());

    setSavingFloorTable(true);
    try {
      if (editingFloorTable) {
        const payload: Record<string, unknown> = {
          tableNumber: trimmedNumber,
          label: trimmedLabel || null,
          floorSection: trimmedSection || null,
          capacity: seats,
        };
        if (!editingFloorTable.activeSession) {
          payload.status = formStatus;
        }
        await apiRequest(`/tables/${editingFloorTable.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        setFeedback({
          type: 'success',
          text: `Updated Table "${trimmedNumber}" (${trimmedSection || 'Main Floor'}).`,
        });
      } else {
        await apiRequest('/tables', {
          method: 'POST',
          body: JSON.stringify({
            tableNumber: trimmedNumber,
            label: trimmedLabel || undefined,
            floorSection: trimmedSection || undefined,
            capacity: seats,
            status: formStatus,
          }),
        });
        setFeedback({
          type: 'success',
          text: `Added Table "${trimmedNumber}" with permanent QR code generated automatically.`,
        });
      }
      setTableModalOpen(false);
      setEditingFloorTable(null);
      await loadFloor();
    } catch (err) {
      setTableModalError(err instanceof ApiError ? err.message : 'Failed to save table');
    } finally {
      setSavingFloorTable(false);
    }
  };

  const handleConfirmDeleteTable = async () => {
    if (!deleteTargetTable) return;
    setDeletingTable(true);
    setFeedback(null);
    try {
      await apiRequest(`/tables/${deleteTargetTable.id}`, { method: 'DELETE' });
      const deletedNum = deleteTargetTable.tableNumber;
      setDeleteTargetTable(null);
      setFeedback({
        type: 'success',
        text: `Table "${deletedNum}" was removed from the dining floor.`,
      });
      await loadFloor();
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Failed to delete table',
      });
      setDeleteTargetTable(null);
    } finally {
      setDeletingTable(false);
    }
  };

  const statusCounts = useMemo(() => {
    const counts = {
      AVAILABLE: 0,
      OCCUPIED: 0,
      RESERVED: 0,
    };
    for (const table of tables) {
      counts[getFloorFilterCategory(table)] += 1;
    }
    return counts;
  }, [tables]);

  const sectionNames = useMemo(() => {
    const unique = new Set<string>();
    for (const t of tables) {
      const sec = t.floorSection?.trim();
      if (sec) unique.add(sec);
    }
    return Array.from(unique).sort((a, b) => a.localeCompare(b));
  }, [tables]);

  const hasUnassignedSection = useMemo(
    () => sectionNames.length > 0 && tables.some((t) => !t.floorSection?.trim()),
    [tables, sectionNames],
  );

  const sectionSuggestions = useMemo(
    () => Array.from(new Set([...sectionNames, ...DEFAULT_FLOOR_SECTIONS])),
    [sectionNames],
  );

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
    return tables.filter((t) => {
      if (statusFilter !== 'ALL' && getFloorFilterCategory(t) !== statusFilter) {
        return false;
      }
      if (sectionFilter === '__UNASSIGNED__') {
        return !t.floorSection?.trim();
      }
      if (sectionFilter !== 'ALL') {
        return t.floorSection?.trim() === sectionFilter;
      }
      return true;
    });
  }, [tables, statusFilter, sectionFilter]);

  const groupedSections = useMemo(() => {
    if (sectionFilter !== 'ALL' || sectionNames.length === 0) {
      return [{ sectionName: null as string | null, items: filteredTables }];
    }
    const groups = new Map<string, FloorSessionTableDto[]>();
    for (const t of filteredTables) {
      const key = t.floorSection?.trim() || 'Main Dining Area';
      const bucket = groups.get(key) ?? [];
      bucket.push(t);
      groups.set(key, bucket);
    }
    return Array.from(groups.entries()).map(([sectionName, items]) => ({
      sectionName,
      items,
    }));
  }, [filteredTables, sectionFilter, sectionNames.length]);

  return (
    <DashboardShell
      title="Dining Floor & Live Tables"
      subtitle="Configure floor sections, manage seating status (Available, Occupied, Reserved), track active orders, and oversee dining sessions."
      onOutletChanged={() => {
        setFeedback(null);
        setStatusFilter('ALL');
        setSectionFilter('ALL');
        setLoading(true);
        void loadFloor();
        void loadPolicyIfPermitted(userRole);
      }}
    >
      {/* Top Action Bar, Status Filters & Visual Legend */}
      <div className="mb-4 space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {(
              [
                { id: 'ALL', label: `All (${tables.length})` },
                { id: 'AVAILABLE', label: `Available (${statusCounts.AVAILABLE})` },
                { id: 'OCCUPIED', label: `Occupied (${statusCounts.OCCUPIED})` },
                { id: 'RESERVED', label: `Reserved (${statusCounts.RESERVED})` },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                data-testid={`floor-filter-${tab.id.toLowerCase()}`}
                onClick={() => setStatusFilter(tab.id)}
                className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                  statusFilter === tab.id
                    ? 'bg-slate-900 text-white shadow-sm'
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
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </button>

            {canManageTables && (
              <button
                type="button"
                data-testid="floor-add-table-btn"
                onClick={openCreateTableModal}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-bold text-primary-foreground shadow-sm transition hover:bg-primary/90"
              >
                <Plus className="h-4 w-4" /> Add Table
              </button>
            )}
          </div>
        </div>

        {/* Section Filter Pills + Visual Legend */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3 text-xs">
          {sectionNames.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 inline-flex items-center gap-1 font-semibold text-slate-500">
                <Layers className="h-3.5 w-3.5" /> Floor / Section:
              </span>
              <button
                type="button"
                onClick={() => setSectionFilter('ALL')}
                className={`rounded-full px-2.5 py-1 font-semibold transition ${
                  sectionFilter === 'ALL'
                    ? 'bg-orange-100 text-orange-800 ring-1 ring-orange-200'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                All Sections
              </button>
              {sectionNames.map((sec) => (
                <button
                  key={sec}
                  type="button"
                  onClick={() => setSectionFilter(sec)}
                  className={`rounded-full px-2.5 py-1 font-semibold transition ${
                    sectionFilter === sec
                      ? 'bg-orange-100 text-orange-800 ring-1 ring-orange-200'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {sec}
                </button>
              ))}
              {hasUnassignedSection && (
                <button
                  type="button"
                  onClick={() => setSectionFilter('__UNASSIGNED__')}
                  className={`rounded-full px-2.5 py-1 font-semibold transition ${
                    sectionFilter === '__UNASSIGNED__'
                      ? 'bg-orange-100 text-orange-800 ring-1 ring-orange-200'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  Unassigned
                </button>
              )}
            </div>
          ) : (
            <span className="text-slate-500">
              Visual live floor plan &bull; Tip: assign sections like Patio or Main Hall to group tables
            </span>
          )}

          <div className="flex flex-wrap items-center gap-3 text-[11px] font-semibold text-slate-600">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" /> Available
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-primary" /> Occupied
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-amber-500" /> Reserved
            </span>
          </div>
        </div>
      </div>

      {/* Owner Quick QR Join Security Policy Toggles */}
      {isOwner && policy && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs">
          <div className="flex items-center gap-2 font-semibold text-slate-700">
            <ShieldCheck className="h-4 w-4 text-orange-600" />
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
                        method: 'PATCH',
                        body: JSON.stringify({ status: KitchenStatus.SERVED }),
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

      {/* Floor Table Grid / Visual Layout */}
      {loading ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          Loading live dining floor...
        </div>
      ) : tables.length === 0 ? (
        <div
          data-testid="floor-empty-state"
          className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center shadow-sm"
        >
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-orange-50 text-orange-600">
            <Utensils className="h-6 w-6" />
          </div>
          <h3 className="mt-4 text-base font-bold text-slate-900">
            No tables on your dining floor yet
          </h3>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-slate-500">
            Add your restaurant tables with floor sections and seating capacities to manage
            reservations, seat guests, and track live orders.
          </p>
          {canManageTables && (
            <button
              type="button"
              data-testid="floor-empty-add-table-btn"
              onClick={openCreateTableModal}
              className="mt-5 inline-flex h-10 items-center gap-1.5 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" /> Add Table
            </button>
          )}
        </div>
      ) : filteredTables.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          No tables match the selected status or section filter.
        </div>
      ) : (
        <div className="space-y-6">
          {groupedSections.map((group) => (
            <section key={group.sectionName ?? '__all__'} className="space-y-3">
              {group.sectionName && (
                <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                  <div className="flex items-center gap-2">
                    <Layers className="h-4 w-4 text-orange-600" />
                    <h2 className="text-sm font-bold uppercase tracking-wide text-slate-800">
                      {group.sectionName}
                    </h2>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
                      {group.items.length}
                    </span>
                  </div>
                </div>
              )}

              <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
                {group.items.map((table) => {
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
                  const visualKey = getCardVisualKey(table, stage);
                  const visualStyle = FLOOR_STATUS_STYLE[visualKey];
                  const activeOrdersCount = session?.balance?.activeOrdersCount ?? 0;

                  return (
                    <article
                      key={table.id}
                      data-testid={`floor-table-card-${table.tableNumber}`}
                      className={`relative flex flex-col justify-between overflow-hidden rounded-2xl border bg-white p-5 shadow-sm transition ${visualStyle.cardClass}`}
                    >
                      <span
                        className={`absolute inset-x-0 top-0 h-1 ${visualStyle.barClass}`}
                        aria-hidden="true"
                      />

                      <div>
                        {/* Card Header */}
                        <div className="flex items-start justify-between gap-2 pt-0.5">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <h2 className="text-lg font-extrabold text-slate-900">
                                Table {table.tableNumber}
                              </h2>
                              {table.floorSection && (
                                <span className="rounded-md bg-orange-50 px-2 py-0.5 text-[11px] font-semibold text-orange-700">
                                  {table.floorSection}
                                </span>
                              )}
                            </div>
                            <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                              {table.label && (
                                <span className="truncate font-medium text-slate-700">
                                  {table.label}
                                </span>
                              )}
                              {table.label && <span aria-hidden="true">•</span>}
                              <span className="inline-flex items-center gap-1">
                                <Users className="h-3.5 w-3.5 text-slate-400" />
                                {table.capacity} {table.capacity === 1 ? 'seat' : 'seats'}
                              </span>
                            </p>
                          </div>

                          <div className="flex shrink-0 items-center gap-1.5">
                            <span
                              className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${visualStyle.badgeClass}`}
                            >
                              {visualStyle.label}
                            </span>

                            {canManageTables && (
                              <>
                                <button
                                  type="button"
                                  aria-label={`Edit Table ${table.tableNumber}`}
                                  data-testid={`floor-edit-table-${table.tableNumber}`}
                                  onClick={() => openEditTableModal(table)}
                                  className="rounded-lg border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  aria-label={`Delete Table ${table.tableNumber}`}
                                  data-testid={`floor-delete-table-${table.tableNumber}`}
                                  onClick={() => setDeleteTargetTable(table)}
                                  className="rounded-lg border border-rose-200 p-1.5 text-rose-600 hover:bg-rose-50"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </>
                            )}
                          </div>
                        </div>

                        {!session ? (
                          <div
                            className={`mt-5 rounded-xl p-4 text-center ${
                              visualKey === 'RESERVED'
                                ? 'border border-amber-200 bg-amber-50/70'
                                : visualKey === 'OCCUPIED'
                                  ? 'border border-orange-200 bg-orange-50/60'
                                  : 'bg-slate-50'
                            }`}
                          >
                            {visualKey === 'RESERVED' ? (
                              <BookmarkCheck className="mx-auto h-7 w-7 text-amber-600" />
                            ) : (
                              <Utensils
                                className={`mx-auto h-7 w-7 ${
                                  visualKey === 'OCCUPIED' ? 'text-orange-600' : 'text-slate-400'
                                }`}
                              />
                            )}
                            <p className="mt-2 text-xs text-slate-600">
                              {visualKey === 'RESERVED'
                                ? 'Table is currently reserved for an upcoming booking.'
                                : visualKey === 'OCCUPIED'
                                  ? 'Marked occupied without an active QR dining session yet.'
                                  : 'Clean & available. Seat a party to generate a rotating QR join PIN.'}
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
                              className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-60"
                            >
                              <Play className="h-4 w-4" />
                              {visualKey === 'RESERVED'
                                ? 'Seat Reserved Party'
                                : 'Seat Party & Open Table'}
                            </button>

                            {canManageTables && (
                              <div className="mt-2.5 flex flex-wrap justify-center gap-2">
                                {visualKey !== 'RESERVED' ? (
                                  <button
                                    type="button"
                                    disabled={busyKey === `status-${table.id}`}
                                    onClick={() =>
                                      void runAction(`status-${table.id}`, async () => {
                                        await apiRequest(`/tables/${table.id}`, {
                                          method: 'PATCH',
                                          body: JSON.stringify({ status: TableStatus.RESERVED }),
                                        });
                                        setFeedback({
                                          type: 'success',
                                          text: `Table ${table.tableNumber} marked as Reserved.`,
                                        });
                                      })
                                    }
                                    className="inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-50"
                                  >
                                    <BookmarkCheck className="h-3 w-3" /> Reserve Table
                                  </button>
                                ) : null}
                                {visualKey !== 'AVAILABLE' ? (
                                  <button
                                    type="button"
                                    disabled={busyKey === `status-${table.id}`}
                                    onClick={() =>
                                      void runAction(`status-${table.id}`, async () => {
                                        await apiRequest(`/tables/${table.id}`, {
                                          method: 'PATCH',
                                          body: JSON.stringify({ status: TableStatus.AVAILABLE }),
                                        });
                                        setFeedback({
                                          type: 'success',
                                          text: `Table ${table.tableNumber} marked Available.`,
                                        });
                                      })
                                    }
                                    className="inline-flex items-center gap-1 rounded-lg border border-emerald-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-50"
                                  >
                                    <Check className="h-3 w-3" /> Mark Available
                                  </button>
                                ) : null}
                              </div>
                            )}
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
                              <UserCheck className="h-3.5 w-3.5 text-orange-600" />
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
                                  order.kitchenStatus === KitchenStatus.ACKNOWLEDGED ||
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
                            className="inline-flex flex-1 items-center justify-center gap-1 rounded-xl bg-primary px-3 py-2 text-xs font-bold text-primary-foreground hover:bg-primary/90"
                          >
                            <Receipt className="h-3.5 w-3.5" /> Generate Bill
                          </button>
                        ) : (
                          <Link
                            href={`/dashboard/billing?billId=${encodeURIComponent(session.activeBill.id)}`}
                            className="inline-flex flex-1 items-center justify-center gap-1 rounded-xl bg-primary px-3 py-2 text-xs font-bold text-primary-foreground hover:bg-primary/90"
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
            </section>
          ))}
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
                    className="flex-1 rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    {savingEdit ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Add / Edit Table Modal */}
      {tableModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          role="dialog"
          aria-modal="true"
          data-testid="floor-table-modal"
        >
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h2 className="text-lg font-bold text-slate-900">
                  {editingFloorTable
                    ? `Edit Table ${editingFloorTable.tableNumber}`
                    : 'Add New Table'}
                </h2>
                <p className="text-xs text-slate-500">
                  {editingFloorTable
                    ? 'Update table name, seating capacity, floor section, or availability.'
                    : 'Create a dining floor table with an automatic permanent QR code.'}
                </p>
              </div>
              <button
                type="button"
                aria-label="Close table modal"
                onClick={() => {
                  setTableModalOpen(false);
                  setEditingFloorTable(null);
                }}
              >
                <X className="h-5 w-5 text-slate-400 hover:text-slate-600" />
              </button>
            </div>

            {tableModalError && (
              <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">
                {tableModalError}
              </div>
            )}

            <datalist id="floor-section-suggestions">
              {sectionSuggestions.map((sec) => (
                <option key={sec} value={sec} />
              ))}
            </datalist>

            <form onSubmit={handleSaveFloorTable} noValidate className="mt-4 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="floor-form-number"
                    className="block text-xs font-semibold uppercase text-slate-600"
                  >
                    Table Number
                  </label>
                  <input
                    id="floor-form-number"
                    value={formNumber}
                    onChange={(e) => setFormNumber(e.target.value)}
                    placeholder="e.g. T7"
                    maxLength={20}
                    className="mt-1 h-10 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                  />
                </div>
                <div>
                  <label
                    htmlFor="floor-form-capacity"
                    className="block text-xs font-semibold uppercase text-slate-600"
                  >
                    Seating Capacity
                  </label>
                  <input
                    id="floor-form-capacity"
                    type="number"
                    min={1}
                    max={50}
                    step={1}
                    value={formCapacity}
                    onChange={(e) => setFormCapacity(e.target.value)}
                    className="mt-1 h-10 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="floor-form-label"
                  className="block text-xs font-semibold uppercase text-slate-600"
                >
                  Table Name / Label
                </label>
                <input
                  id="floor-form-label"
                  value={formLabel}
                  onChange={(e) => setFormLabel(e.target.value)}
                  placeholder="e.g. Window Booth, Garden Corner"
                  maxLength={60}
                  className="mt-1 h-10 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                />
              </div>

              <div>
                <label
                  htmlFor="floor-form-section"
                  className="block text-xs font-semibold uppercase text-slate-600"
                >
                  Floor / Section
                </label>
                <input
                  id="floor-form-section"
                  list="floor-section-suggestions"
                  value={formSection}
                  onChange={(e) => setFormSection(e.target.value)}
                  placeholder="e.g. Main Hall, Patio, Rooftop"
                  maxLength={60}
                  className="mt-1 h-10 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                />
              </div>

              <div>
                <label
                  htmlFor="floor-form-status"
                  className="block text-xs font-semibold uppercase text-slate-600"
                >
                  Table Status
                </label>
                {editingFloorTable?.activeSession ? (
                  <div className="mt-1 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2.5 text-xs font-medium text-orange-800">
                    Occupied (Live Dining Session open). Close and reset the session on the card to
                    return this table to Available or Reserved.
                  </div>
                ) : (
                  <select
                    id="floor-form-status"
                    value={formStatus}
                    onChange={(e) => setFormStatus(e.target.value as EditableTableStatus)}
                    className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                  >
                    <option value={TableStatus.AVAILABLE}>Available</option>
                    <option value={TableStatus.OCCUPIED}>Occupied</option>
                    <option value={TableStatus.RESERVED}>Reserved</option>
                  </select>
                )}
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setTableModalOpen(false);
                    setEditingFloorTable(null);
                  }}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingFloorTable}
                  data-testid="floor-save-table-btn"
                  className="rounded-lg bg-primary px-5 py-2 text-sm font-bold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-60"
                >
                  {savingFloorTable
                    ? 'Saving...'
                    : editingFloorTable
                      ? 'Save Changes'
                      : 'Create Table'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Table Confirmation Modal */}
      {deleteTargetTable && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          role="dialog"
          aria-modal="true"
          data-testid="floor-delete-modal"
        >
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-50 text-rose-600">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  Delete Table {deleteTargetTable.tableNumber}?
                </h3>
                <p className="mt-1 text-sm text-slate-600">
                  This permanently deletes Table {deleteTargetTable.tableNumber} and revokes its
                  printable QR code. Tables with live sessions or historical orders cannot be
                  deleted permanently.
                </p>
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                disabled={deletingTable}
                onClick={() => setDeleteTargetTable(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deletingTable}
                data-testid="floor-confirm-delete-btn"
                onClick={() => void handleConfirmDeleteTable()}
                className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
              >
                {deletingTable ? 'Deleting...' : 'Delete Table'}
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardShell>
  );
}

