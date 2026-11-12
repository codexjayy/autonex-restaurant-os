'use client';

import React, { useState } from 'react';
import { formatInrFromPaise } from '@autonex/shared';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from '@autonex/ui';
import {
  CalendarPlus,
  CheckCircle2,
  Clock,
  CreditCard,
  IndianRupee,
  RefreshCw,
} from 'lucide-react';
import type {
  AdminPaymentsResponse,
  AdminRestaurantRow,
  AdminSubscriptionRow,
} from '@/lib/api-client';

interface PaymentsRevenuePanelProps {
  paymentsData: AdminPaymentsResponse | null;
  busyAction: boolean;
  onMarkPaid: (invoiceId: string, paymentRef?: string) => Promise<void>;
}

export function PaymentsRevenuePanel({
  paymentsData,
  busyAction,
  onMarkPaid,
}: PaymentsRevenuePanelProps) {
  const [refDrafts, setRefDrafts] = useState<Record<string, string>>({});
  const summary = paymentsData?.summary;
  const invoices = paymentsData?.subscriptionInvoices ?? [];
  const breakdown = paymentsData?.restaurantRevenueBreakdown ?? [];

  return (
    <div className="space-y-6" data-testid="sa-payments-panel">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="border-slate-200 bg-white">
          <CardHeader className="pb-1">
            <CardDescription className="text-xs uppercase">Platform MRR</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900">
              {formatInrFromPaise(summary?.mrrPaise ?? 0)}
            </div>
            <p className="mt-1 text-xs text-slate-500">Monthly recurring subscriptions</p>
          </CardContent>
        </Card>

        <Card className="border-slate-200 bg-white">
          <CardHeader className="pb-1">
            <CardDescription className="text-xs uppercase">SaaS Revenue Collected</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-700">
              {formatInrFromPaise(summary?.totalSubscriptionRevenuePaise ?? 0)}
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Pending: {formatInrFromPaise(summary?.pendingSubscriptionRevenuePaise ?? 0)}
            </p>
          </CardContent>
        </Card>

        <Card className="border-slate-200 bg-white">
          <CardHeader className="pb-1">
            <CardDescription className="text-xs uppercase">Today Restaurant GMV</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900">
              {formatInrFromPaise(summary?.todayRestaurantRevenuePaise ?? 0)}
            </div>
            <p className="mt-1 text-xs text-slate-500">Collected across active branches today</p>
          </CardContent>
        </Card>

        <Card className="border-slate-200 bg-white">
          <CardHeader className="pb-1">
            <CardDescription className="text-xs uppercase">30-Day Restaurant GMV</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">
              {formatInrFromPaise(summary?.last30DaysRestaurantRevenuePaise ?? 0)}
            </div>
            <p className="mt-1 text-xs text-slate-500">Settled & partial POS bills (30d)</p>
          </CardContent>
        </Card>
      </div>

      {/* SaaS Subscription Invoices */}
      <Card className="border-slate-200 bg-white">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CreditCard className="h-4 w-4 text-primary" />
            Subscription Invoices & Settlements
          </CardTitle>
          <CardDescription>
            Platform billing ledger including 18% GST and manual reconciliation actions.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">
              No subscription invoices recorded yet. Assign a paid plan to generate an invoice.
            </p>
          ) : (
            <div className="space-y-2.5">
              {invoices.map((inv) => (
                <div
                  key={inv.id}
                  className="flex flex-col gap-3 rounded-lg border border-slate-200 p-3.5 md:flex-row md:items-center md:justify-between"
                >
                  <div className="space-y-1 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono font-semibold text-slate-900">
                        {inv.invoiceNumber}
                      </span>
                      <Badge
                        variant={
                          inv.status === 'PAID'
                            ? 'success'
                            : inv.status === 'FAILED'
                              ? 'destructive'
                              : 'warning'
                        }
                      >
                        {inv.status}
                      </Badge>
                      <span className="font-semibold text-slate-800">{inv.tenantName}</span>
                    </div>
                    <p className="text-slate-500">
                      {inv.planName} ({inv.billingCycle}) • Base {formatInrFromPaise(inv.amountPaise)}{' '}
                      + GST {formatInrFromPaise(inv.taxPaise)} ={' '}
                      <strong className="text-slate-900">{formatInrFromPaise(inv.totalPaise)}</strong>
                      {inv.paymentRef ? ` • Ref: ${inv.paymentRef}` : ''}
                    </p>
                  </div>

                  {inv.status !== 'PAID' ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        value={refDrafts[inv.id] ?? ''}
                        onChange={(e) =>
                          setRefDrafts((prev) => ({ ...prev, [inv.id]: e.target.value }))
                        }
                        placeholder="UTR / Payment Ref"
                        className="h-8 w-44 text-xs"
                      />
                      <Button
                        size="sm"
                        disabled={busyAction}
                        onClick={() => void onMarkPaid(inv.id, refDrafts[inv.id])}
                      >
                        <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                        Mark Paid
                      </Button>
                    </div>
                  ) : (
                    <span className="text-xs text-emerald-700 font-medium">
                      Settled{' '}
                      {inv.paidAt
                        ? new Date(inv.paidAt).toLocaleDateString('en-IN', {
                            day: '2-digit',
                            month: 'short',
                            year: 'numeric',
                          })
                        : ''}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Per-Restaurant POS Revenue */}
      <Card className="border-slate-200 bg-white">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <IndianRupee className="h-4 w-4 text-emerald-600" />
            Restaurant POS Revenue Breakdown
          </CardTitle>
          <CardDescription>Today and trailing 30-day collected bill volumes per tenant.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2 pr-4 font-semibold">Restaurant</th>
                  <th className="py-2 pr-4 font-semibold">Status</th>
                  <th className="py-2 pr-4 font-semibold">Today Bills</th>
                  <th className="py-2 pr-4 font-semibold">Today Revenue</th>
                  <th className="py-2 pr-4 font-semibold">30d Bills</th>
                  <th className="py-2 text-right font-semibold">30d Revenue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {breakdown.map((row) => (
                  <tr key={row.tenantId}>
                    <td className="py-2.5 pr-4 font-semibold text-slate-900">{row.tenantName}</td>
                    <td className="py-2.5 pr-4">
                      <Badge variant="outline">{row.status}</Badge>
                    </td>
                    <td className="py-2.5 pr-4">{row.todayBillsCount}</td>
                    <td className="py-2.5 pr-4 font-medium text-slate-800">
                      {formatInrFromPaise(row.todayRevenuePaise)}
                    </td>
                    <td className="py-2.5 pr-4">{row.last30DaysBillsCount}</td>
                    <td className="py-2.5 text-right font-semibold text-emerald-700">
                      {formatInrFromPaise(row.last30DaysRevenuePaise)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

interface TrialManagementPanelProps {
  subscriptions: AdminSubscriptionRow[];
  restaurants: AdminRestaurantRow[];
  busyAction: boolean;
  onExtendTrial: (tenantId: string, days: number) => Promise<void>;
  onOpenConvertPlan: (rest: AdminRestaurantRow) => void;
  onRunSweep: () => Promise<void>;
}

export function TrialManagementPanel({
  subscriptions,
  restaurants,
  busyAction,
  onExtendTrial,
  onOpenConvertPlan,
  onRunSweep,
}: TrialManagementPanelProps) {
  const [customDays, setCustomDays] = useState<Record<string, string>>({});

  const trialRows = subscriptions.filter(
    (s) => s.status === 'TRIAL' || s.status === 'GRACE' || s.status === 'EXPIRED',
  );
  const restMap = new Map(restaurants.map((r) => [r.id, r]));

  return (
    <div className="space-y-4" data-testid="sa-trials-panel">
      <Card className="border-slate-200 bg-white">
        <CardHeader className="flex flex-wrap flex-row items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="h-4 w-4 text-primary" />
              Trial, Grace & Expiring Workspaces ({trialRows.length})
            </CardTitle>
            <CardDescription>
              Extend free trial windows, convert tenants to paid subscriptions, or sweep expired
              trials.
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" disabled={busyAction} onClick={() => void onRunSweep()}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Run Lifecycle Sweep
          </Button>
        </CardHeader>
        <CardContent>
          {trialRows.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">
              No restaurants are currently in Trial, Grace, or Expired subscription states.
            </p>
          ) : (
            <div className="space-y-3">
              {trialRows.map((sub) => {
                const targetEnd = sub.trialEndsAt ?? sub.currentPeriodEnd;
                const daysLeft = targetEnd
                  ? Math.ceil((new Date(targetEnd).getTime() - Date.now()) / (24 * 60 * 60 * 1000))
                  : null;
                const restRow = restMap.get(sub.tenantId);
                const canExtend =
                  sub.tenantStatus !== 'PENDING_APPROVAL' && sub.tenantStatus !== 'REJECTED';
                const customVal = Number.parseInt(customDays[sub.tenantId] ?? '7', 10) || 7;

                return (
                  <div
                    key={sub.id}
                    className="flex flex-col gap-3 rounded-lg border border-slate-200 p-4 lg:flex-row lg:items-center lg:justify-between"
                  >
                    <div className="space-y-1 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-bold text-slate-900">{sub.tenantName}</span>
                        <Badge variant={sub.status === 'EXPIRED' ? 'destructive' : 'warning'}>
                          SUB: {sub.status}
                        </Badge>
                        <Badge variant="outline">TENANT: {sub.tenantStatus}</Badge>
                      </div>
                      <p className="text-slate-600">
                        Plan: <strong>{sub.plan.name}</strong> • Trial Ends:{' '}
                        {targetEnd
                          ? new Date(targetEnd).toLocaleDateString('en-IN', {
                              day: '2-digit',
                              month: 'short',
                              year: 'numeric',
                            })
                          : '—'}{' '}
                        {daysLeft !== null && (
                          <span
                            className={`font-semibold ${
                              daysLeft <= 3 ? 'text-amber-700' : 'text-emerald-700'
                            }`}
                          >
                            ({daysLeft > 0 ? `${daysLeft} days left` : 'Expired'})
                          </span>
                        )}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyAction || !canExtend}
                        onClick={() => void onExtendTrial(sub.tenantId, 7)}
                      >
                        <CalendarPlus className="mr-1 h-3.5 w-3.5" />
                        +7d
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyAction || !canExtend}
                        onClick={() => void onExtendTrial(sub.tenantId, 14)}
                      >
                        +14d
                      </Button>
                      <div className="flex items-center gap-1">
                        <Input
                          type="number"
                          min={1}
                          max={90}
                          value={customDays[sub.tenantId] ?? '7'}
                          onChange={(e) =>
                            setCustomDays((prev) => ({
                              ...prev,
                              [sub.tenantId]: e.target.value,
                            }))
                          }
                          className="h-8 w-16 text-xs"
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyAction || !canExtend}
                          onClick={() => void onExtendTrial(sub.tenantId, customVal)}
                        >
                          Extend
                        </Button>
                      </div>
                      {restRow && (
                        <Button
                          size="sm"
                          disabled={busyAction}
                          onClick={() => onOpenConvertPlan(restRow)}
                        >
                          Convert to Paid
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

