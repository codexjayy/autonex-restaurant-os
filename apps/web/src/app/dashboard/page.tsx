'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { formatInrFromPaise } from '@autonex/shared';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@autonex/ui';
import {
  Activity,
  ArrowRight,
  Building2,
  CheckCircle2,
  ChefHat,
  Circle,
  Clock,
  CreditCard,
  Eye,
  IndianRupee,
  QrCode,
  RefreshCw,
  Settings,
  ShieldAlert,
  ShieldCheck,
  ShoppingBag,
  Store,
  Users,
  UtensilsCrossed,
  X,
} from 'lucide-react';
import { DashboardShell } from '@/components/dashboard-shell';
import {
  ApiError,
  ensureFreshAccessToken,
  getCurrentTenant,
  getStoredSession,
  getUsersMe,
  getWorkspaceOverview,
  listOutlets,
  OutletRecordDto,
  setStoredSession,
  subscribeWorkspaceSync,
  TenantCurrentDto,
  UserMeProfileDto,
  WorkspaceOverviewResponse,
} from '@/lib/api-client';

function formatShortDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatDateTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatActivityLabel(action: string): string {
  return action
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function displayTenantStatus(status?: string): string {
  switch (status) {
    case 'ACTIVE':
      return 'APPROVED';
    case 'TRIAL':
      return 'APPROVED (TRIAL)';
    case 'PENDING_APPROVAL':
      return 'PENDING_APPROVAL';
    case 'REJECTED':
      return 'REJECTED';
    case 'SUSPENDED':
      return 'SUSPENDED';
    case 'LOCKED':
      return 'SUSPENDED (LOCKED)';
    case 'GRACE':
      return 'APPROVED (GRACE)';
    default:
      return status ?? 'UNAVAILABLE';
  }
}

export default function DashboardOverviewPage() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tenant, setTenant] = useState<TenantCurrentDto | null>(null);
  const [me, setMe] = useState<UserMeProfileDto | null>(null);
  const [outlets, setOutlets] = useState<OutletRecordDto[]>([]);
  const [overview, setOverview] = useState<WorkspaceOverviewResponse | null>(null);
  const [statusModalOpen, setStatusModalOpen] = useState(false);
  const [restrictedStatus, setRestrictedStatus] = useState<'SUSPENDED' | 'REJECTED' | null>(null);

  const loadData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      let stored = getStoredSession('tenant');
      if (!stored?.accessToken) {
        const refreshed = await ensureFreshAccessToken('tenant');
        if (!refreshed) {
          setLoading(false);
          setRefreshing(false);
          return;
        }
        stored = getStoredSession('tenant');
      }
      if (!stored?.user?.tenantId || stored.user?.isSuperAdmin) {
        setLoading(false);
        setRefreshing(false);
        return;
      }

      if (stored.user.tenantStatus === 'SUSPENDED' || stored.user.tenantStatus === 'REJECTED') {
        setRestrictedStatus(stored.user.tenantStatus);
      }

      const [meRes, tenantRes, outletRes, overviewRes] = await Promise.allSettled([
        getUsersMe(),
        getCurrentTenant(),
        listOutlets(),
        getWorkspaceOverview(),
      ]);

      const errors: string[] = [];
      let detectedRestricted: 'SUSPENDED' | 'REJECTED' | null = null;

      const inspectRestricted = (reason: unknown) => {
        if (reason instanceof ApiError) {
          if (reason.code === 'TENANT_SUSPENDED') detectedRestricted = 'SUSPENDED';
          else if (reason.code === 'TENANT_REJECTED') detectedRestricted = 'REJECTED';
        }
      };

      if (meRes.status === 'fulfilled') {
        setMe(meRes.value);
      } else {
        inspectRestricted(meRes.reason);
        errors.push(
          meRes.reason instanceof ApiError ? meRes.reason.message : 'Unable to load user profile',
        );
      }

      if (tenantRes.status === 'fulfilled') {
        setTenant(tenantRes.value);
        if (stored.user.tenantStatus !== tenantRes.value.status) {
          setStoredSession(
            {
              ...stored,
              user: { ...stored.user, tenantStatus: tenantRes.value.status },
              tenant: {
                id: tenantRes.value.id,
                name: tenantRes.value.name,
                slug: tenantRes.value.slug,
                status: tenantRes.value.status,
              },
            },
            'tenant',
          );
        }
      } else {
        inspectRestricted(tenantRes.reason);
        errors.push(
          tenantRes.reason instanceof ApiError
            ? tenantRes.reason.message
            : 'Unable to load restaurant account status',
        );
      }

      if (outletRes.status === 'fulfilled') {
        setOutlets(outletRes.value);
      } else {
        inspectRestricted(outletRes.reason);
        errors.push(
          outletRes.reason instanceof ApiError ? outletRes.reason.message : 'Unable to load outlets',
        );
      }

      if (overviewRes.status === 'fulfilled') {
        setOverview(overviewRes.value);
      } else if (overviewRes.reason instanceof ApiError) {
        inspectRestricted(overviewRes.reason);
        errors.push(overviewRes.reason.message);
      }

      if (detectedRestricted) {
        setRestrictedStatus(detectedRestricted);
      } else if (overviewRes.status === 'fulfilled' || tenantRes.status === 'fulfilled') {
        setRestrictedStatus(null);
      }

      if (errors.length > 0) {
        setError(errors[0] ?? 'Unable to load dashboard workspace');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load dashboard workspace');
    } finally {
      if (!silent) setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadData(false);
    return subscribeWorkspaceSync(() => {
      void loadData(true);
    });
  }, [loadData]);

  const liveTenantStatus =
    restrictedStatus ?? overview?.tenant?.status ?? tenant?.status ?? me?.tenantStatus;

  useEffect(() => {
    if (liveTenantStatus !== 'PENDING_APPROVAL') return;
    const timer = window.setInterval(() => {
      void loadData(true);
    }, 6000);
    return () => window.clearInterval(timer);
  }, [liveTenantStatus, loadData]);

  const activeOutlet =
    outlets.find((o) => o.id === me?.outletId) ?? outlets[0] ?? overview?.activeOutlet;
  const outletsCount = overview?.outletsCount ?? outlets.length;

  const checklist = overview?.checklist;
  const checklistItems = checklist
    ? [
        {
          label: 'Complete restaurant & outlet profile',
          done: checklist.steps.profileComplete,
          href: '/dashboard/settings',
        },
        {
          label: 'AutoNex platform approval',
          done: checklist.steps.adminApproved,
          onClick: () => setStatusModalOpen(true),
        },
        {
          label: 'Configure menu categories & dishes',
          done: checklist.steps.menuConfigured,
          href: '/dashboard/menu',
        },
        {
          label: 'Add dining floor tables',
          done: checklist.steps.tablesConfigured,
          href: '/dashboard/floor',
        },
        {
          label: 'Generate permanent table QR codes',
          done: checklist.steps.qrGenerated,
          href: '/dashboard/tables',
        },
        {
          label: 'Invite & activate floor/kitchen staff',
          done: checklist.steps.staffAdded,
          href: '/dashboard/team',
        },
      ]
    : [];

  const sub = overview?.subscription;
  const metrics = overview?.metrics;
  const recentActivity = overview?.recentActivity ?? [];

  const statusBadgeVariant =
    liveTenantStatus === 'ACTIVE' || liveTenantStatus === 'TRIAL'
      ? ('success' as const)
      : liveTenantStatus === 'REJECTED' ||
          liveTenantStatus === 'SUSPENDED' ||
          liveTenantStatus === 'LOCKED'
        ? ('destructive' as const)
        : liveTenantStatus
          ? ('warning' as const)
          : ('secondary' as const);

  return (
    <DashboardShell
      title="Workspace Overview"
      subtitle="Live operations telemetry, onboarding readiness, subscription plan, and branch health."
      onOutletChanged={() => void loadData(false)}
      actions={
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            data-testid="overview-view-status-top"
            onClick={() => setStatusModalOpen(true)}
          >
            <Eye className="mr-1.5 h-3.5 w-3.5" />
            View Status
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={loading || refreshing}
            onClick={() => void loadData(true)}
          >
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      }
    >
      {error && (
        <Alert variant="destructive" className="mb-5">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Pending / Restricted Account Approval Banner */}
      {liveTenantStatus === 'PENDING_APPROVAL' && (
        <div
          data-testid="pending-approval-banner"
          className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-amber-950 shadow-sm"
        >
          <div className="flex items-start gap-3">
            <Clock className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
            <div>
              <p className="text-sm font-semibold">
                Your restaurant registration is under AutoNex verification.
              </p>
              <p className="text-xs text-amber-900/80">
                You can configure outlets, menu items, tables, and staff while an AutoNex
                platform administrator reviews your account. Status updates automatically upon
                approval.
              </p>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            data-testid="view-status-btn"
            onClick={() => setStatusModalOpen(true)}
            className="border-amber-400 bg-white text-amber-950 hover:bg-amber-100"
          >
            <Eye className="mr-1.5 h-3.5 w-3.5" />
            View Status
          </Button>
        </div>
      )}

      {(liveTenantStatus === 'REJECTED' ||
        liveTenantStatus === 'SUSPENDED' ||
        liveTenantStatus === 'LOCKED') && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-red-950">
          <div className="flex items-start gap-3">
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
            <div>
              <p className="text-sm font-semibold">
                Account Status: {displayTenantStatus(liveTenantStatus)}
              </p>
              <p className="text-xs text-red-900/85">
                {overview?.tenant?.rejectionReason ||
                  overview?.tenant?.suspensionReason ||
                  'Access is currently restricted by AutoNex administration.'}
              </p>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            data-testid="view-status-btn"
            onClick={() => setStatusModalOpen(true)}
            className="border-red-300 bg-white text-red-900 hover:bg-red-100"
          >
            View Status
          </Button>
        </div>
      )}

      {loading ? (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[1, 2, 3, 4].map((i) => (
              <Card key={i} className="h-32 animate-pulse bg-secondary/40" />
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[1, 2, 3, 4].map((i) => (
              <Card key={i} className="h-28 animate-pulse bg-secondary/40" />
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Primary Account, Subscription, Outlets & Role Grid */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="border-border bg-white">
              <CardHeader className="pb-2">
                <CardDescription>Restaurant Account Status</CardDescription>
                <CardTitle className="truncate text-lg" data-testid="overview-tenant-name">
                  {overview?.tenant?.name ?? tenant?.name ?? 'Your Restaurant'}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <Badge data-testid="overview-tenant-status" variant={statusBadgeVariant}>
                  {displayTenantStatus(liveTenantStatus)}
                </Badge>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="card-view-status-btn"
                  onClick={() => setStatusModalOpen(true)}
                >
                  View Status
                </Button>
              </CardContent>
            </Card>

            <Card className="border-border bg-white">
              <CardHeader className="pb-2">
                <CardDescription>Subscription Plan & Expiry</CardDescription>
                <CardTitle className="flex items-center justify-between gap-2 text-lg">
                  <span className="truncate">{sub?.planName ?? 'Starter Trial'}</span>
                  <CreditCard className="h-4 w-4 shrink-0 text-primary" />
                </CardTitle>
              </CardHeader>
              <CardContent className="flex items-center justify-between gap-2 pt-1">
                <div className="text-xs text-muted-foreground">
                  {sub ? (
                    <>
                      <span className="font-semibold text-foreground">{sub.status}</span>
                      {' • '}
                      {sub.daysRemaining !== null
                        ? `${sub.daysRemaining}d left (${formatShortDate(sub.expiryDate)})`
                        : formatShortDate(sub.expiryDate)}
                    </>
                  ) : (
                    'Plan details pending'
                  )}
                </div>
                <Button size="sm" variant="outline" asChild>
                  <Link href="/dashboard/plan">Plan</Link>
                </Button>
              </CardContent>
            </Card>

            <Card className="border-border bg-white">
              <CardHeader className="pb-2">
                <CardDescription>Active Outlets</CardDescription>
                <CardTitle className="flex items-center justify-between gap-2 text-lg">
                  <span className="truncate" data-testid="overview-active-outlet">
                    {activeOutlet?.name ?? 'Primary Branch'}
                  </span>
                  <Store className="h-4 w-4 shrink-0 text-primary" />
                </CardTitle>
              </CardHeader>
              <CardContent className="flex items-center justify-between gap-2 pt-1">
                <span className="text-xs text-muted-foreground">
                  {outletsCount} outlet{outletsCount === 1 ? '' : 's'} configured
                </span>
                <Button size="sm" variant="outline" asChild>
                  <Link href="/dashboard/outlets">Manage</Link>
                </Button>
              </CardContent>
            </Card>

            <Card className="border-border bg-white">
              <CardHeader className="pb-2">
                <CardDescription>Your Role & Permissions</CardDescription>
                <CardTitle className="flex items-center justify-between gap-2 text-lg">
                  <span>{me?.role ?? 'OWNER'}</span>
                  <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-600" />
                </CardTitle>
              </CardHeader>
              <CardContent className="flex items-center justify-between gap-2 pt-1">
                <span className="text-xs text-muted-foreground">
                  {me?.permissions?.length ?? 0} capabilities active
                </span>
                <Button size="sm" variant="outline" asChild>
                  <Link href="/dashboard/team">Team</Link>
                </Button>
              </CardContent>
            </Card>
          </div>

          {/* Live Restaurant KPI Cards (Staff, Tables, Menu, Today's Orders, Today's Revenue) */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Card className="border-border bg-white">
              <CardHeader className="flex flex-row items-center justify-between pb-1">
                <CardDescription className="text-xs font-medium uppercase tracking-wide">
                  Staff Members
                </CardDescription>
                <Users className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-foreground" data-testid="kpi-staff-count">
                  {metrics?.staffCount ?? 1}
                </div>
                <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{metrics?.pendingInvitationsCount ?? 0} pending invite(s)</span>
                  <Link href="/dashboard/team" className="font-medium text-primary hover:underline">
                    Manage
                  </Link>
                </div>
              </CardContent>
            </Card>

            <Card className="border-border bg-white">
              <CardHeader className="flex flex-row items-center justify-between pb-1">
                <CardDescription className="text-xs font-medium uppercase tracking-wide">
                  Total Tables
                </CardDescription>
                <Building2 className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-foreground" data-testid="kpi-tables-count">
                  {metrics?.totalTables ?? 0}
                </div>
                <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {metrics?.occupiedTables ?? 0} occupied • {metrics?.activeQrCount ?? 0} QR
                  </span>
                  <Link href="/dashboard/tables" className="font-medium text-primary hover:underline">
                    Tables
                  </Link>
                </div>
              </CardContent>
            </Card>

            <Card className="border-border bg-white">
              <CardHeader className="flex flex-row items-center justify-between pb-1">
                <CardDescription className="text-xs font-medium uppercase tracking-wide">
                  Menu Items
                </CardDescription>
                <UtensilsCrossed className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-foreground" data-testid="kpi-menu-count">
                  {metrics?.menuItemsCount ?? 0}
                </div>
                <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{metrics?.categoriesCount ?? 0} active categories</span>
                  <Link href="/dashboard/menu" className="font-medium text-primary hover:underline">
                    Menu
                  </Link>
                </div>
              </CardContent>
            </Card>

            <Card className="border-border bg-white">
              <CardHeader className="flex flex-row items-center justify-between pb-1">
                <CardDescription className="text-xs font-medium uppercase tracking-wide">
                  Today&apos;s Orders
                </CardDescription>
                <ShoppingBag className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-foreground" data-testid="kpi-orders-today">
                  {metrics?.ordersTodayCount ?? 0}
                </div>
                <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{metrics?.activeKitchenOrdersCount ?? 0} live in kitchen</span>
                  <Link href="/dashboard/kds" className="font-medium text-primary hover:underline">
                    KDS
                  </Link>
                </div>
              </CardContent>
            </Card>

            <Card className="border-border bg-white">
              <CardHeader className="flex flex-row items-center justify-between pb-1">
                <CardDescription className="text-xs font-medium uppercase tracking-wide">
                  Today&apos;s Revenue
                </CardDescription>
                <IndianRupee className="h-4 w-4 text-emerald-600" />
              </CardHeader>
              <CardContent>
                <div
                  className="text-2xl font-bold text-emerald-700"
                  data-testid="kpi-revenue-today"
                >
                  {formatInrFromPaise(metrics?.revenueTodayPaise ?? 0)}
                </div>
                <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{metrics?.sessionsTodayCount ?? 0} dining sessions</span>
                  <Link
                    href="/dashboard/billing"
                    className="font-medium text-primary hover:underline"
                  >
                    Billing
                  </Link>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Onboarding Progress + Recent Activity + Quick Actions */}
          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="border-border bg-white">
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <ShieldCheck className="h-5 w-5 text-primary" />
                      Onboarding Progress
                    </CardTitle>
                    <CardDescription>
                      Restaurant Onboarding Checklist — synced with live database telemetry.
                    </CardDescription>
                  </div>
                  {checklist && (
                    <Badge variant={checklist.goLiveReady ? 'success' : 'warning'}>
                      {checklist.completedCount}/{checklist.totalCount} ({checklist.progressPercent}
                      %)
                    </Badge>
                  )}
                </div>
                {checklist && (
                  <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-secondary">
                    <div
                      className="h-full rounded-full bg-primary transition-all duration-300"
                      style={{ width: `${checklist.progressPercent}%` }}
                    />
                  </div>
                )}
              </CardHeader>
              <CardContent className="space-y-2.5">
                {checklistItems.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Checklist metrics will appear once an active outlet is selected.
                  </p>
                ) : (
                  checklistItems.map((item) => {
                    const rowInner = (
                      <div className="flex w-full items-center justify-between rounded-lg border border-border px-3 py-2.5 text-sm transition hover:border-primary/40 hover:bg-secondary/30">
                        <span className="flex items-center gap-2.5">
                          {item.done ? (
                            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                          ) : (
                            <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />
                          )}
                          <span className={item.done ? 'font-medium text-foreground' : 'text-muted-foreground'}>
                            {item.label}
                          </span>
                        </span>
                        <span className="flex items-center gap-2">
                          <Badge variant={item.done ? 'success' : 'secondary'}>
                            {item.done ? 'Done' : 'Pending'}
                          </Badge>
                          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                        </span>
                      </div>
                    );
                    return item.href ? (
                      <Link key={item.label} href={item.href} className="block">
                        {rowInner}
                      </Link>
                    ) : (
                      <button
                        key={item.label}
                        type="button"
                        onClick={item.onClick}
                        className="block w-full text-left"
                      >
                        {rowInner}
                      </button>
                    );
                  })
                )}
              </CardContent>
            </Card>

            <div className="space-y-6">
              <Card className="border-border bg-white">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Activity className="h-5 w-5 text-primary" />
                    Recent Activity
                  </CardTitle>
                  <CardDescription>
                    Real-time workspace audit events for {overview?.tenant?.name ?? tenant?.name}.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {recentActivity.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                      No workspace activity recorded yet.
                    </p>
                  ) : (
                    <div className="divide-y divide-border" data-testid="recent-activity-list">
                      {recentActivity.slice(0, 6).map((item) => (
                        <div
                          key={item.id}
                          className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-xs"
                        >
                          <div className="min-w-0">
                            <span className="font-semibold text-foreground">
                              {formatActivityLabel(item.action)}
                            </span>
                            <span className="ml-2 text-muted-foreground">
                              by {item.actorName} ({item.actorRole})
                            </span>
                          </div>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {formatDateTime(item.createdAt)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card className="border-border bg-white">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Quick Operations Shortcuts</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-2.5 sm:grid-cols-2">
                  <Button variant="outline" className="h-auto justify-start gap-3 p-3.5" asChild>
                    <Link href="/dashboard/menu">
                      <UtensilsCrossed className="h-4 w-4 text-primary" />
                      <div className="text-left">
                        <div className="text-sm font-semibold">Menu Editor</div>
                        <div className="text-xs text-muted-foreground">Categories & dishes</div>
                      </div>
                    </Link>
                  </Button>

                  <Button variant="outline" className="h-auto justify-start gap-3 p-3.5" asChild>
                    <Link href="/dashboard/tables">
                      <QrCode className="h-4 w-4 text-primary" />
                      <div className="text-left">
                        <div className="text-sm font-semibold">Tables & QR</div>
                        <div className="text-xs text-muted-foreground">Floor tables & QR PDF</div>
                      </div>
                    </Link>
                  </Button>

                  <Button variant="outline" className="h-auto justify-start gap-3 p-3.5" asChild>
                    <Link href="/dashboard/kds">
                      <ChefHat className="h-4 w-4 text-primary" />
                      <div className="text-left">
                        <div className="text-sm font-semibold">Kitchen KDS</div>
                        <div className="text-xs text-muted-foreground">Live prep tickets</div>
                      </div>
                    </Link>
                  </Button>

                  <Button variant="outline" className="h-auto justify-start gap-3 p-3.5" asChild>
                    <Link href="/dashboard/settings">
                      <Settings className="h-4 w-4 text-primary" />
                      <div className="text-left">
                        <div className="text-sm font-semibold">Settings & GST</div>
                        <div className="text-xs text-muted-foreground">Outlet tax & rules</div>
                      </div>
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      )}

      {/* VIEW APPROVAL STATUS MODAL */}
      {statusModalOpen && (
        <div
          data-testid="status-details-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
        >
          <Card className="w-full max-w-lg border-border bg-white shadow-2xl">
            <CardHeader className="flex flex-row items-start justify-between gap-2 border-b border-border pb-4">
              <div>
                <CardTitle>Restaurant Verification & Approval Status</CardTitle>
                <CardDescription>
                  Live PostgreSQL account governance state for{' '}
                  {overview?.tenant?.name ?? tenant?.name ?? 'your restaurant'}.
                </CardDescription>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setStatusModalOpen(false)}>
                <X className="h-4 w-4" />
              </Button>
            </CardHeader>
            <CardContent className="space-y-4 pt-5 text-sm">
              <div className="flex items-center justify-between rounded-lg border border-border bg-secondary/30 p-3.5">
                <span className="font-medium text-muted-foreground">Current Status</span>
                <Badge variant={statusBadgeVariant}>{displayTenantStatus(liveTenantStatus)}</Badge>
              </div>

              {liveTenantStatus === 'PENDING_APPROVAL' && (
                <Alert className="border-amber-300 bg-amber-50 text-amber-950">
                  <AlertDescription className="text-xs">
                    <strong>Your restaurant registration is under AutoNex verification.</strong>{' '}
                    Only an authorized AutoNex Super Admin can approve your account. This dashboard
                    refreshes automatically once verification completes.
                  </AlertDescription>
                </Alert>
              )}

              {(overview?.tenant?.rejectionReason || overview?.tenant?.suspensionReason) && (
                <Alert variant="destructive">
                  <AlertDescription className="text-xs">
                    {overview?.tenant?.rejectionReason || overview?.tenant?.suspensionReason}
                  </AlertDescription>
                </Alert>
              )}

              <div className="grid gap-2.5 rounded-lg border border-border p-3.5 text-xs">
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Registered At</span>
                  <span className="font-medium">
                    {formatDateTime(overview?.tenant?.createdAt)}
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Approved At</span>
                  <span className="font-medium">
                    {formatDateTime(overview?.tenant?.approvedAt ?? tenant?.approvedAt)}
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Subscription Plan</span>
                  <span className="font-medium">
                    {sub ? `${sub.planName} (${sub.status})` : 'Starter Trial'}
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Plan Expiry</span>
                  <span className="font-medium">{formatShortDate(sub?.expiryDate)}</span>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void loadData(true)}
                  disabled={refreshing}
                >
                  <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                  Check Latest Status
                </Button>
                <Button size="sm" onClick={() => setStatusModalOpen(false)}>
                  Close
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </DashboardShell>
  );
}
