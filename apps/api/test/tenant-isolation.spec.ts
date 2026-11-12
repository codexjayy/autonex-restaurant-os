import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { StaffRole, SYSTEM_ROLE_SUPER_ADMIN, TenantStatus } from '@autonex/shared';
import { TenantContextService } from '../src/common/context/tenant-context.service';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { TenantStatusGuard } from '../src/common/guards/tenant-status.guard';
import {
  applyTenantQueryGuard,
  createTenantScopedExtension,
  PrismaService,
} from '../src/common/prisma/prisma.service';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER_A = '33333333-3333-4333-8333-333333333333';
const OUTLET_A = '44444444-4444-4444-8444-444444444444';

function mockExecutionContext(params: {
  headers?: Record<string, string>;
  user?: unknown;
  metadata?: Record<string, unknown>;
}): ExecutionContext {
  const req: Record<string, unknown> = {
    header: (name: string) => params.headers?.[name.toLowerCase()],
    user: params.user,
  };
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
    getHandler: () => params.metadata ?? {},
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('Cross-Tenant Isolation & Security Guards', () => {
  it('isolates AsyncLocalStorage tenant contexts across concurrent requests', async () => {
    const ctxService = new TenantContextService();

    const [resA, resB] = await Promise.all([
      new Promise<string>((resolve) => {
        ctxService.run({ requestId: 'req-a', tenantId: TENANT_A }, () => {
          setTimeout(() => resolve(ctxService.getTenantIdOrThrow()), 15);
        });
      }),
      new Promise<string>((resolve) => {
        ctxService.run({ requestId: 'req-b', tenantId: TENANT_B }, () => {
          setTimeout(() => resolve(ctxService.getTenantIdOrThrow()), 5);
        });
      }),
    ]);

    expect(resA).toBe(TENANT_A);
    expect(resB).toBe(TENANT_B);
    expect(ctxService.get()).toBeUndefined();
  });

  it('rejects cross-tenant x-tenant-id header spoofing in JwtAuthGuard', async () => {
    const jwtSecret = 'test_access_secret_min_32_characters_long_001';
    const jwt = new JwtService({ secret: jwtSecret });
    const token = await jwt.signAsync({
      sub: USER_A,
      tenantId: TENANT_A,
      outletId: OUTLET_A,
      role: StaffRole.OWNER,
      isSuperAdmin: false,
      tenantStatus: TenantStatus.ACTIVE,
    });

    const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
    const config = { get: () => jwtSecret } as unknown as ConfigService;
    const ctxService = new TenantContextService();
    const guard = new JwtAuthGuard(reflector, jwt, config, ctxService);

    const execCtx = mockExecutionContext({
      headers: {
        authorization: `Bearer ${token}`,
        'x-tenant-id': TENANT_B,
      },
    });

    await expect(
      ctxService.run({ requestId: 'req-spoof' }, () => guard.canActivate(execCtx)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects missing bearer token in JwtAuthGuard', async () => {
    const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
    const jwt = new JwtService({});
    const config = { get: () => 'secret' } as unknown as ConfigService;
    const guard = new JwtAuthGuard(reflector, jwt, config, new TenantContextService());

    await expect(guard.canActivate(mockExecutionContext({ headers: {} }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('blocks PENDING_APPROVAL tenants on operational routes unless AllowPendingTenant is set', () => {
    const metadataMap = new Map<string, unknown>();
    const reflector = {
      getAllAndOverride: (key: string) => metadataMap.get(key) ?? false,
    } as unknown as Reflector;
    const guard = new TenantStatusGuard(reflector);

    const pendingCtx = mockExecutionContext({
      user: {
        userId: USER_A,
        tenantId: TENANT_A,
        role: StaffRole.OWNER,
        isSuperAdmin: false,
        tenantStatus: TenantStatus.PENDING_APPROVAL,
      },
    });

    expect(() => guard.canActivate(pendingCtx)).toThrow(ForbiddenException);

    metadataMap.set('allowPendingTenant', true);
    expect(guard.canActivate(pendingCtx)).toBe(true);
  });

  it('blocks SUSPENDED tenants even on pending-allowed routes, while allowing SUPER_ADMIN', () => {
    const reflector = {
      getAllAndOverride: (key: string) => key === 'allowPendingTenant',
    } as unknown as Reflector;
    const guard = new TenantStatusGuard(reflector);

    expect(() =>
      guard.canActivate(
        mockExecutionContext({
          user: {
            userId: USER_A,
            tenantId: TENANT_A,
            role: StaffRole.OWNER,
            isSuperAdmin: false,
            tenantStatus: TenantStatus.SUSPENDED,
          },
        }),
      ),
    ).toThrow(ForbiddenException);

    expect(
      guard.canActivate(
        mockExecutionContext({
          user: {
            userId: USER_A,
            role: SYSTEM_ROLE_SUPER_ADMIN,
            isSuperAdmin: true,
          },
        }),
      ),
    ).toBe(true);
  });

  it('enforces RBAC role restrictions via RolesGuard', () => {
    const reflector = {
      getAllAndOverride: (key: string) => (key === 'roles' ? [StaffRole.OWNER] : false),
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);

    expect(() =>
      guard.canActivate(
        mockExecutionContext({
          user: { userId: USER_A, tenantId: TENANT_A, role: StaffRole.WAITER, isSuperAdmin: false },
        }),
      ),
    ).toThrow(ForbiddenException);

    expect(
      guard.canActivate(
        mockExecutionContext({
          user: { userId: USER_A, tenantId: TENANT_A, role: StaffRole.OWNER, isSuperAdmin: false },
        }),
      ),
    ).toBe(true);
  });

  it('rejects invalid tenant UUID in Prisma tenant extension', () => {
    expect(() => createTenantScopedExtension('not-a-uuid')).toThrow(ForbiddenException);
  });

  it('blocks cross-tenant queries and writes inside Prisma tenant isolation guard', async () => {
    const fakeQuery = jest.fn(async (args) => args);

    // 1. Auto-injects tenantId on reads
    const readArgs = (await applyTenantQueryGuard({
      tenantId: TENANT_A,
      model: 'Outlet',
      operation: 'findMany',
      args: { where: { isActive: true } },
      query: fakeQuery,
    })) as { where: Record<string, unknown> };
    expect(readArgs.where.tenantId).toBe(TENANT_A);

    // 2. Rejects querying Tenant B explicitly
    await expect(
      applyTenantQueryGuard({
        tenantId: TENANT_A,
        model: 'Outlet',
        operation: 'findMany',
        args: { where: { tenantId: TENANT_B } },
        query: fakeQuery,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // 3. Rejects creating record under Tenant B
    await expect(
      applyTenantQueryGuard({
        tenantId: TENANT_A,
        model: 'Membership',
        operation: 'create',
        args: { data: { tenantId: TENANT_B, role: StaffRole.WAITER } },
        query: fakeQuery,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // 4. Rejects findUnique returning another tenant's row
    await expect(
      applyTenantQueryGuard({
        tenantId: TENANT_A,
        model: 'Outlet',
        operation: 'findUnique',
        args: { where: { id: OUTLET_A } },
        query: async () => ({ id: OUTLET_A, tenantId: TENANT_B }),
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // 5. Rejects cross-tenant Tenant root lookup
    await expect(
      applyTenantQueryGuard({
        tenantId: TENANT_A,
        model: 'Tenant',
        operation: 'findFirst',
        args: { where: { id: TENANT_B } },
        query: fakeQuery,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('extends appClient before starting $transaction in runInTenantTx (no rawTx.$extends call)', async () => {
    const configMock = {
      get: () => 'postgresql://autonex_app:dev@localhost:5432/autonex',
    } as unknown as ConfigService;
    const ctxService = new TenantContextService();
    const prismaService = new PrismaService(configMock, ctxService);

    const execRawMock = jest.fn(async () => 1);
    // Simulate real Prisma TransactionClient where $extends does NOT exist on tx
    const scopedTx = { $executeRaw: execRawMock };
    const transactionMock = jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(scopedTx));
    const extendsMock = jest.fn(() => ({ $transaction: transactionMock }));

    Object.defineProperty(prismaService, 'appClient', {
      value: { $extends: extendsMock },
      writable: true,
    });

    const result = await prismaService.runInTenantTx(async (tx) => {
      expect(tx).toBe(scopedTx);
      return 'ok';
    }, TENANT_A);

    expect(result).toBe('ok');
    expect(extendsMock).toHaveBeenCalledTimes(1);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(execRawMock).toHaveBeenCalledTimes(1);
  });
});

