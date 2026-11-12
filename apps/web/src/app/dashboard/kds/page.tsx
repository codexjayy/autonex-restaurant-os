'use client';

import {
  DietaryType,
  KdsEventEnvelope,
  KdsTicketPayload,
  KitchenStatus,
  StaffRole,
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
  CheckCheck,
  ChefHat,
  Clock,
  Flame,
  Languages,
  Printer,
  RefreshCw,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  XCircle,
} from 'lucide-react';
import { KotPrintModal } from '@/components/kot-print-modal';
import {
  ApiError,
  AuthSession,
  KdsAcknowledgeResponse,
  KdsBoardResponse,
  KdsTransitionResponse,
  WS_BASE_URL,
  apiRequest,
  ensureFreshAccessToken,
  getStoredSession,
} from '@/lib/api-client';
import {
  KDS_TRANSLATIONS,
  KdsLocale,
  loadSavedKdsLocale,
  saveKdsLocale,
} from '@/lib/kds-i18n';
import {
  KdsConnectionMode,
  KdsSyncState,
  applyKdsEventToState,
  applySingleTicketUpdateToState,
  createInitialKdsSyncState,
  playKdsChime,
  reconcileKdsPollResponse,
} from '@/lib/kds-sync';

type FilterTab = 'ALL' | KitchenStatus.NEW | KitchenStatus.PREPARING | KitchenStatus.READY | KitchenStatus.SERVED;

function formatElapsed(createdIso: string, nowMs: number): { text: string; minutes: number } {
  const diffSec = Math.max(0, Math.floor((nowMs - Date.parse(createdIso)) / 1000));
  const mins = Math.floor(diffSec / 60);
  const secs = diffSec % 60;
  return {
    text: `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`,
    minutes: mins,
  };
}

function dietaryIndicator(type: DietaryType) {
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

export default function KdsBoardPage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthSession | null>(null);
  const [ready, setReady] = useState(false);

  const [locale, setLocale] = useState<KdsLocale>('en');
  const t = KDS_TRANSLATIONS[locale];

  const [syncState, setSyncState] = useState<KdsSyncState>(() => createInitialKdsSyncState());
  const syncStateRef = useRef<KdsSyncState>(syncState);
  syncStateRef.current = syncState;

  const [connectionMode, setConnectionMode] = useState<KdsConnectionMode>('POLLING_FALLBACK');
  const [activeFilter, setActiveFilter] = useState<FilterTab>('ALL');
  const [includeServed, setIncludeServed] = useState(false);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const [soundEnabled, setSoundEnabled] = useState(true);
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const soundEnabledRef = useRef(true);
  soundEnabledRef.current = soundEnabled;
  const audioCtxRef = useRef<AudioContext | null>(null);

  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [printingTicket, setPrintingTicket] = useState<KdsTicketPayload | null>(null);
  const [banner, setBanner] = useState<{ type: 'info' | 'success' | 'error'; text: string } | null>(
    null,
  );

  const wsDisconnectedOnceRef = useRef(false);
  const consecutivePollErrorsRef = useRef(0);
  const socketRef = useRef<Socket | null>(null);

  // Unlock Web Audio context cleanly on user interaction
  const unlockAudio = useCallback(() => {
    if (typeof window === 'undefined') return;
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
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

  const triggerNewOrderChime = useCallback(() => {
    if (!soundEnabledRef.current) return;
    const played = playKdsChime(audioCtxRef.current);
    if (!played) {
      setAudioUnlocked(false);
    }
  }, []);

  useEffect(() => {
    const stored = getStoredSession();
    if (!stored?.accessToken) {
      router.replace('/login');
      return;
    }
    setSession(stored);
    setLocale(loadSavedKdsLocale());
    setReady(true);
  }, [router]);

  const handleChangeLocale = (nextLocale: KdsLocale) => {
    setLocale(nextLocale);
    saveKdsLocale(nextLocale);
  };

  // Live 1-second timer tick for SLA elapsed indicators
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const fetchBoard = useCallback(
    async (incremental: boolean, notifyNewArrivals = true) => {
      const params = new URLSearchParams();
      if (includeServed) params.set('includeServed', 'true');
      const cursor = syncStateRef.current.syncCursor;
      if (incremental && cursor) {
        params.set('since', cursor);
      }

      const qs = params.toString();
      try {
        const res = await apiRequest<KdsBoardResponse>(`/kds/orders${qs ? `?${qs}` : ''}`);
        consecutivePollErrorsRef.current = 0;

        const { nextState, newlyArrivedUnackedCount, recoveredCount } = reconcileKdsPollResponse(
          syncStateRef.current,
          res,
          { includeServed, notifyNewArrivals },
        );
        syncStateRef.current = nextState;
        setSyncState(nextState);

        if (newlyArrivedUnackedCount > 0) {
          triggerNewOrderChime();
        }

        if (!incremental && wsDisconnectedOnceRef.current) {
          wsDisconnectedOnceRef.current = false;
          setBanner({
            type: 'success',
            text:
              recoveredCount > 0
                ? `${t.reconnectedSyncedPrefix} (+${recoveredCount})`
                : t.reconnectedSyncedPrefix,
          });
        }
      } catch (err) {
        consecutivePollErrorsRef.current += 1;
        if (err instanceof ApiError && err.status === 401) {
          router.replace('/login');
          return;
        }
        if (
          typeof navigator !== 'undefined' &&
          (!navigator.onLine || consecutivePollErrorsRef.current >= 2)
        ) {
          setConnectionMode('OFFLINE');
        }
      }
    },
    [includeServed, router, t.reconnectedSyncedPrefix, triggerNewOrderChime],
  );

  // Initial load & when `includeServed` toggles
  useEffect(() => {
    if (!ready) return;
    void fetchBoard(false, false);
  }, [ready, includeServed, fetchBoard]);

  // Socket.IO connection lifecycle + token refresh recovery + browser online/offline listeners
  useEffect(() => {
    if (!ready) return;

    const socket = io(`${WS_BASE_URL}/kds`, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      auth: (cb) => {
        const latest = getStoredSession();
        cb({ token: latest?.accessToken ?? '' });
      },
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnectionMode('LIVE_WS');
      // Full open-ticket snapshot sync on every WS connect / reconnect so missed changes are never lost
      void fetchBoard(false, true);
    });

    socket.on('kds:connected', () => {
      setConnectionMode('LIVE_WS');
    });

    socket.on('kds:error', (payload: { code?: string }) => {
      if (payload?.code === 'UNAUTHORIZED') {
        void ensureFreshAccessToken().then((fresh) => {
          if (fresh && socket.disconnected) {
            socket.connect();
          }
        });
      }
    });

    socket.on('kds.event', (envelope: KdsEventEnvelope) => {
      const { nextState, duplicateEvent, isNewUnackedArrival } = applyKdsEventToState(
        syncStateRef.current,
        envelope,
      );
      if (duplicateEvent) return;
      syncStateRef.current = nextState;
      setSyncState(nextState);

      if (isNewUnackedArrival) {
        triggerNewOrderChime();
      }
    });

    socket.on('disconnect', () => {
      wsDisconnectedOnceRef.current = true;
      setConnectionMode(
        typeof navigator !== 'undefined' && !navigator.onLine ? 'OFFLINE' : 'POLLING_FALLBACK',
      );
    });

    socket.on('connect_error', () => {
      wsDisconnectedOnceRef.current = true;
      setConnectionMode(
        typeof navigator !== 'undefined' && !navigator.onLine ? 'OFFLINE' : 'POLLING_FALLBACK',
      );
      void ensureFreshAccessToken();
    });

    const handleOnline = () => {
      if (socket.connected) {
        setConnectionMode('LIVE_WS');
        void fetchBoard(false, true);
      } else {
        setConnectionMode('POLLING_FALLBACK');
        socket.connect();
        void fetchBoard(false, true);
      }
    };

    const handleOffline = () => {
      wsDisconnectedOnceRef.current = true;
      setConnectionMode('OFFLINE');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [ready, fetchBoard, triggerNewOrderChime]);

  // Automatic 4-second cursor polling fallback whenever WS is not connected,
  // plus gentle 25-second safety reconciliation even when LIVE_WS
  useEffect(() => {
    if (!ready) return;
    const intervalMs = connectionMode === 'LIVE_WS' ? 25_000 : 4_000;
    const timer = window.setInterval(() => {
      const useIncremental = connectionMode !== 'LIVE_WS' && Boolean(syncStateRef.current.syncCursor);
      void fetchBoard(useIncremental, true);
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [ready, connectionMode, fetchBoard]);

  // Repeat gentle audible chime every 20s if an unacknowledged NEW order is still waiting
  const tickets = useMemo(() => {
    return Array.from(syncState.ticketsById.values()).sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );
  }, [syncState.ticketsById]);

  const unackedCount = useMemo(
    () =>
      tickets.filter((tk) => tk.kitchenStatus === KitchenStatus.NEW && !tk.acknowledgedAt).length,
    [tickets],
  );

  useEffect(() => {
    if (!ready || unackedCount === 0 || !soundEnabled) return;
    const reminder = window.setInterval(() => {
      triggerNewOrderChime();
    }, 20_000);
    return () => window.clearInterval(reminder);
  }, [ready, unackedCount, soundEnabled, triggerNewOrderChime]);

  const counts = useMemo(() => {
    let newCount = 0;
    let preparingCount = 0;
    let readyCount = 0;
    let servedCount = 0;

    for (const tk of tickets) {
      if (tk.kitchenStatus === KitchenStatus.NEW) newCount += 1;
      else if (tk.kitchenStatus === KitchenStatus.PREPARING) preparingCount += 1;
      else if (tk.kitchenStatus === KitchenStatus.READY) readyCount += 1;
      else if (tk.kitchenStatus === KitchenStatus.SERVED) servedCount += 1;
    }

    return {
      activeTotal: newCount + preparingCount + readyCount,
      newCount,
      preparingCount,
      readyCount,
      servedCount,
    };
  }, [tickets]);

  const visibleTickets = useMemo(() => {
    return tickets.filter((tk) => {
      if (activeFilter === 'ALL') {
        if (includeServed) {
          return (
            tk.kitchenStatus === KitchenStatus.NEW ||
            tk.kitchenStatus === KitchenStatus.PREPARING ||
            tk.kitchenStatus === KitchenStatus.READY ||
            tk.kitchenStatus === KitchenStatus.SERVED
          );
        }
        return (
          tk.kitchenStatus === KitchenStatus.NEW ||
          tk.kitchenStatus === KitchenStatus.PREPARING ||
          tk.kitchenStatus === KitchenStatus.READY
        );
      }
      return tk.kitchenStatus === activeFilter;
    });
  }, [tickets, activeFilter, includeServed]);

  const canManageKitchen = session?.user.role !== StaffRole.WAITER;

  const handleAcknowledge = async (orderId: string) => {
    unlockAudio();
    setBusyOrderId(orderId);
    setBanner(null);
    try {
      const res = await apiRequest<KdsAcknowledgeResponse>(`/kds/orders/${orderId}/acknowledge`, {
        method: 'POST',
      });
      const updated = applySingleTicketUpdateToState(syncStateRef.current, res.order);
      syncStateRef.current = updated;
      setSyncState(updated);
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Unable to confirm ticket receipt',
      });
    } finally {
      setBusyOrderId(null);
    }
  };

  const handleTransition = async (orderId: string, nextStatus: KitchenStatus, reason?: string) => {
    unlockAudio();
    setBusyOrderId(orderId);
    setBanner(null);
    try {
      const res = await apiRequest<KdsTransitionResponse>(`/kds/orders/${orderId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus, ...(reason ? { reason } : {}) }),
      });
      const updated = applySingleTicketUpdateToState(syncStateRef.current, res.order);
      syncStateRef.current = updated;
      setSyncState(updated);
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof ApiError ? err.message : 'Failed to update ticket status',
      });
    } finally {
      setBusyOrderId(null);
    }
  };

  const handleCancelTicket = async (ticket: KdsTicketPayload) => {
    const reason = window.prompt(
      `Cancel KOT #${ticket.kotNumber} (Table ${ticket.tableNumber})? Enter short reason:`,
      'Out of ingredients',
    );
    if (reason === null) return;
    await handleTransition(ticket.id, KitchenStatus.CANCELLED, reason.trim() || 'Cancelled by staff');
  };

  if (!ready || !session) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-sm text-slate-300">
        Loading Kitchen Display...
      </div>
    );
  }

  return (
    <div
      onClick={unlockAudio}
      className="min-h-screen bg-slate-950 text-slate-100 selection:bg-brand-500 selection:text-white"
    >
      {/* Top KDS Control Header */}
      <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-900/95 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link
              href="/dashboard"
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3 text-xs font-semibold text-slate-200 hover:bg-slate-700"
            >
              <ArrowLeft className="h-4 w-4" />
              {t.backToDashboard}
            </Link>
            <div className="flex items-center gap-2.5">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600 text-white">
                <ChefHat className="h-6 w-6" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-lg font-extrabold tracking-tight text-white sm:text-xl">
                    {t.title}
                  </h1>
                  <span className="hidden rounded-md bg-slate-800 px-2 py-0.5 text-xs font-medium text-slate-300 sm:inline-block">
                    {session.outlet?.name || session.tenant?.name}
                  </span>
                </div>
                <p className="hidden text-xs text-slate-400 md:block">{t.subtitle}</p>
              </div>
            </div>
          </div>

          {/* Right Controls: Connection Indicator, Language, Sound, Sync */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Connection Status Pill */}
            {connectionMode === 'LIVE_WS' && (
              <span className="inline-flex min-h-[42px] items-center gap-2 rounded-xl border border-emerald-700/60 bg-emerald-950/70 px-3 text-xs font-bold text-emerald-300">
                <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-400" />
                <Wifi className="h-4 w-4" />
                {t.liveWs}
              </span>
            )}
            {connectionMode === 'POLLING_FALLBACK' && (
              <span className="inline-flex min-h-[42px] items-center gap-2 rounded-xl border border-amber-600/70 bg-amber-950/70 px-3 text-xs font-bold text-amber-300">
                <RefreshCw className="h-4 w-4 animate-spin" />
                {t.pollingFallback}
              </span>
            )}
            {connectionMode === 'OFFLINE' && (
              <span className="inline-flex min-h-[42px] items-center gap-2 rounded-xl border border-rose-600 bg-rose-950/80 px-3 text-xs font-bold text-rose-200">
                <WifiOff className="h-4 w-4 animate-pulse" />
                {t.offline}
              </span>
            )}

            {/* Locale Switcher: EN | ગુજરાતી | हिन्दी */}
            <div className="inline-flex min-h-[42px] items-center gap-1 rounded-xl border border-slate-700 bg-slate-800 p-1">
              <Languages className="ml-1.5 h-4 w-4 text-slate-400" />
              {(
                [
                  { code: 'en', label: 'EN' },
                  { code: 'gu', label: 'ગુજરાતી' },
                  { code: 'hi', label: 'हिन्दी' },
                ] as const
              ).map((lang) => (
                <button
                  key={lang.code}
                  type="button"
                  onClick={() => handleChangeLocale(lang.code)}
                  className={`rounded-lg px-2.5 py-1.5 text-xs font-bold transition ${
                    locale === lang.code
                      ? 'bg-brand-600 text-white'
                      : 'text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  {lang.label}
                </button>
              ))}
            </div>

            {/* Sound Controls */}
            <button
              type="button"
              onClick={() => {
                unlockAudio();
                setSoundEnabled((prev) => !prev);
              }}
              className={`inline-flex min-h-[42px] items-center gap-1.5 rounded-xl border px-3 text-xs font-bold ${
                soundEnabled
                  ? 'border-emerald-700/70 bg-emerald-950/60 text-emerald-200'
                  : 'border-slate-700 bg-slate-800 text-slate-400'
              }`}
            >
              {soundEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
              {soundEnabled ? t.soundOn : t.soundMuted}
            </button>

            <button
              type="button"
              onClick={() => {
                unlockAudio();
                playKdsChime(audioCtxRef.current);
              }}
              className="inline-flex min-h-[42px] items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3 text-xs font-semibold text-slate-200 hover:bg-slate-700"
            >
              <Bell className="h-4 w-4 text-amber-400" />
              {t.testChime}
            </button>

            <button
              type="button"
              onClick={() => void fetchBoard(false, true)}
              className="inline-flex min-h-[42px] items-center gap-1.5 rounded-xl bg-slate-100 px-3 text-xs font-bold text-slate-900 hover:bg-white"
            >
              <RefreshCw className="h-4 w-4" />
              {t.syncNow}
            </button>
          </div>
        </div>

        {/* Status Filter Bar & Counters */}
        <div className="mx-auto mt-3 flex max-w-[1600px] flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {(
              [
                { id: 'ALL', label: t.filterAll, count: counts.activeTotal },
                { id: KitchenStatus.NEW, label: t.statusNew, count: counts.newCount },
                { id: KitchenStatus.PREPARING, label: t.statusPreparing, count: counts.preparingCount },
                { id: KitchenStatus.READY, label: t.statusReady, count: counts.readyCount },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveFilter(tab.id)}
                className={`inline-flex min-h-[42px] items-center gap-2 rounded-xl px-4 text-sm font-bold transition ${
                  activeFilter === tab.id
                    ? 'bg-brand-600 text-white shadow'
                    : 'border border-slate-700 bg-slate-800/80 text-slate-200 hover:bg-slate-700'
                }`}
              >
                <span>{tab.label}</span>
                <span className="rounded-full bg-slate-950/60 px-2 py-0.5 text-xs">{tab.count}</span>
              </button>
            ))}

            {includeServed && (
              <button
                type="button"
                onClick={() => setActiveFilter(KitchenStatus.SERVED)}
                className={`inline-flex min-h-[42px] items-center gap-2 rounded-xl px-4 text-sm font-bold transition ${
                  activeFilter === KitchenStatus.SERVED
                    ? 'bg-slate-200 text-slate-950'
                    : 'border border-slate-700 bg-slate-800/80 text-slate-300 hover:bg-slate-700'
                }`}
              >
                <span>{t.statusServed}</span>
                <span className="rounded-full bg-slate-950/50 px-2 py-0.5 text-xs text-white">
                  {counts.servedCount}
                </span>
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {unackedCount > 0 && (
              <span className="inline-flex animate-pulse items-center gap-1.5 rounded-xl bg-amber-500 px-3 py-1.5 text-xs font-extrabold text-slate-950">
                <BellRing className="h-4 w-4" />
                {unackedCount} {t.unackedCounter}
              </span>
            )}

            <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-200">
              <input
                type="checkbox"
                checked={includeServed}
                onChange={(e) => {
                  setIncludeServed(e.target.checked);
                  if (!e.target.checked && activeFilter === KitchenStatus.SERVED) {
                    setActiveFilter('ALL');
                  }
                }}
                className="h-4 w-4 rounded accent-brand-500"
              />
              {t.includeServed}
            </label>
          </div>
        </div>
      </header>

      {/* Main Ticket Board */}
      <main className="mx-auto max-w-[1600px] space-y-4 p-4 sm:p-6">
        {!audioUnlocked && soundEnabled && (
          <button
            type="button"
            onClick={() => {
              unlockAudio();
              playKdsChime(audioCtxRef.current);
            }}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-amber-500/60 bg-amber-950/60 px-4 py-3 text-sm font-bold text-amber-200 hover:bg-amber-900/60"
          >
            <BellRing className="h-5 w-5 text-amber-400" />
            {t.enableSoundPrompt}
          </button>
        )}

        {connectionMode === 'POLLING_FALLBACK' && (
          <div className="flex items-center gap-3 rounded-xl border border-amber-600/70 bg-amber-950/70 px-4 py-3 text-sm font-semibold text-amber-200">
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400" />
            <span>{t.pollingBanner}</span>
          </div>
        )}

        {connectionMode === 'OFFLINE' && (
          <div className="flex items-center gap-3 rounded-xl border border-rose-600 bg-rose-950/80 px-4 py-3 text-sm font-semibold text-rose-100">
            <WifiOff className="h-5 w-5 shrink-0 text-rose-400" />
            <span>{t.offlineBanner}</span>
          </div>
        )}

        {banner && (
          <div
            className={`flex items-center justify-between rounded-xl px-4 py-3 text-sm font-semibold ${
              banner.type === 'error'
                ? 'border border-rose-700 bg-rose-950/80 text-rose-200'
                : banner.type === 'success'
                  ? 'border border-emerald-700 bg-emerald-950/70 text-emerald-200'
                  : 'border border-sky-700 bg-sky-950/70 text-sky-200'
            }`}
          >
            <span>{banner.text}</span>
            <button
              type="button"
              onClick={() => setBanner(null)}
              className="text-xs underline opacity-80 hover:opacity-100"
            >
              Dismiss
            </button>
          </div>
        )}

        {visibleTickets.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-slate-700 bg-slate-900/60 px-6 py-16 text-center">
            <ChefHat className="mx-auto h-12 w-12 text-slate-600" />
            <h2 className="mt-4 text-xl font-bold text-slate-200">{t.emptyBoardTitle}</h2>
            <p className="mt-1 text-sm text-slate-400">{t.emptyBoardHint}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {visibleTickets.map((ticket) => {
              const isUnackedNew =
                ticket.kitchenStatus === KitchenStatus.NEW && !ticket.acknowledgedAt;
              const elapsed = formatElapsed(ticket.createdAt, nowMs);
              const isBusy = busyOrderId === ticket.id;

              const borderStyle = isUnackedNew
                ? 'border-amber-400 ring-2 ring-amber-400/70'
                : ticket.kitchenStatus === KitchenStatus.NEW
                  ? 'border-sky-500'
                  : ticket.kitchenStatus === KitchenStatus.PREPARING
                    ? 'border-amber-500'
                    : ticket.kitchenStatus === KitchenStatus.READY
                      ? 'border-emerald-500'
                      : 'border-slate-700';

              const timerStyle =
                elapsed.minutes >= 15
                  ? 'animate-pulse bg-rose-600 text-white'
                  : elapsed.minutes >= 8
                    ? 'bg-amber-500 text-slate-950'
                    : 'bg-slate-800 text-slate-200';

              return (
                <article
                  key={ticket.id}
                  className={`flex flex-col justify-between overflow-hidden rounded-2xl border-2 bg-slate-900 shadow-lg ${borderStyle}`}
                >
                  <div>
                    {/* Unacknowledged Urgent Header Strip */}
                    {isUnackedNew && (
                      <div className="flex animate-pulse items-center justify-center gap-2 bg-amber-400 px-3 py-1.5 text-xs font-extrabold uppercase tracking-wider text-slate-950">
                        <BellRing className="h-4 w-4" />
                        {t.unackedBadge}
                      </div>
                    )}

                    {/* Ticket Card Top Info */}
                    <div className="border-b border-slate-800 bg-slate-900 px-4 py-3">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-2xl font-black tracking-tight text-white">
                              {t.tableLabel} {ticket.tableNumber}
                            </span>
                            <span className="rounded-lg bg-slate-800 px-2.5 py-0.5 text-xs font-extrabold text-brand-300">
                              KOT #{ticket.kotNumber}
                            </span>
                            {ticket.isAddOn && (
                              <span className="rounded-lg bg-fuchsia-600 px-2 py-0.5 text-[11px] font-extrabold uppercase text-white">
                                {t.addOnBadge} · {t.roundLabel} {ticket.roundNumber}
                              </span>
                            )}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                            {ticket.tableLabel && <span>{ticket.tableLabel} ·</span>}
                            <span>{ticket.source === 'STAFF_POS' ? 'Waiter' : 'Customer QR'}</span>
                            <span>·</span>
                            <span>
                              {new Date(ticket.createdAt).toLocaleTimeString('en-IN', {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </span>
                          </div>
                        </div>

                        <div className="flex flex-col items-end gap-1.5">
                          <span
                            className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 font-mono text-sm font-extrabold ${timerStyle}`}
                          >
                            <Clock className="h-3.5 w-3.5" />
                            {elapsed.text}
                          </span>
                          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-300">
                            {ticket.kitchenStatus === KitchenStatus.NEW
                              ? t.statusNew
                              : ticket.kitchenStatus === KitchenStatus.PREPARING
                                ? t.statusPreparing
                                : ticket.kitchenStatus === KitchenStatus.READY
                                  ? t.statusReady
                                  : ticket.kitchenStatus === KitchenStatus.SERVED
                                    ? t.statusServed
                                    : t.statusCancelled}
                          </span>
                        </div>
                      </div>

                      {ticket.acknowledgedAt && (
                        <div className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-emerald-950/60 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
                          <CheckCheck className="h-3.5 w-3.5" />
                          {t.ackedLabel}{' '}
                          {new Date(ticket.acknowledgedAt).toLocaleTimeString('en-IN', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                          {ticket.acknowledgedByName ? ` (${ticket.acknowledgedByName})` : ''}
                        </div>
                      )}
                    </div>

                    {/* Ticket Line Items */}
                    <ul className="divide-y divide-slate-800/80 px-4 py-2">
                      {ticket.items.map((item) => (
                        <li key={item.id} className="py-2.5">
                          <div className="flex items-start gap-2.5">
                            <span className="flex h-7 min-w-[2.2rem] shrink-0 items-center justify-center rounded-lg bg-slate-800 px-2 text-base font-black text-white">
                              {item.quantity}x
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                {dietaryIndicator(item.dietaryTypeSnapshot)}
                                <span className="text-base font-bold leading-snug text-white">
                                  {item.itemNameSnapshot}
                                </span>
                              </div>
                              {item.modifiersSnapshotJson?.length > 0 && (
                                <p className="mt-1 text-xs font-medium text-sky-300">
                                  + {item.modifiersSnapshotJson.map((m) => m.optionName).join(' · ')}
                                </p>
                              )}
                              {item.prepNotes && (
                                <p className="mt-1.5 inline-block rounded-md bg-amber-950/80 px-2 py-1 text-xs font-bold text-amber-200 ring-1 ring-amber-700/60">
                                  * {item.prepNotes}
                                </p>
                              )}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>

                    {ticket.notes && (
                      <div className="mx-4 mb-3 rounded-xl border border-amber-700/60 bg-amber-950/60 px-3 py-2 text-xs font-bold text-amber-200">
                        {t.notesLabel}: {ticket.notes}
                      </div>
                    )}
                  </div>

                  {/* Large Tablet Touch Action Bar */}
                  <div className="space-y-2 border-t border-slate-800 bg-slate-900/90 p-3">
                    {isUnackedNew && canManageKitchen && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void handleAcknowledge(ticket.id)}
                        className="flex min-h-[54px] w-full items-center justify-center gap-2 rounded-xl bg-amber-400 px-4 text-base font-black text-slate-950 shadow hover:bg-amber-300 disabled:opacity-50"
                      >
                        <BellRing className="h-5 w-5" />
                        {t.btnAcknowledge}
                      </button>
                    )}

                    <div className="flex items-stretch gap-2">
                      {ticket.kitchenStatus === KitchenStatus.NEW && canManageKitchen && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleTransition(ticket.id, KitchenStatus.PREPARING)}
                          className="flex min-h-[54px] flex-1 items-center justify-center gap-2 rounded-xl bg-sky-500 px-4 text-base font-extrabold text-slate-950 hover:bg-sky-400 disabled:opacity-50"
                        >
                          <Flame className="h-5 w-5" />
                          {t.btnStartPreparing}
                        </button>
                      )}

                      {ticket.kitchenStatus === KitchenStatus.PREPARING && canManageKitchen && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleTransition(ticket.id, KitchenStatus.READY)}
                          className="flex min-h-[54px] flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 text-base font-extrabold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
                        >
                          <CheckCheck className="h-5 w-5" />
                          {t.btnMarkReady}
                        </button>
                      )}

                      {ticket.kitchenStatus === KitchenStatus.READY && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleTransition(ticket.id, KitchenStatus.SERVED)}
                          className="flex min-h-[54px] flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-500 px-4 text-base font-extrabold text-white hover:bg-indigo-400 disabled:opacity-50"
                        >
                          <CheckCheck className="h-5 w-5" />
                          {t.btnMarkServed}
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => setPrintingTicket(ticket)}
                        title={t.btnPrintKot}
                        aria-label={t.btnPrintKot}
                        className="inline-flex min-h-[54px] min-w-[54px] items-center justify-center rounded-xl border border-slate-700 bg-slate-800 px-3 text-slate-200 hover:bg-slate-700"
                      >
                        <Printer className="h-5 w-5" />
                      </button>

                      {canManageKitchen &&
                        (ticket.kitchenStatus === KitchenStatus.NEW ||
                          ticket.kitchenStatus === KitchenStatus.PREPARING) && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => void handleCancelTicket(ticket)}
                            title={t.btnCancelKot}
                            aria-label={t.btnCancelKot}
                            className="inline-flex min-h-[54px] min-w-[54px] items-center justify-center rounded-xl border border-rose-800 bg-rose-950/60 px-3 text-rose-300 hover:bg-rose-900/70 disabled:opacity-50"
                          >
                            <XCircle className="h-5 w-5" />
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

      {printingTicket && (
        <KotPrintModal
          ticket={printingTicket}
          outletName={session.outlet?.name || session.tenant?.name || 'AutoNex Restaurant'}
          onClose={() => setPrintingTicket(null)}
        />
      )}
    </div>
  );
}

