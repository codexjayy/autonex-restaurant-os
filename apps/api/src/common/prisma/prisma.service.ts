import { ForbiddenException, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { ErrorCode } from '@autonex/shared';
import { TenantContextService } from '../context/tenant-context.service';
import { isValidUuid } from '../security/crypto.util';

const TENANT_SCOPED_MODELS = new Set([
  'Outlet',
  'Membership',
  'RefreshToken',
  'AuditLog',
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
]);

export interface TenantQueryParams {
  tenantId: string;
  model?: string;
  operation: string;
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
}

export async function applyTenantQueryGuard({
  tenantId,
  model,
  operation,
  args,
  query,
}: TenantQueryParams): Promise<unknown> {
  if (!isValidUuid(tenantId)) {
    throw new ForbiddenException({
      code: ErrorCode.TENANT_CONTEXT_MISSING,
      message: 'Valid tenantId UUID is required for tenant-scoped queries',
    });
  }

  if (!model || !TENANT_SCOPED_MODELS.has(model)) {
    if (model === 'Tenant') {
      const mutableArgs = (args ?? {}) as Record<string, unknown>;
      const where = (mutableArgs.where ?? {}) as Record<string, unknown>;
      if (where.id !== undefined && where.id !== tenantId) {
        throw new ForbiddenException({
          code: ErrorCode.FORBIDDEN,
          message: 'Cross-tenant Tenant access blocked by app isolation layer',
        });
      }
      mutableArgs.where = { ...where, id: tenantId };
      return query(mutableArgs);
    }
    return query(args);
  }

  const mutableArgs = (args ?? {}) as Record<string, unknown>;

  const enforceWritePayload = (item: Record<string, unknown>) => {
    if (item.tenantId !== undefined && item.tenantId !== tenantId) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: `Cross-tenant write rejected on ${model}`,
      });
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

  const where = (mutableArgs.where ?? {}) as Record<string, unknown>;
  if (where.tenantId !== undefined && where.tenantId !== tenantId) {
    throw new ForbiddenException({
      code: ErrorCode.FORBIDDEN,
      message: `Cross-tenant query rejected on ${model}`,
    });
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
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: `Cross-tenant read rejected on ${model}`,
      });
    }
    return result;
  }

  mutableArgs.where = { ...where, tenantId };
  return query(mutableArgs);
}

export function createTenantScopedExtension(tenantId: string) {
  if (!isValidUuid(tenantId)) {
    throw new ForbiddenException({
      code: ErrorCode.TENANT_CONTEXT_MISSING,
      message: 'Valid tenantId UUID is required for tenant-scoped queries',
    });
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
          });
        },
      },
    },
  });
}

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  public readonly appClient: PrismaClient;
  public readonly adminClient: PrismaClient;

  constructor(
    configService: ConfigService,
    private readonly tenantContext: TenantContextService,
  ) {
    const appUrl = configService.get<string>('DATABASE_URL');
    const adminUrl = configService.get<string>('DATABASE_ADMIN_URL') ?? appUrl;

    this.appClient = new PrismaClient({ datasources: { db: { url: appUrl } } });
    this.adminClient = new PrismaClient({ datasources: { db: { url: adminUrl } } });
  }

  async onModuleInit(): Promise<void> {
    if (process.env.SKIP_DB_CONNECT === 'true') return;
    await this.appClient.$connect();
    await this.adminClient.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.appClient.$disconnect();
    await this.adminClient.$disconnect();
  }

  /**
   * Executes work inside a PostgreSQL transaction with BOTH:
   * 1. Layer 2 DB RLS (`SET LOCAL app.current_tenant_id = '<uuid>'`)
   * 2. Layer 1 Prisma `$extends` tenant filter & cross-tenant write rejection
   */
  async runInTenantTx<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    explicitTenantId?: string,
  ): Promise<T> {
    const tenantId = explicitTenantId ?? this.tenantContext.getTenantIdOrThrow();
    if (!isValidUuid(tenantId)) {
      throw new ForbiddenException({
        code: ErrorCode.TENANT_CONTEXT_MISSING,
        message: 'Invalid or missing tenantId in tenant context',
      });
    }

    return this.appClient.$transaction(async (rawTx) => {
      await rawTx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      const scopedTx = (rawTx as unknown as PrismaClient).$extends(
        createTenantScopedExtension(tenantId),
      ) as unknown as Prisma.TransactionClient;
      return fn(scopedTx);
    });
  }

  /**
   * Audited system/admin helper for Super Admin routes and pre-tenant auth lookup.
   */
  async runAsSystemAdmin<T>(fn: (adminDb: PrismaClient) => Promise<T>): Promise<T> {
    return fn(this.adminClient);
  }
}

