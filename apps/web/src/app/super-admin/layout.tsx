'use client';

import React, { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  clearStoredSession,
  ensureFreshAccessToken,
  getAdminMe,
  getStoredSession,
} from '@/lib/api-client';

const PUBLIC_SUPER_ADMIN_PATHS = new Set(['/super-admin/login', '/super-admin/reset-password']);

export default function SuperAdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isPublicAuthRoute = PUBLIC_SUPER_ADMIN_PATHS.has(pathname);
  const [verified, setVerified] = useState(isPublicAuthRoute);

  useEffect(() => {
    if (isPublicAuthRoute) {
      setVerified(true);
      return;
    }

    let active = true;
    setVerified(false);

    const guard = async () => {
      let stored = getStoredSession('super-admin');
      if (!stored?.accessToken) {
        const refreshed = await ensureFreshAccessToken('super-admin');
        if (!refreshed) {
          const tenantSession = getStoredSession('tenant');
          if (active) {
            router.replace(
              tenantSession ? '/super-admin/login?error=unauthorized' : '/super-admin/login',
            );
          }
          return;
        }
        stored = getStoredSession('super-admin');
      }

      if (!stored?.user?.isSuperAdmin || stored.user?.role !== 'SUPER_ADMIN') {
        if (active) router.replace('/super-admin/login?error=unauthorized');
        return;
      }

      try {
        const me = await getAdminMe();
        if (!active) return;
        if (!me.isSuperAdmin || me.role !== 'SUPER_ADMIN') {
          router.replace('/super-admin/login?error=unauthorized');
          return;
        }
        setVerified(true);
      } catch {
        if (!active) return;
        clearStoredSession('super-admin');
        router.replace('/super-admin/login?error=unauthorized');
      }
    };

    void guard();

    return () => {
      active = false;
    };
  }, [isPublicAuthRoute, pathname, router]);

  if (!isPublicAuthRoute && !verified) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-sm text-slate-300">
        Verifying Super Admin session...
      </div>
    );
  }

  return <>{children}</>;
}

