'use client';

import React, { useCallback, useEffect, useState } from 'react';
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
  Select,
} from '@autonex/ui';
import { DashboardShell } from '@/components/dashboard-shell';
import {
  ApiError,
  AuthSessionRecordDto,
  getCurrentTenant,
  getUsersMe,
  listAuthSessions,
  listOutlets,
  OutletRecordDto,
  revokeAuthSession,
  subscribeWorkspaceSync,
  updateCurrentTenant,
  updateOutlet,
  updateUsersMe,
} from '@/lib/api-client';

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [userName, setUserName] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [userPhone, setUserPhone] = useState('');
  const [userRole, setUserRole] = useState('');

  const [tenantName, setTenantName] = useState('');
  const [currency, setCurrency] = useState('INR');
  const [locale, setLocale] = useState('en-IN');
  const [defaultTimezone, setDefaultTimezone] = useState('Asia/Kolkata');

  const [activeOutlet, setActiveOutlet] = useState<OutletRecordDto | null>(null);
  const [outletName, setOutletName] = useState('');
  const [outletAddress, setOutletAddress] = useState('');
  const [gstin, setGstin] = useState('');
  const [gstRateBps, setGstRateBps] = useState('500');
  const [taxMode, setTaxMode] = useState<'EXCLUSIVE' | 'INCLUSIVE' | 'NONE'>('EXCLUSIVE');
  const [kdsLanguage, setKdsLanguage] = useState<'en' | 'gu' | 'hi'>('en');
  const [receiptFooter, setReceiptFooter] = useState('');

  const [sessions, setSessions] = useState<AuthSessionRecordDto[]>([]);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingTenant, setSavingTenant] = useState(false);
  const [savingOutlet, setSavingOutlet] = useState(false);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [me, tenant, outlets, authSessions] = await Promise.all([
        getUsersMe(),
        getCurrentTenant(),
        listOutlets(),
        listAuthSessions(),
      ]);

      setUserName(me.name);
      setUserEmail(me.email ?? '');
      setUserPhone(me.phone);
      setUserRole(me.role ?? '');

      setTenantName(tenant.name);
      setCurrency(tenant.settings?.currency ?? 'INR');
      setLocale(tenant.settings?.locale ?? 'en-IN');
      setDefaultTimezone(tenant.settings?.defaultTimezone ?? 'Asia/Kolkata');
      setSessions(authSessions);

      const currentOutlet = outlets.find((o) => o.id === me.outletId) ?? outlets[0] ?? null;
      setActiveOutlet(currentOutlet);
      if (currentOutlet) {
        setOutletName(currentOutlet.name);
        setOutletAddress(currentOutlet.address ?? '');
        setGstin(currentOutlet.gstin ?? '');
        setGstRateBps(String(currentOutlet.gstRateBps ?? 500));
        setTaxMode(currentOutlet.taxMode);
        setKdsLanguage(
          (currentOutlet.settings?.kdsLanguage as 'en' | 'gu' | 'hi' | undefined) ?? 'en',
        );
        setReceiptFooter(currentOutlet.settings?.receiptFooter ?? '');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
    return subscribeWorkspaceSync(() => {
      void loadSettings();
    });
  }, [loadSettings]);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (userName.trim().length < 2) {
      setError('Display name must be at least 2 characters');
      return;
    }
    setSavingProfile(true);
    try {
      await updateUsersMe({
        name: userName.trim(),
        email: userEmail.trim() || undefined,
      });
      setSuccess('Your profile has been updated.');
      await loadSettings();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update profile');
    } finally {
      setSavingProfile(false);
    }
  };

  const handleSaveTenant = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSavingTenant(true);
    try {
      await updateCurrentTenant({
        name: tenantName,
        currency,
        locale,
        defaultTimezone,
      });
      setSuccess('Restaurant settings saved.');
      await loadSettings();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save restaurant settings');
    } finally {
      setSavingTenant(false);
    }
  };

  const handleSaveOutlet = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeOutlet) return;
    setError(null);
    setSuccess(null);
    setSavingOutlet(true);
    try {
      await updateOutlet(activeOutlet.id, {
        name: outletName,
        address: outletAddress.trim() || undefined,
        gstin: gstin.trim() || undefined,
        gstRateBps: Number(gstRateBps) || 0,
        taxMode,
        kdsLanguage,
        receiptFooter: receiptFooter.trim() || undefined,
      });
      setSuccess(`Updated settings for outlet "${outletName}".`);
      await loadSettings();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update outlet settings');
    } finally {
      setSavingOutlet(false);
    }
  };

  const handleRevokeSession = async (sessionId: string) => {
    setError(null);
    setSuccess(null);
    try {
      await revokeAuthSession(sessionId);
      setSuccess('Session revoked.');
      await loadSettings();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to revoke session');
    }
  };

  return (
    <DashboardShell
      title="Settings"
      subtitle="Configure restaurant defaults, GST & KDS language per outlet, and active login sessions."
      onOutletChanged={() => void loadSettings()}
    >
      <div className="space-y-6">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {success && (
          <Alert variant="success" data-testid="settings-success">
            <AlertDescription>{success}</AlertDescription>
          </Alert>
        )}

        {loading ? (
          <Card className="h-48 animate-pulse bg-secondary/40" />
        ) : (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <CardTitle>My Profile</CardTitle>
                    <CardDescription>
                      Update your personal account display name and email used across AutoNex outlets.
                    </CardDescription>
                  </div>
                  {userRole && <Badge variant="outline">{userRole}</Badge>}
                </div>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleSaveProfile} className="grid gap-4 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="profile-name">Full Name</Label>
                    <Input
                      id="profile-name"
                      data-testid="settings-profile-name"
                      value={userName}
                      onChange={(e) => setUserName(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="profile-email">Email Address</Label>
                    <Input
                      id="profile-email"
                      data-testid="settings-profile-email"
                      type="email"
                      value={userEmail}
                      onChange={(e) => setUserEmail(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="profile-phone">Phone (verified)</Label>
                    <Input id="profile-phone" value={userPhone} disabled />
                  </div>
                  <div className="sm:col-span-3">
                    <Button
                      type="submit"
                      data-testid="save-profile-settings"
                      disabled={savingProfile}
                    >
                      {savingProfile ? 'Saving Profile...' : 'Save Profile'}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>

            <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Restaurant Tenant Defaults</CardTitle>
                <CardDescription>
                  Organization-wide defaults applied across all outlets.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleSaveTenant} className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="tenant-name">Restaurant Brand Name</Label>
                    <Input
                      id="tenant-name"
                      data-testid="settings-tenant-name"
                      value={tenantName}
                      onChange={(e) => setTenantName(e.target.value)}
                    />
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="tenant-currency">Currency</Label>
                      <Input
                        id="tenant-currency"
                        value={currency}
                        onChange={(e) => setCurrency(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="tenant-locale">Default Locale</Label>
                      <Select
                        id="tenant-locale"
                        value={locale}
                        onChange={(e) => setLocale(e.target.value)}
                      >
                        <option value="en-IN">English (India)</option>
                        <option value="gu-IN">Gujarati (ગુજરાતી)</option>
                        <option value="hi-IN">Hindi (हिन्दी)</option>
                      </Select>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="tenant-tz">Default Timezone</Label>
                    <Input
                      id="tenant-tz"
                      value={defaultTimezone}
                      onChange={(e) => setDefaultTimezone(e.target.value)}
                    />
                  </div>

                  <Button
                    type="submit"
                    data-testid="save-tenant-settings"
                    disabled={savingTenant}
                  >
                    {savingTenant ? 'Saving...' : 'Save Restaurant Settings'}
                  </Button>
                </form>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Active Outlet Configuration</CardTitle>
                <CardDescription>
                  {activeOutlet
                    ? `Editing settings for ${activeOutlet.name}`
                    : 'No active outlet selected'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleSaveOutlet} className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="edit-outlet-name">Outlet Name</Label>
                    <Input
                      id="edit-outlet-name"
                      value={outletName}
                      onChange={(e) => setOutletName(e.target.value)}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="edit-outlet-address">Address</Label>
                    <Input
                      id="edit-outlet-address"
                      value={outletAddress}
                      onChange={(e) => setOutletAddress(e.target.value)}
                    />
                  </div>

                  <div className="grid gap-4 sm:grid-cols-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="edit-outlet-gstin">GSTIN</Label>
                      <Input
                        id="edit-outlet-gstin"
                        value={gstin}
                        onChange={(e) => setGstin(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="edit-outlet-gst">GST (bps)</Label>
                      <Input
                        id="edit-outlet-gst"
                        type="number"
                        value={gstRateBps}
                        onChange={(e) => setGstRateBps(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="edit-outlet-tax">Tax Mode</Label>
                      <Select
                        id="edit-outlet-tax"
                        value={taxMode}
                        onChange={(e) =>
                          setTaxMode(e.target.value as 'EXCLUSIVE' | 'INCLUSIVE' | 'NONE')
                        }
                      >
                        <option value="EXCLUSIVE">Exclusive</option>
                        <option value="INCLUSIVE">Inclusive</option>
                        <option value="NONE">No Tax</option>
                      </Select>
                    </div>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="edit-outlet-kds">KDS Screen Language</Label>
                      <Select
                        id="edit-outlet-kds"
                        value={kdsLanguage}
                        onChange={(e) => setKdsLanguage(e.target.value as 'en' | 'gu' | 'hi')}
                      >
                        <option value="en">English</option>
                        <option value="gu">ગુજરાતી (Gujarati)</option>
                        <option value="hi">हिन्दी (Hindi)</option>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="edit-outlet-footer">Receipt Footer</Label>
                      <Input
                        id="edit-outlet-footer"
                        value={receiptFooter}
                        onChange={(e) => setReceiptFooter(e.target.value)}
                        placeholder="Thank you for dining with us!"
                      />
                    </div>
                  </div>

                  <Button
                    type="submit"
                    data-testid="save-outlet-settings"
                    disabled={savingOutlet || !activeOutlet}
                  >
                    {savingOutlet ? 'Saving...' : 'Save Outlet Settings'}
                  </Button>
                </form>
              </CardContent>
            </Card>
            </div>
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Active & Recent Auth Sessions</CardTitle>
            <CardDescription>
              Refresh-token families backed by PostgreSQL sessions. Revoke any suspicious device.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {sessions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tracked sessions recorded yet.</p>
            ) : (
              sessions.map((s) => (
                <div
                  key={s.id}
                  className="flex flex-col justify-between gap-2 rounded-xl border border-border p-3 text-sm sm:flex-row sm:items-center"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">
                        {s.ipAddress ?? 'Unknown IP'}
                      </span>
                      <Badge variant={s.isActive ? 'success' : 'secondary'}>
                        {s.isActive ? 'ACTIVE' : 'REVOKED'}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {s.userAgent ?? 'Browser / API client'} • Started{' '}
                      {new Date(s.createdAt).toLocaleString()}
                    </p>
                  </div>
                  {s.isActive && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void handleRevokeSession(s.id)}
                    >
                      Revoke Session
                    </Button>
                  )}
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardShell>
  );
}

