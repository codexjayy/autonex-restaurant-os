import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Observable, Subject } from 'rxjs';

export type PlatformRealtimeEventType =
  | 'restaurant.approved'
  | 'restaurant.rejected'
  | 'restaurant.suspended'
  | 'restaurant.reactivated'
  | 'outlet.created'
  | 'outlet.updated'
  | 'subscription.updated'
  | 'trial.updated'
  | 'menu.updated'
  | 'order.created'
  | 'order.updated'
  | 'payment.updated';

export interface PlatformRealtimeEvent {
  id: string;
  type: PlatformRealtimeEventType;
  tenantId: string;
  outletId?: string | null;
  tenantWide?: boolean;
  timestamp: string;
  payload: Record<string, unknown>;
}

@Injectable()
export class RealtimeEventsService {
  private readonly stream$ = new Subject<PlatformRealtimeEvent>();

  get events$(): Observable<PlatformRealtimeEvent> {
    return this.stream$.asObservable();
  }

  emit(input: {
    type: PlatformRealtimeEventType;
    tenantId: string;
    outletId?: string | null;
    tenantWide?: boolean;
    payload?: Record<string, unknown>;
  }): PlatformRealtimeEvent {
    const event: PlatformRealtimeEvent = {
      id: randomUUID(),
      type: input.type,
      tenantId: input.tenantId,
      outletId: input.outletId ?? null,
      tenantWide: input.tenantWide ?? true,
      timestamp: new Date().toISOString(),
      payload: input.payload ?? {},
    };
    this.stream$.next(event);
    return event;
  }
}

