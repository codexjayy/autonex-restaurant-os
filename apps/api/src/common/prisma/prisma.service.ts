import {
  applyTenantQueryGuard as applySharedTenantQueryGuard,
  createTenantScopedExtension as createSharedTenantScopedExtension,
  Prisma,
  PrismaClient,
  TENANT_SCOPED_MODELS,
  type TenantQueryParams as SharedTenantQueryParams,
} from '@autonex/database';
import { ForbiddenException, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ErrorCode } from '@autonex/shared';
import { TenantContextService } from '../context/tenant-context.service';
import { isValidUuid } from '../security/crypto.util';

export { TENANT_SCOPED_MODELS };

export type TenantQueryParams = Omit<SharedTenantQueryParams, 'createError'>;

function forbiddenFactory(code: string, message: string): ForbiddenException {
  return new ForbiddenException({ code, message });
}

export async function applyTenantQueryGuard(params: TenantQueryParams): Promise<unknown> {
  return applySharedTenantQueryGuard({
    ...params,
    createError: forbiddenFactory,
  });
}

export function createTenantScopedExtension(tenantId: string) {
  if (!isValidUuid(tenantId)) {
    throw new ForbiddenException({
      code: ErrorCode.TENANT_CONTEXT_MISSING,
      message: 'Valid tenantId UUID is required for tenant-scoped queries',
    });
  }

  return createSharedTenantScopedExtension(tenantId, forbiddenFactory);
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

    const scopedClient = this.appClient.$extends(
      createTenantScopedExtension(tenantId),
    ) as unknown as PrismaClient;

    return scopedClient.$transaction(async (scopedTx) => {
      await scopedTx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      return fn(scopedTx as unknown as Prisma.TransactionClient);
    });
  }

  /**
   * Audited system/admin helper for Super Admin routes and pre-tenant auth lookup.
   */
  async runAsSystemAdmin<T>(fn: (adminDb: PrismaClient) => Promise<T>): Promise<T> {
    return fn(this.adminClient);
  }
}

