'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  ChefHat,
  Circle,
  ClipboardList,
  CreditCard,
  LayoutGrid,
  QrCode,
  UtensilsCrossed,
} from 'lucide-react';
import { DashboardShell } from '@/components/dashboard-shell';
import { ApiError, OnboardingChecklistResponse, apiRequest } from '@/lib/api-client';

export default function DashboardOverviewPage() {
  const [checklist, setChecklist] = useState<OnboardingChecklistResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiRequest<OnboardingChecklistResponse>('/outlet/onboarding')
      .then(setChecklist)
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : 'Unable to load onboarding status');
      });
  }, []);

  const stepItems = checklist
    ? [
        { label: 'Restaurant Profile & Contact Details', done: checklist.steps.profileComplete },
        { label: 'Platform Approval / Trial Activation', done: checklist.steps.adminApproved },
        {
          label: `Menu Items Configured (${checklist.counts?.menuItemsCount ?? 0} active)`,
          done: checklist.steps.menuConfigured,
          href: '/dashboard/menu',
        },
        {
          label: `Tables Created (${checklist.counts?.tablesCount ?? 0} active)`,
          done: checklist.steps.tablesConfigured,
          href: '/dashboard/tables',
        },
        {
          label: `Table QR Tokens Generated (${checklist.counts?.activeQrCount ?? 0} active)`,
          done: checklist.steps.qrGenerated,
          href: '/dashboard/tables',
        },
        { label: 'Additional Staff Added (optional)', done: checklist.steps.staffAdded },
      ]
    : [];

  return (
    <DashboardShell
      title="Restaurant Control Center"
      subtitle="Complete your menu, add dining tables, and download printable QR tent cards."
    >
      {error && (
        <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm md:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-900">Onboarding Checklist</h2>
            {checklist && (
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                  checklist.goLiveReady
                    ? 'bg-emerald-50 text-emerald-700'
                    : 'bg-amber-50 text-amber-700'
                }`}
              >
                {checklist.goLiveReady ? 'Ready for Service' : 'Setup In Progress'}
              </span>
            )}
          </div>

          {!checklist ? (
            <p className="mt-4 text-sm text-slate-500">Loading checklist...</p>
          ) : (
            <ul className="mt-4 divide-y divide-slate-100">
              {stepItems.map((step) => (
                <li key={step.label} className="flex items-center justify-between py-3">
                  <div className="flex items-center gap-3">
                    {step.done ? (
                      <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                    ) : (
                      <Circle className="h-5 w-5 text-slate-300" />
                    )}
                    <span className={step.done ? 'text-sm text-slate-900' : 'text-sm text-slate-600'}>
                      {step.label}
                    </span>
                  </div>
                  {step.href && (
                    <Link
                      href={step.href}
                      className="text-xs font-semibold text-brand-600 hover:underline"
                    >
                      Configure
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-4">
          <Link
            href="/dashboard/menu"
            className="block rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-brand-500"
          >
            <div className="flex items-center justify-between">
              <UtensilsCrossed className="h-6 w-6 text-brand-600" />
              <ArrowRight className="h-4 w-4 text-slate-400" />
            </div>
            <h3 className="mt-3 font-semibold text-slate-900">Menu Editor</h3>
            <p className="mt-1 text-xs text-slate-600">
              Create categories, dishes, modifier add-ons, WebP photos & out-of-stock toggles.
            </p>
          </Link>

          <Link
            href="/dashboard/tables"
            className="block rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-brand-500"
          >
            <div className="flex items-center justify-between">
              <QrCode className="h-6 w-6 text-brand-600" />
              <ArrowRight className="h-4 w-4 text-slate-400" />
            </div>
            <h3 className="mt-3 font-semibold text-slate-900">Tables & Bulk QR Print</h3>
            <p className="mt-1 text-xs text-slate-600">
              Manage floor tables, download all QR PDFs at once, or rotate compromised tokens.
            </p>
          </Link>

          <Link
            href="/dashboard/floor"
            className="block rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-brand-500"
          >
            <div className="flex items-center justify-between">
              <LayoutGrid className="h-6 w-6 text-brand-600" />
              <ArrowRight className="h-4 w-4 text-slate-400" />
            </div>
            <h3 className="mt-3 font-semibold text-slate-900">Live Table Floor</h3>
            <p className="mt-1 text-xs text-slate-600">
              Monitor live table stages, ready-to-serve pickups, pre-prep edits, bill lock, and reset.
            </p>
          </Link>

          <Link
            href="/dashboard/billing"
            className="block rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-brand-500"
          >
            <div className="flex items-center justify-between">
              <CreditCard className="h-6 w-6 text-brand-600" />
              <ArrowRight className="h-4 w-4 text-slate-400" />
            </div>
            <h3 className="mt-3 font-semibold text-slate-900">Billing & Payments</h3>
            <p className="mt-1 text-xs text-slate-600">
              Consolidate GST bills, record cash/UPI/card settlements, Razorpay links, refunds & PDF receipts.
            </p>
          </Link>

          <Link
            href="/dashboard/staff-order"
            className="block rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-brand-500"
          >
            <div className="flex items-center justify-between">
              <ClipboardList className="h-6 w-6 text-brand-600" />
              <ArrowRight className="h-4 w-4 text-slate-400" />
            </div>
            <h3 className="mt-3 font-semibold text-slate-900">Waiter Desk & Staff Order</h3>
            <p className="mt-1 text-xs text-slate-600">
              Open table sessions, share join codes, approve guests, or punch orders on behalf of diners.
            </p>
          </Link>

          <Link
            href="/dashboard/kds"
            className="block rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-brand-500"
          >
            <div className="flex items-center justify-between">
              <ChefHat className="h-6 w-6 text-brand-600" />
              <ArrowRight className="h-4 w-4 text-slate-400" />
            </div>
            <h3 className="mt-3 font-semibold text-slate-900">Kitchen Display (KDS)</h3>
            <p className="mt-1 text-xs text-slate-600">
              Live WebSocket kitchen board with audio chime, receipt acknowledgement & Gujarati/Hindi labels.
            </p>
          </Link>
        </div>
      </div>
    </DashboardShell>
  );
}

