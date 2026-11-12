'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatInrFromPaise } from '@autonex/shared';
import {
  Activity,
  Building2,
  CheckCircle2,
  CreditCard,
  FileSearch,
  LifeBuoy,
  LogOut,
  Plus,
  RefreshCw,
  Shield,
  ShieldAlert,
} from 'lucide-react';
import {
  ApiError,
  apiRequest,
  AuthSession,
  clearStoredSession,
  getStoredSession,
  PlanDto,
  PlatformOverviewDto,
  RestaurantUsageTelemetryDto,
  SubscriptionBillingCycle,
  SubscriptionStatus,
  SupportCaseDto,
  SupportCaseStatus,
  TenantStatus,
} from '@/lib/api-client';

type TabId = 'overview' | 'restaurants' | 'plans' | 'support' | 'audit';

interface OverviewApiResponse {
  overview: PlatformOverviewDto;
  restaurantsTelemetry: Array<{
    tenantId: string;
    tenantName: string;
    status: TenantStatus;
    planName: string | null;
    subscriptionStatus: SubscriptionStatus | null;
    telemetry: RestaurantUsageTelemetryDto;
  }>;
}

interface AdminRestaurantRow {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  pendingSuspensionAfterService: boolean;
  suspensionReason: string | null;
  activeOpenSessionsCount: number;
  createdAt: string;
  outlets: Array<{ id: string; name: string; contactPhone: string }>;
  subscription: {
    id: string;
    status: SubscriptionStatus;
    billingCycle: SubscriptionBillingCycle;
    plan: PlanDto;
  } | null;
  _count: {
    memberships: number;
    diningSessions: number;
    orders: number;
    supportCases: number;
  };
}

interface AuditLogEntry {
  id: string;
  tenantId: string | null;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string | null;
  beforeJson: unknown;
  afterJson: unknown;
  createdAt: string;
  tenant?: { id: string; name: string } | null;
  actorUser?: { id: string; name: string; email: string | null } | null;
}

export default function SuperAdminPortalPage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthSession | null>(null);
  const [tab, setTab] = useState<TabId>('overview');

  const [overviewData, setOverviewData] = useState<OverviewApiResponse | null>(null);
  const [restaurants, setRestaurants] = useState<AdminRestaurantRow[]>([]);
  const [plans, setPlans] = useState<PlanDto[]>([]);
  const [supportCases, setSupportCases] = useState<SupportCaseDto[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [auditActionFilter, setAuditActionFilter] = useState<string>('');
  const [auditTenantFilter, setAuditTenantFilter] = useState<string>('');

  // Onboard modal/panel form
  const [onboardOpen, setOnboardOpen] = useState(false);
  const [obName, setObName] = useState('');
  const [obOutlet, setObOutlet] = useState('Main Outlet');
  const [obOwnerName, setObOwnerName] = useState('');
  const [obEmail, setObEmail] = useState('');
  const [obPhone, setObPhone] = useState('');
  const [obPassword, setObPassword] = useState('');
  const [obPlanId, setObPlanId] = useState('');

  // Assign subscription drawer
  const [subTargetTenant, setSubTargetTenant] = useState<AdminRestaurantRow | null>(null);
  const [assignPlanId, setAssignPlanId] = useState('');
  const [assignStatus, setAssignStatus] = useState<SubscriptionStatus>(SubscriptionStatus.ACTIVE);
  const [assignCycle, setAssignCycle] = useState<SubscriptionBillingCycle>(
    SubscriptionBillingCycle.MONTHLY,
  );
  const [assignPaymentRef, setAssignPaymentRef] = useState('');

  // New plan form
  const [planCode, setPlanCode] = useState('');
  const [planName, setPlanName] = useState('');
  const [planMonthlyInr, setPlanMonthlyInr] = useState('999');
  const [planYearlyInr, setPlanYearlyInr] = useState('9990');
  const [planMaxTables, setPlanMaxTables] = useState('30');
  const [planMaxStaff, setPlanMaxStaff] = useState('15');

  // Support note state
  const [noteDrafts, setNoteDrafts] = useState<Record<string, { body: string; isInternal: boolean }>>({});

  useEffect(() => {
    const stored = getStoredSession();
    if (!stored?.accessToken) {
      router.replace('/login');
      return;
    }
    if (stored.user.role !== 'SUPER_ADMIN') {
      router.replace('/dashboard');
      return;
    }
    setSession(stored);
  }, [router]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ov, rests, planList, cases, logs] = await Promise.all([
        apiRequest<OverviewApiResponse>('/admin/analytics/overview'),
        apiRequest<AdminRestaurantRow[]>(
          `/admin/restaurants${statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : ''}`,
        ),
        apiRequest<PlanDto[]>('/admin/plans'),
        apiRequest<SupportCaseDto[]>('/admin/support-cases'),
        apiRequest<AuditLogEntry[]>(
          `/admin/audit-logs?limit=100${
            auditTenantFilter ? `&tenantId=${encodeURIComponent(auditTenantFilter)}` : ''
          }${auditActionFilter ? `&action=${encodeURIComponent(auditActionFilter)}` : ''}`,
        ),
      ]);
      setOverviewData(ov);
      setRestaurants(rests);
      setPlans(planList);
      setSupportCases(cases);
      setAuditLogs(logs);
      const firstPlan = planList[0];
      if (!assignPlanId && firstPlan) {
        setAssignPlanId(firstPlan.id);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load Super Admin console');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, auditTenantFilter, auditActionFilter, assignPlanId]);

  useEffect(() => {
    if (session?.user.role === 'SUPER_ADMIN') {
      void loadAll();
    }
  }, [session, loadAll]);

  const handleAction = async (label: string, fn: () => Promise<unknown>) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(label);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Operation failed');
    }
  };

  const handleOnboardSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await handleAction(`Onboarded ${obName}`, async () => {
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

  const handleAssignSubscription = async (e: FormEvent) => {
    e.preventDefault();
    if (!subTargetTenant) return;
    await handleAction(`Updated subscription for ${subTargetTenant.name}`, async () => {
      await apiRequest(`/admin/restaurants/${subTargetTenant.id}/subscription`, {
        method: 'POST',
        body: JSON.stringify({
          planId: assignPlanId,
          status: assignStatus,
          billingCycle: assignCycle,
          paymentReference: assignPaymentRef || undefined,
          recordPaidInvoice: assignStatus === SubscriptionStatus.ACTIVE,
        }),
      });
      setSubTargetTenant(null);
      setAssignPaymentRef('');
    });
  };

  const handleCreatePlan = async (e: FormEvent) => {
    e.preventDefault();
    await handleAction(`Created plan ${planCode.toUpperCase()}`, async () => {
      await apiRequest('/admin/plans', {
        method: 'POST',
        body: JSON.stringify({
          code: planCode,
          name: planName,
          monthlyPricePaise: Math.round(Number(planMonthlyInr) * 100),
          yearlyPricePaise: Math.round(Number(planYearlyInr) * 100),
          maxTables: Number(planMaxTables),
          maxStaff: Number(planMaxStaff),
        }),
      });
      setPlanCode('');
      setPlanName('');
    });
  };

  const handleAddSupportNote = async (caseId: string) => {
    const draft = noteDrafts[caseId];
    if (!draft?.body?.trim()) return;
    await handleAction('Added note to support case', async () => {
      await apiRequest(`/admin/support-cases/${caseId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ body: draft.body.trim(), isInternal: draft.isInternal }),
      });
      setNoteDrafts((prev) => ({ ...prev, [caseId]: { body: '', isInternal: false } }));
    });
  };

  if (!session) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        Verifying Super Admin clearance...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-slate-900 text-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 font-bold">
              <Shield className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-base font-bold">AutoNex Platform Super Admin</h1>
              <p className="text-xs text-slate-300">
                Multi-Tenant Control Plane • {session.user.name}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {(
              [
                ['overview', 'Analytics', Activity],
                ['restaurants', 'Restaurants', Building2],
                ['plans', 'Plans & Subscriptions', CreditCard],
                ['support', 'Support Cases', LifeBuoy],
                ['audit', 'Audit Logs', FileSearch],
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                  tab === id
                    ? 'bg-white text-slate-900'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}

            <button
              type="button"
              onClick={() => {
                clearStoredSession();
                router.replace('/login');
              }}
              className="ml-2 inline-flex items-center gap-1 rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
            >
              <LogOut className="h-3.5 w-3.5" /> Logout
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-slate-900 capitalize">{tab}</h2>
            <p className="text-xs text-slate-500">
              All actions record immutable audit logs and respect mid-meal active dining sessions.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                handleAction('Subscription sweep complete', () =>
                  apiRequest('/admin/subscriptions/sweep', { method: 'POST' }),
                )
              }
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Run Lifecycle Sweep
            </button>
            <button
              type="button"
              onClick={() => loadAll()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
            >
              Refresh Data
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            {error}
          </div>
        )}
        {notice && (
          <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            {notice}
          </div>
        )}

        {loading && !overviewData ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
            Loading platform metrics...
          </div>
        ) : null}

        {/* OVERVIEW TAB */}
        {tab === 'overview' && overviewData && (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-2xl border border-slate-200 bg-white p-5">
                <p className="text-xs font-medium text-slate-500">Total Restaurants</p>
                <p className="mt-1 text-2xl font-bold text-slate-900">
                  {overviewData.overview.totalRestaurants}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Active: {overviewData.overview.restaurantsByStatus.ACTIVE} • Trial:{' '}
                  {overviewData.overview.restaurantsByStatus.TRIAL} • Pending:{' '}
                  {overviewData.overview.restaurantsByStatus.PENDING_APPROVAL}
                </p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-5">
                <p className="text-xs font-medium text-slate-500">SaaS MRR</p>
                <p className="mt-1 text-2xl font-bold text-emerald-700">
                  {formatInrFromPaise(overviewData.overview.mrrPaise)}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Paid active subscriptions: {overviewData.overview.subscriptionsByStatus.ACTIVE}
                </p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-5">
                <p className="text-xs font-medium text-slate-500">30d Platform GMV / Orders</p>
                <p className="mt-1 text-2xl font-bold text-slate-900">
                  {formatInrFromPaise(overviewData.overview.platformRevenueLast30DaysPaise)}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {overviewData.overview.platformOrdersLast30Days} orders across{' '}
                  {overviewData.overview.platformSessionsLast30Days} sessions
                </p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-5">
                <p className="text-xs font-medium text-slate-500">Open Support Cases</p>
                <p className="mt-1 text-2xl font-bold text-amber-700">
                  {overviewData.overview.openSupportCasesCount}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Grace: {overviewData.overview.subscriptionsByStatus.GRACE} • Locked:{' '}
                  {overviewData.overview.restaurantsByStatus.LOCKED}
                </p>
              </div>
            </div>

            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
              <div className="border-b border-slate-100 px-5 py-3.5">
                <h3 className="text-sm font-bold text-slate-900">Per-Restaurant Usage Telemetry (30 Days)</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Restaurant</th>
                      <th className="px-4 py-3 font-semibold">Status / Plan</th>
                      <th className="px-4 py-3 font-semibold">Live Tables Open</th>
                      <th className="px-4 py-3 font-semibold">Orders (24h / 30d)</th>
                      <th className="px-4 py-3 font-semibold">Sessions (30d)</th>
                      <th className="px-4 py-3 font-semibold">GMV (30d)</th>
                      <th className="px-4 py-3 font-semibold">Tables / Staff</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {overviewData.restaurantsTelemetry.map((row) => (
                      <tr key={row.tenantId} className="hover:bg-slate-50">
                        <td className="px-4 py-3 font-semibold text-slate-900">{row.tenantName}</td>
                        <td className="px-4 py-3">
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 font-semibold text-slate-700">
                            {row.status}
                          </span>{' '}
                          <span className="text-slate-500">{row.planName ?? 'None'}</span>
                        </td>
                        <td className="px-4 py-3 font-semibold text-slate-800">
                          {row.telemetry.activeOpenSessionsCount}
                        </td>
                        <td className="px-4 py-3">
                          {row.telemetry.ordersLast24Hours} / {row.telemetry.ordersLast30Days}
                        </td>
                        <td className="px-4 py-3">{row.telemetry.sessionsLast30Days}</td>
                        <td className="px-4 py-3 font-semibold text-emerald-700">
                          {formatInrFromPaise(row.telemetry.revenueLast30DaysPaise)}
                        </td>
                        <td className="px-4 py-3">
                          {row.telemetry.tablesCount} / {row.telemetry.staffCount}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* RESTAURANTS TAB */}
        {tab === 'restaurants' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium"
                >
                  <option value="">All Statuses</option>
                  {Object.values(TenantStatus).map((st) => (
                    <option key={st} value={st}>
                      {st}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={() => setOnboardOpen((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-brand-700"
              >
                <Plus className="h-4 w-4" /> Onboard Restaurant
              </button>
            </div>

            {onboardOpen && (
              <form
                onSubmit={handleOnboardSubmit}
                className="grid gap-3 rounded-2xl border border-slate-200 bg-white p-5 sm:grid-cols-3"
              >
                <input
                  required
                  placeholder="Restaurant Name"
                  value={obName}
                  onChange={(e) => setObName(e.target.value)}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-xs"
                />
                <input
                  required
                  placeholder="Outlet Name"
                  value={obOutlet}
                  onChange={(e) => setObOutlet(e.target.value)}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-xs"
                />
                <input
                  required
                  placeholder="Owner Full Name"
                  value={obOwnerName}
                  onChange={(e) => setObOwnerName(e.target.value)}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-xs"
                />
                <input
                  required
                  type="email"
                  placeholder="Owner Email"
                  value={obEmail}
                  onChange={(e) => setObEmail(e.target.value)}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-xs"
                />
                <input
                  required
                  placeholder="Owner Phone (+91...)"
                  value={obPhone}
                  onChange={(e) => setObPhone(e.target.value)}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-xs"
                />
                <input
                  required
                  type="password"
                  minLength={8}
                  placeholder="Temporary Password (min 8)"
                  value={obPassword}
                  onChange={(e) => setObPassword(e.target.value)}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-xs"
                />
                <select
                  value={obPlanId}
                  onChange={(e) => setObPlanId(e.target.value)}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-xs"
                >
                  <option value="">Default 14-day Trial (Starter)</option>
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      Activate on {p.name}
                    </option>
                  ))}
                </select>
                <div className="flex gap-2 sm:col-span-2">
                  <button
                    type="submit"
                    className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
                  >
                    Create &amp; Provision Tenant
                  </button>
                  <button
                    type="button"
                    onClick={() => setOnboardOpen(false)}
                    className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-medium text-slate-600"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}

            {subTargetTenant && (
              <form
                onSubmit={handleAssignSubscription}
                className="rounded-2xl border border-brand-200 bg-brand-50/40 p-5"
              >
                <h4 className="text-sm font-bold text-slate-900">
                  Manage Subscription: {subTargetTenant.name}
                </h4>
                <div className="mt-3 grid gap-3 sm:grid-cols-4">
                  <select
                    value={assignPlanId}
                    onChange={(e) => setAssignPlanId(e.target.value)}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs"
                  >
                    {plans.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({formatInrFromPaise(p.monthlyPricePaise)}/mo)
                      </option>
                    ))}
                  </select>
                  <select
                    value={assignStatus}
                    onChange={(e) => setAssignStatus(e.target.value as SubscriptionStatus)}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs"
                  >
                    {Object.values(SubscriptionStatus).map((st) => (
                      <option key={st} value={st}>
                        {st}
                      </option>
                    ))}
                  </select>
                  <select
                    value={assignCycle}
                    onChange={(e) => setAssignCycle(e.target.value as SubscriptionBillingCycle)}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs"
                  >
                    <option value={SubscriptionBillingCycle.MONTHLY}>MONTHLY</option>
                    <option value={SubscriptionBillingCycle.YEARLY}>YEARLY</option>
                  </select>
                  <input
                    placeholder="Payment Ref / UTR (optional)"
                    value={assignPaymentRef}
                    onChange={(e) => setAssignPaymentRef(e.target.value)}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs"
                  />
                </div>
                <div className="mt-3 flex gap-2">
                  <button
                    type="submit"
                    className="rounded-lg bg-brand-600 px-4 py-1.5 text-xs font-semibold text-white"
                  >
                    Apply Plan &amp; Record Invoice
                  </button>
                  <button
                    type="button"
                    onClick={() => setSubTargetTenant(null)}
                    className="rounded-lg border border-slate-300 bg-white px-4 py-1.5 text-xs font-medium"
                  >
                    Close
                  </button>
                </div>
              </form>
            )}

            <div className="space-y-3">
              {restaurants.map((r) => (
                <div
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-5"
                >
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-base font-bold text-slate-900">{r.name}</span>
                      <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-bold text-slate-800">
                        {r.status}
                      </span>
                      {r.pendingSuspensionAfterService && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-semibold text-amber-800">
                          <ShieldAlert className="h-3 w-3" /> Draining {r.activeOpenSessionsCount} active table(s) before suspend
                        </span>
                      )}
                      {r.subscription && (
                        <span className="rounded-full bg-sky-50 px-2.5 py-0.5 text-[11px] font-semibold text-sky-800">
                          {r.subscription.plan.name} ({r.subscription.status})
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      Outlet: {r.outlets[0]?.name ?? 'N/A'} • Staff: {r._count.memberships} •
                      Orders: {r._count.orders} • Open Tables: {r.activeOpenSessionsCount}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {r.status === TenantStatus.PENDING_APPROVAL && (
                      <button
                        type="button"
                        onClick={() =>
                          handleAction(`Approved ${r.name}`, () =>
                            apiRequest(`/admin/restaurants/${r.id}/approve`, {
                              method: 'POST',
                              body: JSON.stringify({ targetStatus: 'TRIAL' }),
                            }),
                          )
                        }
                        className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" /> Approve (14d Trial)
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => {
                        setSubTargetTenant(r);
                        if (r.subscription?.plan?.id) setAssignPlanId(r.subscription.plan.id);
                      }}
                      className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      Plan / Renew
                    </button>

                    {(r.status === TenantStatus.SUSPENDED || r.status === TenantStatus.LOCKED) && (
                      <button
                        type="button"
                        onClick={() =>
                          handleAction(`Reactivated ${r.name}`, () =>
                            apiRequest(`/admin/restaurants/${r.id}/reactivate`, {
                              method: 'POST',
                              body: JSON.stringify({ reason: 'Super Admin reactivation' }),
                            }),
                          )
                        }
                        className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-700"
                      >
                        Reactivate
                      </button>
                    )}

                    {r.status !== TenantStatus.SUSPENDED && !r.pendingSuspensionAfterService && (
                      <button
                        type="button"
                        onClick={() =>
                          handleAction(
                            `Suspension triggered for ${r.name} (respects open tables)`,
                            () =>
                              apiRequest(`/admin/restaurants/${r.id}/suspend`, {
                                method: 'POST',
                                body: JSON.stringify({ reason: 'Admin suspension review' }),
                              }),
                          )
                        }
                        className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-100"
                      >
                        Suspend
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() =>
                        handleAction(`Offboarding processed for ${r.name}`, () =>
                          apiRequest(`/admin/restaurants/${r.id}/offboard`, {
                            method: 'POST',
                            body: JSON.stringify({ reason: 'Restaurant offboarded' }),
                          }),
                        )
                      }
                      className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
                    >
                      Offboard
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* PLANS TAB */}
        {tab === 'plans' && (
          <div className="grid gap-6 lg:grid-cols-3">
            <form
              onSubmit={handleCreatePlan}
              className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3"
            >
              <h3 className="text-sm font-bold text-slate-900">Create Subscription Plan</h3>
              <input
                required
                placeholder="Code (e.g. ENTERPRISE)"
                value={planCode}
                onChange={(e) => setPlanCode(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
              />
              <input
                required
                placeholder="Display Name"
                value={planName}
                onChange={(e) => setPlanName(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  required
                  type="number"
                  placeholder="Monthly INR"
                  value={planMonthlyInr}
                  onChange={(e) => setPlanMonthlyInr(e.target.value)}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-xs"
                />
                <input
                  required
                  type="number"
                  placeholder="Yearly INR"
                  value={planYearlyInr}
                  onChange={(e) => setPlanYearlyInr(e.target.value)}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-xs"
                />
                <input
                  required
                  type="number"
                  placeholder="Max Tables"
                  value={planMaxTables}
                  onChange={(e) => setPlanMaxTables(e.target.value)}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-xs"
                />
                <input
                  required
                  type="number"
                  placeholder="Max Staff"
                  value={planMaxStaff}
                  onChange={(e) => setPlanMaxStaff(e.target.value)}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-xs"
                />
              </div>
              <button
                type="submit"
                className="w-full rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
              >
                Create Plan
              </button>
            </form>

            <div className="space-y-3 lg:col-span-2">
              {plans.map((p) => (
                <div
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-5"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-bold text-slate-500">{p.code}</span>
                      <span className="font-bold text-slate-900">{p.name}</span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                          p.isActive
                            ? 'bg-emerald-50 text-emerald-700'
                            : 'bg-slate-100 text-slate-500'
                        }`}
                      >
                        {p.isActive ? 'ACTIVE' : 'ARCHIVED'}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      {formatInrFromPaise(p.monthlyPricePaise)}/mo •{' '}
                      {formatInrFromPaise(p.yearlyPricePaise)}/yr • {p.maxTables} tables •{' '}
                      {p.maxStaff} staff • {p.trialDays}d trial / {p.graceDays}d grace
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      handleAction(`Toggled plan ${p.code}`, () =>
                        apiRequest(`/admin/plans/${p.id}`, {
                          method: 'PATCH',
                          body: JSON.stringify({ isActive: !p.isActive }),
                        }),
                      )
                    }
                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    {p.isActive ? 'Archive' : 'Activate'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* SUPPORT TAB */}
        {tab === 'support' && (
          <div className="space-y-4">
            {supportCases.map((sc) => {
              const draft = noteDrafts[sc.id] ?? { body: '', isInternal: false };
              return (
                <div key={sc.id} className="rounded-2xl border border-slate-200 bg-white p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <span className="font-mono text-xs font-bold text-slate-500">
                        {sc.caseNumber}
                      </span>{' '}
                      <span className="font-bold text-slate-900">{sc.subject}</span>
                      <p className="text-xs text-slate-500">
                        Restaurant: {sc.tenantName || sc.tenantId} • {sc.category} • {sc.priority}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <select
                        value={sc.status}
                        onChange={(e) =>
                          handleAction(`Updated case ${sc.caseNumber}`, () =>
                            apiRequest(`/admin/support-cases/${sc.id}`, {
                              method: 'PATCH',
                              body: JSON.stringify({
                                status: e.target.value as SupportCaseStatus,
                              }),
                            }),
                          )
                        }
                        className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-semibold"
                      >
                        {Object.values(SupportCaseStatus).map((st) => (
                          <option key={st} value={st}>
                            {st}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <p className="mt-2 text-sm text-slate-700">{sc.description}</p>

                  {sc.notes && sc.notes.length > 0 && (
                    <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
                      {sc.notes.map((n) => (
                        <div
                          key={n.id}
                          className={`rounded-lg px-3 py-2 text-xs ${
                            n.isInternal
                              ? 'border border-amber-200 bg-amber-50 text-amber-900'
                              : 'bg-slate-50 text-slate-700'
                          }`}
                        >
                          <span className="font-semibold">
                            {n.authorName || n.authorRole}
                            {n.isInternal ? ' [INTERNAL ADMIN NOTE]' : ''}
                          </span>
                          <p className="mt-1">{n.body}</p>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <input
                      value={draft.body}
                      onChange={(e) =>
                        setNoteDrafts((prev) => ({
                          ...prev,
                          [sc.id]: { ...draft, body: e.target.value },
                        }))
                      }
                      placeholder="Reply to restaurant or write internal admin note..."
                      className="min-w-[240px] flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs"
                    />
                    <label className="inline-flex items-center gap-1.5 text-xs text-slate-600">
                      <input
                        type="checkbox"
                        checked={draft.isInternal}
                        onChange={(e) =>
                          setNoteDrafts((prev) => ({
                            ...prev,
                            [sc.id]: { ...draft, isInternal: e.target.checked },
                          }))
                        }
                      />
                      Internal only
                    </label>
                    <button
                      type="button"
                      onClick={() => handleAddSupportNote(sc.id)}
                      className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                    >
                      Add Note
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* AUDIT LOGS TAB */}
        {tab === 'audit' && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-3">
              <select
                value={auditTenantFilter}
                onChange={(e) => setAuditTenantFilter(e.target.value)}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs"
              >
                <option value="">All Tenants &amp; Platform</option>
                {restaurants.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              <input
                value={auditActionFilter}
                onChange={(e) => setAuditActionFilter(e.target.value)}
                placeholder="Filter by action (e.g., SUBSCRIPTION)"
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs"
              />
            </div>

            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Timestamp</th>
                      <th className="px-4 py-3 font-semibold">Tenant</th>
                      <th className="px-4 py-3 font-semibold">Actor</th>
                      <th className="px-4 py-3 font-semibold">Action</th>
                      <th className="px-4 py-3 font-semibold">Entity</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {auditLogs.map((log) => (
                      <tr key={log.id} className="hover:bg-slate-50">
                        <td className="px-4 py-2.5 text-slate-500">
                          {new Date(log.createdAt).toLocaleString()}
                        </td>
                        <td className="px-4 py-2.5 font-medium text-slate-900">
                          {log.tenant?.name ?? 'PLATFORM'}
                        </td>
                        <td className="px-4 py-2.5 text-slate-700">
                          {log.actorUser?.name ?? 'System'} ({log.actorRole})
                        </td>
                        <td className="px-4 py-2.5 font-mono font-semibold text-brand-700">
                          {log.action}
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">
                          {log.entityType}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
