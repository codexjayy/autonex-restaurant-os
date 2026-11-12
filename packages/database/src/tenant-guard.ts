import { Prisma } from '@prisma/client';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class TenantIsolationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TenantIsolationError';
  }
}

export const TENANT_SCOPED_MODELS = new Set([
  // Milestone 1 / Phase 1
  'Outlet',
  'TenantSettings',
  'OutletSettings',
  'Membership',
  'RefreshToken',
  'Session',
  'Invitation',
  'AuditLog',
  // Phase 2-5
  'Category',
  'MenuItem',
  'ModifierGroup',
  'ModifierOption',
  'RestaurantTable',
  'TableQrToken',
  'DiningSession',
  'SessionGuest',
  'Order',
  'OrderItem',
  'OrderEvent',
  'OutboxEvent',
  // Phase 6-7
  'Bill',
  'BillLine',
  'PaymentAttempt',
  'PaymentAllocation',
  'Refund',
  'WebhookEvent',
  'Subscription',
  'SubscriptionInvoice',
  'SupportCase',
  'SupportCaseNote',
]);

export type IsolationErrorFactory = (code: string, message: string) => Error;

export interface TenantQueryParams {
  tenantId: string;
  model?: string;
  operation: string;
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
  createError?: IsolationErrorFactory;
}

const defaultErrorFactory: IsolationErrorFactory = (code, message) =>
  new TenantIsolationError(code, message);

export async function applyTenantQueryGuard({
  tenantId,
  model,
  operation,
  args,
  query,
  createError = defaultErrorFactory,
}: TenantQueryParams): Promise<unknown> {
  if (!UUID_REGEX.test(tenantId)) {
    throw createError(
      'TENANT_CONTEXT_MISSING',
      'Valid tenantId UUID is required for tenant-scoped queries',
    );
  }

  if (model === 'Tenant') {
    const mutableArgs = { ...((args ?? {}) as Record<string, unknown>) };
    const where = { ...((mutableArgs.where ?? {}) as Record<string, unknown>) };
    if (where.id !== undefined && where.id !== tenantId) {
      throw createError('FORBIDDEN', 'Cross-tenant Tenant access blocked by app isolation layer');
    }
    mutableArgs.where = { ...where, id: tenantId };
    return query(mutableArgs);
  }

  if (model === 'Role') {
    const mutableArgs = { ...((args ?? {}) as Record<string, unknown>) };
    if (
      operation === 'create' ||
      operation === 'createMany' ||
      operation === 'update' ||
      operation === 'updateMany' ||
      operation === 'delete' ||
      operation === 'deleteMany' ||
      operation === 'upsert'
    ) {
      const validateOptionalTenantId = (record: unknown) => {
        if (record && typeof record === 'object') {
          const rec = record as Record<string, unknown>;
          if (rec.tenantId !== undefined && rec.tenantId !== tenantId) {
            throw createError('FORBIDDEN', 'Cross-tenant or system Role mutation blocked by app isolation layer');
          }
        }
      };

      if (operation === 'create') {
        const data = mutableArgs.data as Record<string, unknown> | undefined;
        if (data && data.tenantId !== tenantId) {
          throw createError('FORBIDDEN', 'Cross-tenant or system Role mutation blocked by app isolation layer');
        }
        return query(mutableArgs);
      }

      if (operation === 'createMany') {
        const rawData = mutableArgs.data;
        const rows = Array.isArray(rawData) ? rawData : rawData ? [rawData] : [];
        for (const row of rows) {
          if (!row || typeof row !== 'object' || (row as Record<string, unknown>).tenantId !== tenantId) {
            throw createError('FORBIDDEN', 'Cross-tenant or system Role mutation blocked by app isolation layer');
          }
        }
        return query(mutableArgs);
      }

      if (operation === 'upsert') {
        validateOptionalTenantId(mutableArgs.create);
        validateOptionalTenantId(mutableArgs.update);
        if (
          mutableArgs.create &&
          typeof mutableArgs.create === 'object' &&
          (mutableArgs.create as Record<string, unknown>).tenantId === undefined
        ) {
          throw createError('FORBIDDEN', 'Cross-tenant or system Role mutation blocked by app isolation layer');
        }
      } else {
        validateOptionalTenantId(mutableArgs.data);
      }

      const where = { ...((mutableArgs.where ?? {}) as Record<string, unknown>) };
      if (where.tenantId !== undefined && where.tenantId !== tenantId) {
        throw createError('FORBIDDEN', 'Cross-tenant or system Role mutation blocked by app isolation layer');
      }
      mutableArgs.where = { ...where, tenantId };
      return query(mutableArgs);
    }

    const where = { ...((mutableArgs.where ?? {}) as Record<string, unknown>) };
    if (where.tenantId !== undefined && where.tenantId !== null && where.tenantId !== tenantId) {
      throw createError('FORBIDDEN', 'Cross-tenant Role query blocked by app isolation layer');
    }
    if (
      operation === 'findMany' ||
      operation === 'findFirst' ||
      operation === 'findFirstOrThrow' ||
      operation === 'count' ||
      operation === 'aggregate' ||
      operation === 'groupBy'
    ) {
      const roleScope = { OR: [{ tenantId }, { tenantId: null }] };
      mutableArgs.where =
        where.OR !== undefined || where.AND !== undefined
          ? { AND: [where, roleScope] }
          : { ...where, ...roleScope };
      return query(mutableArgs);
    }

    const result = await query(mutableArgs);
    if (
      (operation === 'findUnique' || operation === 'findUniqueOrThrow') &&
      result &&
      typeof result === 'object' &&
      'tenantId' in result
    ) {
      const recordTenantId = (result as { tenantId?: unknown }).tenantId;
      if (recordTenantId !== null && recordTenantId !== undefined && recordTenantId !== tenantId) {
        throw createError('FORBIDDEN', 'Cross-tenant Role query blocked by app isolation layer');
      }
    }
    return result;
  }

  if (!model || !TENANT_SCOPED_MODELS.has(model)) {
    return query(args);
  }

  const mutableArgs = { ...((args ?? {}) as Record<string, unknown>) };

  const enforceWritePayload = (item: Record<string, unknown>) => {
    if (item.tenantId !== undefined && item.tenantId !== tenantId) {
      throw createError('FORBIDDEN', `Cross-tenant write rejected on ${model}`);
    }
    return { ...item, tenantId };
  };

  if (operation === 'create' || operation === 'createMany') {
    if (Array.isArray(mutableArgs.data)) {
      mutableArgs.data = mutableArgs.data.map((d) =>
        enforceWritePayload(d as Record<string, unknown>),
      );
    } else if (mutableArgs.data && typeof mutableArgs.data === 'object') {
      mutableArgs.data = enforceWritePayload(mutableArgs.data as Record<string, unknown>);
    }
    return query(mutableArgs);
  }

  const where = { ...((mutableArgs.where ?? {}) as Record<string, unknown>) };
  if (where.tenantId !== undefined && where.tenantId !== tenantId) {
    throw createError('FORBIDDEN', `Cross-tenant query rejected on ${model}`);
  }

  if (operation === 'upsert') {
    if (mutableArgs.create && typeof mutableArgs.create === 'object') {
      mutableArgs.create = enforceWritePayload(mutableArgs.create as Record<string, unknown>);
    }
    if (mutableArgs.update && typeof mutableArgs.update === 'object') {
      mutableArgs.update = enforceWritePayload(mutableArgs.update as Record<string, unknown>);
    }
  }

  if (operation === 'findUnique' || operation === 'findUniqueOrThrow') {
    const result = await query(mutableArgs);
    if (
      result &&
      typeof result === 'object' &&
      'tenantId' in result &&
      (result as { tenantId?: unknown }).tenantId !== tenantId
    ) {
      throw createError('FORBIDDEN', `Cross-tenant read rejected on ${model}`);
    }
    return result;
  }

  mutableArgs.where = { ...where, tenantId };
  return query(mutableArgs);
}

export function createTenantScopedExtension(
  tenantId: string,
  createError: IsolationErrorFactory = defaultErrorFactory,
) {
  if (!UUID_REGEX.test(tenantId)) {
    throw createError(
      'TENANT_CONTEXT_MISSING',
      'Valid tenantId UUID is required for tenant-scoped queries',
    );
  }

  return Prisma.defineExtension({
    name: 'tenant-isolation-guard',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          return applyTenantQueryGuard({
            tenantId,
            model,
            operation,
            args,
            query: query as (a: unknown) => Promise<unknown>,
            createError,
          });
        },
      },
    },
  });
}

