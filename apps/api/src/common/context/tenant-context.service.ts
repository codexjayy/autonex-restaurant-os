import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ActorRole, TenantStatus } from '@autonex/shared';

export interface RequestContextData {
  requestId: string;
  ipAddress?: string;
  userId?: string;
  tenantId?: string;
  outletId?: string;
  membershipId?: string;
  role?: ActorRole;
  isSuperAdmin?: boolean;
  tenantStatus?: TenantStatus;
}

@Injectable()
export class TenantContextService {
  private readonly storage = new AsyncLocalStorage<RequestContextData>();

  run<T>(initial: RequestContextData, fn: () => T): T {
    return this.storage.run({ ...initial }, fn);
  }

  get(): RequestContextData | undefined {
    return this.storage.getStore();
  }

  update(patch: Partial<RequestContextData>): void {
    const store = this.storage.getStore();
    if (!store) return;
    Object.assign(store, patch);
  }

  getTenantIdOrThrow(): string {
    const tenantId = this.storage.getStore()?.tenantId;
    if (!tenantId) {
      throw new Error('TenantContext missing tenantId in current request scope');
    }
    return tenantId;
  }

  getRequestId(): string {
    return this.storage.getStore()?.requestId ?? 'unknown';
  }
}

