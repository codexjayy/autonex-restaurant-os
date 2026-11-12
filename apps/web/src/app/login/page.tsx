'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { TenantStatus } from '@autonex/shared';
import { ApiError, AuthSession, apiRequest, setStoredSession } from '@/lib/api-client';

interface LoginResponse {
  accessToken: string;
  user: AuthSession['user'] & { tenantStatus?: TenantStatus };
  memberships?: Array<{
    tenantId: string;
    tenantName: string;
    tenantStatus: TenantStatus;
    outletId: string;
    outletName: string;
    role: string;
  }>;
}

export default function LoginPage() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const res = await apiRequest<LoginResponse>('/auth/login', {
        method: 'POST',
        auth: false,
        body: JSON.stringify({ identifier, password }),
      });
      const primary = res.memberships?.[0];
      setStoredSession({
        accessToken: res.accessToken,
        user: res.user,
        ...(primary
          ? {
              tenant: {
                id: primary.tenantId,
                name: primary.tenantName,
                slug: primary.tenantName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
                status: primary.tenantStatus,
              },
              outlet: {
                id: primary.outletId,
                name: primary.outletName,
                timezone: 'Asia/Kolkata',
              },
            }
          : {}),
      });
      if (res.user.role === 'SUPER_ADMIN') {
        router.push('/admin');
      } else {
        router.push('/dashboard');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-7 shadow-sm">
        <h1 className="text-2xl font-bold text-slate-900">Owner / Manager Login</h1>
        <p className="mt-1 text-sm text-slate-600">
          Manage your restaurant menu, item availability, and table QR codes.
        </p>

        {error && (
          <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-600">
              Email or Phone
            </label>
            <input
              required
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="owner@restaurant.in or +919876543210"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-600">
              Password
            </label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {submitting ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-slate-600">
          New restaurant?{' '}
          <Link href="/register" className="font-semibold text-brand-600 hover:underline">
            Register here
          </Link>
        </p>
      </div>
    </main>
  );
}

