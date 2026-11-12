'use client';

import React, { Suspense, useState } from 'react';
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
import { acceptInvitationSchema } from '@autonex/validation';
import { ApiError, apiRequest, setStoredSession } from '@/lib/api-client';

interface AcceptInvitationResponse {
  accessToken: string;
  refreshToken: string;
  csrfToken?: string;
  user: {
    id: string;
    name: string;
    email?: string | null;
    phone: string;
    role: string;
    tenantId: string;
    outletId: string;
  };
}

function AcceptInviteForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialToken = searchParams.get('token') ?? '';

  const [token, setToken] = useState(initialToken);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFieldErrors({});

    const parsed = acceptInvitationSchema.safeParse({
      token: token.trim(),
      name: name.trim() || undefined,
      password: password || undefined,
      pin: pin.trim(),
    });

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
      const res = await apiRequest<AcceptInvitationResponse>('/auth/invitations/accept', {
        method: 'POST',
        auth: false,
        body: JSON.stringify(parsed.data),
      });

      setStoredSession({
        accessToken: res.accessToken,
        user: {
          ...res.user,
          tenantStatus: 'ACTIVE',
        },
      });
      router.push('/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to accept staff invitation');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="w-full max-w-md border-border shadow-sm">
      <CardHeader className="space-y-2 text-center">
        <div className="mx-auto flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground">
            A
          </div>
          <span className="text-lg font-bold tracking-tight">AutoNex Restaurant OS</span>
        </div>
        <div className="pt-1">
          <Badge variant="outline">Staff Onboarding</Badge>
        </div>
        <CardTitle className="text-2xl">Accept Staff Invitation</CardTitle>
        <CardDescription>
          Enter your one-time invite token and set a 4–6 digit terminal PIN to join your outlet team.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="invite-accept-token">Invitation Token</Label>
            <Input
              id="invite-accept-token"
              data-testid="invite-accept-token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste your 16+ char invitation token"
              className="font-mono text-xs"
            />
            {fieldErrors.token && (
              <p className="text-xs text-destructive">{fieldErrors.token}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="invite-accept-name">Display Name (optional)</Label>
            <Input
              id="invite-accept-name"
              data-testid="invite-accept-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Override invited display name if needed"
            />
            {fieldErrors.name && (
              <p className="text-xs text-destructive">{fieldErrors.name}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="invite-accept-password">Account Password (optional)</Label>
            <Input
              id="invite-accept-password"
              data-testid="invite-accept-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="8+ chars for email/phone login"
            />
            {fieldErrors.password && (
              <p className="text-xs text-destructive">{fieldErrors.password}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="invite-accept-pin">Staff Terminal PIN (4–6 digits)</Label>
            <Input
              id="invite-accept-pin"
              data-testid="invite-accept-pin"
              type="password"
              inputMode="numeric"
              maxLength={6}
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="e.g. 4321"
            />
            {fieldErrors.pin && (
              <p className="text-xs text-destructive">{fieldErrors.pin}</p>
            )}
          </div>

          <Button
            type="submit"
            data-testid="invite-accept-submit"
            className="w-full"
            disabled={loading}
          >
            {loading ? 'Activating Account...' : 'Accept Invitation & Sign In'}
          </Button>
        </form>

        <div className="border-t border-border pt-4 text-center text-sm text-muted-foreground">
          Already activated your account?{' '}
          <Link href="/login" className="font-semibold text-primary hover:underline">
            Sign in instead
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

export default function AcceptInvitePage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <Suspense
        fallback={
          <Card className="h-96 w-full max-w-md animate-pulse bg-secondary/40" />
        }
      >
        <AcceptInviteForm />
      </Suspense>
    </div>
  );
}

