'use client';

import {
  DietaryType,
  KdsBoardPayload,
  KdsEventEnvelope,
  KdsTicketPayload,
  KitchenStation,
  KitchenStatus,
  OrderSource,
  StaffRole,
  TenantStatus,
  formatInrFromPaise,
} from '@autonex/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  AlertTriangle,
  ArrowLeft,
  Bell,
  BellRing,
  Check,
  CheckCheck,
  ChefHat,
  Clock,
  Coffee,
  Cookie,
  Eye,
  Flame,
  IceCream,
  Languages,
  Printer,
  RefreshCw,
  ShieldAlert,
  User,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  X,
  XCircle,
} from 'lucide-react';
import {
  API_BASE_URL,
  ApiError,
  AuthSession,
  SubscriptionSummaryDto,
  TenantCurrentDto,
  apiRequest,
  ensureFreshAccessToken,
  getStoredSession,
  subscribeRealtimeStream,
} from '@/lib/api-client';
import { KDS_TRANSLATIONS, KdsLocale, KdsTranslations } from '@/lib/kds-i18n';
import {
  KdsConnectionMode,
  KdsSyncState,
  applyKdsEventToState,
  applySingleTicketUpdateToState,
  createInitialKdsSyncState,
  playKdsChime,
  reconcileKdsPollResponse,
} from '@/lib/kds-sync';

type FilterTab =
  | 'ALL'
  | KitchenStatus.NEW
  | KitchenStatus.ACKNOWLEDGED
  | KitchenStatus.PREPARING
  | KitchenStatus.READY
  | KitchenStatus.SERVED;

type StationFilter = 'ALL' | KitchenStation;

type BlockReason = 'PENDING_APPROVAL' | 'SUSPENDED' | 'ROLE_OR_OUTLET';

interface AccessPauseDetails {
  reason: BlockReason;
  tenantStatus: string;
  restaurantName: string | null;
  subscriptionStatus: string | null;
  trialDaysRemaining: number | null;
}

const WS_BASE_URL =
  process.env.NEXT_PUBLIC_WS_URL || API_BASE_URL.replace(/\/api\/v1\/?$/, '');

const LOCALE_STORAGE_KEY = 'autonex_kds_locale';

const DELAY_WARN_MIN = 8;
const DELAY_URGENT_MIN = 15;

function getStationLabel(station: KitchenStation | string, t: KdsTranslations): string {
  switch (station) {
    case KitchenStation.BAR:
      return t.stationBar;
    case KitchenStation.BAKERY:
      return t.stationBakery;
    case KitchenStation.DESSERTS:
      return t.stationDesserts;
    case KitchenStation.MAIN_KITCHEN:
    default:
      return t.stationMainKitchen;
  }
}

function getStationIcon(station: KitchenStation | string) {
  switch (station) {
    case KitchenStation.BAR:
      return Coffee;
    case KitchenStation.BAKERY:
      return Cookie;
    case KitchenStation.DESSERTS:
      return IceCream;
    case KitchenStation.MAIN_KITCHEN:
    default:
      return Flame;
  }
}

function getTicketStations(ticket: KdsTicketPayload): KitchenStation[] {
  if (ticket.stations && ticket.stations.length > 0) {
    return ticket.stations;
  }
  const set = new Set<KitchenStation>();
  for (const item of ticket.items) {
    set.add(item.kitchenStation ?? KitchenStation.MAIN_KITCHEN);
  }
  if (set.size === 0) {
    set.add(KitchenStation.MAIN_KITCHEN);
  }
  return Array.from(set);
}

function getEstimatedPrepMinutes(ticket: KdsTicketPayload): number | null {
  let maxPrep: number | null = null;
  for (const item of ticket.items) {
    if (item.status === 'CANCELLED' || item.quantity <= 0) continue;
    if (typeof item.prepTimeMinutes === 'number' && item.prepTimeMinutes > 0) {
      maxPrep = maxPrep === null ? item.prepTimeMinutes : Math.max(maxPrep, item.prepTimeMinutes);
    }
  }
  return maxPrep;
}

function formatClockTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '--:--';
  }
}

function computeDaysLeft(targetIso?: string | null): number | null {
  if (!targetIso) return null;
  const ms = new Date(targetIso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

function formatPrepStopwatch(createdAtIso: string, nowMs: number): {
  label: string;
  elapsedMinutes: number;
} {
  const diffSec = Math.max(0, Math.floor((nowMs - new Date(createdAtIso).getTime()) / 1000));
  const mins = Math.floor(diffSec / 60);
  const secs = diffSec % 60;
  return {
    label: `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`,
    elapsedMinutes: mins,
  };
}

function KdsDietaryDot({ type }: { type: DietaryType | string }) {
  if (type === DietaryType.VEG) {
    return (
      <span
        title="Veg"
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-emerald-400"
      >
        <span className="h-2 w-2 rounded-full bg-emerald-400" />
      </span>
    );
  }
  if (type === DietaryType.NON_VEG) {
    return (
      <span
        title="Non-Veg"
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-rose-400"
      >
        <span className="h-2 w-2 rounded-full bg-rose-400" />
      </span>
    );
  }
  return (
    <span
      title="Egg"
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-amber-400"
    >
      <span className="h-2 w-2 rounded-full bg-amber-400" />
    </span>
  );
}

function getStatusBadgeStyle(status: KitchenStatus | string, t: KdsTranslations) {
  switch (status) {
    case KitchenStatus.NEW:
      return {
        label: t.statusNew,
        badgeClass: 'bg-orange-500 text-slate-950 font-extrabold',
        cardClass: 'border-orange-500/80 bg-slate-900 shadow-lg shadow-orange-950/30',
        stripeClass: 'bg-orange-500',
        headerBg: 'bg-orange-500/10 border-b border-orange-500/20',
      };
    case KitchenStatus.ACKNOWLEDGED:
      return {
        label: t.statusAcknowledged,
        badgeClass: 'bg-cyan-400 text-slate-950 font-extrabold',
        cardClass: 'border-cyan-500/70 bg-slate-900',
        stripeClass: 'bg-cyan-400',
        headerBg: 'bg-cyan-500/10 border-b border-cyan-500/20',
      };
    case KitchenStatus.PREPARING:
      return {
        label: t.statusPreparing,
        badgeClass: 'bg-sky-400 text-slate-950 font-extrabold',
        cardClass: 'border-sky-500/70 bg-slate-900',
        stripeClass: 'bg-sky-400',
        headerBg: 'bg-sky-500/10 border-b border-sky-500/20',
      };
    case KitchenStatus.READY:
      return {
        label: t.statusReady,
        badgeClass: 'bg-emerald-400 text-slate-950 font-extrabold',
        cardClass: 'border-emerald-500/75 bg-slate-900',
        stripeClass: 'bg-emerald-400',
        headerBg: 'bg-emerald-500/10 border-b border-emerald-500/20',
      };
    case KitchenStatus.SERVED:
      return {
        label: t.statusServed,
        badgeClass: 'bg-slate-600 text-slate-100 font-bold',
        cardClass: 'border-slate-700 bg-slate-900/75 opacity-85',
        stripeClass: 'bg-slate-500',
        headerBg: 'bg-slate-800/70 border-b border-slate-800',
      };
    default:
      return {
        label: status,
        badgeClass: 'bg-rose-500 text-white font-bold',
        cardClass: 'border-rose-700/60 bg-slate-900/70 opacity-75',
        stripeClass: 'bg-rose-500',
        headerBg: 'bg-rose-950/30 border-b border-rose-800/40',
      };
  }
}

export default function KdsBoardPage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthSession | null>(null);
  const [ready, setReady] = useState(false);

  const [locale, setLocale] = useState<KdsLocale>('en');
  const t = KDS_TRANSLATIONS[locale];

  const [syncState, setSyncState] = useState<KdsSyncState>(() => createInitialKdsSyncState());
  const syncStateRef = useRef<KdsSyncState>(syncState);
  syncStateRef.current = syncState;
  const tickets = useMemo(
    () => Array.from(syncState.ticketsById.values()),
    [syncState.ticketsById],
  );
  const initialPollDoneRef = useRef(false);

  const [connectionMode, setConnectionMode] = useState<KdsConnectionMode>('CONNECTING');
  const connectionModeRef = useRef<KdsConnectionMode>('CONNECTING');
  connectionModeRef.current = connectionMode;

  const [activeFilter, setActiveFilter] = useState<FilterTab>('ALL');
  const [activeStation, setActiveStation] = useState<StationFilter>('ALL');
  const [includeServed, setIncludeServed] = useState(false);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const [soundEnabled, setSoundEnabled] = useState(true);
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const soundEnabledRef = useRef(true);
  soundEnabledRef.current = soundEnabled;
  const audioCtxRef = useRef<AudioContext | null>(null);

  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [detailTicket, setDetailTicket] = useState<KdsTicketPayload | null>(null);
  const [printingTicket, setPrintingTicket] = useState<KdsTicketPayload | null>(null);
  const [banner, setBanner] = useState<{ type: 'info' | 'success' | 'error'; text: string } | null>(
    null,
  );

  const [accessPause, setAccessPause] = useState<AccessPauseDetails | null>(null);
  const [checkingAccess, setCheckingAccess] = useState(false);
  const [subscriptionNotice, setSubscriptionNotice] = useState<string | null>(null);

  const wsDisconnectedOnceRef = useRef(false);
  const kdsVerifiedRef = useRef(false);
  const refreshedAfter403Ref = useRef(false);
  const consecutivePollErrorsRef = useRef(0);
  const socketRef = useRef<Socket | null>(null);
  const probeSocketRef = useRef<(() => void) | null>(null);
  const reconnectKeyCounterRef = useRef(0);
  const [streamReconnectKey, setStreamReconnectKey] = useState(0);

  // Restore saved locale preference on mount
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (saved === 'en' || saved === 'hi' || saved === 'gu') {
      setLocale(saved);
    }
  }, []);

  const handleLocaleChange = (next: KdsLocale) => {
    setLocale(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
    }
  };

  // Unlock Web Audio context cleanly on user interaction
  const unlockAudio = useCallback(() => {
    if (typeof window === 'undefined') return;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioCtx();
    }
    if (audioCtxRef.current.state === 'suspended') {
      void audioCtxRef.current.resume().then(() => {
        setAudioUnlocked(true);
      });
    } else if (audioCtxRef.current.state === 'running') {
      setAudioUnlocked(true);
    }
  }, []);

  const triggerChime = useCallback(() => {
    if (!soundEnabledRef.current) return;
    unlockAudio();
    if (audioCtxRef.current) {
      playKdsChime(audioCtxRef.current);
    }
  }, [unlockAudio]);

  // Auth gate + sync listener for workspace/outlet switches
  useEffect(() => {
    const syncSession = () => {
      const stored = getStoredSession();
      if (!stored?.accessToken) {
        router.replace('/login');
        return;
      }
      setSession(stored);
      setReady(true);
    };

    syncSession();

    const handleWorkspaceUpdate = () => {
      const updated = getStoredSession();
      if (!updated?.accessToken) {
        router.replace('/login');
        return;
      }
      setSession(updated);
      setSyncState(createInitialKdsSyncState());
      initialPollDoneRef.current = false;
      setAccessPause(null);
      refreshedAfter403Ref.current = false;
      kdsVerifiedRef.current = false;
      reconnectKeyCounterRef.current += 1;
      setStreamReconnectKey(reconnectKeyCounterRef.current);
    };

    window.addEventListener('autonex:workspace-updated', handleWorkspaceUpdate);
    const unsubSse = subscribeRealtimeStream('tenant', (evt) => {
      if (
        evt.type === 'restaurant.approved' ||
        evt.type === 'restaurant.reactivated' ||
        evt.type === 'restaurant.suspended' ||
        evt.type === 'restaurant.rejected'
      ) {
        void ensureFreshAccessToken('tenant').finally(() => {
          handleWorkspaceUpdate();
        });
      }
    });
    return () => {
      window.removeEventListener('autonex:workspace-updated', handleWorkspaceUpdate);
      unsubSse();
    };
  }, [router]);

  // Fetch non-blocking tenant/subscription status info when session is ready
  useEffect(() => {
    if (!ready || !session) return;
    let active = true;
    void (async () => {
      try {
        const sub = await apiRequest<SubscriptionSummaryDto>('/subscriptions/current');
        if (!active) return;
        if (sub.status === 'GRACE' || session.tenant?.status === TenantStatus.LOCKED) {
          const graceDaysLeft = computeDaysLeft(sub.graceEndsAt);
          setSubscriptionNotice(
            sub.status === 'GRACE'
              ? `Subscription in grace period${graceDaysLeft !== null ? ` (${graceDaysLeft} day(s) left)` : ''}. KDS remains operational.`
              : null,
          );
        } else {
          setSubscriptionNotice(null);
        }
      } catch {
        // Non-owner roles or unconfigured plans ignore silently
      }
    })();
    return () => {
      active = false;
    };
  }, [ready, session]);

  // Live 1-second timer tick for preparation timers and delayed highlights
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Inspect DB status & attempt recovery when KDS returns 403 / stream block
  const inspectAndResolveAccessPause = useCallback(async () => {
    setCheckingAccess(true);
    try {
      const freshToken = await ensureFreshAccessToken();
      const updatedSession = getStoredSession();
      if (updatedSession) {
        setSession(updatedSession);
      }

      let dbTenant: TenantCurrentDto | null = null;
      let dbSub: SubscriptionSummaryDto | null = null;
      try {
        dbTenant = await apiRequest<TenantCurrentDto>('/tenancy/current');
      } catch {
        // Ignore if role cannot access /tenancy/current
      }
      try {
        dbSub = await apiRequest<SubscriptionSummaryDto>('/subscriptions/current');
      } catch {
        // Ignore if role cannot access /subscriptions/current
      }

      const resolvedStatus =
        dbTenant?.status ||
        updatedSession?.tenant?.status ||
        updatedSession?.user?.tenantStatus ||
        TenantStatus.PENDING_APPROVAL;

      const role = updatedSession?.user?.role || session?.user?.role || '';
      const hasOutlet = Boolean(updatedSession?.user?.outletId || updatedSession?.outlet?.id);
      const roleAllowed = [
        StaffRole.OWNER,
        StaffRole.MANAGER,
        StaffRole.KITCHEN,
        StaffRole.CASHIER,
        StaffRole.WAITER,
      ].includes(role as StaffRole);

      // If DB confirms tenant is approved & role/outlet is valid, recover automatically!
      if (
        freshToken &&
        hasOutlet &&
        roleAllowed &&
        resolvedStatus !== TenantStatus.PENDING_APPROVAL &&
        resolvedStatus !== TenantStatus.SUSPENDED
      ) {
        setAccessPause(null);
        kdsVerifiedRef.current = false;
        wsDisconnectedOnceRef.current = false;
        setConnectionMode('CONNECTING');
        reconnectKeyCounterRef.current += 1;
        setStreamReconnectKey(reconnectKeyCounterRef.current);
        return;
      }

      const reason: BlockReason =
        resolvedStatus === TenantStatus.PENDING_APPROVAL
          ? 'PENDING_APPROVAL'
          : resolvedStatus === TenantStatus.SUSPENDED
            ? 'SUSPENDED'
            : 'ROLE_OR_OUTLET';

      setAccessPause({
        reason,
        tenantStatus: String(resolvedStatus),
        restaurantName: dbTenant?.name ?? updatedSession?.tenant?.name ?? null,
        subscriptionStatus: dbSub?.status ? String(dbSub.status) : null,
        trialDaysRemaining: computeDaysLeft(dbSub?.trialEndsAt),
      });
      setConnectionMode('BLOCKED');
    } finally {
      setCheckingAccess(false);
    }
  }, [session?.user?.role]);

  // Incremental / snapshot REST polling & reconciliation
  const pollBoard = useCallback(
    async (fullSnapshot = false) => {
      if (connectionModeRef.current === 'BLOCKED') return;
      try {
        const params = new URLSearchParams();
        if (includeServed) params.set('includeServed', 'true');
        if (!fullSnapshot && syncStateRef.current.syncCursor && !includeServed) {
          params.set('since', syncStateRef.current.syncCursor);
        }
        const qs = params.toString();
        const payload = await apiRequest<KdsBoardPayload>(
          `/kds/orders${qs ? `?${qs}` : ''}`,
        );

        consecutivePollErrorsRef.current = 0;
        kdsVerifiedRef.current = true;
        setAccessPause(null);

        const reconciled = reconcileKdsPollResponse(syncStateRef.current, payload, {
          includeServed,
          notifyNewArrivals: initialPollDoneRef.current,
        });
        initialPollDoneRef.current = true;

        if (reconciled.newlyArrivedUnackedCount > 0) {
          triggerChime();
        }

        setSyncState(reconciled.nextState);
        if (!socketRef.current?.connected) {
          setConnectionMode((prev) => (prev === 'BLOCKED' ? 'BLOCKED' : 'POLLING_FALLBACK'));
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) {
          if (!refreshedAfter403Ref.current) {
            refreshedAfter403Ref.current = true;
            await inspectAndResolveAccessPause();
            return;
          }
          await inspectAndResolveAccessPause();
          return;
        }
        if (err instanceof ApiError && err.status === 401) {
          return;
        }
        consecutivePollErrorsRef.current += 1;
        if (consecutivePollErrorsRef.current >= 2) {
          setConnectionMode((prev) => (prev === 'BLOCKED' ? 'BLOCKED' : 'OFFLINE'));
        }
      }
    },
    [includeServed, inspectAndResolveAccessPause, triggerChime],
  );

  // Socket.IO realtime `/kds` listener + clean reconnect lifecycle
  useEffect(() => {
    if (!ready || !session?.accessToken) return;

    const handleDisconnectOrError = () => {
      if (connectionModeRef.current === 'BLOCKED') return;
      if (consecutivePollErrorsRef.current >= 2) {
        setConnectionMode('OFFLINE');
      } else {
        setConnectionMode(
          wsDisconnectedOnceRef.current || !kdsVerifiedRef.current
            ? 'POLLING_FALLBACK'
            : 'CONNECTING',
        );
      }
    };

    const socket = io(`${WS_BASE_URL}/kds`, {
      transports: ['websocket', 'polling'],
      auth: { token: session.accessToken },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1500,
      reconnectionDelayMax: 8000,
    });
    socketRef.current = socket;

    const attachFreshTokenToHandshake = async () => {
      const nextToken = await ensureFreshAccessToken();
      if (nextToken) {
        socket.auth = { token: nextToken };
      }
    };
    socket.io.on('reconnect_attempt', () => {
      void attachFreshTokenToHandshake();
    });

    socket.on('connect', () => {
      kdsVerifiedRef.current = true;
      consecutivePollErrorsRef.current = 0;
      setAccessPause(null);
      setConnectionMode('LIVE_WS');
      void pollBoard(true);
    });

    socket.on('disconnect', () => {
      wsDisconnectedOnceRef.current = true;
      handleDisconnectOrError();
      void pollBoard(false);
    });

    socket.on('connect_error', () => {
      wsDisconnectedOnceRef.current = true;
      handleDisconnectOrError();
    });

    socket.on('kds:error', (payload: { code?: string; message?: string }) => {
      if (
        payload?.code === 'FORBIDDEN' ||
        payload?.code === 'TENANT_NOT_APPROVED' ||
        payload?.code === 'TENANT_SUSPENDED'
      ) {
        if (!refreshedAfter403Ref.current) {
          refreshedAfter403Ref.current = true;
          void inspectAndResolveAccessPause().then(() => {
            const latest = getStoredSession();
            if (latest?.accessToken && !socket.connected) {
              socket.auth = { token: latest.accessToken };
            }
          });
          return;
        }
        socket.disconnect();
        void inspectAndResolveAccessPause();
      } else if (payload?.code === 'UNAUTHORIZED') {
        void attachFreshTokenToHandshake();
      }
    });

    socket.on('kds.event', (envelope: KdsEventEnvelope) => {
      const outcome = applyKdsEventToState(syncStateRef.current, envelope);
      setSyncState(outcome.nextState);
      if (outcome.isNewUnackedArrival) {
        triggerChime();
      }
    });

    probeSocketRef.current = () => {
      if (!socket.connected && connectionModeRef.current !== 'BLOCKED') {
        void attachFreshTokenToHandshake().finally(() => {
          socket.connect();
        });
      }
    };

    const handleOnline = () => {
      setConnectionMode((prev) => (prev === 'BLOCKED' ? 'BLOCKED' : 'CONNECTING'));
      void pollBoard(true);
      probeSocketRef.current?.();
    };
    const handleOffline = () => {
      setConnectionMode((prev) => (prev === 'BLOCKED' ? 'BLOCKED' : 'OFFLINE'));
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    void pollBoard(true);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      probeSocketRef.current = null;
      socket.disconnect();
      socketRef.current = null;
    };
  }, [
    ready,
    session?.accessToken,
    streamReconnectKey,
    inspectAndResolveAccessPause,
    pollBoard,
    triggerChime,
  ]);

  // Adaptive polling interval: 4s when WS is offline/fallback, 15s consistency sync when WS is live
  useEffect(() => {
    if (!ready) return;
    const intervalMs = connectionMode === 'LIVE_WS' ? 15000 : 4000;
    const id = window.setInterval(() => {
      if (connectionMode === 'BLOCKED') return;
      void pollBoard(false);
      if (
        (connectionMode === 'OFFLINE' || connectionMode === 'CONNECTING') &&
        probeSocketRef.current
      ) {
        probeSocketRef.current();
      }
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [ready, connectionMode, pollBoard]);

  // Periodic reminder chime while unacknowledged NEW tickets sit on the board
  const unacknowledgedCount = useMemo(
    () =>
      tickets.filter(
        (tk) => tk.kitchenStatus === KitchenStatus.NEW && !tk.acknowledgedAt,
      ).length,
    [tickets],
  );

  useEffect(() => {
    if (!soundEnabled || unacknowledgedCount === 0) return;
    const id = window.setInterval(() => {
      if (soundEnabledRef.current && audioCtxRef.current?.state === 'running') {
        playKdsChime(audioCtxRef.current);
      }
    }, 20000);
    return () => window.clearInterval(id);
  }, [soundEnabled, unacknowledgedCount]);

  // Keep detail modal ticket in sync with live board state
  const liveDetailTicket = useMemo(() => {
    if (!detailTicket) return null;
    return syncState.ticketsById.get(detailTicket.id) ?? detailTicket;
  }, [detailTicket, syncState.ticketsById]);

  // Station counts across open orders (or matching served if viewing served)
  const stationCounts = useMemo(() => {
    const counts: Record<StationFilter, number> = {
      ALL: 0,
      [KitchenStation.MAIN_KITCHEN]: 0,
      [KitchenStation.BAR]: 0,
      [KitchenStation.BAKERY]: 0,
      [KitchenStation.DESSERTS]: 0,
    };

    for (const tk of tickets) {
      const inActiveBucket =
        activeFilter === KitchenStatus.SERVED
          ? tk.kitchenStatus === KitchenStatus.SERVED
          : tk.kitchenStatus === KitchenStatus.NEW ||
            tk.kitchenStatus === KitchenStatus.ACKNOWLEDGED ||
            tk.kitchenStatus === KitchenStatus.PREPARING ||
            tk.kitchenStatus === KitchenStatus.READY;
      if (!inActiveBucket) continue;
      counts.ALL += 1;
      for (const st of getTicketStations(tk)) {
        if (st in counts) {
          counts[st] += 1;
        }
      }
    }
    return counts;
  }, [tickets, activeFilter]);

  // Filter tickets by selected station first so status counts reflect the chosen station accurately
  const stationTickets = useMemo(() => {
    if (activeStation === 'ALL') return tickets;
    return tickets.filter((tk) => getTicketStations(tk).includes(activeStation));
  }, [tickets, activeStation]);

  // Tab counts & filtered tickets
  const { visibleTickets, counts } = useMemo(() => {
    let newCount = 0;
    let acknowledgedCount = 0;
    let preparingCount = 0;
    let readyCount = 0;
    let servedCount = 0;

    for (const tk of stationTickets) {
      if (tk.kitchenStatus === KitchenStatus.NEW) newCount += 1;
      else if (tk.kitchenStatus === KitchenStatus.ACKNOWLEDGED) acknowledgedCount += 1;
      else if (tk.kitchenStatus === KitchenStatus.PREPARING) preparingCount += 1;
      else if (tk.kitchenStatus === KitchenStatus.READY) readyCount += 1;
      else if (tk.kitchenStatus === KitchenStatus.SERVED) servedCount += 1;
    }

    const openTotal = newCount + acknowledgedCount + preparingCount + readyCount;

    const filtered = stationTickets.filter((tk) => {
      if (tk.kitchenStatus === KitchenStatus.CANCELLED) return false;
      if (activeFilter === 'ALL') {
        if (includeServed) {
          return (
            tk.kitchenStatus === KitchenStatus.NEW ||
            tk.kitchenStatus === KitchenStatus.ACKNOWLEDGED ||
            tk.kitchenStatus === KitchenStatus.PREPARING ||
            tk.kitchenStatus === KitchenStatus.READY ||
            tk.kitchenStatus === KitchenStatus.SERVED
          );
        }
        return (
          tk.kitchenStatus === KitchenStatus.NEW ||
          tk.kitchenStatus === KitchenStatus.ACKNOWLEDGED ||
          tk.kitchenStatus === KitchenStatus.PREPARING ||
          tk.kitchenStatus === KitchenStatus.READY
        );
      }
      return tk.kitchenStatus === activeFilter;
    });

    // Prioritize unacknowledged new & delayed orders within All Open / active queues
    const sorted = [...filtered].sort((a, b) => {
      const rank = (s: KitchenStatus) => {
        if (s === KitchenStatus.NEW) return 0;
        if (s === KitchenStatus.ACKNOWLEDGED) return 1;
        if (s === KitchenStatus.PREPARING) return 2;
        if (s === KitchenStatus.READY) return 3;
        return 4;
      };
      const rDiff = rank(a.kitchenStatus) - rank(b.kitchenStatus);
      if (rDiff !== 0) return rDiff;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

    return {
      visibleTickets: sorted,
      counts: {
        allOpen: openTotal,
        newCount,
        acknowledgedCount,
        preparingCount,
        readyCount,
        servedCount,
      },
    };
  }, [stationTickets, activeFilter, includeServed]);

  // Status mutations
  const handleAcknowledge = async (orderId: string) => {
    unlockAudio();
    setBusyOrderId(orderId);
    setBanner(null);
    try {
      const res = await apiRequest<{ order: KdsTicketPayload }>(
        `/kds/orders/${orderId}/acknowledge`,
        { method: 'POST' },
      );
      setSyncState((prev) => applySingleTicketUpdateToState(prev, res.order));
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Unable to accept order.',
      });
    } finally {
      setBusyOrderId(null);
    }
  };

  const handleTransition = async (
    orderId: string,
    nextStatus: KitchenStatus,
    reason?: string,
  ) => {
    unlockAudio();
    setBusyOrderId(orderId);
    setBanner(null);
    try {
      const res = await apiRequest<{ order: KdsTicketPayload }>(
        `/kds/orders/${orderId}/status`,
        {
          method: 'PATCH',
          body: JSON.stringify({ status: nextStatus, ...(reason ? { reason } : {}) }),
        },
      );
      setSyncState((prev) => applySingleTicketUpdateToState(prev, res.order));
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Status update failed.',
      });
    } finally {
      setBusyOrderId(null);
    }
  };

  const handleCancelTicket = async (ticket: KdsTicketPayload) => {
    const reason = window.prompt(t.cancelConfirmPrompt);
    if (reason === null) return;
    await handleTransition(ticket.id, KitchenStatus.CANCELLED, reason.trim() || 'Cancelled by staff');
  };

  if (!ready || !session) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-300">
        Loading Kitchen Display System...
      </div>
    );
  }

  const userRole = session.user.role as StaffRole;
  const canManageKitchen = userRole !== StaffRole.WAITER;
  const outletLabel = session.outlet?.name || session.tenant?.name || 'Active Outlet';
  const isTenantLocked = session.tenant?.status === TenantStatus.LOCKED;

  return (
    <div
      className="min-h-screen bg-slate-950 text-slate-100 selection:bg-orange-500 selection:text-white"
      onClick={() => unlockAudio()}
    >
      {/* Top KDS Sticky Header */}
      <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-900/95 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3">
          {/* Left: Back link + Title + Outlet */}
          <div className="flex items-center gap-3">
            <Link
              href="/dashboard"
              className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 text-xs font-semibold text-slate-200 transition hover:bg-slate-700"
            >
              <ArrowLeft className="h-4 w-4" />
              <span className="hidden sm:inline">{t.backToOverview}</span>
            </Link>
            <div className="flex items-center gap-2.5">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-600 text-white shadow-sm">
                <ChefHat className="h-6 w-6" />
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-base font-bold tracking-tight text-white sm:text-lg">
                    {t.title}
                  </h1>
                  {unacknowledgedCount > 0 && connectionMode !== 'BLOCKED' && (
                    <span className="inline-flex animate-pulse items-center gap-1 rounded-full bg-rose-600 px-2.5 py-0.5 text-xs font-extrabold text-white">
                      <BellRing className="h-3.5 w-3.5" />
                      {unacknowledgedCount} {t.unacknowledgedAlert}
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-400">
                  {outletLabel} • {t.subtitle}
                </p>
              </div>
            </div>
          </div>

          {/* Right: Realtime status, sound controls, language switcher */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Connection status pill */}
            <div
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold ${
                connectionMode === 'LIVE_WS'
                  ? 'bg-emerald-950/80 text-emerald-300 ring-1 ring-emerald-700/60'
                  : connectionMode === 'POLLING_FALLBACK'
                    ? 'bg-sky-950/80 text-sky-300 ring-1 ring-sky-700/60'
                    : connectionMode === 'BLOCKED'
                      ? 'bg-amber-950/90 text-amber-300 ring-1 ring-amber-600/60'
                      : 'bg-rose-950/90 text-rose-300 ring-1 ring-rose-700/60'
              }`}
            >
              {connectionMode === 'LIVE_WS' || connectionMode === 'POLLING_FALLBACK' ? (
                <Wifi className="h-3.5 w-3.5" />
              ) : connectionMode === 'BLOCKED' ? (
                <ShieldAlert className="h-3.5 w-3.5" />
              ) : (
                <WifiOff className="h-3.5 w-3.5" />
              )}
              <span>
                {connectionMode === 'LIVE_WS'
                  ? t.liveWs
                  : connectionMode === 'POLLING_FALLBACK'
                    ? t.pollingFallback
                    : connectionMode === 'BLOCKED'
                      ? t.blocked
                      : connectionMode === 'CONNECTING'
                        ? t.reconnecting
                        : t.offline}
              </span>
            </div>

            {/* Sound controls */}
            {!audioUnlocked && soundEnabled && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  unlockAudio();
                  if (audioCtxRef.current) playKdsChime(audioCtxRef.current);
                }}
                className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-amber-500 px-3 text-xs font-extrabold text-slate-950 shadow-sm hover:bg-amber-400"
              >
                <Bell className="h-4 w-4" />
                {t.unlockAudio}
              </button>
            )}

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                unlockAudio();
                setSoundEnabled((prev) => !prev);
              }}
              className={`inline-flex h-10 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition ${
                soundEnabled
                  ? 'border-slate-700 bg-slate-800 text-slate-100 hover:bg-slate-700'
                  : 'border-rose-800 bg-rose-950/70 text-rose-300 hover:bg-rose-900/70'
              }`}
            >
              {soundEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
              <span className="hidden md:inline">{soundEnabled ? t.soundOn : t.soundOff}</span>
            </button>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                unlockAudio();
                if (audioCtxRef.current) playKdsChime(audioCtxRef.current);
              }}
              className="hidden h-10 items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 text-xs font-semibold text-slate-200 hover:bg-slate-700 sm:inline-flex"
            >
              <Bell className="h-4 w-4 text-orange-400" />
              {t.testBell}
            </button>

            {/* Manual sync trigger */}
            <button
              type="button"
              onClick={() => {
                if (connectionMode === 'BLOCKED') {
                  void inspectAndResolveAccessPause();
                } else {
                  void pollBoard(true);
                }
              }}
              aria-label="Sync KDS queue"
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700"
            >
              <RefreshCw className={`h-4 w-4 ${checkingAccess ? 'animate-spin' : ''}`} />
            </button>

            {/* Locale switcher */}
            <div className="flex items-center rounded-lg border border-slate-700 bg-slate-800 p-0.5">
              <Languages className="ml-2 mr-1 h-3.5 w-3.5 text-slate-400" />
              {(
                [
                  { code: 'en', label: 'EN' },
                  { code: 'hi', label: 'हिंदी' },
                  { code: 'gu', label: 'ગુજ' },
                ] as { code: KdsLocale; label: string }[]
              ).map((opt) => (
                <button
                  key={opt.code}
                  type="button"
                  onClick={() => handleLocaleChange(opt.code)}
                  className={`rounded-md px-2.5 py-1.5 text-xs font-bold transition ${
                    locale === opt.code
                      ? 'bg-orange-600 text-white'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Station Bar & Status Filter Tabs (hidden only when completely blocked) */}
        {connectionMode !== 'BLOCKED' && (
          <div className="mx-auto mt-3 max-w-[1600px] space-y-2.5 border-t border-slate-800 pt-2.5">
            {/* Row 1: Kitchen Stations */}
            <div className="flex flex-wrap items-center gap-2">
              {(
                [
                  { id: 'ALL', label: t.stationAll, icon: ChefHat },
                  {
                    id: KitchenStation.MAIN_KITCHEN,
                    label: t.stationMainKitchen,
                    icon: Flame,
                  },
                  { id: KitchenStation.BAR, label: t.stationBar, icon: Coffee },
                  { id: KitchenStation.BAKERY, label: t.stationBakery, icon: Cookie },
                  {
                    id: KitchenStation.DESSERTS,
                    label: t.stationDesserts,
                    icon: IceCream,
                  },
                ] as {
                  id: StationFilter;
                  label: string;
                  icon: typeof ChefHat;
                }[]
              ).map((st) => {
                const Icon = st.icon;
                const active = activeStation === st.id;
                const stCount = stationCounts[st.id] ?? 0;
                return (
                  <button
                    key={st.id}
                    type="button"
                    onClick={() => setActiveStation(st.id)}
                    className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-bold transition ${
                      active
                        ? 'border-orange-500 bg-orange-600 text-white shadow-sm'
                        : 'border-slate-700 bg-slate-800/90 text-slate-300 hover:bg-slate-700 hover:text-white'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    <span>{st.label}</span>
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                        active
                          ? 'bg-slate-950/30 text-white'
                          : 'bg-slate-900 text-slate-400'
                      }`}
                    >
                      {stCount}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Row 2: Order Workflow Filter Tabs + Show Served toggle */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                {(
                  [
                    { id: 'ALL', label: t.allOpen, count: counts.allOpen },
                    { id: KitchenStatus.NEW, label: t.statusNew, count: counts.newCount },
                    {
                      id: KitchenStatus.ACKNOWLEDGED,
                      label: t.statusAcknowledged,
                      count: counts.acknowledgedCount,
                    },
                    {
                      id: KitchenStatus.PREPARING,
                      label: t.statusPreparing,
                      count: counts.preparingCount,
                    },
                    { id: KitchenStatus.READY, label: t.statusReady, count: counts.readyCount },
                  ] as { id: FilterTab; label: string; count: number }[]
                ).map((tab) => {
                  const active = activeFilter === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setActiveFilter(tab.id)}
                      className={`flex min-h-[42px] items-center gap-2 rounded-xl px-3.5 text-xs font-bold transition sm:text-sm ${
                        active
                          ? 'bg-orange-600 text-white shadow-sm'
                          : 'bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white'
                      }`}
                    >
                      <span>{tab.label}</span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          active
                            ? 'bg-slate-950/35 text-white'
                            : 'bg-slate-900 text-slate-300'
                        }`}
                      >
                        {tab.count}
                      </span>
                    </button>
                  );
                })}

                <button
                  type="button"
                  onClick={() => {
                    const willInclude = !includeServed;
                    if (!includeServed) {
                      setIncludeServed(true);
                    }
                    setActiveFilter(KitchenStatus.SERVED);
                    if (willInclude) {
                      void pollBoard(true);
                    }
                  }}
                  className={`flex min-h-[42px] items-center gap-2 rounded-xl px-3.5 text-xs font-bold transition sm:text-sm ${
                    activeFilter === KitchenStatus.SERVED
                      ? 'bg-slate-600 text-white'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  <span>{t.statusServed}</span>
                  <span className="rounded-full bg-slate-900 px-2 py-0.5 text-xs text-slate-300">
                    {counts.servedCount}
                  </span>
                </button>
              </div>

              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-300">
                <input
                  type="checkbox"
                  checked={includeServed}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setIncludeServed(checked);
                    if (!checked && activeFilter === KitchenStatus.SERVED) {
                      setActiveFilter('ALL');
                    }
                    if (checked) {
                      void pollBoard(true);
                    }
                  }}
                  className="h-4 w-4 rounded accent-orange-500"
                />
                {t.includeServed}
              </label>
            </div>
          </div>
        )}
      </header>

      {/* Banners */}
      <div className="mx-auto max-w-[1600px] space-y-3 px-4 pt-4 sm:px-6">
        {(isTenantLocked || subscriptionNotice) && connectionMode !== 'BLOCKED' && (
          <div className="flex items-center gap-2.5 rounded-xl border border-amber-700/70 bg-amber-950/60 px-4 py-2.5 text-xs font-medium text-amber-200">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
            <span>{subscriptionNotice || t.lockBanner}</span>
          </div>
        )}

        {connectionMode === 'OFFLINE' && (
          <div className="flex items-center gap-3 rounded-xl border border-rose-700 bg-rose-950/75 px-4 py-3 text-sm font-medium text-rose-100">
            <WifiOff className="h-5 w-5 shrink-0 text-rose-400" />
            <span>{t.offlineBanner}</span>
          </div>
        )}

        {banner && (
          <div
            className={`flex items-center justify-between rounded-xl border px-4 py-2.5 text-sm font-medium ${
              banner.type === 'error'
                ? 'border-rose-700 bg-rose-950/75 text-rose-100'
                : 'border-emerald-700 bg-emerald-950/75 text-emerald-100'
            }`}
          >
            <span>{banner.text}</span>
            <button
              type="button"
              onClick={() => setBanner(null)}
              className="text-xs font-bold underline"
            >
              {t.closeDetails}
            </button>
          </div>
        )}
      </div>

      {/* Main Content */}
      <main className="mx-auto max-w-[1600px] px-4 py-5 sm:px-6">
        {connectionMode === 'BLOCKED' ? (
          <div className="mx-auto mt-6 max-w-2xl rounded-2xl border border-amber-700/70 bg-slate-900 p-7 shadow-xl sm:p-9">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/30">
                <ShieldAlert className="h-6 w-6" />
              </div>
              <div className="flex-1">
                <h2 className="text-xl font-bold text-white">
                  {accessPause?.reason === 'SUSPENDED'
                    ? t.accessPausedSuspendedTitle
                    : accessPause?.reason === 'ROLE_OR_OUTLET'
                      ? t.accessPausedRoleTitle
                      : t.accessPausedPendingTitle}
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-slate-300">
                  {accessPause?.reason === 'SUSPENDED'
                    ? t.accessPausedSuspendedDesc
                    : accessPause?.reason === 'ROLE_OR_OUTLET'
                      ? t.accessPausedRoleDesc
                      : t.accessPausedPendingDesc}
                </p>

                <div className="mt-5 grid gap-3 rounded-xl border border-slate-800 bg-slate-950/80 p-4 text-xs sm:grid-cols-2">
                  <div>
                    <span className="text-slate-400">{t.currentStatusLabel}</span>
                    <p className="mt-1 font-bold text-amber-300">
                      {accessPause?.tenantStatus ||
                        session.tenant?.status ||
                        TenantStatus.PENDING_APPROVAL}
                    </p>
                  </div>
                  <div>
                    <span className="text-slate-400">{t.subscriptionStatusLabel}</span>
                    <p className="mt-1 font-bold text-slate-200">
                      {accessPause?.subscriptionStatus
                        ? accessPause.trialDaysRemaining !== null &&
                          accessPause.subscriptionStatus === 'TRIAL'
                          ? `${accessPause.subscriptionStatus} (${accessPause.trialDaysRemaining}d left)`
                          : accessPause.subscriptionStatus
                        : outletLabel}
                    </p>
                  </div>
                </div>

                <div className="mt-6 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    disabled={checkingAccess}
                    onClick={() => void inspectAndResolveAccessPause()}
                    className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-orange-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-orange-500 disabled:opacity-60"
                  >
                    <RefreshCw className={`h-4 w-4 ${checkingAccess ? 'animate-spin' : ''}`} />
                    {checkingAccess ? t.checkingStatus : t.btnCheckApproval}
                  </button>
                  <Link
                    href="/dashboard"
                    className="inline-flex min-h-[44px] items-center rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-700"
                  >
                    {t.btnOpenOverview}
                  </Link>
                  <Link
                    href="/dashboard/plan"
                    className="inline-flex min-h-[44px] items-center rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-700"
                  >
                    {t.btnOpenPlan}
                  </Link>
                </div>
              </div>
            </div>
          </div>
        ) : visibleTickets.length === 0 ? (
          <div className="mt-12 rounded-2xl border border-dashed border-slate-800 bg-slate-900/50 p-12 text-center">
            <ChefHat className="mx-auto h-12 w-12 text-slate-600" />
            <h2 className="mt-4 text-lg font-bold text-slate-200">
              {tickets.length > 0 ? t.emptyFilteredTitle : t.emptyTitle}
            </h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-slate-400">
              {tickets.length > 0 ? t.emptyFilteredDesc : t.emptyDesc}
            </p>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {visibleTickets.map((ticket) => {
              const isBusy = busyOrderId === ticket.id;
              const style = getStatusBadgeStyle(ticket.kitchenStatus, t);
              const isUnackedNew =
                ticket.kitchenStatus === KitchenStatus.NEW && !ticket.acknowledgedAt;

              const { label: stopwatchLabel, elapsedMinutes } = formatPrepStopwatch(
                ticket.createdAt,
                nowMs,
              );
              const estPrep = getEstimatedPrepMinutes(ticket);
              const warnThreshold = estPrep ? Math.max(estPrep, DELAY_WARN_MIN) : DELAY_WARN_MIN;
              const urgentThreshold = estPrep
                ? Math.max(estPrep + 5, DELAY_URGENT_MIN)
                : DELAY_URGENT_MIN;

              const isCompleted =
                ticket.kitchenStatus === KitchenStatus.SERVED ||
                ticket.kitchenStatus === KitchenStatus.CANCELLED;
              const isUrgentDelay = !isCompleted && elapsedMinutes >= urgentThreshold;
              const isDelayed = !isCompleted && !isUrgentDelay && elapsedMinutes >= warnThreshold;

              const ticketStations = getTicketStations(ticket);
              const customerDisplay =
                ticket.customerName ||
                (ticket.source === OrderSource.STAFF_POS && ticket.placedByName
                  ? `${t.waiterLabel}: ${ticket.placedByName}`
                  : null);

              const activeItems = ticket.items.filter(
                (i) => i.status !== 'CANCELLED' && i.quantity > 0,
              );
              const totalPieces = activeItems.reduce((sum, i) => sum + i.quantity, 0);

              return (
                <article
                  key={ticket.id}
                  data-testid={`kds-ticket-${ticket.kotNumber}`}
                  className={`flex flex-col overflow-hidden rounded-2xl border-2 transition ${
                    isUrgentDelay
                      ? 'border-rose-500 bg-slate-900 shadow-lg shadow-rose-950/50 ring-2 ring-rose-500/40'
                      : isDelayed
                        ? 'border-amber-400 bg-slate-900 shadow-lg shadow-amber-950/30'
                        : isUnackedNew
                          ? `${style.cardClass} ring-2 ring-orange-500/40`
                          : style.cardClass
                  }`}
                >
                  {/* Top status & delay urgency bar */}
                  <div
                    className={`h-1.5 w-full ${
                      isUrgentDelay
                        ? 'bg-rose-500'
                        : isDelayed
                          ? 'bg-amber-400'
                          : style.stripeClass
                    }`}
                  />

                  {/* Ticket Header */}
                  <div className={`px-4 py-3 ${style.headerBg}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-xl font-black tracking-tight text-white">
                            {t.tablePrefix} {ticket.tableNumber}
                          </span>
                          {ticket.tableLabel && (
                            <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[11px] font-medium text-slate-300">
                              {ticket.tableLabel}
                            </span>
                          )}
                          {ticket.isAddOn && (
                            <span className="rounded bg-amber-400 px-1.5 py-0.5 text-[10px] font-extrabold text-slate-950">
                              {t.addOn}
                            </span>
                          )}
                        </div>

                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-300">
                          <span className="font-bold text-orange-300">
                            {t.kotPrefix} #{ticket.kotNumber}
                          </span>
                          <span className="text-slate-500">•</span>
                          <span>
                            {t.roundPrefix} {ticket.roundNumber}
                          </span>
                          <span className="text-slate-500">•</span>
                          <span className="text-slate-300">
                            {ticket.source === OrderSource.STAFF_POS
                              ? t.waiterSource
                              : t.guestSource}
                          </span>
                        </div>
                      </div>

                      <div className="flex flex-col items-end gap-1">
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-[11px] uppercase tracking-wide ${style.badgeClass}`}
                        >
                          {style.label}
                        </span>
                        <div
                          className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-xs font-extrabold ${
                            isUrgentDelay
                              ? 'animate-pulse bg-rose-600 text-white'
                              : isDelayed
                                ? 'bg-amber-400 text-slate-950'
                                : 'bg-slate-800 text-slate-200'
                          }`}
                        >
                          <Clock className="h-3 w-3" />
                          <span>{stopwatchLabel}</span>
                        </div>
                      </div>
                    </div>

                    {/* Customer name, timestamp, estimated prep & urgency badges */}
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-1.5 text-[11px]">
                      <div className="flex flex-wrap items-center gap-2">
                        {customerDisplay && (
                          <span className="inline-flex items-center gap-1 rounded bg-slate-800/90 px-2 py-0.5 font-semibold text-slate-200">
                            <User className="h-3 w-3 text-orange-400" />
                            {ticket.customerName ? `${t.customerLabel}: ${ticket.customerName}` : customerDisplay}
                          </span>
                        )}
                        <span className="text-slate-400">
                          {t.orderTimeLabel} {formatClockTime(ticket.createdAt)}
                        </span>
                        {estPrep !== null && (
                          <span className="rounded bg-slate-800 px-1.5 py-0.5 font-medium text-slate-300">
                            {t.prepTimeEst} {estPrep}m
                          </span>
                        )}
                      </div>

                      {(isUrgentDelay || isDelayed) && (
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-extrabold tracking-wide ${
                            isUrgentDelay
                              ? 'animate-pulse bg-rose-600 text-white'
                              : 'bg-amber-500 text-slate-950'
                          }`}
                        >
                          <AlertTriangle className="h-3 w-3" />
                          {isUrgentDelay
                            ? `${t.priorityHigh} • ${t.urgentDelayBadge}`
                            : t.delayedBadge}
                        </span>
                      )}
                    </div>

                    {/* Station tags */}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {ticketStations.map((st) => {
                        const StIcon = getStationIcon(st);
                        return (
                          <span
                            key={st}
                            className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800/90 px-2 py-0.5 text-[10px] font-semibold text-slate-200"
                          >
                            <StIcon className="h-3 w-3 text-orange-400" />
                            {getStationLabel(st, t)}
                          </span>
                        );
                      })}
                    </div>
                  </div>

                  {/* Items & Notes Body */}
                  <div className="flex-1 space-y-2.5 p-4">
                    <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      <span>
                        {t.qtyLabel}: {totalPieces}
                      </span>
                      <button
                        type="button"
                        onClick={() => setDetailTicket(ticket)}
                        className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold text-orange-400 hover:bg-slate-800 hover:text-orange-300"
                      >
                        <Eye className="h-3.5 w-3.5" />
                        {t.btnViewDetails}
                      </button>
                    </div>

                    <ul className="space-y-2">
                      {ticket.items.map((item) => {
                        const cancelledLine = item.status === 'CANCELLED' || item.quantity === 0;
                        const itemStation = item.kitchenStation ?? KitchenStation.MAIN_KITCHEN;
                        const otherStationDimmed =
                          activeStation !== 'ALL' && itemStation !== activeStation;
                        return (
                          <li
                            key={item.id}
                            className={`rounded-xl border px-3 py-2 ${
                              cancelledLine
                                ? 'border-slate-800 bg-slate-950/50 text-slate-500 line-through'
                                : otherStationDimmed
                                  ? 'border-slate-800/70 bg-slate-950/40 opacity-55'
                                  : 'border-slate-800 bg-slate-950/75'
                            }`}
                          >
                            <div className="flex items-start gap-2.5">
                              <span
                                className={`mt-0.5 flex h-6 min-w-[28px] items-center justify-center rounded-md px-1.5 text-xs font-extrabold ${
                                  cancelledLine
                                    ? 'bg-slate-800 text-slate-500'
                                    : 'bg-orange-500/20 text-orange-300 ring-1 ring-orange-500/30'
                                }`}
                              >
                                {item.quantity}x
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center justify-between gap-2">
                                  <div className="flex items-center gap-1.5">
                                    <KdsDietaryDot type={item.dietaryTypeSnapshot} />
                                    <span className="text-sm font-bold leading-snug text-white">
                                      {item.itemNameSnapshot}
                                    </span>
                                  </div>
                                  {ticketStations.length > 1 && (
                                    <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold text-slate-300">
                                      {getStationLabel(itemStation, t)}
                                    </span>
                                  )}
                                </div>
                                {item.modifiersSnapshotJson.length > 0 && (
                                  <p className="mt-0.5 text-xs text-slate-300">
                                    +{' '}
                                    {item.modifiersSnapshotJson
                                      .map((m) => m.optionName)
                                      .join(', ')}
                                  </p>
                                )}
                                {item.prepNotes && (
                                  <p className="mt-1 rounded bg-amber-950/80 px-2 py-0.5 text-xs font-semibold text-amber-200">
                                    {t.itemNotesLabel}: {item.prepNotes}
                                  </p>
                                )}
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>

                    {ticket.notes && (
                      <div className="rounded-xl border border-amber-700/60 bg-amber-950/60 px-3 py-2 text-xs font-semibold text-amber-100">
                        <span className="text-amber-300">{t.specialInstructions}:</span>{' '}
                        {ticket.notes}
                      </div>
                    )}

                    {ticket.acknowledgedAt && ticket.acknowledgedByName && (
                      <p className="text-[11px] text-slate-400">
                        {t.acknowledgedBy}:{' '}
                        <span className="font-semibold text-slate-200">
                          {ticket.acknowledgedByName}
                        </span>
                      </p>
                    )}
                  </div>

                  {/* Card Footer Actions — Exact Stage Workflow */}
                  <div className="border-t border-slate-800 bg-slate-900/90 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      {ticket.kitchenStatus === KitchenStatus.NEW && canManageKitchen && (
                        <>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => void handleAcknowledge(ticket.id)}
                            className="flex min-h-[50px] flex-1 items-center justify-center gap-2 rounded-xl bg-orange-600 px-3 text-sm font-extrabold text-white transition hover:bg-orange-500 disabled:opacity-50"
                          >
                            <Bell className="h-4 w-4" />
                            <span>{t.btnAcknowledge}</span>
                          </button>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() =>
                              void handleTransition(ticket.id, KitchenStatus.PREPARING)
                            }
                            className="flex min-h-[50px] items-center justify-center gap-1.5 rounded-xl bg-sky-500 px-3 text-sm font-extrabold text-slate-950 transition hover:bg-sky-400 disabled:opacity-50"
                          >
                            <Flame className="h-4 w-4" />
                            <span>{t.btnStartPreparing}</span>
                          </button>
                        </>
                      )}

                      {ticket.kitchenStatus === KitchenStatus.ACKNOWLEDGED && canManageKitchen && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() =>
                            void handleTransition(ticket.id, KitchenStatus.PREPARING)
                          }
                          className="flex min-h-[50px] flex-1 items-center justify-center gap-2 rounded-xl bg-sky-500 px-4 text-sm font-extrabold text-slate-950 transition hover:bg-sky-400 disabled:opacity-50"
                        >
                          <Flame className="h-5 w-5" />
                          <span>{t.btnStartPreparing}</span>
                        </button>
                      )}

                      {ticket.kitchenStatus === KitchenStatus.PREPARING && canManageKitchen && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleTransition(ticket.id, KitchenStatus.READY)}
                          className="flex min-h-[50px] flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 text-sm font-extrabold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
                        >
                          <Check className="h-5 w-5" />
                          <span>{t.btnMarkReady}</span>
                        </button>
                      )}

                      {ticket.kitchenStatus === KitchenStatus.READY && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleTransition(ticket.id, KitchenStatus.SERVED)}
                          className="flex min-h-[50px] flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-500 px-4 text-sm font-extrabold text-white transition hover:bg-indigo-400 disabled:opacity-50"
                        >
                          <CheckCheck className="h-5 w-5" />
                          <span>{t.btnMarkServed}</span>
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => setPrintingTicket(ticket)}
                        title={t.btnPrintKot}
                        aria-label={t.btnPrintKot}
                        className="inline-flex min-h-[50px] min-w-[48px] items-center justify-center rounded-xl border border-slate-700 bg-slate-800 px-3 text-slate-200 hover:bg-slate-700"
                      >
                        <Printer className="h-4 w-4" />
                      </button>

                      {canManageKitchen &&
                        (ticket.kitchenStatus === KitchenStatus.NEW ||
                          ticket.kitchenStatus === KitchenStatus.ACKNOWLEDGED ||
                          ticket.kitchenStatus === KitchenStatus.PREPARING) && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => void handleCancelTicket(ticket)}
                            title={t.btnCancelKot}
                            aria-label={t.btnCancelKot}
                            className="inline-flex min-h-[50px] min-w-[48px] items-center justify-center rounded-xl border border-rose-800 bg-rose-950/60 px-3 text-rose-300 hover:bg-rose-900/70 disabled:opacity-50"
                          >
                            <XCircle className="h-4 w-4" />
                          </button>
                        )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </main>

      {/* Complete Order Details Modal */}
      {liveDetailTicket && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
          onClick={() => setDetailTicket(null)}
        >
          <div
            className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 text-slate-100 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
              <div>
                <h2 className="text-lg font-bold text-white">
                  {t.detailsTitle} • {t.kotPrefix} #{liveDetailTicket.kotNumber}
                </h2>
                <p className="text-xs text-slate-400">
                  {t.tablePrefix} {liveDetailTicket.tableNumber}
                  {liveDetailTicket.tableLabel ? ` (${liveDetailTicket.tableLabel})` : ''} •{' '}
                  {t.roundPrefix} {liveDetailTicket.roundNumber} •{' '}
                  {liveDetailTicket.source === OrderSource.STAFF_POS
                    ? t.waiterSource
                    : t.guestSource}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDetailTicket(null)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4 p-5">
              {/* Customer / Staff + Timeline */}
              <div className="grid gap-3 rounded-xl border border-slate-800 bg-slate-950/70 p-3.5 text-xs sm:grid-cols-2">
                <div>
                  <span className="text-slate-400">{t.customerLabel}: </span>
                  <span className="font-bold text-white">
                    {liveDetailTicket.customerName ||
                      liveDetailTicket.placedByName ||
                      (liveDetailTicket.source === OrderSource.STAFF_POS
                        ? t.waiterSource
                        : t.guestSource)}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400">{t.subtotalLabel}: </span>
                  <span className="font-bold text-orange-300">
                    {formatInrFromPaise(liveDetailTicket.subtotalPaise)}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400">{t.timelinePlaced}: </span>
                  <span className="font-semibold text-slate-200">
                    {formatClockTime(liveDetailTicket.createdAt)}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400">{t.timelineAccepted}: </span>
                  <span className="font-semibold text-slate-200">
                    {liveDetailTicket.acknowledgedAt
                      ? formatClockTime(liveDetailTicket.acknowledgedAt)
                      : '—'}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400">{t.timelinePreparing}: </span>
                  <span className="font-semibold text-slate-200">
                    {liveDetailTicket.acceptedAt
                      ? formatClockTime(liveDetailTicket.acceptedAt)
                      : '—'}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400">{t.timelineReady}: </span>
                  <span className="font-semibold text-slate-200">
                    {liveDetailTicket.readyAt ? formatClockTime(liveDetailTicket.readyAt) : '—'}
                  </span>
                </div>
                {liveDetailTicket.servedAt && (
                  <div className="sm:col-span-2">
                    <span className="text-slate-400">{t.timelineServed}: </span>
                    <span className="font-semibold text-emerald-300">
                      {formatClockTime(liveDetailTicket.servedAt)}
                    </span>
                  </div>
                )}
              </div>

              {/* Station tags */}
              <div className="flex flex-wrap gap-1.5">
                {getTicketStations(liveDetailTicket).map((st) => {
                  const StIcon = getStationIcon(st);
                  return (
                    <span
                      key={st}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-200"
                    >
                      <StIcon className="h-3.5 w-3.5 text-orange-400" />
                      {getStationLabel(st, t)}
                    </span>
                  );
                })}
              </div>

              {/* Items breakdown */}
              <ul className="space-y-2">
                {liveDetailTicket.items.map((item) => {
                  const cancelled = item.status === 'CANCELLED' || item.quantity === 0;
                  return (
                    <li
                      key={item.id}
                      className={`rounded-xl border border-slate-800 bg-slate-950/75 px-3.5 py-2.5 ${
                        cancelled ? 'opacity-55 line-through' : ''
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="rounded bg-orange-500/20 px-2 py-0.5 text-xs font-extrabold text-orange-300">
                            {item.quantity}x
                          </span>
                          <KdsDietaryDot type={item.dietaryTypeSnapshot} />
                          <span className="text-sm font-bold text-white">
                            {item.itemNameSnapshot}
                          </span>
                        </div>
                        <span className="text-xs font-medium text-slate-400">
                          {getStationLabel(item.kitchenStation ?? KitchenStation.MAIN_KITCHEN, t)}
                          {item.prepTimeMinutes ? ` • ${item.prepTimeMinutes}m` : ''}
                        </span>
                      </div>
                      {item.modifiersSnapshotJson.length > 0 && (
                        <p className="mt-1 text-xs text-slate-300">
                          + {item.modifiersSnapshotJson.map((m) => m.optionName).join(', ')}
                        </p>
                      )}
                      {item.prepNotes && (
                        <p className="mt-1 text-xs font-semibold text-amber-200">
                          {t.itemNotesLabel}: {item.prepNotes}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>

              {liveDetailTicket.notes && (
                <div className="rounded-xl border border-amber-700/60 bg-amber-950/60 p-3 text-xs font-semibold text-amber-100">
                  <span className="text-amber-300">{t.specialInstructions}: </span>
                  {liveDetailTicket.notes}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-800 px-5 py-3.5">
              <button
                type="button"
                onClick={() => setPrintingTicket(liveDetailTicket)}
                className="inline-flex min-h-[42px] items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3.5 text-xs font-bold text-slate-200 hover:bg-slate-700"
              >
                <Printer className="h-4 w-4" />
                {t.btnPrintKot}
              </button>
              <button
                type="button"
                onClick={() => setDetailTicket(null)}
                className="inline-flex min-h-[42px] items-center rounded-xl bg-orange-600 px-4 text-xs font-bold text-white hover:bg-orange-500"
              >
                {t.closeDetails}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Print KOT Modal */}
      {printingTicket && (
        <KotPrintModal
          ticket={printingTicket}
          outletName={outletLabel}
          onClose={() => setPrintingTicket(null)}
        />
      )}
    </div>
  );
}

function KotPrintModal({
  ticket,
  outletName,
  onClose,
}: {
  ticket: KdsTicketPayload;
  outletName: string;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-white p-6 font-mono text-xs text-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-dashed border-slate-400 pb-3 text-center">
          <p className="text-sm font-black uppercase tracking-wider">{outletName}</p>
          <p className="mt-1 text-base font-extrabold">
            KOT #{ticket.kotNumber} • TABLE {ticket.tableNumber}
          </p>
          <p className="text-[11px] text-slate-600">
            Round {ticket.roundNumber}
            {ticket.isAddOn ? ' (ADD-ON)' : ''} •{' '}
            {ticket.source === OrderSource.STAFF_POS ? 'WAITER POS' : 'CUSTOMER QR'}
          </p>
          {ticket.customerName && (
            <p className="text-[11px] font-bold text-slate-700">Guest: {ticket.customerName}</p>
          )}
          <p className="text-[11px] text-slate-600">
            {new Date(ticket.createdAt).toLocaleString()}
          </p>
        </div>

        <ul className="my-3 space-y-2 border-b border-dashed border-slate-400 pb-3">
          {ticket.items.map((item) => (
            <li
              key={item.id}
              className={item.status === 'CANCELLED' || item.quantity === 0 ? 'line-through' : ''}
            >
              <div className="flex justify-between font-bold">
                <span>
                  {item.quantity}x {item.itemNameSnapshot}
                </span>
                <span className="text-[10px] uppercase text-slate-500">
                  {item.kitchenStation ?? KitchenStation.MAIN_KITCHEN}
                </span>
              </div>
              {item.modifiersSnapshotJson.length > 0 && (
                <p className="pl-4 text-[11px] text-slate-700">
                  + {item.modifiersSnapshotJson.map((m) => m.optionName).join(', ')}
                </p>
              )}
              {item.prepNotes && (
                <p className="pl-4 text-[11px] font-bold text-slate-800">
                  NOTE: {item.prepNotes}
                </p>
              )}
            </li>
          ))}
        </ul>

        {ticket.notes && (
          <p className="mb-3 rounded bg-slate-100 p-2 font-bold">NOTE: {ticket.notes}</p>
        )}

        <div className="flex gap-2 print:hidden">
          <button
            type="button"
            onClick={() => window.print()}
            className="flex-1 rounded-lg bg-slate-900 px-3 py-2 font-sans text-xs font-bold text-white hover:bg-slate-800"
          >
            Print KOT
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-3 py-2 font-sans text-xs font-bold text-slate-700 hover:bg-slate-100"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
