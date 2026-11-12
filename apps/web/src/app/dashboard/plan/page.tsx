'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { formatInrFromPaise } from '@autonex/shared';
import {
  CheckCircle2,
  Download,
  FileText,
  LifeBuoy,
  MessageSquarePlus,
  RefreshCw,
  Send,
  Sparkles,
} from 'lucide-react';
import { DashboardShell } from '@/components/dashboard-shell';
import {
  ApiError,
  apiRequest,
  PlanDto,
  RestaurantUsageTelemetryDto,
  subscribeWorkspaceSync,
  SubscriptionInvoiceDto,
  SubscriptionSummaryDto,
  SupportCaseCategory,
  SupportCaseDto,
  SupportCasePriority,
  TenantStatus,
} from '@/lib/api-client';

interface OwnerSubscriptionResponse {
  tenant: {
    id: string;
    name: string;
    status: TenantStatus;
    pendingSuspensionAfterService: boolean;
    suspensionReason: string | null;
  };
  subscription: SubscriptionSummaryDto | null;
  telemetry: RestaurantUsageTelemetryDto;
  openSupportCasesCount: number;
  invoices: SubscriptionInvoiceDto[];
  availablePlans: PlanDto[];
}

interface DailySummaryResponse {
  exportedAt: string;
  date: string;
  restaurantName: string;
  tenantStatus: string;
  totals: {
    ordersToday: number;
    sessionsToday: number;
    billsGenerated: number;
    billsPaid: number;
    grossSubtotalPaise: number;
    totalDiscountPaise: number;
    totalGstPaise: number;
    totalBilledPaise: number;
    totalCollectedPaise: number;
  };
  paymentMethodTotalsPaise: Record<string, number>;
  bills: Array<{
    billNumber: string;
    status: string;
    subtotalPaise: number;
    discountPaise: number;
    cgstPaise: number;
    sgstPaise: number;
    totalPaise: number;
    paidPaise: number;
    createdAt: string;
  }>;
}

export default function OwnerPlanAndSupportPage() {
  const [data, setData] = useState<OwnerSubscriptionResponse | null>(null);
  const [cases, setCases] = useState<SupportCaseDto[]>([]);
  const [dailySummary, setDailySummary] = useState<DailySummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Support ticket form
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<SupportCaseCategory>(SupportCaseCategory.TECHNICAL);
  const [priority, setPriority] = useState<SupportCasePriority>(SupportCasePriority.MEDIUM);
  const [submittingCase, setSubmittingCase] = useState(false);

  // Support reply state per caseId
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [sendingReplyFor, setSendingReplyFor] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [subRes, caseRes, summaryRes] = await Promise.all([
        apiRequest<OwnerSubscriptionResponse>('/subscriptions/current'),
        apiRequest<SupportCaseDto[]>('/subscriptions/support-cases'),
        apiRequest<DailySummaryResponse>('/subscriptions/daily-summary'),
      ]);
      setData(subRes);
      setCases(caseRes);
      setDailySummary(summaryRes);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load plan and support details');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
    return subscribeWorkspaceSync(() => {
      void loadAll();
    });
  }, [loadAll]);

  const handleDownloadCsv = () => {
    if (!dailySummary) return;
    const header = [
      'Bill Number',
      'Status',
      'Subtotal (INR)',
      'Discount (INR)',
      'CGST+SGST (INR)',
      'Total (INR)',
      'Paid (INR)',
      'Created At',
    ];
    const rows = dailySummary.bills.map((b) => [
      b.billNumber,
      b.status,
      (b.subtotalPaise / 100).toFixed(2),
      (b.discountPaise / 100).toFixed(2),
      ((b.cgstPaise + b.sgstPaise) / 100).toFixed(2),
      (b.totalPaise / 100).toFixed(2),
      (b.paidPaise / 100).toFixed(2),
      b.createdAt,
    ]);
    const csv = [header, ...rows]
      .map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `autonex-daily-summary-${dailySummary.date}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  const handleCreateCase = async (e: FormEvent) => {
    e.preventDefault();
    setSubmittingCase(true);
    setError(null);
    setNotice(null);
    try {
      await apiRequest<SupportCaseDto>('/subscriptions/support-cases', {
        method: 'POST',
        body: JSON.stringify({ subject, description, category, priority }),
      });
      setSubject('');
      setDescription('');
      setNotice('Support case submitted. AutoNex team will respond shortly.');
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create support case');
    } finally {
      setSubmittingCase(false);
    }
  };

  const handleReplyCase = async (caseId: string) => {
    const body = replyDrafts[caseId]?.trim();
    if (!body) return;
    setSendingReplyFor(caseId);
    setError(null);
    try {
      await apiRequest(`/subscriptions/support-cases/${caseId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
      setReplyDrafts((prev) => ({ ...prev, [caseId]: '' }));
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to send reply');
    } finally {
      setSendingReplyFor(null);
    }
  };

  const sub = data?.subscription;
  const telemetry = data?.telemetry;

  return (
    <DashboardShell
      title="Subscription Plan, Export & Support"
      subtitle="Track your trial/billing status, export today's settlement report anytime, and reach AutoNex support."
    >
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

      {loading && !data ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          Loading subscription and usage summary...
        </div>
      ) : (
        <div className="space-y-6">
          {/* Current Plan + Telemetry */}
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm lg:col-span-2">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
                    <Sparkles className="h-3.5 w-3.5" />
                    {sub ? `${sub.plan.name} • ${sub.status}` : 'Trial Pending'}
                  </span>
                  <h2 className="mt-2 text-xl font-bold text-slate-900">
                    {data?.tenant.name}
                  </h2>
                  <p className="mt-1 text-sm text-slate-600">
                    {sub?.plan.description || 'Multi-tenant QR ordering and kitchen management.'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => loadAll()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Refresh
                </button>
              </div>

              {sub && (
                <div className="mt-5 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-xl bg-slate-50 p-3.5">
                    <p className="text-xs font-medium text-slate-500">Billing Cycle</p>
                    <p className="mt-1 text-base font-bold text-slate-900">
                      {sub.billingCycle} ({formatInrFromPaise(
                        sub.billingCycle === 'YEARLY'
                          ? sub.plan.yearlyPricePaise
                          : sub.plan.monthlyPricePaise,
                      )})
                    </p>
                  </div>
                  <div className="rounded-xl bg-slate-50 p-3.5">
                    <p className="text-xs font-medium text-slate-500">Remaining Window</p>
                    <p className="mt-1 text-base font-bold text-slate-900">
                      {sub.evaluation.inGracePeriod
                        ? `${sub.evaluation.graceDaysRemaining} grace days left`
                        : `${sub.evaluation.daysRemaining} days left`}
                    </p>
                  </div>
                  <div className="rounded-xl bg-slate-50 p-3.5">
                    <p className="text-xs font-medium text-slate-500">Service Mode</p>
                    <p className="mt-1 text-base font-bold text-slate-900">
                      {sub.evaluation.isReadOnlyLocked ? 'Read-Only Settlement' : 'Full Live Service'}
                    </p>
                  </div>
                </div>
              )}

              {telemetry && sub && (
                <div className="mt-5 grid grid-cols-2 gap-3 border-t border-slate-100 pt-4 sm:grid-cols-4">
                  <div>
                    <p className="text-xs text-slate-500">Tables Used</p>
                    <p className="text-sm font-bold text-slate-900">
                      {telemetry.tablesCount} / {sub.plan.maxTables}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">Active Staff</p>
                    <p className="text-sm font-bold text-slate-900">
                      {telemetry.staffCount} / {sub.plan.maxStaff}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">30d Orders</p>
                    <p className="text-sm font-bold text-slate-900">
                      {telemetry.ordersLast30Days}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">30d Collected</p>
                    <p className="text-sm font-bold text-slate-900">
                      {formatInrFromPaise(telemetry.revenueLast30DaysPaise)}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Daily Summary Export Card (Always works even in LOCKED mode) */}
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-center gap-2 text-slate-900">
                <FileText className="h-5 w-5 text-brand-600" />
                <h3 className="font-bold">Today&apos;s Settlement Export</h3>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                Available anytime—even if your account is locked—so you never lose today&apos;s counter accounts.
              </p>

              {dailySummary && (
                <div className="mt-4 space-y-2 rounded-xl bg-slate-50 p-3.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-slate-600">Date</span>
                    <span className="font-semibold text-slate-900">{dailySummary.date}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-600">Orders / Bills Paid</span>
                    <span className="font-semibold text-slate-900">
                      {dailySummary.totals.ordersToday} / {dailySummary.totals.billsPaid}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-600">Collected Total</span>
                    <span className="font-bold text-emerald-700">
                      {formatInrFromPaise(dailySummary.totals.totalCollectedPaise)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-600">Cash / Manual UPI</span>
                    <span className="font-medium text-slate-800">
                      {formatInrFromPaise(dailySummary.paymentMethodTotalsPaise.CASH ?? 0)} /{' '}
                      {formatInrFromPaise(dailySummary.paymentMethodTotalsPaise.UPI_MANUAL ?? 0)}
                    </span>
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={handleDownloadCsv}
                disabled={!dailySummary}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
              >
                <Download className="h-4 w-4" />
                Download Daily Summary CSV
              </button>
            </div>
          </div>

          {/* Available Plans & Invoices */}
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h3 className="text-base font-bold text-slate-900">Available AutoNex Plans</h3>
              <p className="mt-0.5 text-xs text-slate-500">
                Contact support via ticket below or your account manager to upgrade or renew.
              </p>
              <div className="mt-4 space-y-3">
                {data?.availablePlans.map((plan) => {
                  const isCurrent = sub?.plan.id === plan.id;
                  return (
                    <div
                      key={plan.id}
                      className={`rounded-xl border p-4 ${
                        isCurrent ? 'border-brand-300 bg-brand-50/40' : 'border-slate-200'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-slate-900">{plan.name}</span>
                            {isCurrent && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                                <CheckCircle2 className="h-3 w-3" /> Current
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 text-xs text-slate-500">
                            Up to {plan.maxTables} tables • {plan.maxStaff} staff • {plan.graceDays}d grace
                          </p>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-bold text-slate-900">
                            {formatInrFromPaise(plan.monthlyPricePaise)}/mo
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {formatInrFromPaise(plan.yearlyPricePaise)}/yr
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h3 className="text-base font-bold text-slate-900">Subscription Invoices</h3>
              <div className="mt-4 space-y-2.5">
                {data?.invoices.length ? (
                  data.invoices.map((inv) => (
                    <div
                      key={inv.id}
                      className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50 px-4 py-3 text-sm"
                    >
                      <div>
                        <p className="font-semibold text-slate-900">
                          {inv.invoiceNumber} • {inv.planName || inv.billingCycle}
                        </p>
                        <p className="text-xs text-slate-500">
                          {new Date(inv.periodStart).toLocaleDateString()} –{' '}
                          {new Date(inv.periodEnd).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-bold text-slate-900">{formatInrFromPaise(inv.totalPaise)}</p>
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">
                          {inv.status}
                        </span>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-slate-500">
                    No subscription invoices generated yet (Free Trial active).
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Support Desk */}
          <div className="grid gap-6 lg:grid-cols-3">
            <form
              onSubmit={handleCreateCase}
              className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
            >
              <div className="flex items-center gap-2">
                <MessageSquarePlus className="h-5 w-5 text-brand-600" />
                <h3 className="text-base font-bold text-slate-900">Raise Support Case</h3>
              </div>
              <div className="mt-4 space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-600">Category</label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value as SupportCaseCategory)}
                    className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  >
                    {Object.values(SupportCaseCategory).map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600">Priority</label>
                  <select
                    value={priority}
                    onChange={(e) => setPriority(e.target.value as SupportCasePriority)}
                    className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  >
                    {Object.values(SupportCasePriority).map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600">Subject</label>
                  <input
                    required
                    minLength={4}
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder="e.g., Request plan renewal or printer help"
                    className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600">Details</label>
                  <textarea
                    required
                    minLength={10}
                    rows={4}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Describe your request clearly..."
                    className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  />
                </div>
                <button
                  type="submit"
                  disabled={submittingCase}
                  className="w-full rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
                >
                  {submittingCase ? 'Submitting...' : 'Submit Ticket'}
                </button>
              </div>
            </form>

            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm lg:col-span-2">
              <div className="flex items-center gap-2">
                <LifeBuoy className="h-5 w-5 text-brand-600" />
                <h3 className="text-base font-bold text-slate-900">Your Support Cases</h3>
              </div>

              <div className="mt-4 space-y-4">
                {cases.length === 0 ? (
                  <p className="text-sm text-slate-500">No support cases raised yet.</p>
                ) : (
                  cases.map((sc) => (
                    <div key={sc.id} className="rounded-xl border border-slate-200 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <span className="text-xs font-mono font-bold text-slate-500">
                            {sc.caseNumber}
                          </span>{' '}
                          <span className="font-bold text-slate-900">{sc.subject}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700">
                            {sc.priority}
                          </span>
                          <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-700">
                            {sc.status}
                          </span>
                        </div>
                      </div>
                      <p className="mt-2 text-sm text-slate-700">{sc.description}</p>
                      {sc.resolutionNotes && (
                        <div className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                          <span className="font-semibold">Resolution:</span> {sc.resolutionNotes}
                        </div>
                      )}

                      {sc.notes && sc.notes.length > 0 && (
                        <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
                          {sc.notes.map((n) => (
                            <div
                              key={n.id}
                              className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700"
                            >
                              <span className="font-semibold text-slate-900">
                                {n.authorName || n.authorRole}
                              </span>{' '}
                              <span className="text-slate-400">
                                ({new Date(n.createdAt).toLocaleString()})
                              </span>
                              <p className="mt-1">{n.body}</p>
                            </div>
                          ))}
                        </div>
                      )}

                      {sc.status !== 'CLOSED' && (
                        <div className="mt-3 flex gap-2">
                          <input
                            value={replyDrafts[sc.id] ?? ''}
                            onChange={(e) =>
                              setReplyDrafts((prev) => ({ ...prev, [sc.id]: e.target.value }))
                            }
                            placeholder="Add follow-up note..."
                            className="flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs"
                          />
                          <button
                            type="button"
                            disabled={sendingReplyFor === sc.id}
                            onClick={() => handleReplyCase(sc.id)}
                            className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                          >
                            <Send className="h-3 w-3" /> Send
                          </button>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </DashboardShell>
  );
}

