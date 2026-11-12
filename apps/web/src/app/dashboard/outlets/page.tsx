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
import { createOutletSchema } from '@autonex/validation';
import { MapPin, Phone, Plus, Trash2 } from 'lucide-react';
import { DashboardShell } from '@/components/dashboard-shell';
import {
  ApiError,
  createOutlet,
  listOutlets,
  OutletRecordDto,
  softDeleteOutlet,
  subscribeWorkspaceSync,
  switchOutlet,
  updateOutlet,
} from '@/lib/api-client';

export default function OutletsPage() {
  const [outlets, setOutlets] = useState<OutletRecordDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [address, setAddress] = useState('');
  const [timezone, setTimezone] = useState('Asia/Kolkata');
  const [kdsLanguage, setKdsLanguage] = useState<'en' | 'gu' | 'hi'>('en');
  const [submitting, setSubmitting] = useState(false);

  const loadOutlets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listOutlets();
      setOutlets(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to fetch outlets');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOutlets();
    return subscribeWorkspaceSync(() => {
      void loadOutlets();
    });
  }, [loadOutlets]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const parsed = createOutletSchema.safeParse({
      name,
      contactPhone,
      address: address.trim() || undefined,
      timezone: timezone.trim() || 'Asia/Kolkata',
      kdsLanguage,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid outlet form data');
      return;
    }

    setSubmitting(true);
    try {
      const created = await createOutlet(parsed.data);
      setName('');
      setContactPhone('');
      setAddress('');
      setSuccess(`Created outlet "${created.name}".`);
      await loadOutlets();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create outlet');
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleActive = async (outlet: OutletRecordDto) => {
    setError(null);
    setSuccess(null);
    try {
      await updateOutlet(outlet.id, { isActive: !outlet.isActive });
      setSuccess(`Updated status for "${outlet.name}".`);
      await loadOutlets();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update outlet');
    }
  };

  const handleDelete = async (outlet: OutletRecordDto) => {
    setError(null);
    setSuccess(null);
    try {
      await softDeleteOutlet(outlet.id);
      setSuccess(`Archived outlet "${outlet.name}".`);
      await loadOutlets();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to archive outlet');
    }
  };

  const handleSwitch = async (outletId: string, outletName: string) => {
    setError(null);
    try {
      await switchOutlet(outletId);
      setSuccess(`Active outlet switched to "${outletName}".`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to switch outlet');
    }
  };

  return (
    <DashboardShell
      title="Outlets Management"
      subtitle="Create restaurant branches, switch active outlet scope, and manage outlet availability."
      onOutletChanged={() => void loadOutlets()}
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

        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Plus className="h-4 w-4 text-primary" />
                Add New Outlet
              </CardTitle>
              <CardDescription>
                Each outlet has independent tables, QR codes, GST, and KDS language settings.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleCreate} className="space-y-3.5">
                <div className="space-y-1.5">
                  <Label htmlFor="outlet-name">Outlet Name</Label>
                  <Input
                    id="outlet-name"
                    data-testid="new-outlet-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="SG Highway Branch"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="outlet-phone">Contact Phone</Label>
                  <Input
                    id="outlet-phone"
                    data-testid="new-outlet-phone"
                    value={contactPhone}
                    onChange={(e) => setContactPhone(e.target.value)}
                    placeholder="+919825099887"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="outlet-address">Address</Label>
                  <Input
                    id="outlet-address"
                    data-testid="new-outlet-address"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="Plot 12, SG Highway, Ahmedabad"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="outlet-tz">Timezone</Label>
                    <Input
                      id="outlet-tz"
                      value={timezone}
                      onChange={(e) => setTimezone(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="outlet-lang">KDS Language</Label>
                    <Select
                      id="outlet-lang"
                      value={kdsLanguage}
                      onChange={(e) => setKdsLanguage(e.target.value as 'en' | 'gu' | 'hi')}
                    >
                      <option value="en">English</option>
                      <option value="gu">ગુજરાતી (Gujarati)</option>
                      <option value="hi">हिन्दी (Hindi)</option>
                    </Select>
                  </div>
                </div>

                <Button
                  type="submit"
                  data-testid="create-outlet-submit"
                  disabled={submitting}
                  className="w-full"
                >
                  {submitting ? 'Creating...' : 'Create Outlet'}
                </Button>
              </form>
            </CardContent>
          </Card>

          <div className="space-y-4 lg:col-span-2">
            {loading ? (
              <Card className="h-40 animate-pulse bg-secondary/40" />
            ) : outlets.length === 0 ? (
              <Card>
                <CardContent className="py-10 text-center text-sm text-muted-foreground">
                  No outlets found for this restaurant yet.
                </CardContent>
              </Card>
            ) : (
              outlets.map((outlet) => (
                <Card key={outlet.id} data-testid={`outlet-card-${outlet.id}`}>
                  <CardContent className="flex flex-col justify-between gap-4 p-5 sm:flex-row sm:items-center">
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-semibold text-foreground">{outlet.name}</h3>
                        <Badge variant={outlet.isActive ? 'success' : 'secondary'}>
                          {outlet.isActive ? 'ACTIVE' : 'INACTIVE'}
                        </Badge>
                        <Badge variant="outline">
                          KDS: {(outlet.settings?.kdsLanguage ?? 'en').toUpperCase()}
                        </Badge>
                      </div>

                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Phone className="h-3.5 w-3.5" />
                          {outlet.contactPhone}
                        </span>
                        {outlet.address && (
                          <span className="flex items-center gap-1">
                            <MapPin className="h-3.5 w-3.5" />
                            {outlet.address}
                          </span>
                        )}
                      </div>

                      <p className="text-xs text-muted-foreground">
                        GST: {(outlet.gstRateBps / 100).toFixed(1)}% ({outlet.taxMode}) •{' '}
                        {outlet.timezone}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void handleSwitch(outlet.id, outlet.name)}
                      >
                        Switch Active
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void handleToggleActive(outlet)}
                      >
                        {outlet.isActive ? 'Deactivate' : 'Activate'}
                      </Button>
                      {outlets.length > 1 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          onClick={() => void handleDelete(outlet)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}

