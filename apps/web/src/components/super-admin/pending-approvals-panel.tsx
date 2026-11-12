'use client';

import React from 'react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@autonex/ui';
import { CheckCircle2, Clock, Eye, Mail, MapPin, Phone, UserCheck, XCircle } from 'lucide-react';
import type { AdminRestaurantRow } from '@/lib/api-client';

interface PendingApprovalsPanelProps {
  restaurants: AdminRestaurantRow[];
  busyAction: boolean;
  onInspect: (tenantId: string) => void;
  onApprove: (rest: AdminRestaurantRow) => void;
  onReject: (rest: AdminRestaurantRow) => void;
}

export function PendingApprovalsPanel({
  restaurants,
  busyAction,
  onInspect,
  onApprove,
  onReject,
}: PendingApprovalsPanelProps) {
  const pendingList = restaurants.filter((r) => r.status === 'PENDING_APPROVAL');

  return (
    <div className="space-y-4" data-testid="sa-pending-approvals-panel">
      <Card className="border-amber-200 bg-amber-50/40">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base text-slate-900">
            <Clock className="h-4 w-4 text-amber-600" />
            Pending Restaurant Registrations ({pendingList.length})
          </CardTitle>
          <CardDescription>
            Verify restaurant identity, owner details, and outlet address before granting
            operational access. Approvals synchronize immediately to the Owner Dashboard.
          </CardDescription>
        </CardHeader>
      </Card>

      {pendingList.length === 0 ? (
        <Card className="bg-white p-10 text-center">
          <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-500" />
          <h3 className="mt-3 text-base font-semibold text-slate-800">
            No pending restaurant registrations
          </h3>
          <p className="mt-1 text-sm text-slate-500">
            Every submitted registration has already been reviewed.
          </p>
        </Card>
      ) : (
        <div className="grid gap-4">
          {pendingList.map((rest) => {
            const primaryOutlet = rest.outlets?.[0];
            return (
              <Card key={rest.id} className="border-amber-200 bg-white">
                <CardContent className="flex flex-col gap-4 p-5 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-bold text-slate-900">{rest.name}</h3>
                      <Badge variant="warning">PENDING_APPROVAL</Badge>
                    </div>
                    <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-600">
                      <span className="inline-flex items-center gap-1">
                        <UserCheck className="h-3.5 w-3.5 text-slate-400" />
                        <strong>Owner:</strong> {rest.owner?.name ?? 'N/A'}
                      </span>
                      {rest.owner?.email && (
                        <span className="inline-flex items-center gap-1">
                          <Mail className="h-3.5 w-3.5 text-slate-400" />
                          {rest.owner.email}
                        </span>
                      )}
                      {rest.owner?.phone && (
                        <span className="inline-flex items-center gap-1">
                          <Phone className="h-3.5 w-3.5 text-slate-400" />
                          {rest.owner.phone}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500">
                      <span className="inline-flex items-center gap-1">
                        <MapPin className="h-3.5 w-3.5 text-slate-400" />
                        {primaryOutlet
                          ? `${primaryOutlet.name}${primaryOutlet.address ? ` • ${primaryOutlet.address}` : ''}`
                          : 'No outlet recorded'}
                      </span>
                      <span>
                        Registered:{' '}
                        {new Date(rest.createdAt).toLocaleString('en-IN', {
                          day: '2-digit',
                          month: 'short',
                          year: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onInspect(rest.id)}
                    >
                      <Eye className="mr-1.5 h-3.5 w-3.5" />
                      Inspect
                    </Button>
                    <Button
                      size="sm"
                      disabled={busyAction}
                      onClick={() => onApprove(rest)}
                      className="bg-emerald-600 text-white hover:bg-emerald-700"
                    >
                      <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busyAction}
                      onClick={() => onReject(rest)}
                    >
                      <XCircle className="mr-1.5 h-3.5 w-3.5" />
                      Reject
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

