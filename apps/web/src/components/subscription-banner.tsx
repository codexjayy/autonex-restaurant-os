'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AlertTriangle, Clock, Lock, ShieldAlert, Sparkles } from 'lucide-react';
import {
  apiRequest,
  subscribeWorkspaceSync,
  SubscriptionSummaryDto,
  TenantStatus,
} from '@/lib/api-client';

interface OwnerSubscriptionState {
  tenant: {
    id: string;
    name: string;
    status: TenantStatus;
    pendingSuspensionAfterService: boolean;
    suspensionReason: string | null;
  };
  subscription: SubscriptionSummaryDto | null;
}

export function SubscriptionBanner() {
  const [state, setState] = useState<OwnerSubscriptionState | null>(null);

  useEffect(() => {
    let active = true;
    const fetchState = () => {
      apiRequest<OwnerSubscriptionState>('/subscriptions/current')
        .then((res) => {
          if (active) setState(res);
        })
        .catch(() => {
          // Roles such as Kitchen/Waiter do not have /subscriptions/current access
        });
    };
    fetchState();
    const unsub = subscribeWorkspaceSync(fetchState);
    return () => {
      active = false;
      unsub();
    };
  }, []);

  if (!state?.subscription) return null;

  const { tenant, subscription } = state;
  const ev = subscription.evaluation;

  if (tenant.pendingSuspensionAfterService) {
    return (
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900">
        <div className="flex items-center gap-2.5">
          <ShieldAlert className="h-5 w-5 shrink-0 text-rose-600" />
          <div>
            <span className="font-semibold">Account suspension scheduled after live service:</span>{' '}
            New tables &amp; orders are paused. Finish active KDS tickets, settle open bills, and export
            today&apos;s summary.
          </div>
        </div>
        <Link
          href="/dashboard/plan"
          className="rounded-lg bg-rose-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-800"
        >
          Export / Contact Support
        </Link>
      </div>
    );
  }

  if (ev.isReadOnlyLocked || tenant.status === TenantStatus.LOCKED) {
    return (
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900">
        <div className="flex items-center gap-2.5">
          <Lock className="h-5 w-5 shrink-0 text-rose-600" />
          <div>
            <span className="font-semibold">Read-only mode ({subscription.plan.name}):</span>{' '}
            Subscription expired. Open tables can still finish KDS &amp; settle bills; renew your plan
            to resume new QR &amp; staff orders.
          </div>
        </div>
        <Link
          href="/dashboard/plan"
          className="rounded-lg bg-rose-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-800"
        >
          Manage Plan &amp; Export
        </Link>
      </div>
    );
  }

  if (ev.inGracePeriod) {
    return (
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
        <div className="flex items-center gap-2.5">
          <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
          <div>
            <span className="font-semibold">Grace Period ({ev.graceDaysRemaining} day{ev.graceDaysRemaining === 1 ? '' : 's'} left):</span>{' '}
            Your {subscription.plan.name} period ended. Complete renewal to avoid read-only lock.
          </div>
        </div>
        <Link
          href="/dashboard/plan"
          className="rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-800"
        >
          View Plan &amp; Support
        </Link>
      </div>
    );
  }

  if (subscription.status === 'TRIAL' && ev.daysRemaining <= 14) {
    return (
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-2.5 text-sm text-sky-900">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 shrink-0 text-sky-600" />
          <span>
            <span className="font-semibold">Free Trial ({subscription.plan.name}):</span>{' '}
            {ev.daysRemaining} day{ev.daysRemaining === 1 ? '' : 's'} remaining.
          </span>
        </div>
        <Link
          href="/dashboard/plan"
          className="inline-flex items-center gap-1 text-xs font-semibold text-sky-700 hover:underline"
        >
          <Sparkles className="h-3.5 w-3.5" /> Plan &amp; Support
        </Link>
      </div>
    );
  }

  return null;
}

