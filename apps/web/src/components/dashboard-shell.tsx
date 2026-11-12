'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Badge,
  Button,
  Select,
  Separator,
  cn,
} from '@autonex/ui';
import {
  Building2,
  ChefHat,
  CreditCard,
  LayoutDashboard,
  LogOut,
  Menu,
  QrCode,
  ReceiptIndianRupee,
  Settings,
  ShieldCheck,
  Store,
  Users,
  UtensilsCrossed,
  X,
} from 'lucide-react';
import { SubscriptionBanner } from '@/components/subscription-banner';
import {
  broadcastWorkspaceSync,
  clearStoredSession,
  ensureFreshAccessToken,
  getCurrentTenant,
  getStoredSession,
  getUsersMe,
  listOutlets,
  logoutSession,
  OutletRecordDto,
  setStoredSession,
  subscribeRealtimeStream,
  subscribeWorkspaceSync,
  switchOutlet,
  TenantCurrentDto,
  UserMeProfileDto,
} from '@/lib/api-client';

interface NavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

const WORKSPACE_NAV: NavItem[] = [
  { label: 'Overview', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Outlets', href: '/dashboard/outlets', icon: Store },
  { label: 'Team & Roles', href: '/dashboard/team', icon: Users },
  { label: 'Settings', href: '/dashboard/settings', icon: Settings },
];

const OPERATIONS_NAV: NavItem[] = [
  { label: 'Menu Editor', href: '/dashboard/menu', icon: UtensilsCrossed },
  { label: 'Tables & QR', href: '/dashboard/tables', icon: QrCode },
  { label: 'Dining Floor', href: '/dashboard/floor', icon: Building2 },
  { label: 'Kitchen KDS', href: '/dashboard/kds', icon: ChefHat },
  { label: 'Billing & Payments', href: '/dashboard/billing', icon: ReceiptIndianRupee },
  { label: 'Plan & Support', href: '/dashboard/plan', icon: CreditCard },
];

function statusVariant(status?: string) {
  switch (status) {
    case 'ACTIVE':
    case 'TRIAL':
      return 'success' as const;
    case 'PENDING_APPROVAL':
    case 'GRACE':
      return 'warning' as const;
    case 'LOCKED':
    case 'SUSPENDED':
    case 'REJECTED':
      return 'destructive' as const;
    default:
      return 'secondary' as const;
  }
}

function statusDisplayLabel(status?: string) {
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
    default:
      return status ?? 'LOADING';
  }
}

export interface DashboardShellProps {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  onOutletChanged?: (outletId: string) => void;
  children: React.ReactNode;
}

export function DashboardShell({
  title,
  subtitle,
  actions,
  onOutletChanged,
  children,
}: DashboardShellProps) {
  const pathname = usePathname();
  const router = useRouter();

  const [mobileOpen, setMobileOpen] = useState(false);
  const [me, setMe] = useState<UserMeProfileDto | null>(null);
  const [tenant, setTenant] = useState<TenantCurrentDto | null>(null);
  const [outlets, setOutlets] = useState<OutletRecordDto[]>([]);
  const [activeOutletId, setActiveOutletId] = useState<string>('');
  const [switchingOutlet, setSwitchingOutlet] = useState(false);

  const loadWorkspaceContext = useCallback(async () => {
    let stored = getStoredSession('tenant');
    if (!stored?.accessToken) {
      const refreshed = await ensureFreshAccessToken('tenant');
      if (!refreshed) {
        router.replace('/login');
        return;
      }
      stored = getStoredSession('tenant');
    }

    if (!stored?.accessToken || !stored.user?.tenantId || stored.user?.isSuperAdmin) {
      clearStoredSession('tenant');
      router.replace('/login');
      return;
    }

    if (stored.user.outletId) {
      setActiveOutletId(stored.user.outletId);
    }

    const [meRes, tenantRes, outletsRes] = await Promise.allSettled([
      getUsersMe(),
      getCurrentTenant(),
      listOutlets(),
    ]);

    if (meRes.status === 'fulfilled') {
      setMe(meRes.value);
      if (meRes.value.outletId) {
        setActiveOutletId(meRes.value.outletId);
      }
    } else if (
      meRes.reason &&
      typeof meRes.reason === 'object' &&
      'status' in meRes.reason &&
      ((meRes.reason as { status: number }).status === 401 ||
        ((meRes.reason as { status: number; code?: string }).status === 403 &&
          (meRes.reason as { code?: string }).code === 'TENANT_REJECTED'))
    ) {
      clearStoredSession('tenant');
      router.replace('/login');
      return;
    } else if (
      meRes.reason &&
      typeof meRes.reason === 'object' &&
      'code' in meRes.reason &&
      (meRes.reason as { code?: string }).code === 'TENANT_SUSPENDED'
    ) {
      setTenant((prev) =>
        prev ? { ...prev, status: 'SUSPENDED' as typeof prev.status } : prev,
      );
      setMe((prev) => (prev ? { ...prev, tenantStatus: 'SUSPENDED' } : prev));
    }

    if (tenantRes.status === 'fulfilled') {
      setTenant(tenantRes.value);
    }
    if (outletsRes.status === 'fulfilled') {
      setOutlets(outletsRes.value);
    }

    const liveStatus =
      (tenantRes.status === 'fulfilled' ? tenantRes.value.status : undefined) ??
      (meRes.status === 'fulfilled' ? meRes.value.tenantStatus : undefined);

    if (liveStatus && stored.user.tenantStatus !== liveStatus) {
      setStoredSession(
        {
          ...stored,
          user: {
            ...stored.user,
            tenantStatus: liveStatus,
          },
          ...(tenantRes.status === 'fulfilled'
            ? {
                tenant: {
                  id: tenantRes.value.id,
                  name: tenantRes.value.name,
                  slug: tenantRes.value.slug,
                  status: tenantRes.value.status,
                },
              }
            : stored.tenant
              ? { tenant: { ...stored.tenant, status: liveStatus as typeof stored.tenant.status } }
              : {}),
        },
        'tenant',
      );
      if (liveStatus !== 'SUSPENDED' && liveStatus !== 'REJECTED') {
        void ensureFreshAccessToken('tenant');
      }
    }
  }, [router]);

  useEffect(() => {
    void loadWorkspaceContext();
    const unsubSync = subscribeWorkspaceSync(() => {
      void loadWorkspaceContext();
    });
    const unsubSse = subscribeRealtimeStream('tenant', (evt) => {
      if (
        evt.type === 'restaurant.approved' ||
        evt.type === 'restaurant.reactivated' ||
        evt.type === 'subscription.updated' ||
        evt.type === 'trial.updated' ||
        evt.type === 'outlet.created' ||
        evt.type === 'outlet.updated'
      ) {
        void ensureFreshAccessToken('tenant').finally(() => {
          broadcastWorkspaceSync();
        });
      } else if (evt.type === 'restaurant.suspended' || evt.type === 'restaurant.rejected') {
        const nextStatus = evt.type === 'restaurant.rejected' ? 'REJECTED' : 'SUSPENDED';
        const currentStored = getStoredSession('tenant');
        if (currentStored) {
          const updatedSession = {
            ...currentStored,
            user: {
              ...currentStored.user,
              tenantStatus: nextStatus,
            },
            ...(currentStored.tenant
              ? {
                  tenant: {
                    ...currentStored.tenant,
                    status: nextStatus as typeof currentStored.tenant.status,
                  },
                }
              : {}),
          };
          setStoredSession(updatedSession, 'tenant');
          setTenant((prev) =>
            prev ? { ...prev, status: nextStatus as typeof prev.status } : prev,
          );
          setMe((prev) => (prev ? { ...prev, tenantStatus: nextStatus } : prev));
        }
        broadcastWorkspaceSync();
      } else {
        broadcastWorkspaceSync();
      }
    });
    return () => {
      unsubSync();
      unsubSse();
    };
  }, [loadWorkspaceContext]);

  useEffect(() => {
    const status = tenant?.status ?? me?.tenantStatus;
    const intervalMs = status === 'PENDING_APPROVAL' ? 6000 : 30000;
    const timer = window.setInterval(() => {
      void loadWorkspaceContext();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [tenant?.status, me?.tenantStatus, loadWorkspaceContext]);

  const handleOutletChange = async (nextOutletId: string) => {
    if (!nextOutletId || nextOutletId === activeOutletId) return;
    setSwitchingOutlet(true);
    try {
      await switchOutlet(nextOutletId);
      setActiveOutletId(nextOutletId);
      onOutletChanged?.(nextOutletId);
      router.refresh();
    } finally {
      setSwitchingOutlet(false);
    }
  };

  const handleLogout = async () => {
    await logoutSession('tenant');
    router.replace('/login');
  };

  const renderNavSection = (label: string, items: NavItem[]) => (
    <div className="space-y-1">
      <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      {items.map((item) => {
        const Icon = item.icon;
        const active =
          item.href === '/dashboard'
            ? pathname === '/dashboard'
            : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setMobileOpen(false)}
            className={cn(
              'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              active
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-foreground/80 hover:bg-secondary hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </div>
  );

  const sidebarContent = (
    <div className="flex h-full flex-col bg-card">
      <div className="flex items-center justify-between px-4 py-4">
        <Link href="/dashboard" className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground">
            AN
          </div>
          <div>
            <div className="text-sm font-bold tracking-tight text-foreground">AutoNex</div>
            <div className="text-[11px] text-muted-foreground">Restaurant OS</div>
          </div>
        </Link>
        <button
          type="button"
          onClick={() => setMobileOpen(false)}
          className="rounded-md p-1 text-muted-foreground hover:bg-secondary lg:hidden"
          aria-label="Close navigation"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="px-4 pb-3">
        <div className="rounded-xl border border-border bg-secondary/40 p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p
                data-testid="sidebar-restaurant-name"
                className="truncate text-sm font-semibold text-foreground"
              >
                {tenant?.name ?? 'Restaurant Workspace'}
              </p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {me?.name ?? 'Team Member'} • {me?.role ?? 'STAFF'}
              </p>
            </div>
            <Badge
              data-testid="sidebar-tenant-status"
              variant={statusVariant(tenant?.status ?? me?.tenantStatus)}
            >
              {statusDisplayLabel(tenant?.status ?? me?.tenantStatus)}
            </Badge>
          </div>
        </div>
      </div>

      <Separator />

      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
        {renderNavSection('Workspace', WORKSPACE_NAV)}
        {renderNavSection('Operations', OPERATIONS_NAV)}
        {me?.isSuperAdmin && (
          <div className="space-y-1">
            <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Platform
            </p>
            <Link
              href="/super-admin"
              className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-foreground/80 hover:bg-secondary"
            >
              <ShieldCheck className="h-4 w-4" />
              <span>Super Admin</span>
            </Link>
          </div>
        )}
      </nav>

      <Separator />

      <div className="p-3">
        <Button
          type="button"
          variant="outline"
          data-testid="logout-button"
          onClick={handleLogout}
          className="w-full justify-start gap-2"
        >
          <LogOut className="h-4 w-4" />
          <span>Sign Out</span>
        </Button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Desktop Sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-border bg-card lg:block">
        {sidebarContent}
      </aside>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div
            className="fixed inset-0 bg-foreground/40 backdrop-blur-xs"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="relative z-10 w-64 border-r border-border bg-card shadow-xl">
            {sidebarContent}
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex min-h-screen flex-col lg:pl-64">
        <header className="sticky top-0 z-20 border-b border-border bg-card/90 backdrop-blur">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-6">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setMobileOpen(true)}
                className="rounded-lg border border-border p-2 text-foreground hover:bg-secondary lg:hidden"
                aria-label="Open menu"
              >
                <Menu className="h-5 w-5" />
              </button>
              <div>
                <h1 className="text-lg font-bold tracking-tight text-foreground sm:text-xl">
                  {title}
                </h1>
                {subtitle && (
                  <p className="text-xs text-muted-foreground sm:text-sm">{subtitle}</p>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              {outlets.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="hidden text-xs font-medium text-muted-foreground sm:inline">
                    Outlet:
                  </span>
                  <Select
                    data-testid="outlet-selector"
                    aria-label="Active outlet selector"
                    value={activeOutletId || outlets[0]?.id || ''}
                    disabled={switchingOutlet}
                    onChange={(e) => void handleOutletChange(e.target.value)}
                    className="h-9 min-w-[180px] text-xs font-medium"
                  >
                    {outlets.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name} {o.isActive ? '' : '(Inactive)'}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
              {actions}
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
          <SubscriptionBanner />
          {children}
        </main>
      </div>
    </div>
  );
}
