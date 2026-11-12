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
import { ArrowLeft, CheckCircle2, KeyRound, ShieldCheck } from 'lucide-react';
import {
  ApiError,
  requestSuperAdminPasswordReset,
  resetSuperAdminPassword,
} from '@/lib/api-client';

function ResetPasswordContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tokenFromUrl = searchParams.get('token') ?? '';

  const [step, setStep] = useState<'REQUEST' | 'RESET'>(tokenFromUrl ? 'RESET' : 'REQUEST');
  const [identifier, setIdentifier] = useState('');
  const [token, setToken] = useState(tokenFromUrl);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (tokenFromUrl) {
      setToken(tokenFromUrl);
      setStep('RESET');
    }
  }, [tokenFromUrl]);

  const handleRequestReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);

    if (!identifier.trim()) {
      setError('Enter your registered Super Admin email or phone number.');
      return;
    }

    setLoading(true);
    try {
      const res = await requestSuperAdminPasswordReset(identifier.trim());
      setNotice(res.message);
      setStep('RESET');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to request password reset.');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);

    if (token.trim().length < 20) {
      setError('Enter the complete one-time reset token.');
      return;
    }
    if (newPassword.length < 10) {
      setError('New password must be at least 10 characters with uppercase, lowercase, and digit.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Password confirmation does not match.');
      return;
    }

    setLoading(true);
    try {
      await resetSuperAdminPassword({ token: token.trim(), newPassword });
      router.replace('/super-admin/login?reset=success');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to reset Super Admin password.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 px-4 py-10 text-slate-100">
      <div className="mx-auto flex max-w-md flex-col gap-6 pt-6">
        <div className="flex items-center justify-between">
          <Link
            href="/super-admin/login"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-white"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to Admin Sign In
          </Link>
          <Badge className="border-orange-500/40 bg-orange-500/15 text-orange-300">
            Account Recovery
          </Badge>
        </div>

        <div className="text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary text-white shadow-lg shadow-orange-600/20">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <h1 className="mt-4 text-2xl font-bold tracking-tight text-white">
            Super Admin Password Reset
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            One-time cryptographic token recovery with full session revocation
          </p>
        </div>

        <Card className="border-slate-800 bg-slate-900 text-slate-100 shadow-2xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-white">
              <KeyRound className="h-4 w-4 text-primary" />
              {step === 'REQUEST' ? 'Request Recovery Token' : 'Set New Administrator Password'}
            </CardTitle>
            <CardDescription className="text-slate-400">
              {step === 'REQUEST'
                ? 'A one-time reset token is issued in server security logs / configured notification channel.'
                : 'Resetting revokes all active Super Admin sessions and clears login lockouts.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {notice && (
              <Alert
                className="border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                data-testid="reset-notice"
              >
                <AlertDescription>{notice}</AlertDescription>
              </Alert>
            )}
            {error && (
              <Alert variant="destructive" data-testid="reset-error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {step === 'REQUEST' ? (
              <form onSubmit={handleRequestReset} className="space-y-4" noValidate>
                <div className="space-y-1.5">
                  <Label htmlFor="reset-identifier" className="text-slate-200">
                    Registered Admin Email or Phone
                  </Label>
                  <Input
                    id="reset-identifier"
                    data-testid="reset-identifier-input"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    placeholder="Enter registered email or phone"
                    className="border-slate-700 bg-slate-950 text-white placeholder:text-slate-500"
                  />
                </div>
                <Button
                  type="submit"
                  data-testid="reset-request-submit"
                  disabled={loading}
                  className="w-full"
                >
                  {loading ? 'Issuing Reset Token...' : 'Request Password Reset'}
                </Button>
                <button
                  type="button"
                  onClick={() => setStep('RESET')}
                  className="w-full text-center text-xs text-slate-400 hover:text-slate-200"
                >
                  Already have a reset token? Enter it here
                </button>
              </form>
            ) : (
              <form onSubmit={handleConfirmReset} className="space-y-4" noValidate>
                <div className="space-y-1.5">
                  <Label htmlFor="reset-token" className="text-slate-200">
                    One-Time Reset Token
                  </Label>
                  <Input
                    id="reset-token"
                    data-testid="reset-token-input"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="Paste reset token"
                    className="border-slate-700 bg-slate-950 font-mono text-xs text-white placeholder:text-slate-500"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="reset-new-password" className="text-slate-200">
                    New Password (min 10 chars, upper/lower/digit)
                  </Label>
                  <Input
                    id="reset-new-password"
                    data-testid="reset-new-password-input"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Enter new strong password"
                    className="border-slate-700 bg-slate-950 text-white placeholder:text-slate-500"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="reset-confirm-password" className="text-slate-200">
                    Confirm New Password
                  </Label>
                  <Input
                    id="reset-confirm-password"
                    data-testid="reset-confirm-password-input"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter new strong password"
                    className="border-slate-700 bg-slate-950 text-white placeholder:text-slate-500"
                  />
                </div>
                <Button
                  type="submit"
                  data-testid="reset-confirm-submit"
                  disabled={loading}
                  className="w-full"
                >
                  <CheckCircle2 className="mr-1.5 h-4 w-4" />
                  {loading ? 'Updating Password...' : 'Reset Password & Sign In'}
                </Button>
                <button
                  type="button"
                  onClick={() => setStep('REQUEST')}
                  className="w-full text-center text-xs text-slate-400 hover:text-slate-200"
                >
                  Need a new token? Request again
                </button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default function SuperAdminResetPasswordPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-slate-950" />}>
      <ResetPasswordContent />
    </Suspense>
  );
}

