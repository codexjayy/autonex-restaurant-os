'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
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
  Input,
  Label,
  Select,
} from '@autonex/ui';
import {
  BarChart3,
  Building2,
  CheckCircle2,
  Clock,
  CreditCard,
  Eye,
  FileText,
  IndianRupee,
  KeyRound,
  LifeBuoy,
  LogOut,
  Mail,
  MapPin,
  PauseCircle,
  Pencil,
  Phone,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Store,
  UserCheck,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import {
  AdminAuditLogEntry,
  AdminOverviewResponse,
  AdminPaymentsResponse,
  AdminPlatformUserDto,
  AdminRestaurantDetail,
  AdminRestaurantRow,
  AdminSubscriptionRow,
  ApiError,
  apiRequest,
  approveAdminRestaurant,
  broadcastWorkspaceSync,
  changeSuperAdminPassword,
  clearStoredSession,
  createSuperAdminAccount,
  ensureFreshAccessToken,
  extendAdminTrial,
  getAdminMe,
  getAdminPayments,
  getAdminPlatformOverview,
  getAdminPlatformSettings,
  getAdminRestaurantDetail,
  getStoredSession,
  listAdminRestaurants,
  listAdminSubscriptions,
  listAdminUsers,
  logoutSession,
  markAdminInvoicePaid,
  offboardAdminRestaurant,
  PlanDto,
  PlatformSettingsDto,
  reactivateAdminRestaurant,
  rejectAdminRestaurant,
  runAdminSubscriptionSweep,
  subscribeRealtimeStream,
  subscribeWorkspaceSync,
  SubscriptionBillingCycle,
  SubscriptionStatus,
  SupportCaseDto,
  SupportCaseStatus,
  suspendAdminRestaurant,
  TenantStatus,
  updateAdminPlan,
  updateAdminPlatformSettings,
  updateAdminUserStatus,
} from '@/lib/api-client';
import { AnalyticsPanel } from '@/components/super-admin/analytics-panel';
import { PendingApprovalsPanel } from '@/components/super-admin/pending-approvals-panel';
import {
  PaymentsRevenuePanel,
  TrialManagementPanel,
} from '@/components/super-admin/trials-payments-panel';
import {
  PlatformSettingsPanel,
  UsersAdminsPanel,
} from '@/components/super-admin/users-settings-panel';

type AdminTab =
  | 'ANALYTICS'
  | 'RESTAURANTS'
  | 'PENDING_QUEUE'
  | 'PLANS'
  | 'PAYMENTS'
  | 'TRIALS'
  | 'USERS'
  | 'SETTINGS'
  | 'AUDIT'
  | 'SUPPORT'
  | 'SECURITY';
type RestaurantFilter = 'ALL' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';

function formatInr(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', {
    minimumFractionDigits: paise % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
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

function tenantStatusBadgeVariant(status: string) {
  switch (status) {
    case TenantStatus.ACTIVE:
    case TenantStatus.TRIAL:
      return 'success' as const;
    case TenantStatus.PENDING_APPROVAL:
    case TenantStatus.GRACE:
      return 'warning' as const;
    case TenantStatus.REJECTED:
    case TenantStatus.SUSPENDED:
    case TenantStatus.LOCKED:
      return 'destructive' as const;
    default:
      return 'secondary' as const;
  }
}

function tenantStatusDisplay(status: string): string {
  switch (status) {
    case TenantStatus.ACTIVE:
      return 'APPROVED • ACTIVE';
    case TenantStatus.TRIAL:
      return 'APPROVED • TRIAL';
    default:
      return status;
  }
}

export default function SuperAdminDashboardPage() {
  const router = useRouter();
  const [authorized, setAuthorized] = useState(false);
  const [adminUserId, setAdminUserId] = useState<string | undefined>(undefined);
  const [adminName, setAdminName] = useState('Super Admin');
  const [requiresPasswordChange, setRequiresPasswordChange] = useState(false);
  const [activeTab, setActiveTab] = useState<AdminTab>('RESTAURANTS');
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Core Data
  const [overviewData, setOverviewData] = useState<AdminOverviewResponse | null>(null);
  const [restaurants, setRestaurants] = useState<AdminRestaurantRow[]>([]);
  const [plans, setPlans] = useState<PlanDto[]>([]);
  const [subscriptions, setSubscriptions] = useState<AdminSubscriptionRow[]>([]);
  const [paymentsData, setPaymentsData] = useState<AdminPaymentsResponse | null>(null);
  const [platformUsers, setPlatformUsers] = useState<AdminPlatformUserDto[]>([]);
  const [platformSettings, setPlatformSettings] = useState<PlatformSettingsDto | null>(null);
  const [supportCases, setSupportCases] = useState<SupportCaseDto[]>([]);
  const [auditLogs, setAuditLogs] = useState<AdminAuditLogEntry[]>([]);

  // Plan edit modal
  const [editingPlan, setEditingPlan] = useState<PlanDto | null>(null);
  const [editPlanName, setEditPlanName] = useState('');
  const [editPlanMonthlyInr, setEditPlanMonthlyInr] = useState('');
  const [editPlanYearlyInr, setEditPlanYearlyInr] = useState('');
  const [editPlanMaxTables, setEditPlanMaxTables] = useState('');
  const [editPlanMaxStaff, setEditPlanMaxStaff] = useState('');

  // Filters
  const [statusFilter, setStatusFilter] = useState<RestaurantFilter>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [auditActionFilter, setAuditActionFilter] = useState('');
  const [auditTenantFilter, setAuditTenantFilter] = useState('');

  // Restaurant Details Modal
  const [detailLoading, setDetailLoading] = useState(false);
  const [selectedDetail, setSelectedDetail] = useState<AdminRestaurantDetail | null>(null);

  // Action Modals (Approve / Reject / Suspend / Subscription / Onboard)
  const [approveTarget, setApproveTarget] = useState<AdminRestaurantRow | null>(null);
  const [approveMode, setApproveMode] = useState<'ACTIVE' | 'TRIAL'>('ACTIVE');
  const [approveNote, setApproveNote] = useState('');

  const [rejectTarget, setRejectTarget] = useState<AdminRestaurantRow | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const [suspendTarget, setSuspendTarget] = useState<AdminRestaurantRow | null>(null);
  const [suspendReason, setSuspendReason] = useState('');

  const [subTargetTenant, setSubTargetTenant] = useState<AdminRestaurantRow | null>(null);
  const [assignPlanId, setAssignPlanId] = useState('');
  const [assignStatus, setAssignStatus] = useState<SubscriptionStatus>(SubscriptionStatus.ACTIVE);
  const [assignCycle, setAssignCycle] = useState<SubscriptionBillingCycle>(
    SubscriptionBillingCycle.MONTHLY,
  );
  const [assignPaymentRef, setAssignPaymentRef] = useState('');

  const [onboardOpen, setOnboardOpen] = useState(false);
  const [obName, setObName] = useState('');
  const [obOutlet, setObOutlet] = useState('Main Outlet');
  const [obOwnerName, setObOwnerName] = useState('');
  const [obEmail, setObEmail] = useState('');
  const [obPhone, setObPhone] = useState('');
  const [obPassword, setObPassword] = useState('');
  const [obPlanId, setObPlanId] = useState('');

  // New plan form
  const [planCode, setPlanCode] = useState('');
  const [planName, setPlanName] = useState('');
  const [planMonthlyInr, setPlanMonthlyInr] = useState('999');
  const [planYearlyInr, setPlanYearlyInr] = useState('9990');
  const [planMaxTables, setPlanMaxTables] = useState('30');
  const [planMaxStaff, setPlanMaxStaff] = useState('15');

  // Support note state
  const [noteDrafts, setNoteDrafts] = useState<
    Record<string, { body: string; isInternal: boolean }>
  >({});

  // Super Admin security tab state
  const [secCurrentPassword, setSecCurrentPassword] = useState('');
  const [secNewPassword, setSecNewPassword] = useState('');
  const [secConfirmPassword, setSecConfirmPassword] = useState('');

  // Strict RBAC guard on mount
  useEffect(() => {
    let active = true;
    const verifySuperAdmin = async () => {
      let stored = getStoredSession('super-admin');
      if (!stored?.accessToken) {
        const refreshed = await ensureFreshAccessToken('super-admin');
        if (!refreshed) {
          if (active) router.replace('/super-admin/login');
          return;
        }
        stored = getStoredSession('super-admin');
      }
      if (!stored?.user?.isSuperAdmin || stored.user?.role !== 'SUPER_ADMIN') {
        router.replace('/super-admin/login?error=unauthorized');
        return;
      }
      try {
        const me = await getAdminMe();
        if (!active) return;
        if (!me.isSuperAdmin || me.role !== 'SUPER_ADMIN') {
          router.replace('/super-admin/login?error=unauthorized');
          return;
        }
        setAdminUserId(me.id);
        setAdminName(me.name || 'Super Admin');
        setRequiresPasswordChange(Boolean(me.requiresPasswordChange));
        setAuthorized(true);
      } catch {
        if (!active) return;
        clearStoredSession('super-admin');
        router.replace('/super-admin/login?error=unauthorized');
      }
    };
    void verifySuperAdmin();
    return () => {
      active = false;
    };
  }, [router]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const backendStatus = statusFilter === 'ALL' ? undefined : statusFilter;
      const [ov, rests, planList, subs, payments, usersList, settingsObj, cases, logs] =
        await Promise.all([
          getAdminPlatformOverview(),
          listAdminRestaurants(backendStatus),
          apiRequest<PlanDto[]>('/admin/plans'),
          listAdminSubscriptions(),
          getAdminPayments(),
          listAdminUsers(),
          getAdminPlatformSettings(),
          apiRequest<SupportCaseDto[]>('/admin/support-cases'),
          apiRequest<AdminAuditLogEntry[]>(
            `/admin/audit-logs?limit=100${
              auditTenantFilter ? `&tenantId=${encodeURIComponent(auditTenantFilter)}` : ''
            }${auditActionFilter ? `&action=${encodeURIComponent(auditActionFilter)}` : ''}`,
          ),
        ]);
      setOverviewData(ov);
      setRestaurants(rests);
      setPlans(planList);
      setSubscriptions(subs);
      setPaymentsData(payments);
      setPlatformUsers(usersList);
      setPlatformSettings(settingsObj);
      setSupportCases(cases);
      setAuditLogs(logs);
      const firstPlan = planList[0];
      if (!assignPlanId && firstPlan) {
        setAssignPlanId(firstPlan.id);
      }
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        clearStoredSession('super-admin');
        router.replace('/super-admin/login?error=unauthorized');
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Failed to load Super Admin console');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, auditTenantFilter, auditActionFilter, assignPlanId, router]);

  useEffect(() => {
    if (!authorized) return;
    void loadAll();
    let timer: number | null = null;
    const scheduleRefresh = () => {
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        void loadAll();
      }, 300);
    };
    const unsubSse = subscribeRealtimeStream('super-admin', scheduleRefresh);
    const unsubSync = subscribeWorkspaceSync(scheduleRefresh);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unsubSse();
      unsubSync();
    };
  }, [authorized, loadAll]);

  const openDetails = async (tenantId: string) => {
    setDetailLoading(true);
    setError(null);
    try {
      const detail = await getAdminRestaurantDetail(tenantId);
      setSelectedDetail(detail);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to fetch restaurant details');
    } finally {
      setDetailLoading(false);
    }
  };

  const runAction = async (successMessage: string, fn: () => Promise<unknown>) => {
    setBusyAction(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      broadcastWorkspaceSync();
      setNotice(successMessage);
      await loadAll();
      if (selectedDetail) {
        try {
          const refreshed = await getAdminRestaurantDetail(selectedDetail.id);
          setSelectedDetail(refreshed);
        } catch {
          setSelectedDetail(null);
        }
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Operation failed');
    } finally {
      setBusyAction(false);
    }
  };

  const filteredRestaurants = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return restaurants;
    return restaurants.filter((r) => {
      const outletMatch = (r.outlets ?? []).some(
        (o) =>
          (o.name ?? '').toLowerCase().includes(q) ||
          (o.address ?? '').toLowerCase().includes(q) ||
          (o.contactPhone ?? '').toLowerCase().includes(q),
      );
      return (
        (r.name ?? '').toLowerCase().includes(q) ||
        (r.slug ?? '').toLowerCase().includes(q) ||
        (r.owner?.name ?? '').toLowerCase().includes(q) ||
        (r.owner?.email ?? '').toLowerCase().includes(q) ||
        (r.owner?.phone ?? '').toLowerCase().includes(q) ||
        outletMatch
      );
    });
  }, [restaurants, searchQuery]);

  const handleConfirmApprove = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!approveTarget) return;
    const target = approveTarget;
    setApproveTarget(null);
    await runAction(
      `Approved "${target.name}" (${approveMode === 'ACTIVE' ? 'APPROVED • ACTIVE' : 'APPROVED • TRIAL'}). Dashboard status updated.`,
      () =>
        approveAdminRestaurant(target.id, {
          targetStatus: approveMode,
          ...(approveNote.trim() ? { note: approveNote.trim() } : {}),
        }),
    );
    setApproveNote('');
  };

  const handleConfirmReject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rejectTarget) return;
    if (rejectReason.trim().length < 5) {
      setError('Please enter a rejection reason (minimum 5 characters).');
      return;
    }
    const target = rejectTarget;
    const reason = rejectReason.trim();
    setRejectTarget(null);
    setRejectReason('');
    await runAction(
      `Rejected "${target.name}". All active sessions were revoked and login/operations are blocked.`,
      () => rejectAdminRestaurant(target.id, reason),
    );
  };

  const handleConfirmSuspend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!suspendTarget) return;
    if (suspendReason.trim().length < 5) {
      setError('Please enter a suspension reason (minimum 5 characters).');
      return;
    }
    const target = suspendTarget;
    const reason = suspendReason.trim();
    setSuspendTarget(null);
    setSuspendReason('');
    await runAction(`Suspension applied to "${target.name}".`, () =>
      suspendAdminRestaurant(target.id, reason),
    );
  };

  const handleOnboardSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await runAction(`Onboarded "${obName}" successfully.`, async () => {
      await apiRequest('/admin/restaurants', {
        method: 'POST',
        body: JSON.stringify({
          restaurantName: obName,
          outletName: obOutlet,
          ownerName: obOwnerName,
          ownerEmail: obEmail,
          ownerPhone: obPhone,
          password: obPassword,
          ...(obPlanId ? { planId: obPlanId } : {}),
          activateImmediately: true,
        }),
      });
      setOnboardOpen(false);
      setObName('');
      setObOwnerName('');
      setObEmail('');
      setObPhone('');
      setObPassword('');
    });
  };

  const handleAssignSubscription = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!subTargetTenant || !assignPlanId) return;
    const target = subTargetTenant;
    await runAction(`Updated subscription for "${target.name}".`, async () => {
      await apiRequest(`/admin/restaurants/${target.id}/subscription`, {
        method: 'POST',
        body: JSON.stringify({
          planId: assignPlanId,
          status: assignStatus,
          billingCycle: assignCycle,
          ...(assignPaymentRef.trim() ? { paymentRef: assignPaymentRef.trim() } : {}),
        }),
      });
      setSubTargetTenant(null);
      setAssignPaymentRef('');
    });
  };

  const handleCreatePlan = async (e: React.FormEvent) => {
    e.preventDefault();
    await runAction(`Created subscription plan "${planName}".`, async () => {
      await apiRequest('/admin/plans', {
        method: 'POST',
        body: JSON.stringify({
          code: planCode.toUpperCase(),
          name: planName,
          monthlyPricePaise: Math.round(Number(planMonthlyInr) * 100),
          yearlyPricePaise: Math.round(Number(planYearlyInr) * 100),
          maxTables: Number(planMaxTables) || 25,
          maxStaff: Number(planMaxStaff) || 15,
          features: ['QR Dining', 'Live KDS', 'GST Billing'],
        }),
      });
      setPlanCode('');
      setPlanName('');
    });
  };

  const handleLogout = async () => {
    await logoutSession('super-admin');
    router.replace('/super-admin/login');
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);

    if (!secCurrentPassword || secNewPassword.length < 10) {
      setError('New password must be at least 10 characters with upper, lower, and digit.');
      return;
    }
    if (secNewPassword !== secConfirmPassword) {
      setError('New password and confirmation do not match.');
      return;
    }

    setBusyAction(true);
    try {
      const res = await changeSuperAdminPassword({
        currentPassword: secCurrentPassword,
        newPassword: secNewPassword,
      });
      setSecCurrentPassword('');
      setSecNewPassword('');
      setSecConfirmPassword('');
      clearStoredSession('super-admin');
      setNotice(`${res.message} Redirecting to sign in...`);
      setTimeout(() => {
        router.replace('/super-admin/login');
      }, 800);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to update Super Admin password.');
    } finally {
      setBusyAction(false);
    }
  };

  if (!authorized) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-sm text-slate-300">
        Verifying Super Admin credentials...
      </div>
    );
  }

  const ov = overviewData?.overview;
  const totalRestaurants = ov?.totalRestaurants ?? 0;
  const activeRestaurants =
    ov?.approvedRestaurantsCount ??
    (ov?.restaurantsByStatus?.ACTIVE ?? 0) + (ov?.restaurantsByStatus?.TRIAL ?? 0);
  const pendingCount =
    ov?.pendingApprovalCount ?? ov?.restaurantsByStatus?.PENDING_APPROVAL ?? 0;
  const rejectedCount = ov?.rejectedCount ?? ov?.restaurantsByStatus?.REJECTED ?? 0;
  const suspendedCount =
    (ov?.restaurantsByStatus?.SUSPENDED ?? 0) + (ov?.restaurantsByStatus?.LOCKED ?? 0);

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Top Executive Bar */}
      <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-950 text-white shadow-sm">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-3.5 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-white shadow">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-base font-bold tracking-tight">
                  AutoNex Super Admin
                </span>
                <Badge className="border-orange-500/40 bg-orange-500/20 text-[10px] text-orange-300">
                  SUPER_ADMIN
                </Badge>
              </div>
              <p className="text-xs text-slate-400">
                Signed in as {adminName} • Platform Governance & Restaurant Approvals
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => setOnboardOpen((v) => !v)}
              data-testid="toggle-onboard-btn"
            >
              <Plus className="mr-1.5 h-4 w-4" />
              Onboard Restaurant
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void loadAll()}
              disabled={loading || busyAction}
              className="border-slate-700 bg-slate-900 text-slate-100 hover:bg-slate-800"
            >
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="super-admin-logout"
              onClick={handleLogout}
              className="border-slate-700 bg-slate-900 text-slate-100 hover:bg-slate-800"
            >
              <LogOut className="mr-1.5 h-3.5 w-3.5" />
              Logout
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6">
        {requiresPasswordChange && (
          <Alert
            className="flex flex-wrap items-center justify-between gap-3 border-amber-300 bg-amber-50 text-amber-950"
            data-testid="super-admin-password-rotation-banner"
          >
            <AlertDescription className="text-xs sm:text-sm">
              <strong>Development initial password active.</strong> Require a strong password change
              in the Security tab before deploying to production.
            </AlertDescription>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setActiveTab('SECURITY')}
              className="border-amber-400 bg-white text-amber-900 hover:bg-amber-100"
            >
              Change Password Now
            </Button>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive" data-testid="super-admin-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {notice && (
          <Alert className="border-emerald-300 bg-emerald-50 text-emerald-900" data-testid="super-admin-notice">
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}

        {/* Executive KPI Cards */}
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card className="border-slate-200 bg-white">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardDescription className="text-xs font-medium uppercase tracking-wider text-slate-500">
                Total Restaurants
              </CardDescription>
              <Store className="h-4 w-4 text-slate-400" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-slate-900" data-testid="kpi-total-restaurants">
                {totalRestaurants}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {rejectedCount} Rejected • {suspendedCount} Suspended/Locked
              </p>
            </CardContent>
          </Card>

          <Card className="border-slate-200 bg-white">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardDescription className="text-xs font-medium uppercase tracking-wider text-slate-500">
                Active Restaurants
              </CardDescription>
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            </CardHeader>
            <CardContent>
              <div
                className="text-3xl font-bold text-emerald-700"
                data-testid="kpi-active-restaurants"
              >
                {activeRestaurants}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {ov?.restaurantsByStatus?.ACTIVE ?? 0} Paid Active • {ov?.restaurantsByStatus?.TRIAL ?? 0} Approved Trial
              </p>
            </CardContent>
          </Card>

          <Card
            className={`cursor-pointer border transition hover:border-amber-400 ${
              pendingCount > 0 ? 'border-amber-300 bg-amber-50/50' : 'border-slate-200 bg-white'
            }`}
            onClick={() => {
              setActiveTab('RESTAURANTS');
              setStatusFilter('PENDING_APPROVAL');
            }}
          >
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardDescription className="text-xs font-medium uppercase tracking-wider text-slate-500">
                Pending Approvals
              </CardDescription>
              <Clock className="h-4 w-4 text-amber-600" />
            </CardHeader>
            <CardContent>
              <div
                className="text-3xl font-bold text-amber-700"
                data-testid="kpi-pending-approvals"
              >
                {pendingCount}
              </div>
              <p className="mt-1 text-xs text-slate-600">
                {pendingCount > 0 ? 'Click to review pending registrations' : 'All registrations reviewed'}
              </p>
            </CardContent>
          </Card>

          <Card className="border-slate-200 bg-white">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardDescription className="text-xs font-medium uppercase tracking-wider text-slate-500">
                Revenue Telemetry
              </CardDescription>
              <IndianRupee className="h-4 w-4 text-primary" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-slate-900" data-testid="kpi-revenue">
                {formatInr(ov?.totalRestaurantRevenuePaise ?? ov?.platformRevenueLast30DaysPaise ?? 0)}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                MRR {formatInr(ov?.mrrPaise ?? 0)} • Sub Collected{' '}
                {formatInr(ov?.totalSubscriptionRevenuePaise ?? 0)}
              </p>
            </CardContent>
          </Card>
        </section>

        {/* Direct Admin Onboarding Drawer */}
        {onboardOpen && (
          <Card className="border-primary/40 bg-white shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Onboard Restaurant (Direct Admin Provisioning)</CardTitle>
                <CardDescription>
                  Creates restaurant tenant, primary outlet, owner account, and subscription immediately.
                </CardDescription>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setOnboardOpen(false)}>
                <X className="h-4 w-4" />
              </Button>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleOnboardSubmit} className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label>Restaurant Name</Label>
                  <Input
                    required
                    value={obName}
                    onChange={(e) => setObName(e.target.value)}
                    placeholder="Spice Courtyard"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Primary Outlet</Label>
                  <Input
                    required
                    value={obOutlet}
                    onChange={(e) => setObOutlet(e.target.value)}
                    placeholder="Main Branch"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Owner Full Name</Label>
                  <Input
                    required
                    value={obOwnerName}
                    onChange={(e) => setObOwnerName(e.target.value)}
                    placeholder="Aarav Mehta"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Owner Email</Label>
                  <Input
                    required
                    type="email"
                    value={obEmail}
                    onChange={(e) => setObEmail(e.target.value)}
                    placeholder="owner@restaurant.in"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Owner Phone</Label>
                  <Input
                    required
                    value={obPhone}
                    onChange={(e) => setObPhone(e.target.value)}
                    placeholder="+919825012345"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Initial Password</Label>
                  <Input
                    required
                    type="password"
                    minLength={8}
                    value={obPassword}
                    onChange={(e) => setObPassword(e.target.value)}
                    placeholder="Min 8 chars"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Subscription Plan</Label>
                  <Select value={obPlanId} onChange={(e) => setObPlanId(e.target.value)}>
                    <option value="">Default 14-day Trial</option>
                    {plans.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({formatInr(p.monthlyPricePaise)}/mo)
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="flex items-end gap-2 sm:col-span-2">
                  <Button type="submit" disabled={busyAction}>
                    Provision Restaurant
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setOnboardOpen(false)}>
                    Cancel
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        {/* Primary Section Tabs — 10 Super Admin Management Modules + Security */}
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 pb-3">
          {(
            [
              { id: 'ANALYTICS', label: 'Analytics', icon: BarChart3 },
              { id: 'RESTAURANTS', label: 'Restaurants', icon: Building2 },
              {
                id: 'PENDING_QUEUE',
                label: `Pending Approvals (${pendingCount})`,
                icon: Clock,
              },
              { id: 'PLANS', label: 'Subscriptions & Plans', icon: CreditCard },
              { id: 'PAYMENTS', label: 'Payments & Revenue', icon: IndianRupee },
              { id: 'TRIALS', label: 'Trial Management', icon: Clock },
              { id: 'USERS', label: 'Users & Admins', icon: Users },
              { id: 'SETTINGS', label: 'Platform Settings', icon: Settings },
              { id: 'AUDIT', label: 'Audit Trail', icon: FileText },
              {
                id: 'SUPPORT',
                label: `Support & Complaints (${ov?.openSupportCasesCount ?? 0})`,
                icon: LifeBuoy,
              },
              { id: 'SECURITY', label: 'Security', icon: KeyRound },
            ] as const
          ).map((t) => {
            const Icon = t.icon;
            const isActive = activeTab === t.id;
            return (
              <Button
                key={t.id}
                size="sm"
                data-testid={`sa-tab-${t.id.toLowerCase()}`}
                variant={isActive ? 'default' : 'outline'}
                onClick={() => setActiveTab(t.id)}
                className="gap-1.5"
              >
                <Icon className="h-4 w-4" />
                {t.label}
              </Button>
            );
          })}
        </div>

        {/* ANALYTICS TAB */}
        {activeTab === 'ANALYTICS' && <AnalyticsPanel overviewData={overviewData} />}

        {/* PENDING APPROVALS QUEUE TAB */}
        {activeTab === 'PENDING_QUEUE' && (
          <PendingApprovalsPanel
            restaurants={restaurants}
            busyAction={busyAction}
            onInspect={(tenantId) => void openDetails(tenantId)}
            onApprove={(rest) => {
              setApproveTarget(rest);
              setApproveMode('ACTIVE');
              setApproveNote('');
            }}
            onReject={(rest) => {
              setRejectTarget(rest);
              setRejectReason('');
            }}
          />
        )}

        {/* RESTAURANTS TAB */}
        {activeTab === 'RESTAURANTS' && (
          <div className="space-y-4">
            {/* Separate Filters + Search Bar */}
            <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap gap-2" role="tablist" aria-label="Restaurant Status Filters">
                {(
                  [
                    { id: 'ALL', label: `All (${totalRestaurants})` },
                    { id: 'PENDING_APPROVAL', label: `Pending Approval (${pendingCount})` },
                    { id: 'APPROVED', label: `Approved (${activeRestaurants})` },
                    { id: 'REJECTED', label: `Rejected (${rejectedCount})` },
                    { id: 'SUSPENDED', label: `Suspended (${ov?.restaurantsByStatus?.SUSPENDED ?? 0})` },
                  ] as const
                ).map((f) => (
                  <Button
                    key={f.id}
                    size="sm"
                    data-testid={`filter-${f.id.toLowerCase()}`}
                    variant={statusFilter === f.id ? 'default' : 'outline'}
                    onClick={() => setStatusFilter(f.id)}
                  >
                    {f.label}
                  </Button>
                ))}
              </div>

              <div className="relative w-full sm:w-72">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search restaurant, owner, phone..."
                  className="pl-9"
                  data-testid="restaurant-search"
                />
              </div>
            </div>

            {/* Restaurants Directory */}
            {loading && restaurants.length === 0 ? (
              <Card className="bg-white p-8 text-center text-sm text-slate-500">
                Loading registered restaurants...
              </Card>
            ) : filteredRestaurants.length === 0 ? (
              <Card className="bg-white p-10 text-center">
                <Store className="mx-auto h-10 w-10 text-slate-300" />
                <h3 className="mt-3 text-base font-semibold text-slate-800">
                  No restaurants match this filter
                </h3>
                <p className="mt-1 text-sm text-slate-500">
                  Try switching status filters or clearing your search query.
                </p>
              </Card>
            ) : (
              <div className="grid gap-4">
                {filteredRestaurants.map((rest) => {
                  const primaryOutlet = rest.outlets?.[0];
                  const canApprove =
                    rest.status === TenantStatus.PENDING_APPROVAL ||
                    rest.status === TenantStatus.REJECTED ||
                    rest.status === TenantStatus.SUSPENDED;
                  const canReject =
                    rest.status !== TenantStatus.REJECTED;
                  const canSuspend =
                    rest.status === TenantStatus.ACTIVE ||
                    rest.status === TenantStatus.TRIAL ||
                    rest.status === TenantStatus.GRACE ||
                    rest.status === TenantStatus.PENDING_APPROVAL;
                  const canReactivate =
                    rest.status === TenantStatus.SUSPENDED ||
                    rest.status === TenantStatus.LOCKED;

                  return (
                    <Card
                      key={rest.id}
                      data-testid={`restaurant-row-${rest.slug}`}
                      className="border-slate-200 bg-white transition hover:border-slate-300"
                    >
                      <CardContent className="flex flex-col gap-4 p-5 lg:flex-row lg:items-center lg:justify-between">
                        {/* Identity & Owner Info */}
                        <div className="min-w-0 flex-1 space-y-2">
                          <div className="flex flex-wrap items-center gap-2.5">
                            <h3 className="text-lg font-bold text-slate-900">{rest.name}</h3>
                            <Badge variant={tenantStatusBadgeVariant(rest.status)}>
                              {tenantStatusDisplay(rest.status)}
                            </Badge>
                            {rest.pendingSuspensionAfterService && (
                              <Badge variant="warning">DRAINING ACTIVE TABLES</Badge>
                            )}
                            {rest.subscription?.plan?.name && (
                              <Badge variant="outline">{rest.subscription.plan.name}</Badge>
                            )}
                          </div>

                          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-600">
                            <span className="inline-flex items-center gap-1">
                              <UserCheck className="h-3.5 w-3.5 text-slate-400" />
                              <strong>Owner:</strong> {rest.owner?.name ?? 'N/A'}
                            </span>
                            {rest.owner?.email && (
                              <span className="inline-flex items-center gap-1">
                                <Mail className="h-3.5 w-3.5 text-slate-400" />
                                {rest.owner.email}
                              </span>
                            )}
                            {rest.owner?.phone && (
                              <span className="inline-flex items-center gap-1">
                                <Phone className="h-3.5 w-3.5 text-slate-400" />
                                {rest.owner.phone}
                              </span>
                            )}
                          </div>

                          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500">
                            <span className="inline-flex items-center gap-1">
                              <MapPin className="h-3.5 w-3.5 text-slate-400" />
                              {rest.outlets.length} Outlet{rest.outlets.length === 1 ? '' : 's'}
                              {primaryOutlet
                                ? ` (${primaryOutlet.name}${primaryOutlet.address ? ` • ${primaryOutlet.address}` : ''})`
                                : ''}
                            </span>
                            <span>Orders: {rest._count.orders}</span>
                            <span>Sessions: {rest._count.diningSessions}</span>
                            <span>Revenue: {formatInr(rest.revenueTotalPaise ?? 0)}</span>
                            <span>Registered: {formatDateTime(rest.createdAt)}</span>
                          </div>

                          {rest.rejectionReason && rest.status === TenantStatus.REJECTED && (
                            <p className="text-xs font-medium text-red-700">
                              Rejection Reason: {rest.rejectionReason}
                            </p>
                          )}
                          {rest.suspensionReason &&
                            (rest.status === TenantStatus.SUSPENDED ||
                              rest.status === TenantStatus.LOCKED) && (
                              <p className="text-xs font-medium text-amber-800">
                                Suspension Note: {rest.suspensionReason}
                              </p>
                            )}
                        </div>

                        {/* Actions */}
                        <div className="flex flex-wrap items-center gap-2 shrink-0">
                          <Button
                            size="sm"
                            variant="outline"
                            data-testid={`view-details-${rest.slug}`}
                            onClick={() => void openDetails(rest.id)}
                          >
                            <Eye className="mr-1.5 h-3.5 w-3.5" />
                            View Details
                          </Button>

                          {canApprove && (
                            <Button
                              size="sm"
                              data-testid={`approve-btn-${rest.slug}`}
                              disabled={busyAction}
                              onClick={() => {
                                setApproveTarget(rest);
                                setApproveMode('ACTIVE');
                                setApproveNote('');
                              }}
                              className="bg-emerald-600 text-white hover:bg-emerald-700"
                            >
                              <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                              Approve
                            </Button>
                          )}

                          {canReject && (
                            <Button
                              size="sm"
                              variant="destructive"
                              data-testid={`reject-btn-${rest.slug}`}
                              disabled={busyAction}
                              onClick={() => {
                                setRejectTarget(rest);
                                setRejectReason('');
                              }}
                            >
                              <XCircle className="mr-1.5 h-3.5 w-3.5" />
                              Reject
                            </Button>
                          )}

                          {canSuspend && (
                            <Button
                              size="sm"
                              variant="outline"
                              data-testid={`suspend-btn-${rest.slug}`}
                              disabled={busyAction}
                              onClick={() => {
                                setSuspendTarget(rest);
                                setSuspendReason('');
                              }}
                              className="border-amber-300 text-amber-800 hover:bg-amber-50"
                            >
                              <PauseCircle className="mr-1.5 h-3.5 w-3.5" />
                              Suspend
                            </Button>
                          )}

                          {canReactivate && (
                            <Button
                              size="sm"
                              variant="outline"
                              data-testid={`reactivate-btn-${rest.slug}`}
                              disabled={busyAction}
                              onClick={() =>
                                void runAction(`Reactivated "${rest.name}".`, () =>
                                  reactivateAdminRestaurant(rest.id, { targetStatus: 'ACTIVE' }),
                                )
                              }
                            >
                              Reactivate
                            </Button>
                          )}

                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setSubTargetTenant(rest);
                              setAssignPlanId(rest.subscription?.plan.id ?? plans[0]?.id ?? '');
                            }}
                          >
                            Plan
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* PLANS & SUBSCRIPTIONS TAB */}
        {activeTab === 'PLANS' && (
          <div className="space-y-6">
            <div className="grid gap-6 lg:grid-cols-2">
              <Card className="bg-white">
                <CardHeader>
                  <CardTitle>Active Subscription Tiers</CardTitle>
                  <CardDescription>Pricing, table & staff quotas managed by Super Admin.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {plans.map((p) => (
                    <div
                      key={p.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 p-3.5"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-slate-900">{p.name}</span>
                          <Badge variant="outline">{p.code}</Badge>
                          {!p.isActive && <Badge variant="secondary">Inactive</Badge>}
                        </div>
                        <p className="mt-1 text-xs text-slate-500">
                          Max {p.maxOutlets} outlet(s) • {p.maxTables} tables • {p.maxStaff} staff
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <div className="font-bold text-slate-900">
                            {formatInr(p.monthlyPricePaise)}/mo
                          </div>
                          <div className="text-xs text-slate-500">
                            {formatInr(p.yearlyPricePaise)}/yr
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setEditingPlan(p);
                            setEditPlanName(p.name);
                            setEditPlanMonthlyInr(String(Math.round(p.monthlyPricePaise / 100)));
                            setEditPlanYearlyInr(String(Math.round(p.yearlyPricePaise / 100)));
                            setEditPlanMaxTables(String(p.maxTables));
                            setEditPlanMaxStaff(String(p.maxStaff));
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card className="bg-white">
                <CardHeader>
                  <CardTitle>Create Subscription Plan</CardTitle>
                  <CardDescription>Define a new commercial tier for AutoNex restaurants.</CardDescription>
                </CardHeader>
                <CardContent>
                  <form onSubmit={handleCreatePlan} className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label>Plan Code</Label>
                      <Input
                        required
                        value={planCode}
                        onChange={(e) => setPlanCode(e.target.value)}
                        placeholder="PRO_PLUS"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>Plan Name</Label>
                      <Input
                        required
                        value={planName}
                        onChange={(e) => setPlanName(e.target.value)}
                        placeholder="Pro Plus"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>Monthly Price (INR)</Label>
                      <Input
                        required
                        type="number"
                        value={planMonthlyInr}
                        onChange={(e) => setPlanMonthlyInr(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>Yearly Price (INR)</Label>
                      <Input
                        required
                        type="number"
                        value={planYearlyInr}
                        onChange={(e) => setPlanYearlyInr(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>Max Tables</Label>
                      <Input
                        required
                        type="number"
                        value={planMaxTables}
                        onChange={(e) => setPlanMaxTables(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>Max Staff</Label>
                      <Input
                        required
                        type="number"
                        value={planMaxStaff}
                        onChange={(e) => setPlanMaxStaff(e.target.value)}
                      />
                    </div>
                    <div className="pt-2 sm:col-span-2">
                      <Button type="submit" disabled={busyAction}>
                        Create Plan
                      </Button>
                    </div>
                  </form>
                </CardContent>
              </Card>
            </div>

            <Card className="bg-white">
              <CardHeader>
                <CardTitle className="text-base">
                  Active Restaurant Subscriptions ({subscriptions.length})
                </CardTitle>
                <CardDescription>
                  Monitor billing cycles, renewal dates, and update tenant subscriptions directly.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {subscriptions.length === 0 ? (
                  <p className="py-6 text-center text-sm text-slate-500">
                    No active restaurant subscriptions found.
                  </p>
                ) : (
                  <div className="space-y-2.5">
                    {subscriptions.map((sub) => {
                      const matchingRest = restaurants.find((r) => r.id === sub.tenantId);
                      return (
                        <div
                          key={sub.id}
                          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 p-3 text-xs"
                        >
                          <div className="space-y-0.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-semibold text-slate-900">
                                {sub.tenantName}
                              </span>
                              <Badge variant="outline">{sub.plan.name}</Badge>
                              <Badge
                                variant={
                                  sub.status === 'ACTIVE'
                                    ? 'success'
                                    : sub.status === 'TRIAL'
                                      ? 'warning'
                                      : 'destructive'
                                }
                              >
                                {sub.status}
                              </Badge>
                            </div>
                            <p className="text-slate-500">
                              Cycle: {sub.billingCycle} • Period Ends:{' '}
                              {formatDateTime(sub.currentPeriodEnd ?? sub.trialEndsAt)}
                            </p>
                          </div>
                          {matchingRest && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setSubTargetTenant(matchingRest);
                                setAssignPlanId(sub.plan.id);
                              }}
                            >
                              Update Plan
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* PAYMENTS & REVENUE TAB */}
        {activeTab === 'PAYMENTS' && (
          <PaymentsRevenuePanel
            paymentsData={paymentsData}
            busyAction={busyAction}
            onMarkPaid={async (invoiceId, paymentRef) => {
              await runAction('Subscription invoice marked as PAID.', () =>
                markAdminInvoicePaid(invoiceId, { paymentRef }),
              );
            }}
          />
        )}

        {/* TRIAL MANAGEMENT TAB */}
        {activeTab === 'TRIALS' && (
          <TrialManagementPanel
            subscriptions={subscriptions}
            restaurants={restaurants}
            busyAction={busyAction}
            onExtendTrial={async (tenantId, days) => {
              await runAction(`Trial extended by ${days} days.`, () =>
                extendAdminTrial(tenantId, days, 'Extended via Super Admin Trial Management'),
              );
            }}
            onOpenConvertPlan={(rest) => {
              setSubTargetTenant(rest);
              setAssignPlanId(rest.subscription?.plan.id ?? plans[0]?.id ?? '');
              setAssignStatus(SubscriptionStatus.ACTIVE);
            }}
            onRunSweep={async () => {
              await runAction('Subscription lifecycle sweep executed.', () =>
                runAdminSubscriptionSweep(),
              );
            }}
          />
        )}

        {/* USERS & ADMINS TAB */}
        {activeTab === 'USERS' && (
          <UsersAdminsPanel
            users={platformUsers}
            currentAdminId={adminUserId}
            busyAction={busyAction}
            onCreateSuperAdmin={async (payload) => {
              let ok = false;
              await runAction(`Created Super Admin "${payload.name}".`, async () => {
                await createSuperAdminAccount(payload);
                ok = true;
              });
              return ok;
            }}
            onToggleUserActive={async (userId, isActive) => {
              await runAction(
                isActive ? 'User account activated.' : 'User account deactivated & sessions revoked.',
                () =>
                  updateAdminUserStatus(userId, {
                    isActive,
                    reason: isActive
                      ? 'Re-enabled via Super Admin panel'
                      : 'Disabled via Super Admin panel',
                  }),
              );
            }}
          />
        )}

        {/* PLATFORM SETTINGS TAB */}
        {activeTab === 'SETTINGS' && (
          <PlatformSettingsPanel
            settings={platformSettings}
            busyAction={busyAction}
            onSaveSettings={async (payload) => {
              await runAction('Platform settings saved to database.', () =>
                updateAdminPlatformSettings(payload),
              );
            }}
          />
        )}

        {/* SUPPORT DESK TAB */}
        {activeTab === 'SUPPORT' && (
          <div className="space-y-3">
            {supportCases.length === 0 ? (
              <Card className="bg-white p-8 text-center text-sm text-slate-500">
                No restaurant support cases logged yet.
              </Card>
            ) : (
              supportCases.map((c) => {
                const draft = noteDrafts[c.id] ?? { body: '', isInternal: false };
                return (
                  <Card key={c.id} className="bg-white">
                    <CardHeader className="pb-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline">{c.caseNumber}</Badge>
                          <CardTitle className="text-base">{c.subject}</CardTitle>
                          <Badge
                            variant={
                              c.status === SupportCaseStatus.RESOLVED
                                ? 'success'
                                : c.status === SupportCaseStatus.OPEN
                                  ? 'warning'
                                  : 'secondary'
                            }
                          >
                            {c.status}
                          </Badge>
                        </div>
                        <div className="flex gap-2">
                          {c.status !== SupportCaseStatus.IN_PROGRESS && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                void runAction(`Case ${c.caseNumber} marked IN_PROGRESS.`, () =>
                                  apiRequest(`/admin/support-cases/${c.id}`, {
                                    method: 'PATCH',
                                    body: JSON.stringify({ status: SupportCaseStatus.IN_PROGRESS }),
                                  }),
                                )
                              }
                            >
                              In Progress
                            </Button>
                          )}
                          {c.status !== SupportCaseStatus.RESOLVED && (
                            <Button
                              size="sm"
                              onClick={() =>
                                void runAction(`Case ${c.caseNumber} marked RESOLVED.`, () =>
                                  apiRequest(`/admin/support-cases/${c.id}`, {
                                    method: 'PATCH',
                                    body: JSON.stringify({ status: SupportCaseStatus.RESOLVED }),
                                  }),
                                )
                              }
                            >
                              Resolve
                            </Button>
                          )}
                        </div>
                      </div>
                      <CardDescription>
                        {c.tenantName ?? c.tenantId} • {c.category} • Priority {c.priority}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <p className="text-sm text-slate-700">{c.description}</p>
                      <div className="flex flex-wrap gap-2">
                        <Input
                          value={draft.body}
                          onChange={(e) =>
                            setNoteDrafts((prev) => ({
                              ...prev,
                              [c.id]: { ...draft, body: e.target.value },
                            }))
                          }
                          placeholder="Add support update or resolution note..."
                          className="min-w-[240px] flex-1"
                        />
                        <Button
                          size="sm"
                          disabled={!draft.body.trim() || busyAction}
                          onClick={() =>
                            void runAction('Support note posted.', async () => {
                              await apiRequest(`/admin/support-cases/${c.id}/notes`, {
                                method: 'POST',
                                body: JSON.stringify({
                                  body: draft.body,
                                  isInternal: draft.isInternal,
                                }),
                              });
                              setNoteDrafts((prev) => ({
                                ...prev,
                                [c.id]: { body: '', isInternal: false },
                              }));
                            })
                          }
                        >
                          Post Note
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })
            )}
          </div>
        )}

        {/* AUDIT TRAIL TAB */}
        {activeTab === 'AUDIT' && (
          <Card className="bg-white">
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle>Platform Security & Governance Audit Trail</CardTitle>
                  <CardDescription>
                    Every approval, rejection, suspension, reactivation, and billing mutation.
                  </CardDescription>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Input
                    value={auditActionFilter}
                    onChange={(e) => setAuditActionFilter(e.target.value)}
                    placeholder="Filter action (e.g. REJECTED)"
                    className="w-56"
                  />
                  <Select
                    value={auditTenantFilter}
                    onChange={(e) => setAuditTenantFilter(e.target.value)}
                    className="w-52"
                  >
                    <option value="">All Restaurants</option>
                    {restaurants.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="divide-y divide-slate-100">
                {auditLogs.map((log) => (
                  <div
                    key={log.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-xs"
                  >
                    <div>
                      <Badge variant="outline" className="mr-2 font-mono">
                        {log.action}
                      </Badge>
                      <span className="font-semibold text-slate-800">
                        {log.tenant?.name ?? log.tenantId ?? 'Platform / Auth'}
                      </span>
                      <span className="ml-2 text-slate-500">
                        by {log.actorUser?.name ?? log.actorRole}
                      </span>
                    </div>
                    <span className="text-slate-400">{formatDateTime(log.createdAt)}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* SECURITY TAB */}
        {activeTab === 'SECURITY' && (
          <div className="grid gap-6 md:grid-cols-2">
            <Card className="bg-white">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <KeyRound className="h-4 w-4 text-primary" />
                  Change Super Admin Password
                </CardTitle>
                <CardDescription>
                  Hashed with Argon2id. Updating your password revokes all existing refresh tokens
                  and sessions across devices.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleChangePassword} className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="sec-current-password">Current Password</Label>
                    <Input
                      id="sec-current-password"
                      data-testid="sec-current-password"
                      type="password"
                      required
                      value={secCurrentPassword}
                      onChange={(e) => setSecCurrentPassword(e.target.value)}
                      placeholder="Enter current administrator password"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="sec-new-password">
                      New Password (min 10 chars, upper/lower/digit)
                    </Label>
                    <Input
                      id="sec-new-password"
                      data-testid="sec-new-password"
                      type="password"
                      required
                      value={secNewPassword}
                      onChange={(e) => setSecNewPassword(e.target.value)}
                      placeholder="Create new strong password"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="sec-confirm-password">Confirm New Password</Label>
                    <Input
                      id="sec-confirm-password"
                      data-testid="sec-confirm-password"
                      type="password"
                      required
                      value={secConfirmPassword}
                      onChange={(e) => setSecConfirmPassword(e.target.value)}
                      placeholder="Re-enter new strong password"
                    />
                  </div>
                  <Button
                    type="submit"
                    data-testid="sec-change-password-submit"
                    disabled={busyAction}
                  >
                    {busyAction ? 'Updating...' : 'Update Password'}
                  </Button>
                </form>
              </CardContent>
            </Card>

            <Card className="bg-white">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-primary" />
                  Session & Brute-Force Protection
                </CardTitle>
                <CardDescription>
                  Active Super Admin account controls & security enforcement.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 text-sm text-slate-600">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 space-y-1.5">
                  <p className="font-semibold text-slate-900">Active Security Controls</p>
                  <p className="text-xs">
                    • Password hashing: Argon2id (`@autonex/auth`)
                  </p>
                  <p className="text-xs">
                    • Session management: Short-lived JWT + HTTP-only refresh cookie + CSRF token
                  </p>
                  <p className="text-xs">
                    • Lockout protection: 5 failed attempts trigger a 15-minute account lock
                  </p>
                  <p className="text-xs">
                    • Role enforcement: Backend guard requires `SUPER_ADMIN` (`isSuperAdmin=true`)
                  </p>
                </div>
                <Button variant="destructive" onClick={handleLogout} className="w-full">
                  <LogOut className="mr-1.5 h-4 w-4" />
                  Sign Out & Revoke Session
                </Button>
              </CardContent>
            </Card>
          </div>
        )}
      </main>

      {/* APPROVE MODAL */}
      {approveTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/60 p-4">
          <Card className="w-full max-w-md bg-white shadow-xl">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-emerald-700">
                <CheckCircle2 className="h-5 w-5" />
                Approve Restaurant
              </CardTitle>
              <CardDescription>
                Approving <strong>{approveTarget.name}</strong> removes `PENDING_APPROVAL` and
                unlocks their dashboard, menu, tables, KDS & QR ordering.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleConfirmApprove} className="space-y-4">
                <div className="space-y-1.5">
                  <Label>Activation Status</Label>
                  <Select
                    value={approveMode}
                    onChange={(e) => setApproveMode(e.target.value as 'ACTIVE' | 'TRIAL')}
                  >
                    <option value="ACTIVE">APPROVED • ACTIVE (Full Operations)</option>
                    <option value="TRIAL">APPROVED • TRIAL (14-Day Trial)</option>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Verification Note (optional)</Label>
                  <Input
                    value={approveNote}
                    onChange={(e) => setApproveNote(e.target.value)}
                    placeholder="FSSAI & GST verified by Super Admin"
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setApproveTarget(null)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    data-testid="confirm-approve-btn"
                    disabled={busyAction}
                    className="bg-emerald-600 text-white hover:bg-emerald-700"
                  >
                    Confirm Approval
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      )}

      {/* REJECT MODAL */}
      {rejectTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/60 p-4">
          <Card className="w-full max-w-md bg-white shadow-xl">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-red-700">
                <ShieldAlert className="h-5 w-5" />
                Reject Restaurant Registration
              </CardTitle>
              <CardDescription>
                Rejecting <strong>{rejectTarget.name}</strong> immediately revokes sessions and
                blocks all logins, dashboard access, and QR ordering.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleConfirmReject} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="reject-reason">Rejection Reason (required)</Label>
                  <Input
                    id="reject-reason"
                    data-testid="reject-reason-input"
                    required
                    minLength={5}
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder="Invalid business verification or incomplete GSTIN details"
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" onClick={() => setRejectTarget(null)}>
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    variant="destructive"
                    data-testid="confirm-reject-btn"
                    disabled={busyAction}
                  >
                    Confirm Rejection
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      )}

      {/* SUSPEND MODAL */}
      {suspendTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/60 p-4">
          <Card className="w-full max-w-md bg-white shadow-xl">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-amber-800">
                <PauseCircle className="h-5 w-5" />
                Suspend Restaurant
              </CardTitle>
              <CardDescription>
                Suspends <strong>{suspendTarget.name}</strong>. If tables are currently open, AutoNex
                safely enters read-only drain mode until active meals settle.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleConfirmSuspend} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="suspend-reason">Suspension Reason (required)</Label>
                  <Input
                    id="suspend-reason"
                    data-testid="suspend-reason-input"
                    required
                    minLength={5}
                    value={suspendReason}
                    onChange={(e) => setSuspendReason(e.target.value)}
                    placeholder="Payment overdue or policy violation"
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" onClick={() => setSuspendTarget(null)}>
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    data-testid="confirm-suspend-btn"
                    disabled={busyAction}
                    className="bg-amber-600 text-white hover:bg-amber-700"
                  >
                    Confirm Suspension
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ASSIGN SUBSCRIPTION MODAL */}
      {subTargetTenant && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/60 p-4">
          <Card className="w-full max-w-md bg-white shadow-xl">
            <CardHeader>
              <CardTitle>Manage Plan — {subTargetTenant.name}</CardTitle>
              <CardDescription>Update subscription tier, billing cycle, or status.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleAssignSubscription} className="space-y-3">
                <div className="space-y-1">
                  <Label>Plan</Label>
                  <Select value={assignPlanId} onChange={(e) => setAssignPlanId(e.target.value)}>
                    {plans.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({formatInr(p.monthlyPricePaise)}/mo)
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Subscription Status</Label>
                  <Select
                    value={assignStatus}
                    onChange={(e) => setAssignStatus(e.target.value as SubscriptionStatus)}
                  >
                    {Object.values(SubscriptionStatus).map((st) => (
                      <option key={st} value={st}>
                        {st}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Billing Cycle</Label>
                  <Select
                    value={assignCycle}
                    onChange={(e) =>
                      setAssignCycle(e.target.value as SubscriptionBillingCycle)
                    }
                  >
                    <option value={SubscriptionBillingCycle.MONTHLY}>Monthly</option>
                    <option value={SubscriptionBillingCycle.YEARLY}>Yearly</option>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Payment Reference (optional)</Label>
                  <Input
                    value={assignPaymentRef}
                    onChange={(e) => setAssignPaymentRef(e.target.value)}
                    placeholder="UTR / Razorpay Ref"
                  />
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setSubTargetTenant(null)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={busyAction}>
                    Save Subscription
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      )}

      {/* FULL RESTAURANT DETAILS MODAL */}
      {(selectedDetail || detailLoading) && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 p-4"
          data-testid="restaurant-detail-modal"
        >
          <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-2xl">
            {detailLoading && !selectedDetail ? (
              <div className="p-10 text-center text-sm text-slate-500">
                Loading complete restaurant dossier...
              </div>
            ) : (
              selectedDetail && (
                <div className="space-y-6 p-6">
                  {/* Header */}
                  <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-4">
                    <div>
                      <div className="flex flex-wrap items-center gap-2.5">
                        <h2 className="text-xl font-bold text-slate-900">
                          {selectedDetail.name}
                        </h2>
                        <Badge variant={tenantStatusBadgeVariant(selectedDetail.status)}>
                          {tenantStatusDisplay(selectedDetail.status)}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        Slug: <span className="font-mono">{selectedDetail.slug}</span> • Tenant ID:{' '}
                        <span className="font-mono">{selectedDetail.id}</span>
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setSelectedDetail(null)}
                      aria-label="Close details"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>

                  {/* Registration + Telemetry Summary */}
                  <div className="grid gap-4 md:grid-cols-2">
                    <Card className="border-slate-200">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm">Registration & Governance Info</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-1.5 text-xs text-slate-700">
                        <div>
                          <strong>Registered:</strong> {formatDateTime(selectedDetail.createdAt)}
                        </div>
                        <div>
                          <strong>Approved At:</strong> {formatDateTime(selectedDetail.approvedAt)}
                          {selectedDetail.approvedByUser
                            ? ` (${selectedDetail.approvedByUser.name})`
                            : ''}
                        </div>
                        <div>
                          <strong>Rejected At:</strong> {formatDateTime(selectedDetail.rejectedAt)}
                          {selectedDetail.rejectedByUser
                            ? ` (${selectedDetail.rejectedByUser.name})`
                            : ''}
                        </div>
                        {selectedDetail.rejectionReason && (
                          <div className="text-red-700">
                            <strong>Rejection Reason:</strong> {selectedDetail.rejectionReason}
                          </div>
                        )}
                        {selectedDetail.suspensionReason && (
                          <div className="text-amber-800">
                            <strong>Suspension Reason:</strong> {selectedDetail.suspensionReason}
                          </div>
                        )}
                      </CardContent>
                    </Card>

                    <Card className="border-slate-200">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm">Usage & Revenue Telemetry</CardTitle>
                      </CardHeader>
                      <CardContent className="grid grid-cols-2 gap-2 text-xs text-slate-700">
                        <div>
                          <strong>30d Revenue:</strong>{' '}
                          {formatInr(selectedDetail.telemetry?.revenueLast30DaysPaise ?? 0)}
                        </div>
                        <div>
                          <strong>Today Revenue:</strong>{' '}
                          {formatInr(selectedDetail.telemetry?.revenueTodayPaise ?? 0)}
                        </div>
                        <div>
                          <strong>30d Orders:</strong>{' '}
                          {selectedDetail.telemetry?.ordersLast30Days ?? 0}
                        </div>
                        <div>
                          <strong>Active Tables:</strong>{' '}
                          {selectedDetail.telemetry?.activeOpenSessionsCount ?? 0} /{' '}
                          {selectedDetail.telemetry?.tablesCount ?? 0}
                        </div>
                        <div>
                          <strong>Active Staff:</strong>{' '}
                          {selectedDetail.telemetry?.staffCount ?? selectedDetail.memberships.length}
                        </div>
                        <div>
                          <strong>Plan:</strong>{' '}
                          {selectedDetail.subscription?.plan?.name ?? 'Trial / Unassigned'}
                        </div>
                      </CardContent>
                    </Card>
                  </div>

                  {/* Owner & Team Details */}
                  <Card className="border-slate-200">
                    <CardHeader className="pb-2">
                      <CardTitle className="flex items-center gap-2 text-sm">
                        <Users className="h-4 w-4 text-primary" />
                        Owner & Team Accounts ({selectedDetail.memberships.length})
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {selectedDetail.memberships.map((m) => (
                        <div
                          key={m.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-xs"
                        >
                          <div>
                            <span className="font-semibold text-slate-900">{m.user.name}</span>
                            <Badge variant={m.role === 'OWNER' ? 'default' : 'outline'} className="ml-2">
                              {m.role}
                            </Badge>
                          </div>
                          <div className="flex flex-wrap gap-4 text-slate-600">
                            <span>{m.user.email ?? 'No email'}</span>
                            <span>{m.user.phone}</span>
                          </div>
                        </div>
                      ))}
                    </CardContent>
                  </Card>

                  {/* Outlets Details */}
                  <Card className="border-slate-200">
                    <CardHeader className="pb-2">
                      <CardTitle className="flex items-center gap-2 text-sm">
                        <Store className="h-4 w-4 text-primary" />
                        Outlet Information ({selectedDetail.outlets.length})
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="grid gap-3 md:grid-cols-2">
                      {selectedDetail.outlets.map((o) => (
                        <div
                          key={o.id}
                          className="rounded-lg border border-slate-200 p-3 text-xs space-y-1"
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-semibold text-slate-900">{o.name}</span>
                            <Badge variant={o.isActive ? 'success' : 'secondary'}>
                              {o.isActive ? 'Active' : 'Inactive'}
                            </Badge>
                          </div>
                          <p className="text-slate-600">{o.address}</p>
                          <p className="text-slate-600">Phone: {o.contactPhone}</p>
                          <p className="text-slate-500">
                            GSTIN: {o.gstin || 'Not provided'} • GST:{' '}
                            {((o.gstRateBps ?? 500) / 100).toFixed(1)}% ({o.taxMode ?? 'EXCLUSIVE'})
                          </p>
                          <p className="text-slate-500">Timezone: {o.timezone}</p>
                        </div>
                      ))}
                    </CardContent>
                  </Card>

                  {/* Quick Actions Footer */}
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-4">
                    <div className="flex flex-wrap gap-2">
                      {selectedDetail.status !== TenantStatus.ACTIVE && (
                        <Button
                          size="sm"
                          onClick={() => {
                            setApproveTarget(selectedDetail);
                            setApproveMode('ACTIVE');
                          }}
                          className="bg-emerald-600 text-white hover:bg-emerald-700"
                        >
                          Approve Restaurant
                        </Button>
                      )}
                      {selectedDetail.status !== TenantStatus.REJECTED && (
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => {
                            setRejectTarget(selectedDetail);
                            setRejectReason('');
                          }}
                        >
                          Reject
                        </Button>
                      )}
                      {(selectedDetail.status === TenantStatus.ACTIVE ||
                        selectedDetail.status === TenantStatus.TRIAL) && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setSuspendTarget(selectedDetail);
                            setSuspendReason('');
                          }}
                        >
                          Suspend
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          const reason = window.prompt(
                            `Enter offboarding reason for ${selectedDetail.name}:`,
                          );
                          if (reason && reason.trim().length >= 5) {
                            void runAction(`Offboarded "${selectedDetail.name}".`, () =>
                              offboardAdminRestaurant(selectedDetail.id, reason.trim()),
                            );
                          }
                        }}
                      >
                        Offboard
                      </Button>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => setSelectedDetail(null)}>
                      Close
                    </Button>
                  </div>
                </div>
              )
            )}
          </div>
        </div>
      )}

      {/* EDIT SUBSCRIPTION PLAN MODAL */}
      {editingPlan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <Card className="w-full max-w-md bg-white shadow-xl">
            <CardHeader>
              <CardTitle>Edit Plan: {editingPlan.code}</CardTitle>
              <CardDescription>
                Update commercial pricing and restaurant quota caps cleanly.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const target = editingPlan;
                  setEditingPlan(null);
                  await runAction(`Updated subscription plan "${editPlanName}".`, () =>
                    updateAdminPlan(target.id, {
                      name: editPlanName.trim(),
                      monthlyPricePaise: Math.round(Number(editPlanMonthlyInr) * 100),
                      yearlyPricePaise: Math.round(Number(editPlanYearlyInr) * 100),
                      maxTables: Number(editPlanMaxTables) || target.maxTables,
                      maxStaff: Number(editPlanMaxStaff) || target.maxStaff,
                    }),
                  );
                }}
                className="grid gap-3 sm:grid-cols-2"
              >
                <div className="space-y-1 sm:col-span-2">
                  <Label>Plan Name</Label>
                  <Input
                    required
                    value={editPlanName}
                    onChange={(e) => setEditPlanName(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Monthly Price (INR)</Label>
                  <Input
                    required
                    type="number"
                    value={editPlanMonthlyInr}
                    onChange={(e) => setEditPlanMonthlyInr(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Yearly Price (INR)</Label>
                  <Input
                    required
                    type="number"
                    value={editPlanYearlyInr}
                    onChange={(e) => setEditPlanYearlyInr(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Max Tables</Label>
                  <Input
                    required
                    type="number"
                    value={editPlanMaxTables}
                    onChange={(e) => setEditPlanMaxTables(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Max Staff</Label>
                  <Input
                    required
                    type="number"
                    value={editPlanMaxStaff}
                    onChange={(e) => setEditPlanMaxStaff(e.target.value)}
                  />
                </div>
                <div className="flex justify-end gap-2 pt-2 sm:col-span-2">
                  <Button type="button" variant="outline" onClick={() => setEditingPlan(null)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={busyAction}>
                    Save Plan Changes
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
