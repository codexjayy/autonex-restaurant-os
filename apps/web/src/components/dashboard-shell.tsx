'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  ChefHat,
  ClipboardList,
  CreditCard,
  LayoutDashboard,
  LayoutGrid,
  LifeBuoy,
  LogOut,
  QrCode,
  Shield,
  UtensilsCrossed,
} from 'lucide-react';
import { AuthSession, clearStoredSession, getStoredSession } from '@/lib/api-client';
import { SubscriptionBanner } from './subscription-banner';

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Overview & Checklist', icon: LayoutDashboard },
  { href: '/dashboard/menu', label: 'Menu Editor', icon: UtensilsCrossed },
  { href: '/dashboard/tables', label: 'Tables & QR Print', icon: QrCode },
  { href: '/dashboard/floor', label: 'Live Floor', icon: LayoutGrid },
  { href: '/dashboard/billing', label: 'Billing & Payments', icon: CreditCard },
  { href: '/dashboard/staff-order', label: 'Waiter Ordering', icon: ClipboardList },
  { href: '/dashboard/kds', label: 'Kitchen KDS', icon: ChefHat },
  { href: '/dashboard/plan', label: 'Plan & Support', icon: LifeBuoy },
];

export function DashboardShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [session, setSession] = useState<AuthSession | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = getStoredSession();
    if (!stored?.accessToken) {
      router.replace('/login');
      return;
    }
    setSession(stored);
    setReady(true);
  }, [router]);

  const handleLogout = () => {
    clearStoredSession();
    router.replace('/login');
  };

  if (!ready || !session) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        Loading workspace...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-3.5 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 font-bold text-white">
              A
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-slate-900">
                  {session.outlet?.name || session.tenant?.name || 'AutoNex Restaurant'}
                </span>
                {session.tenant?.status && (
                  <span className="rounded-full bg-orange-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700 ring-1 ring-orange-200">
                    {session.tenant.status.replace('_', ' ')}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500">
                Signed in as {session.user.name} ({session.user.role})
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <nav className="flex flex-wrap items-center gap-1">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                      active
                        ? 'bg-brand-50 text-brand-700'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
            {session.user.role === 'SUPER_ADMIN' && (
              <Link
                href="/admin"
                className="ml-2 inline-flex items-center gap-1 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
              >
                <Shield className="h-3.5 w-3.5" />
                Super Admin
              </Link>
            )}
            <button
              type="button"
              onClick={handleLogout}
              className="ml-2 inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
            >
              <LogOut className="h-3.5 w-3.5" />
              Logout
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <SubscriptionBanner />
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-slate-600">{subtitle}</p>}
        </div>
        {children}
      </main>
    </div>
  );
}

