'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
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
import { createInvitationSchema, PHONE_REGEX, PIN_REGEX } from '@autonex/validation';
import { Check, Copy, KeyRound, Shield, UserPlus } from 'lucide-react';
import { DashboardShell } from '@/components/dashboard-shell';
import {
  ApiError,
  apiRequest,
  createInvitation,
  InvitationRecordDto,
  listInvitations,
  listRoles,
  revokeInvitation,
  RoleMatrixDto,
} from '@/lib/api-client';

interface StaffRowDto {
  membershipId: string;
  userId: string;
  name: string;
  phone: string;
  email: string | null;
  role: string;
  isActive: boolean;
}

export default function TeamPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [staff, setStaff] = useState<StaffRowDto[]>([]);
  const [invitations, setInvitations] = useState<InvitationRecordDto[]>([]);
  const [roles, setRoles] = useState<RoleMatrixDto[]>([]);

  const [invName, setInvName] = useState('');
  const [invPhone, setInvPhone] = useState('');
  const [invEmail, setInvEmail] = useState('');
  const [invRole, setInvRole] = useState('WAITER');
  const [lastToken, setLastToken] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [submittingInvite, setSubmittingInvite] = useState(false);

  const [directName, setDirectName] = useState('');
  const [directPhone, setDirectPhone] = useState('');
  const [directRole, setDirectRole] = useState('WAITER');
  const [directPin, setDirectPin] = useState('');
  const [submittingDirect, setSubmittingDirect] = useState(false);

  const loadTeam = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [staffData, inviteData, rolesData] = await Promise.all([
        apiRequest<StaffRowDto[]>('/auth/staff'),
        listInvitations(),
        listRoles(),
      ]);
      setStaff(staffData);
      setInvitations(inviteData);
      setRoles(rolesData);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load team workspace');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTeam();
  }, [loadTeam]);

  const handleSendInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setLastToken(null);

    const parsed = createInvitationSchema.safeParse({
      name: invName,
      phone: invPhone,
      email: invEmail.trim() || undefined,
      role: invRole,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid invitation inputs');
      return;
    }

    setSubmittingInvite(true);
    setCopiedLink(false);
    try {
      const created = await createInvitation(parsed.data);
      setInvName('');
      setInvPhone('');
      setInvEmail('');
      setLastToken(created.inviteToken);
      setSuccess(`Created staff invitation for ${created.invitation.name}.`);
      await loadTeam();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create invitation');
    } finally {
      setSubmittingInvite(false);
    }
  };

  const handleCopyInviteLink = async () => {
    if (!lastToken) return;
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const link = `${origin}/invite?token=${encodeURIComponent(lastToken)}`;
    try {
      await navigator.clipboard?.writeText(link);
      setCopiedLink(true);
      setSuccess('Invitation link copied to clipboard.');
    } catch {
      setSuccess(`Share invitation link: ${link}`);
    }
  };

  const handleCreateDirectStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const trimmedName = directName.trim();
    const trimmedPhone = directPhone.trim();
    const trimmedPin = directPin.trim();
    if (trimmedName.length < 2) {
      setError('Staff name must be at least 2 characters');
      return;
    }
    if (!PHONE_REGEX.test(trimmedPhone)) {
      setError('Enter a valid 10-15 digit phone number (e.g. +919825011122)');
      return;
    }
    if (!PIN_REGEX.test(trimmedPin)) {
      setError('Terminal PIN must be 4 to 6 digits');
      return;
    }

    setSubmittingDirect(true);
    try {
      await apiRequest('/auth/staff', {
        method: 'POST',
        body: JSON.stringify({
          name: trimmedName,
          phone: trimmedPhone,
          role: directRole,
          pin: trimmedPin,
        }),
      });
      setDirectName('');
      setDirectPhone('');
      setDirectPin('');
      setSuccess(`Added staff member ${trimmedName} with terminal PIN access.`);
      await loadTeam();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add staff member');
    } finally {
      setSubmittingDirect(false);
    }
  };

  const handleToggleStaff = async (member: StaffRowDto) => {
    setError(null);
    setSuccess(null);
    try {
      await apiRequest(`/auth/staff/${member.membershipId}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !member.isActive }),
      });
      setSuccess(`Updated access for ${member.name}.`);
      await loadTeam();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to update staff status');
    }
  };

  const handleRevokeInvite = async (id: string) => {
    setError(null);
    setSuccess(null);
    try {
      await revokeInvitation(id);
      setSuccess('Invitation revoked.');
      await loadTeam();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to revoke invitation');
    }
  };

  return (
    <DashboardShell
      title="Team, Invitations & Roles"
      subtitle="Invite outlet staff with role-scoped RBAC permissions and manage active floor/kitchen access."
      onOutletChanged={() => void loadTeam()}
    >
      <div className="space-y-6">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {success && (
          <Alert variant="success">
            <AlertDescription>{success}</AlertDescription>
          </Alert>
        )}
        {lastToken && (
          <Alert variant="warning">
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
              <div>
                One-time Invitation Token:{' '}
                <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">
                  {lastToken}
                </code>{' '}
                •{' '}
                <Link
                  href={`/invite?token=${encodeURIComponent(lastToken)}`}
                  data-testid="invite-share-link"
                  className="font-semibold underline"
                >
                  Open /invite?token=...
                </Link>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid="copy-invite-link"
                onClick={() => void handleCopyInviteLink()}
              >
                {copiedLink ? (
                  <>
                    <Check className="mr-1.5 h-3.5 w-3.5" />
                    Copied Link
                  </>
                ) : (
                  <>
                    <Copy className="mr-1.5 h-3.5 w-3.5" />
                    Copy Invite Link
                  </>
                )}
              </Button>
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-1">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <UserPlus className="h-4 w-4 text-primary" />
                  Invite Staff Member
                </CardTitle>
                <CardDescription>
                  Generates a cryptographically random 7-day invitation token scoped to your active outlet.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleSendInvite} className="space-y-3.5">
                  <div className="space-y-1.5">
                    <Label htmlFor="invite-name">Full Name</Label>
                    <Input
                      id="invite-name"
                      data-testid="invite-name"
                      value={invName}
                      onChange={(e) => setInvName(e.target.value)}
                      placeholder="Karan Joshi"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="invite-phone">Phone Number</Label>
                    <Input
                      id="invite-phone"
                      data-testid="invite-phone"
                      value={invPhone}
                      onChange={(e) => setInvPhone(e.target.value)}
                      placeholder="+919825011122"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="invite-email">Email (optional)</Label>
                    <Input
                      id="invite-email"
                      type="email"
                      value={invEmail}
                      onChange={(e) => setInvEmail(e.target.value)}
                      placeholder="karan@restaurant.in"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="invite-role">Role</Label>
                    <Select
                      id="invite-role"
                      data-testid="invite-role"
                      value={invRole}
                      onChange={(e) => setInvRole(e.target.value)}
                    >
                      <option value="MANAGER">Outlet Manager</option>
                      <option value="CASHIER">Counter Cashier</option>
                      <option value="WAITER">Waiter / Captain</option>
                      <option value="KITCHEN">Kitchen Staff</option>
                    </Select>
                  </div>
                  <Button
                    type="submit"
                    data-testid="invite-submit"
                    disabled={submittingInvite}
                    className="w-full"
                  >
                    {submittingInvite ? 'Sending Invite...' : 'Send Staff Invitation'}
                  </Button>
                </form>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <KeyRound className="h-4 w-4 text-primary" />
                  Direct Add Staff (Counter PIN)
                </CardTitle>
                <CardDescription>
                  Create an active outlet staff account immediately with a terminal login PIN.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleCreateDirectStaff} className="space-y-3.5">
                  <div className="space-y-1.5">
                    <Label htmlFor="direct-staff-name">Full Name</Label>
                    <Input
                      id="direct-staff-name"
                      data-testid="direct-staff-name"
                      value={directName}
                      onChange={(e) => setDirectName(e.target.value)}
                      placeholder="Meera Desai"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="direct-staff-phone">Phone Number</Label>
                    <Input
                      id="direct-staff-phone"
                      data-testid="direct-staff-phone"
                      value={directPhone}
                      onChange={(e) => setDirectPhone(e.target.value)}
                      placeholder="+919825044556"
                    />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="direct-staff-role">Role</Label>
                      <Select
                        id="direct-staff-role"
                        data-testid="direct-staff-role"
                        value={directRole}
                        onChange={(e) => setDirectRole(e.target.value)}
                      >
                        <option value="MANAGER">Outlet Manager</option>
                        <option value="CASHIER">Counter Cashier</option>
                        <option value="WAITER">Waiter / Captain</option>
                        <option value="KITCHEN">Kitchen Staff</option>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="direct-staff-pin">Terminal PIN</Label>
                      <Input
                        id="direct-staff-pin"
                        data-testid="direct-staff-pin"
                        type="password"
                        inputMode="numeric"
                        maxLength={6}
                        value={directPin}
                        onChange={(e) => setDirectPin(e.target.value)}
                        placeholder="4321"
                      />
                    </div>
                  </div>
                  <Button
                    type="submit"
                    data-testid="direct-staff-submit"
                    variant="secondary"
                    disabled={submittingDirect}
                    className="w-full"
                  >
                    {submittingDirect ? 'Adding Staff...' : 'Add Staff Directly'}
                  </Button>
                </form>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6 lg:col-span-2">
            <Card>
              <CardHeader>
                <CardTitle>Active Outlet Staff ({staff.length})</CardTitle>
                <CardDescription>Team members assigned to your selected outlet.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2.5">
                {loading ? (
                  <div className="h-24 animate-pulse rounded-lg bg-secondary/40" />
                ) : staff.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No staff members found yet.</p>
                ) : (
                  staff.map((m) => (
                    <div
                      key={m.membershipId}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3 text-sm"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-foreground">{m.name}</span>
                          <Badge variant="outline">{m.role}</Badge>
                          <Badge variant={m.isActive ? 'success' : 'secondary'}>
                            {m.isActive ? 'ACTIVE' : 'DISABLED'}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {m.phone} {m.email ? `• ${m.email}` : ''}
                        </p>
                      </div>
                      {m.role !== 'OWNER' && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void handleToggleStaff(m)}
                        >
                          {m.isActive ? 'Disable' : 'Reactivate'}
                        </Button>
                      )}
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Pending & Recent Invitations</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2.5">
                {invitations.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No invitations sent for this outlet yet.
                  </p>
                ) : (
                  invitations.map((inv) => (
                    <div
                      key={inv.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3 text-sm"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-foreground">{inv.name}</span>
                          <Badge variant="outline">{inv.role}</Badge>
                          <Badge
                            variant={
                              inv.status === 'ACCEPTED'
                                ? 'success'
                                : inv.status === 'PENDING'
                                  ? 'warning'
                                  : 'secondary'
                            }
                          >
                            {inv.status}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {inv.phone} • Expires {new Date(inv.expiresAt).toLocaleDateString()}
                        </p>
                      </div>
                      {inv.status === 'PENDING' && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void handleRevokeInvite(inv.id)}
                        >
                          Revoke
                        </Button>
                      )}
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-primary" />
              Role-Based Access Control (RBAC) Matrix
            </CardTitle>
            <CardDescription>
              System roles enforced by NestJS PermissionsGuard and backed by PostgreSQL roles & permissions.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {roles.map((r) => (
              <div key={r.code} className="rounded-xl border border-border p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-foreground">{r.name}</span>
                  <Badge variant="outline">{r.code}</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{r.description}</p>
                <div className="mt-3 flex flex-wrap gap-1">
                  {r.permissions.map((perm) => (
                    <span
                      key={perm}
                      className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground"
                    >
                      {perm}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </DashboardShell>
  );
}

