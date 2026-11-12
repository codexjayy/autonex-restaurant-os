'use client';

import React, { FormEvent, useEffect, useState } from 'react';
import {
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
import {
  Search,
  Settings,
  ShieldCheck,
  UserCheck,
  UserPlus,
  UserX,
  Users,
} from 'lucide-react';
import type { AdminPlatformUserDto, PlatformSettingsDto } from '@/lib/api-client';

interface UsersAdminsPanelProps {
  users: AdminPlatformUserDto[];
  currentAdminId?: string;
  busyAction: boolean;
  onCreateSuperAdmin: (payload: {
    name: string;
    email: string;
    phone: string;
    password: string;
  }) => Promise<boolean>;
  onToggleUserActive: (userId: string, isActive: boolean) => Promise<void>;
}

export function UsersAdminsPanel({
  users,
  currentAdminId,
  busyAction,
  onCreateSuperAdmin,
  onToggleUserActive,
}: UsersAdminsPanelProps) {
  const [scope, setScope] = useState<'ALL' | 'SUPER_ADMINS' | 'TENANT_USERS'>('ALL');
  const [search, setSearch] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');

  const filtered = users.filter((u) => {
    if (scope === 'SUPER_ADMINS' && !u.isSuperAdmin) return false;
    if (scope === 'TENANT_USERS' && u.isSuperAdmin) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      u.name.toLowerCase().includes(q) ||
      (u.email ?? '').toLowerCase().includes(q) ||
      u.phone.toLowerCase().includes(q) ||
      u.memberships.some((m) => m.tenantName.toLowerCase().includes(q))
    );
  });

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await onCreateSuperAdmin({ name, email, phone, password });
    if (ok) {
      setName('');
      setEmail('');
      setPhone('');
      setPassword('');
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-3" data-testid="sa-users-panel">
      <div className="space-y-4 lg:col-span-2">
        <Card className="border-slate-200 bg-white">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Users className="h-4 w-4 text-primary" />
                  Platform Admins & Restaurant Users ({filtered.length})
                </CardTitle>
                <CardDescription>
                  Manage platform Super Admins and tenant owners/staff accounts.
                </CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={scope}
                  onChange={(e) =>
                    setScope(e.target.value as 'ALL' | 'SUPER_ADMINS' | 'TENANT_USERS')
                  }
                  className="h-9 w-40 text-xs"
                >
                  <option value="ALL">All Accounts</option>
                  <option value="SUPER_ADMINS">Super Admins Only</option>
                  <option value="TENANT_USERS">Restaurant Users</option>
                </Select>
                <div className="relative w-56">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search user or tenant..."
                    className="h-9 pl-8 text-xs"
                  />
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {filtered.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-500">
                No user accounts match the current filter.
              </p>
            ) : (
              <div className="space-y-2.5">
                {filtered.map((u) => {
                  const isSelf = currentAdminId === u.id;
                  return (
                    <div
                      key={u.id}
                      className="flex flex-col gap-3 rounded-lg border border-slate-200 p-3.5 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0 space-y-1 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-slate-900">{u.name}</span>
                          {u.isSuperAdmin && (
                            <Badge className="bg-slate-900 text-white">SUPER_ADMIN</Badge>
                          )}
                          <Badge variant={u.isActive ? 'success' : 'destructive'}>
                            {u.isActive ? 'Active' : 'Disabled'}
                          </Badge>
                          {isSelf && <Badge variant="outline">You</Badge>}
                        </div>
                        <p className="text-slate-600">
                          {u.email ?? 'No email'} • {u.phone}
                        </p>
                        {u.memberships.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 pt-0.5">
                            {u.memberships.map((m) => (
                              <Badge key={m.id} variant="outline" className="text-[11px]">
                                {m.tenantName} ({m.role})
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="shrink-0">
                        <Button
                          size="sm"
                          variant={u.isActive ? 'outline' : 'default'}
                          disabled={busyAction || isSelf}
                          onClick={() => void onToggleUserActive(u.id, !u.isActive)}
                        >
                          {u.isActive ? (
                            <>
                              <UserX className="mr-1.5 h-3.5 w-3.5 text-red-600" />
                              Deactivate
                            </>
                          ) : (
                            <>
                              <UserCheck className="mr-1.5 h-3.5 w-3.5" />
                              Activate
                            </>
                          )}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="h-fit border-slate-200 bg-white">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserPlus className="h-4 w-4 text-primary" />
            Add Platform Super Admin
          </CardTitle>
          <CardDescription>
            Creates a new platform administrator account hashed with Argon2id.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1">
              <Label>Full Name</Label>
              <Input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Platform Ops Admin"
              />
            </div>
            <div className="space-y-1">
              <Label>Admin Email</Label>
              <Input
                required
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="ops@autonex.in"
              />
            </div>
            <div className="space-y-1">
              <Label>Phone Number</Label>
              <Input
                required
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+919800000001"
              />
            </div>
            <div className="space-y-1">
              <Label>Strong Password (min 10 chars)</Label>
              <Input
                required
                type="password"
                minLength={10}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Upper, lower & number"
              />
            </div>
            <Button type="submit" disabled={busyAction} className="w-full">
              <ShieldCheck className="mr-1.5 h-4 w-4" />
              Create Super Admin
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

interface PlatformSettingsPanelProps {
  settings: PlatformSettingsDto | null;
  busyAction: boolean;
  onSaveSettings: (payload: Partial<PlatformSettingsDto>) => Promise<void>;
}

export function PlatformSettingsPanel({
  settings,
  busyAction,
  onSaveSettings,
}: PlatformSettingsPanelProps) {
  const [platformName, setPlatformName] = useState('AutoNex Restaurant OS');
  const [supportEmail, setSupportEmail] = useState('support@autonex.in');
  const [supportPhone, setSupportPhone] = useState('+919999999999');
  const [defaultTrialDays, setDefaultTrialDays] = useState('14');
  const [defaultGraceDays, setDefaultGraceDays] = useState('3');
  const [saasGstRateBps, setSaasGstRateBps] = useState('1800');
  const [autoApproveRegistrations, setAutoApproveRegistrations] = useState(false);
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [maintenanceMessage, setMaintenanceMessage] = useState('');

  useEffect(() => {
    if (!settings) return;
    setPlatformName(settings.platformName);
    setSupportEmail(settings.supportEmail);
    setSupportPhone(settings.supportPhone);
    setDefaultTrialDays(String(settings.defaultTrialDays));
    setDefaultGraceDays(String(settings.defaultGraceDays));
    setSaasGstRateBps(String(settings.saasGstRateBps));
    setAutoApproveRegistrations(settings.autoApproveRegistrations);
    setMaintenanceMode(settings.maintenanceMode);
    setMaintenanceMessage(settings.maintenanceMessage ?? '');
  }, [settings]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await onSaveSettings({
      platformName: platformName.trim(),
      supportEmail: supportEmail.trim(),
      supportPhone: supportPhone.trim(),
      defaultTrialDays: Number.parseInt(defaultTrialDays, 10) || 14,
      defaultGraceDays: Number.parseInt(defaultGraceDays, 10) || 3,
      saasGstRateBps: Number.parseInt(saasGstRateBps, 10) || 1800,
      autoApproveRegistrations,
      maintenanceMode,
      maintenanceMessage: maintenanceMessage.trim(),
    });
  };

  return (
    <Card className="border-slate-200 bg-white" data-testid="sa-platform-settings-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Settings className="h-4 w-4 text-primary" />
          Platform Settings & Governance Defaults
        </CardTitle>
        <CardDescription>
          Persisted directly to PostgreSQL (`platform_settings`). Changes are audit logged.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label>Platform Display Name</Label>
            <Input
              required
              value={platformName}
              onChange={(e) => setPlatformName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Support Contact Email</Label>
            <Input
              required
              type="email"
              value={supportEmail}
              onChange={(e) => setSupportEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Support Phone</Label>
            <Input
              required
              value={supportPhone}
              onChange={(e) => setSupportPhone(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Default Trial Days</Label>
            <Input
              required
              type="number"
              min={1}
              max={90}
              value={defaultTrialDays}
              onChange={(e) => setDefaultTrialDays(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Default Grace Days</Label>
            <Input
              required
              type="number"
              min={0}
              max={30}
              value={defaultGraceDays}
              onChange={(e) => setDefaultGraceDays(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>SaaS GST Rate (bps, e.g. 1800 = 18%)</Label>
            <Input
              required
              type="number"
              min={0}
              max={2800}
              value={saasGstRateBps}
              onChange={(e) => setSaasGstRateBps(e.target.value)}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-slate-200 p-3 sm:col-span-2 lg:col-span-3">
            <div>
              <p className="text-sm font-semibold text-slate-800">
                Require Manual Super Admin Verification (Recommended)
              </p>
              <p className="text-xs text-slate-500">
                When Auto-Approve is OFF, every restaurant starts in PENDING_APPROVAL until
                reviewed here.
              </p>
            </div>
            <label className="flex items-center gap-2 text-xs font-medium">
              <input
                type="checkbox"
                checked={autoApproveRegistrations}
                onChange={(e) => setAutoApproveRegistrations(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              Auto-Approve New Signups
            </label>
          </div>

          <div className="space-y-2 rounded-lg border border-slate-200 p-3 sm:col-span-2 lg:col-span-3">
            <label className="flex items-center gap-2 text-xs font-semibold text-slate-800">
              <input
                type="checkbox"
                checked={maintenanceMode}
                onChange={(e) => setMaintenanceMode(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              Enable Scheduled Maintenance Banner
            </label>
            <Input
              value={maintenanceMessage}
              onChange={(e) => setMaintenanceMessage(e.target.value)}
              placeholder="Optional maintenance notice message..."
            />
          </div>

          <div className="flex items-center justify-between sm:col-span-2 lg:col-span-3">
            <span className="text-xs text-slate-500">
              Last updated:{' '}
              {settings?.updatedAt
                ? new Date(settings.updatedAt).toLocaleString('en-IN')
                : 'Default baseline'}
            </span>
            <Button type="submit" data-testid="save-platform-settings-btn" disabled={busyAction}>
              Save Platform Settings
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

