'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getStoredSession } from '@/lib/api-client';

export default function LegacyAdminRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    const stored = getStoredSession('super-admin');
    if (stored?.accessToken && stored.user?.isSuperAdmin && stored.user?.role === 'SUPER_ADMIN') {
      router.replace('/super-admin');
    } else {
      router.replace('/super-admin/login');
    }
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 text-sm text-slate-300">
      Redirecting to AutoNex Super Admin Portal...
    </div>
  );
}
