'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@autonex/ui';
import { loginSchema, staffPinLoginSchema } from '@autonex/validation';
import { ApiError, apiRequest, setStoredSession } from '@/lib/api-client';

interface PasswordLoginResponse {
  accessToken: string;
  user: {
    id: string;
    name: string;
    email?: string | null;
    phone: string;
    role: string;
    isSuperAdmin?: boolean;
    tenantId?: string;
    outletId?: string;
    tenantStatus?: string;
  };
}

interface PinLoginResponse {
  accessToken: string;
  membership: {
    id: string;
    tenantId: string;
    outletId: string;
    outletName: string;
    role: string;
    userName: string;
  };
}

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'password' | 'pin'>('password');

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');

  const [outletId, setOutletId] = useState('');
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFieldErrors({});

    const parsed = loginSchema.safeParse({ identifier, password });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '');
        if (key && !next[key]) next[key] = issue.message;
      }
      setFieldErrors(next);
      return;
    }

    setLoading(true);
    try {
      const res = await apiRequest<PasswordLoginResponse>('/auth/login', {
        method: 'POST',
        auth: false,
        body: JSON.stringify(parsed.data),
      });

      if (res.user.isSuperAdmin || res.user.role === 'SUPER_ADMIN') {
        setStoredSession(
          {
            accessToken: res.accessToken,
            user: res.user,
          },
          'super-admin',
        );
        router.push('/super-admin/dashboard');
      } else {
        setStoredSession(
          {
            accessToken: res.accessToken,
            user: res.user,
          },
          'tenant',
        );
        router.push('/dashboard');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to sign in');
    } finally {
      setLoading(false);
    }
  };

  const handlePinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFieldErrors({});

    const parsed = staffPinLoginSchema.safeParse({ outletId, phone, pin });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '');
        if (key && !next[key]) next[key] = issue.message;
      }
      setFieldErrors(next);
      return;
    }

    setLoading(true);
    try {
      const res = await apiRequest<PinLoginResponse>('/auth/staff-pin', {
        method: 'POST',
        auth: false,
        body: JSON.stringify(parsed.data),
      });

      setStoredSession({
        accessToken: res.accessToken,
        user: {
          id: res.membership.id,
          name: res.membership.userName,
          email: null,
          phone,
          role: res.membership.role,
          tenantId: res.membership.tenantId,
          outletId: res.membership.outletId,
        },
      });
      router.push('/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to sign in with PIN');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md space-y-5">
        <div className="text-center">
          <Badge variant="default">AutoNex Restaurant OS</Badge>
          <h1 className="mt-3 text-2xl font-bold tracking-tight text-foreground">
            Welcome back to your workspace
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in with owner credentials or outlet staff PIN
          </p>
        </div>

        <Card>
          <CardHeader className="pb-4">
            <div className="grid grid-cols-2 gap-2 rounded-xl bg-secondary p-1">
              <button
                type="button"
                data-testid="tab-password-login"
                onClick={() => {
                  setMode('password');
                  setError(null);
                  setFieldErrors({});
                }}
                className={`rounded-lg py-2 text-xs font-semibold transition ${
                  mode === 'password'
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Owner / Manager Login
              </button>
              <button
                type="button"
                data-testid="tab-pin-login"
                onClick={() => {
                  setMode('pin');
                  setError(null);
                  setFieldErrors({});
                }}
                className={`rounded-lg py-2 text-xs font-semibold transition ${
                  mode === 'pin'
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Staff PIN Sign In
              </button>
            </div>
            <CardTitle className="pt-3 text-base">
              {mode === 'password' ? 'Account Sign In' : 'Quick Outlet PIN'}
            </CardTitle>
            <CardDescription>
              {mode === 'password'
                ? 'Use your registered email address or phone number.'
                : 'Fast sign in for floor captains, cashiers, and kitchen team.'}
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            {error && (
              <Alert variant="destructive" data-testid="login-error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {mode === 'password' ? (
              <form onSubmit={handlePasswordSubmit} className="space-y-4" noValidate>
                <div className="space-y-1.5">
                  <Label htmlFor="login-identifier">Email or Phone</Label>
                  <Input
                    id="login-identifier"
                    data-testid="login-identifier"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    placeholder="owner@restaurant.in or +919825012345"
                    autoComplete="username"
                  />
                  {fieldErrors.identifier && (
                    <p className="text-xs text-destructive">{fieldErrors.identifier}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="login-password">Password</Label>
                  <Input
                    id="login-password"
                    data-testid="login-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    autoComplete="current-password"
                  />
                  {fieldErrors.password && (
                    <p className="text-xs text-destructive">{fieldErrors.password}</p>
                  )}
                </div>

                <Button
                  type="submit"
                  data-testid="login-submit"
                  disabled={loading}
                  className="w-full"
                >
                  {loading ? 'Signing in...' : 'Sign In'}
                </Button>
              </form>
            ) : (
              <form onSubmit={handlePinSubmit} className="space-y-4" noValidate>
                <div className="space-y-1.5">
                  <Label htmlFor="pin-outlet-id">Outlet ID</Label>
                  <Input
                    id="pin-outlet-id"
                    data-testid="pin-outlet-id"
                    value={outletId}
                    onChange={(e) => setOutletId(e.target.value)}
                    placeholder="UUID of your outlet"
                  />
                  {fieldErrors.outletId && (
                    <p className="text-xs text-destructive">{fieldErrors.outletId}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="pin-phone">Phone Number</Label>
                  <Input
                    id="pin-phone"
                    data-testid="pin-phone"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+919825012345"
                  />
                  {fieldErrors.phone && (
                    <p className="text-xs text-destructive">{fieldErrors.phone}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="pin-code">4–6 Digit PIN</Label>
                  <Input
                    id="pin-code"
                    data-testid="pin-code"
                    type="password"
                    inputMode="numeric"
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                    placeholder="1234"
                  />
                  {fieldErrors.pin && <p className="text-xs text-destructive">{fieldErrors.pin}</p>}
                </div>

                <Button
                  type="submit"
                  data-testid="pin-submit"
                  disabled={loading}
                  className="w-full"
                >
                  {loading ? 'Verifying PIN...' : 'Sign In with PIN'}
                </Button>
              </form>
            )}

            <p className="pt-2 text-center text-xs text-muted-foreground">
              New restaurant on AutoNex?{' '}
              <Link href="/register" className="font-semibold text-primary hover:underline">
                Register your restaurant
              </Link>
            </p>
            <p className="text-center text-xs text-muted-foreground">
              Platform Administrator?{' '}
              <Link
                href="/super-admin/login"
                className="font-semibold text-slate-700 hover:text-primary hover:underline"
              >
                Super Admin Login
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
