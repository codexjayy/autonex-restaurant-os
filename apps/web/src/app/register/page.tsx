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
import { registerRestaurantSchema } from '@autonex/validation';
import { ApiError, apiRequest, setStoredSession } from '@/lib/api-client';

interface RegisterResponse {
  accessToken: string;
  tenant: {
    id: string;
    name: string;
    slug: string;
    status: string;
  };
  outlet: {
    id: string;
    name: string;
    timezone: string;
  };
  user: {
    id: string;
    name: string;
    email: string | null;
    phone: string;
    role: string;
  };
}

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    restaurantName: '',
    outletName: 'Main Branch',
    ownerName: '',
    email: '',
    phone: '',
    password: '',
    pin: '',
    address: '',
    timezone: 'Asia/Kolkata',
    gstin: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const updateField = (key: keyof typeof form, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFieldErrors({});

    const parsed = registerRestaurantSchema.safeParse({
      restaurantName: form.restaurantName,
      outletName: form.outletName,
      ownerName: form.ownerName,
      email: form.email,
      phone: form.phone,
      password: form.password,
      pin: form.pin,
      address: form.address.trim() || undefined,
      timezone: form.timezone.trim() || 'Asia/Kolkata',
      gstin: form.gstin.trim() || undefined,
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
      const res = await apiRequest<RegisterResponse>('/auth/register', {
        method: 'POST',
        auth: false,
        body: JSON.stringify(parsed.data),
      });

      setStoredSession({
        accessToken: res.accessToken,
        user: {
          id: res.user.id,
          name: res.user.name,
          email: res.user.email,
          phone: res.user.phone,
          role: res.user.role,
          tenantId: res.tenant.id,
          outletId: res.outlet.id,
          tenantStatus: res.tenant.status,
        },
      });
      router.push('/dashboard');
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error && err.message
            ? err.message
            : 'Registration failed',
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto max-w-xl space-y-5">
        <div className="text-center">
          <Badge variant="default">15-Minute Restaurant Setup</Badge>
          <h1 className="mt-3 text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            Register your restaurant on AutoNex
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Create your tenant workspace, flagship outlet, and owner account in one step.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Restaurant & Owner Details</CardTitle>
            <CardDescription>
              All fields are validated before provisioning your isolated restaurant workspace.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            {error && (
              <Alert variant="destructive" data-testid="register-error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="restaurantName">Restaurant Name</Label>
                  <Input
                    id="restaurantName"
                    data-testid="reg-restaurant-name"
                    value={form.restaurantName}
                    onChange={(e) => updateField('restaurantName', e.target.value)}
                    placeholder="Gujarat Spice Kitchen"
                  />
                  {fieldErrors.restaurantName && (
                    <p className="text-xs text-destructive">{fieldErrors.restaurantName}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="outletName">Primary Outlet Name</Label>
                  <Input
                    id="outletName"
                    data-testid="reg-outlet-name"
                    value={form.outletName}
                    onChange={(e) => updateField('outletName', e.target.value)}
                    placeholder="CG Road Branch"
                  />
                  {fieldErrors.outletName && (
                    <p className="text-xs text-destructive">{fieldErrors.outletName}</p>
                  )}
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ownerName">Owner Full Name</Label>
                  <Input
                    id="ownerName"
                    data-testid="reg-owner-name"
                    value={form.ownerName}
                    onChange={(e) => updateField('ownerName', e.target.value)}
                    placeholder="Rohan Patel"
                  />
                  {fieldErrors.ownerName && (
                    <p className="text-xs text-destructive">{fieldErrors.ownerName}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="phone">Phone Number</Label>
                  <Input
                    id="phone"
                    data-testid="reg-phone"
                    value={form.phone}
                    onChange={(e) => updateField('phone', e.target.value)}
                    placeholder="+919825012345"
                  />
                  {fieldErrors.phone && (
                    <p className="text-xs text-destructive">{fieldErrors.phone}</p>
                  )}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="email">Owner Email</Label>
                <Input
                  id="email"
                  data-testid="reg-email"
                  type="email"
                  value={form.email}
                  onChange={(e) => updateField('email', e.target.value)}
                  placeholder="rohan@gujaratspice.in"
                />
                {fieldErrors.email && (
                  <p className="text-xs text-destructive">{fieldErrors.email}</p>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="password">Password (min 8 chars)</Label>
                  <Input
                    id="password"
                    data-testid="reg-password"
                    type="password"
                    value={form.password}
                    onChange={(e) => updateField('password', e.target.value)}
                    placeholder="Create strong password"
                  />
                  {fieldErrors.password && (
                    <p className="text-xs text-destructive">{fieldErrors.password}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="pin">Staff Counter PIN (4–6 digits)</Label>
                  <Input
                    id="pin"
                    data-testid="reg-pin"
                    type="password"
                    inputMode="numeric"
                    value={form.pin}
                    onChange={(e) => updateField('pin', e.target.value)}
                    placeholder="1234"
                  />
                  {fieldErrors.pin && <p className="text-xs text-destructive">{fieldErrors.pin}</p>}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="address">Outlet Address (optional)</Label>
                <Input
                  id="address"
                  data-testid="reg-address"
                  value={form.address}
                  onChange={(e) => updateField('address', e.target.value)}
                  placeholder="Shop 4, Navrangpura, Ahmedabad"
                />
                {fieldErrors.address && (
                  <p className="text-xs text-destructive">{fieldErrors.address}</p>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="timezone">Timezone</Label>
                  <Input
                    id="timezone"
                    value={form.timezone}
                    onChange={(e) => updateField('timezone', e.target.value)}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="gstin">GSTIN (optional)</Label>
                  <Input
                    id="gstin"
                    value={form.gstin}
                    onChange={(e) => updateField('gstin', e.target.value)}
                    placeholder="24ABCDE1234F1Z5"
                  />
                </div>
              </div>

              <Button
                type="submit"
                data-testid="reg-submit"
                disabled={loading}
                className="w-full"
              >
                {loading ? 'Provisioning Workspace...' : 'Create Restaurant Account'}
              </Button>
            </form>

            <p className="pt-2 text-center text-xs text-muted-foreground">
              Already registered?{' '}
              <Link href="/login" className="font-semibold text-primary hover:underline">
                Sign in here
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
