'use client';

import React from 'react';
import { formatInrFromPaise } from '@autonex/shared';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@autonex/ui';
import { BarChart3, Building2, IndianRupee, Layers, TrendingUp, Users } from 'lucide-react';
import type { AdminOverviewResponse, TenantStatus } from '@/lib/api-client';

interface AnalyticsPanelProps {
  overviewData: AdminOverviewResponse | null;
}

const STATUS_KEYS: Array<{ key: TenantStatus; label: string; colorClass: string }> = [
  { key: 'ACTIVE' as TenantStatus, label: 'Approved • Active', colorClass: 'bg-emerald-500' },
  { key: 'TRIAL' as TenantStatus, label: 'Approved • Trial', colorClass: 'bg-sky-500' },
  { key: 'PENDING_APPROVAL' as TenantStatus, label: 'Pending Approval', colorClass: 'bg-amber-500' },
  { key: 'GRACE' as TenantStatus, label: 'Grace Period', colorClass: 'bg-orange-500' },
  { key: 'SUSPENDED' as TenantStatus, label: 'Suspended', colorClass: 'bg-red-500' },
  { key: 'LOCKED' as TenantStatus, label: 'Locked / Draining', colorClass: 'bg-rose-700' },
  { key: 'REJECTED' as TenantStatus, label: 'Rejected', colorClass: 'bg-slate-400' },
];

export function AnalyticsPanel({ overviewData }: AnalyticsPanelProps) {
  const ov = overviewData?.overview;
  const telemetry = overviewData?.restaurantsTelemetry ?? [];
  const total = Math.max(ov?.totalRestaurants ?? 0, 1);

  return (
    <div className="space-y-6" data-testid="sa-analytics-panel">
      {/* Platform Operations Summary */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="border-slate-200 bg-white">
          <CardHeader className="flex flex-row items-center justify-between pb-1">
            <CardDescription className="text-xs font-medium uppercase tracking-wide">
              Orders (Last 30 Days)
            </CardDescription>
            <TrendingUp className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900">
              {ov?.platformOrdersLast30Days ?? 0}
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {ov?.platformSessionsLast30Days ?? 0} dining sessions across platform
            </p>
          </CardContent>
        </Card>

        <Card className="border-slate-200 bg-white">
          <CardHeader className="flex flex-row items-center justify-between pb-1">
            <CardDescription className="text-xs font-medium uppercase tracking-wide">
              Restaurant GMV (30d)
            </CardDescription>
            <IndianRupee className="h-4 w-4 text-emerald-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-700">
              {formatInrFromPaise(ov?.platformRevenueLast30DaysPaise ?? 0)}
            </div>
            <p className="mt-1 text-xs text-slate-500">
              All-time settled: {formatInrFromPaise(ov?.totalRestaurantRevenuePaise ?? 0)}
            </p>
          </CardContent>
        </Card>

        <Card className="border-slate-200 bg-white">
          <CardHeader className="flex flex-row items-center justify-between pb-1">
            <CardDescription className="text-xs font-medium uppercase tracking-wide">
              SaaS MRR
            </CardDescription>
            <Layers className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900">
              {formatInrFromPaise(ov?.mrrPaise ?? 0)}
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Total sub collected: {formatInrFromPaise(ov?.totalSubscriptionRevenuePaise ?? 0)}
            </p>
          </CardContent>
        </Card>

        <Card className="border-slate-200 bg-white">
          <CardHeader className="flex flex-row items-center justify-between pb-1">
            <CardDescription className="text-xs font-medium uppercase tracking-wide">
              Active Staff & Tables
            </CardDescription>
            <Users className="h-4 w-4 text-slate-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900">
              {telemetry.reduce((acc, r) => acc + r.telemetry.staffCount, 0)} staff
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {telemetry.reduce((acc, r) => acc + r.telemetry.tablesCount, 0)} active tables •{' '}
              {telemetry.reduce((acc, r) => acc + r.telemetry.activeOpenSessionsCount, 0)} live
              open tables
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Status Distribution */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="border-slate-200 bg-white">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <BarChart3 className="h-4 w-4 text-primary" />
              Restaurant Account Lifecycle Distribution
            </CardTitle>
            <CardDescription>Real-time tenant statuses across PostgreSQL.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {STATUS_KEYS.map((item) => {
              const count = ov?.restaurantsByStatus?.[item.key] ?? 0;
              const pct = Math.round((count / total) * 100);
              return (
                <div key={item.key} className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="font-medium text-slate-700">{item.label}</span>
                    <span className="text-slate-500">
                      {count} ({pct}%)
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={`h-full rounded-full ${item.colorClass}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card className="border-slate-200 bg-white">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="h-4 w-4 text-primary" />
              Subscription Lifecycle Breakdown
            </CardTitle>
            <CardDescription>Trial, paid, grace, expired, and suspended plans.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {(['TRIAL', 'ACTIVE', 'GRACE', 'EXPIRED', 'SUSPENDED'] as const).map((subStatus) => (
              <div
                key={subStatus}
                className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5"
              >
                <span className="text-xs font-semibold text-slate-700">{subStatus}</span>
                <Badge variant="outline">
                  {ov?.subscriptionsByStatus?.[subStatus] ?? 0}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Per-Restaurant Usage Telemetry Table */}
      <Card className="border-slate-200 bg-white">
        <CardHeader>
          <CardTitle className="text-base">Restaurant Usage & Revenue Telemetry</CardTitle>
          <CardDescription>
            Live orders, active sessions, tables, staff, and 30-day revenue per tenant.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {telemetry.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">
              No restaurant telemetry recorded yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-2 pr-4 font-semibold">Restaurant</th>
                    <th className="py-2 pr-4 font-semibold">Status</th>
                    <th className="py-2 pr-4 font-semibold">Plan</th>
                    <th className="py-2 pr-4 font-semibold">24h / 30d Orders</th>
                    <th className="py-2 pr-4 font-semibold">Live / 30d Sessions</th>
                    <th className="py-2 pr-4 font-semibold">Tables / Staff</th>
                    <th className="py-2 text-right font-semibold">30d Revenue</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {telemetry.map((row) => (
                    <tr key={row.tenantId} className="hover:bg-slate-50/70">
                      <td className="py-2.5 pr-4 font-semibold text-slate-900">
                        {row.tenantName}
                      </td>
                      <td className="py-2.5 pr-4">
                        <Badge variant="outline">{row.status}</Badge>
                      </td>
                      <td className="py-2.5 pr-4 text-slate-600">
                        {row.planName ?? 'Trial'} ({row.subscriptionStatus ?? '—'})
                      </td>
                      <td className="py-2.5 pr-4 text-slate-700">
                        {row.telemetry.ordersLast24Hours} / {row.telemetry.ordersLast30Days}
                      </td>
                      <td className="py-2.5 pr-4 text-slate-700">
                        {row.telemetry.activeOpenSessionsCount} / {row.telemetry.sessionsLast30Days}
                      </td>
                      <td className="py-2.5 pr-4 text-slate-700">
                        {row.telemetry.tablesCount} / {row.telemetry.staffCount}
                      </td>
                      <td className="py-2.5 text-right font-semibold text-emerald-700">
                        {formatInrFromPaise(row.telemetry.revenueLast30DaysPaise)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

