'use client';

import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
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
import { loginSchema } from '@autonex/validation';
import { ArrowLeft, Eye, EyeOff, KeyRound, Lock, ShieldCheck, UserPlus } from 'lucide-react';
import {
  ApiError,
  clearStoredSession,
  getStoredSession,
  getSuperAdminSetupStatus,
  setStoredSession,
  setupInitialSuperAdmin,
  superAdminLogin,
  SuperAdminSetupStatus,
} from '@/lib/api-client';

function SuperAdminLoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const unauthorizedFlag = searchParams.get('error') === 'unauthorized';
  const resetSuccessFlag = searchParams.get('reset') === 'success';

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(
    unauthorizedFlag
      ? 'Super Admin authentication required. Restaurant owners and staff cannot access /super-admin.'
      : null,
  );
  const [notice, setNotice] = useState<string | null>(
    resetSuccessFlag ? 'Super Admin password reset completed. Sign in with your new password.' : null,
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Initial setup mode (only enabled when no active Super Admin exists in DB)
  const [setupStatus, setSetupStatus] = useState<SuperAdminSetupStatus | null>(null);
  const [setupMode, setSetupMode] = useState(false);
  const [setupName, setSetupName] = useState('');
  const [setupEmail, setSetupEmail] = useState('');
  const [setupPhone, setSetupPhone] = useState('');
  const [setupPassword, setSetupPassword] = useState('');
  const [setupToken, setSetupToken] = useState('');

  useEffect(() => {
    const stored = getStoredSession('super-admin');
    if (stored?.accessToken && stored.user?.isSuperAdmin && stored.user?.role === 'SUPER_ADMIN') {
      router.replace('/super-admin/dashboard');
      return;
    }

    let active = true;
    getSuperAdminSetupStatus()
      .then((status) => {
        if (!active) return;
        setSetupStatus(status);
        if (!status.initialized) {
          setSetupMode(true);
        }
      })
      .catch(() => {
        // Setup status check is non-blocking; login remains available.
      });

    return () => {
      active = false;
    };
  }, [router]);

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
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
      const res = await superAdminLogin(parsed.data);

      if (!res.user?.isSuperAdmin || res.user?.role !== 'SUPER_ADMIN') {
        clearStoredSession('super-admin');
        setError(
          'Access denied. Only authorized AutoNex Super Administrators can sign in to the Super Admin portal.',
        );
        return;
      }

      setStoredSession(
        {
          accessToken: res.accessToken,
          user: {
            ...res.user,
            isSuperAdmin: true,
          },
        },
        'super-admin',
      );

      router.replace('/super-admin/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to sign in to Super Admin portal.');
    } finally {
      setLoading(false);
    }
  };

  const handleSetupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setFieldErrors({});

    if (!setupName.trim() || !setupEmail.trim() || !setupPhone.trim() || setupPassword.length < 10) {
      setError('Complete all fields. Initial Super Admin password must be at least 10 characters.');
      return;
    }

    setLoading(true);
    try {
      const res = await setupInitialSuperAdmin({
        name: setupName.trim(),
        email: setupEmail.trim(),
        phone: setupPhone.trim(),
        password: setupPassword,
        ...(setupToken.trim() ? { setupToken: setupToken.trim() } : {}),
      });

      setStoredSession(
        {
          accessToken: res.accessToken,
          user: {
            ...res.user,
            isSuperAdmin: true,
          },
        },
        'super-admin',
      );

      router.replace('/super-admin/dashboard');
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Unable to initialize first Super Admin account.',
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 px-4 py-10 text-slate-100">
      <div className="mx-auto flex max-w-md flex-col gap-6 pt-6">
        <div className="flex items-center justify-between">
          <Link
            href="/login"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-white"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Restaurant Owner Login
          </Link>
          <Badge className="border-orange-500/40 bg-orange-500/15 text-orange-300">
            Platform Control
          </Badge>
        </div>

        <div className="text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary text-white shadow-lg shadow-orange-600/20">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <h1 className="mt-4 text-2xl font-bold tracking-tight text-white">
            AutoNex Super Admin
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Restricted platform governance, restaurant approvals & revenue telemetry
          </p>
        </div>

        <Card className="border-slate-800 bg-slate-900 text-slate-100 shadow-2xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-white">
              {setupMode && setupStatus && !setupStatus.initialized ? (
                <>
                  <UserPlus className="h-4 w-4 text-primary" />
                  Initialize Super Admin
                </>
              ) : (
                <>
                  <Lock className="h-4 w-4 text-primary" />
                  Administrator Sign In
                </>
              )}
            </CardTitle>
            <CardDescription className="text-slate-400">
              {setupMode && setupStatus && !setupStatus.initialized
                ? 'No Super Admin account exists yet. Create the first platform administrator.'
                : 'Authenticate with your registered Super Admin email or phone number.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {notice && (
              <Alert
                className="border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                data-testid="super-admin-login-notice"
              >
                <AlertDescription>{notice}</AlertDescription>
              </Alert>
            )}

            {error && (
              <Alert variant="destructive" data-testid="super-admin-login-error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {setupMode && setupStatus && !setupStatus.initialized ? (
              <form onSubmit={handleSetupSubmit} className="space-y-3.5" noValidate>
                <div className="space-y-1.5">
                  <Label htmlFor="sa-setup-name" className="text-slate-200">
                    Full Name
                  </Label>
                  <Input
                    id="sa-setup-name"
                    value={setupName}
                    onChange={(e) => setSetupName(e.target.value)}
                    placeholder="Platform Administrator"
                    className="border-slate-700 bg-slate-950 text-white placeholder:text-slate-500"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sa-setup-email" className="text-slate-200">
                    Email
                  </Label>
                  <Input
                    id="sa-setup-email"
                    type="email"
                    value={setupEmail}
                    onChange={(e) => setSetupEmail(e.target.value)}
                    placeholder="Enter administrator email"
                    className="border-slate-700 bg-slate-950 text-white placeholder:text-slate-500"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sa-setup-phone" className="text-slate-200">
                    Phone Number
                  </Label>
                  <Input
                    id="sa-setup-phone"
                    value={setupPhone}
                    onChange={(e) => setSetupPhone(e.target.value)}
                    placeholder="+91XXXXXXXXXX"
                    className="border-slate-700 bg-slate-950 text-white placeholder:text-slate-500"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sa-setup-password" className="text-slate-200">
                    Strong Password (min 10 chars, upper/lower/digit)
                  </Label>
                  <Input
                    id="sa-setup-password"
                    type="password"
                    value={setupPassword}
                    onChange={(e) => setSetupPassword(e.target.value)}
                    placeholder="Create strong administrator password"
                    className="border-slate-700 bg-slate-950 text-white placeholder:text-slate-500"
                  />
                </div>
                {setupStatus.requiresSetupToken && (
                  <div className="space-y-1.5">
                    <Label htmlFor="sa-setup-token" className="text-slate-200">
                      Setup Token
                    </Label>
                    <Input
                      id="sa-setup-token"
                      type="password"
                      value={setupToken}
                      onChange={(e) => setSetupToken(e.target.value)}
                      placeholder="Enter server SUPER_ADMIN_SETUP_TOKEN"
                      className="border-slate-700 bg-slate-950 text-white placeholder:text-slate-500"
                    />
                  </div>
                )}
                <Button type="submit" disabled={loading} className="w-full">
                  {loading ? 'Creating Super Admin...' : 'Initialize Super Admin Account'}
                </Button>
                <button
                  type="button"
                  onClick={() => setSetupMode(false)}
                  className="w-full text-center text-xs text-slate-400 hover:text-slate-200"
                >
                  Back to Sign In
                </button>
              </form>
            ) : (
              <form onSubmit={handleLoginSubmit} className="space-y-4" noValidate>
                <div className="space-y-1.5">
                  <Label htmlFor="sa-identifier" className="text-slate-200">
                    Admin Email or Phone
                  </Label>
                  <Input
                    id="sa-identifier"
                    data-testid="super-admin-identifier"
                    type="text"
                    autoComplete="username"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    placeholder="Enter registered email or phone"
                    className="border-slate-700 bg-slate-950 text-white placeholder:text-slate-500"
                  />
                  {fieldErrors.identifier && (
                    <p className="text-xs text-red-400">{fieldErrors.identifier}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="sa-password" className="text-slate-200">
                      Password
                    </Label>
                    <Link
                      href="/super-admin/reset-password"
                      data-testid="super-admin-forgot-link"
                      className="inline-flex items-center gap-1 text-xs font-medium text-orange-400 hover:text-orange-300"
                    >
                      <KeyRound className="h-3 w-3" />
                      Forgot password?
                    </Link>
                  </div>
                  <div className="relative">
                    <Input
                      id="sa-password"
                      data-testid="super-admin-password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter administrator password"
                      className="border-slate-700 bg-slate-950 pr-10 text-white placeholder:text-slate-500"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((prev) => !prev)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {fieldErrors.password && (
                    <p className="text-xs text-red-400">{fieldErrors.password}</p>
                  )}
                </div>

                <Button
                  type="submit"
                  data-testid="super-admin-submit"
                  disabled={loading}
                  className="w-full"
                >
                  {loading ? 'Verifying Super Admin...' : 'Sign In to Super Admin'}
                </Button>

                {setupStatus && !setupStatus.initialized && (
                  <button
                    type="button"
                    onClick={() => setSetupMode(true)}
                    className="w-full text-center text-xs text-orange-400 hover:text-orange-300"
                  >
                    First-time setup required — Initialize Super Admin
                  </button>
                )}
              </form>
            )}
          </CardContent>
        </Card>

        <p className="text-center text-xs text-slate-500">
          Protected by role-based access control (`SUPER_ADMIN`), lockout protection & audit
          logging.
        </p>
      </div>
    </div>
  );
}

export default function SuperAdminLoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-slate-950" />}>
      <SuperAdminLoginContent />
    </Suspense>
  );
}
