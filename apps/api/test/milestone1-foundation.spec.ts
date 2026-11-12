import 'reflect-metadata';
import { ArgumentsHost, ForbiddenException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import { Permissions } from '@autonex/permissions';
import { ErrorCode, StaffRole, SYSTEM_ROLE_SUPER_ADMIN, TenantStatus } from '@autonex/shared';
import type { Queue } from 'bullmq';
import { scryptSync } from 'node:crypto';
import { PERMISSIONS_KEY } from '../src/common/decorators/require-permissions.decorator';
import { IS_PUBLIC_KEY } from '../src/common/decorators/public.decorator';
import { TenantContextService } from '../src/common/context/tenant-context.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { PermissionsGuard } from '../src/common/guards/permissions.guard';
import type { StructuredLoggerService } from '../src/common/logging/structured-logger.service';
import { applyTenantQueryGuard, PrismaService } from '../src/common/prisma/prisma.service';
import { OnboardingJobsService } from '../src/common/queue/onboarding-jobs.service';
import type { OnboardingWelcomeJobPayload } from '../src/common/queue/queue.constants';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  hashSecret,
  needsRehash,
  REFRESH_COOKIE_NAME,
  verifySecret,
} from '../src/common/security/crypto.util';
import { AuthController } from '../src/modules/auth/auth.controller';
import { AuthService } from '../src/modules/auth/auth.service';
import { JwtStrategy } from '../src/modules/auth/strategies/jwt.strategy';
import { TenancyService } from '../src/modules/tenancy/tenancy.service';

function makeExecutionContext(
  handlerMeta: Record<string, unknown>,
  user?: {
    userId: string;
    tenantId?: string;
    outletId?: string;
    role: string;
    isSuperAdmin: boolean;
  },
) {
  const handler = () => {};
  const cls = class DummyController {};
  for (const [k, v] of Object.entries(handlerMeta)) {
    Reflect.defineMetadata(k, v, handler);
  }
  return {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as never;
}

describe('Milestone 1 Security, RBAC, Isolation & Onboarding Foundation', () => {
  const tenantIdA = '11111111-1111-4111-8111-111111111111';
  const tenantIdB = '22222222-2222-4222-8222-222222222222';
  const outletIdA1 = '33333333-3333-4333-8333-333333333333';
  const outletIdA2 = '44444444-4444-4444-8444-444444444444';
  const userIdA = '55555555-5555-4555-8555-555555555555';

  const makeConfig = () =>
    new ConfigService({
      JWT_ACCESS_SECRET: 'test_access_secret_min_32_characters_long_001',
      JWT_REFRESH_SECRET: 'test_refresh_secret_min_32_characters_long_002',
      JWT_ACCESS_TTL: '15m',
      JWT_REFRESH_TTL_DAYS: 7,
      NODE_ENV: 'test',
      REDIS_ENABLED: false,
      SKIP_REDIS_CONNECT: true,
    });

  it('uses Argon2id PHC format for new hashes and transparently supports legacy scrypt verification', () => {
    const hash = hashSecret('OwnerPass#2026');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(verifySecret('OwnerPass#2026', hash)).toBe(true);
    expect(verifySecret('WrongPass', hash)).toBe(false);
    expect(needsRehash(hash)).toBe(false);

    const legacySalt = 'legacysalt';
    const legacyHash = `scrypt:${legacySalt}:${scryptSync('Legacy#123', legacySalt, 64).toString('hex')}`;
    expect(verifySecret('Legacy#123', legacyHash)).toBe(true);
    expect(needsRehash(legacyHash)).toBe(true);
  });

  it('maps JWT payload into AuthenticatedPrincipal via NestJS Passport JwtStrategy', () => {
    const strategy = new JwtStrategy(makeConfig());
    const principal = strategy.validate({
      sub: userIdA,
      tenantId: tenantIdA,
      outletId: outletIdA1,
      membershipId: '66666666-6666-4666-8666-666666666666',
      role: StaffRole.OWNER,
      isSuperAdmin: false,
      tenantStatus: TenantStatus.ACTIVE,
    });

    expect(principal).toEqual({
      userId: userIdA,
      tenantId: tenantIdA,
      outletId: outletIdA1,
      membershipId: '66666666-6666-4666-8666-666666666666',
      role: StaffRole.OWNER,
      isSuperAdmin: false,
      tenantStatus: TenantStatus.ACTIVE,
    });
  });

  it('enforces PermissionsGuard across roles and public endpoints', () => {
    const guard = new PermissionsGuard(new Reflector());

    expect(
      guard.canActivate(
        makeExecutionContext({ [IS_PUBLIC_KEY]: true, [PERMISSIONS_KEY]: [Permissions.TENANT_UPDATE] }),
      ),
    ).toBe(true);

    expect(
      guard.canActivate(
        makeExecutionContext(
          { [PERMISSIONS_KEY]: [Permissions.TENANT_UPDATE, Permissions.OUTLET_CREATE] },
          { userId: userIdA, tenantId: tenantIdA, outletId: outletIdA1, role: StaffRole.OWNER, isSuperAdmin: false },
        ),
      ),
    ).toBe(true);

    expect(() =>
      guard.canActivate(
        makeExecutionContext(
          { [PERMISSIONS_KEY]: [Permissions.TENANT_UPDATE] },
          { userId: userIdA, tenantId: tenantIdA, outletId: outletIdA1, role: StaffRole.WAITER, isSuperAdmin: false },
        ),
      ),
    ).toThrow(ForbiddenException);

    expect(
      guard.canActivate(
        makeExecutionContext(
          { [PERMISSIONS_KEY]: [Permissions.ADMIN_PLATFORM] },
          { userId: userIdA, role: SYSTEM_ROLE_SUPER_ADMIN, isSuperAdmin: true },
        ),
      ),
    ).toBe(true);
  });

  it('rejects cookie-backed refresh without matching double-submit CSRF token and accepts valid pairs', async () => {
    const authServiceMock = {
      refresh: jest.fn().mockResolvedValue({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
      }),
    } as unknown as AuthService;
    const controller = new AuthController(authServiceMock, makeConfig());

    const cookiesWritten: Array<{ name: string; val: string }> = [];
    const resMock = {
      cookie: (name: string, val: string) => cookiesWritten.push({ name, val }),
      clearCookie: jest.fn(),
    } as never;

    const reqMissingCsrf = {
      cookies: {
        [REFRESH_COOKIE_NAME]: 'cookie-refresh-token',
        [CSRF_COOKIE_NAME]: 'csrf-secret-value',
      },
      header: () => undefined,
      socket: {},
    } as never;

    await expect(controller.refresh({}, reqMissingCsrf, resMock)).rejects.toMatchObject({
      response: expect.objectContaining({ code: ErrorCode.CSRF_TOKEN_INVALID }),
    });

    const reqValidCsrf = {
      cookies: {
        [REFRESH_COOKIE_NAME]: 'cookie-refresh-token',
        [CSRF_COOKIE_NAME]: 'csrf-secret-value',
      },
      header: (name: string) => (name.toLowerCase() === CSRF_HEADER_NAME ? 'csrf-secret-value' : undefined),
      socket: {},
    } as never;

    const result = await controller.refresh({}, reqValidCsrf, resMock);
    expect(result.accessToken).toBe('new-access');
    expect(result.csrfToken).toBeTruthy();
    expect(cookiesWritten.some((c) => c.name === CSRF_COOKIE_NAME)).toBe(true);
  });

  it('provisions TenantSettings, OutletSettings, Role linking, Session, and enqueues onboarding job cleanly', async () => {
    const createdRecords: Record<string, unknown> = {};
    const txMock = {
      tenant: {
        create: jest.fn().mockImplementation(async ({ data }) => {
          createdRecords.tenant = data;
          return { id: tenantIdA, ...data };
        }),
      },
      tenantSettings: {
        create: jest.fn().mockImplementation(async ({ data }) => {
          createdRecords.tenantSettings = data;
          return { id: 'ts-1', ...data };
        }),
      },
      outlet: {
        create: jest.fn().mockImplementation(async ({ data }) => ({ id: outletIdA1, ...data })),
      },
      outletSettings: {
        create: jest.fn().mockImplementation(async ({ data }) => {
          createdRecords.outletSettings = data;
          return { id: 'os-1', ...data };
        }),
      },
      user: {
        create: jest.fn().mockImplementation(async ({ data }) => {
          createdRecords.user = data;
          return { id: userIdA, ...data };
        }),
      },
      role: {
        findFirst: jest.fn().mockResolvedValue({ id: 'role-owner-1', code: StaffRole.OWNER }),
      },
      membership: {
        create: jest.fn().mockImplementation(async ({ data }) => {
          createdRecords.membership = data;
          return { id: 'mem-1', ...data };
        }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };

    const adminDbMock = {
      user: { findFirst: jest.fn().mockResolvedValue(null) },
      refreshToken: { create: jest.fn().mockResolvedValue({}) },
      session: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async ({ data }) => {
          createdRecords.session = data;
          return { id: 'sess-1', ...data };
        }),
      },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: typeof txMock) => unknown) => fn(txMock)),
    };

    const prismaMock = {
      runAsSystemAdmin: jest.fn().mockImplementation(async (fn: (db: typeof adminDbMock) => unknown) =>
        fn(adminDbMock),
      ),
    } as unknown as PrismaService;

    const jobsService = new OnboardingJobsService(makeConfig());
    const enqueueSpy = jest.spyOn(jobsService, 'enqueueWelcomeJob');

    const service = new AuthService(
      prismaMock,
      new JwtService({}),
      makeConfig(),
      new TenantContextService(),
      jobsService,
    );

    const out = await service.registerRestaurant({
      restaurantName: 'Gujarat Spice Kitchen',
      outletName: 'Navrangpura Flagship',
      ownerName: 'Rohan Patel',
      email: 'rohan@gujaratspice.in',
      phone: '+919825012345',
      password: 'Password#2026',
      pin: '1234',
      address: 'CG Road, Ahmedabad',
    });

    expect(out.tenant.name).toBe('Gujarat Spice Kitchen');
    expect((createdRecords.tenantSettings as { currency: string }).currency).toBe('INR');
    expect((createdRecords.outletSettings as { gstRateBps: number }).gstRateBps).toBe(500);
    expect((createdRecords.membership as { roleId: string }).roleId).toBe('role-owner-1');
    expect(String((createdRecords.user as { passwordHash: string }).passwordHash)).toMatch(/^\$argon2id\$/);
    expect((createdRecords.session as { userId: string }).userId).toBe(userIdA);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    await expect(enqueueSpy.mock.results[0]!.value).resolves.toEqual({ queued: false });
  });

  it('creates multi-outlet branches with settings, prevents deleting the last outlet, and blocks cross-tenant queries', async () => {
    const outletsDb = [
      {
        id: outletIdA1,
        tenantId: tenantIdA,
        name: 'Main Branch',
        contactPhone: '+919825012345',
        timezone: 'Asia/Kolkata',
        taxMode: 'EXCLUSIVE',
        gstRateBps: 500,
        roundOffEnabled: true,
        requireWaiterApproval: true,
        tablePinEnabled: true,
        isActive: true,
        deletedAt: null,
      },
    ];

    const txMock = {
      outlet: {
        create: jest.fn().mockImplementation(async ({ data }) => {
          const created = { id: outletIdA2, deletedAt: null, ...data };
          outletsDb.push(created);
          return created;
        }),
        findFirst: jest.fn().mockImplementation(async ({ where }) =>
          outletsDb.find((o) => o.id === where.id && o.deletedAt === null) ?? null,
        ),
        count: jest.fn().mockImplementation(async () => outletsDb.filter((o) => o.deletedAt === null).length),
        update: jest.fn().mockImplementation(async ({ where, data }) => {
          const found = outletsDb.find((o) => o.id === where.id)!;
          Object.assign(found, data);
          return found;
        }),
      },
      outletSettings: {
        create: jest.fn().mockImplementation(async ({ data }) => ({ id: 'os-2', ...data })),
      },
      membership: {
        findFirst: jest.fn().mockResolvedValue({ staffPinHash: 'argon2-hash' }),
        create: jest.fn().mockResolvedValue({ id: 'mem-new' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      role: { findFirst: jest.fn().mockResolvedValue({ id: 'role-owner-1' }) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };

    const prismaMock = {
      runInTenantTx: jest.fn().mockImplementation(async (fn: (tx: typeof txMock) => unknown) => fn(txMock)),
    } as unknown as PrismaService;

    const tenancyService = new TenancyService(prismaMock, new TenantContextService());
    const ownerPrincipal = {
      userId: userIdA,
      tenantId: tenantIdA,
      outletId: outletIdA1,
      role: StaffRole.OWNER,
      isSuperAdmin: false,
      tenantStatus: TenantStatus.ACTIVE,
    };

    const secondOutlet = await tenancyService.createOutlet(ownerPrincipal, {
      name: 'SG Highway Branch',
      contactPhone: '+919825099999',
      address: 'SG Highway, Ahmedabad',
    });
    expect(secondOutlet.id).toBe(outletIdA2);

    const deleted = await tenancyService.softDeleteOutlet(ownerPrincipal, outletIdA2);
    expect(deleted.id).toBe(outletIdA2);
    expect(deleted.deletedAt).toBeInstanceOf(Date);

    // Cannot delete the last remaining active outlet
    await expect(tenancyService.softDeleteOutlet(ownerPrincipal, outletIdA1)).rejects.toThrow();

    // Layer 1 isolation blocks cross-tenant queries across Milestone 1 + Phase 6 models
    for (const model of ['TenantSettings', 'OutletSettings', 'Invitation', 'Session', 'Bill']) {
      await expect(
        applyTenantQueryGuard({
          tenantId: tenantIdA,
          model,
          operation: 'findMany',
          args: { where: { tenantId: tenantIdB } },
          query: async (args) => args,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('HttpExceptionFilter maps Prisma errors safely without leaking secrets', () => {
    const tenantContext = new TenantContextService();
    const logger = {
      error: jest.fn(),
      warn: jest.fn(),
      log: jest.fn(),
    } as unknown as StructuredLoggerService;
    const filter = new HttpExceptionFilter(tenantContext, logger);

    const runCase = (err: unknown) => {
      const json = jest.fn();
      const status = jest.fn().mockReturnValue({ json });
      const host = {
        switchToHttp: () => ({
          getResponse: () => ({ status }),
        }),
      } as unknown as ArgumentsHost;

      filter.catch(err, host);
      return {
        statusCode: status.mock.calls[0]?.[0] as number,
        body: json.mock.calls[0]?.[0] as { code?: string; message?: string },
      };
    };

    const conflict = runCase(
      new Prisma.PrismaClientKnownRequestError('postgresql://secret@localhost/db failed', {
        code: 'P2002',
        clientVersion: '6.0.0',
        meta: { target: ['email'] },
      }),
    );
    expect(conflict.statusCode).toBe(HttpStatus.CONFLICT);
    expect(conflict.body.code).toBe(ErrorCode.CONFLICT);
    expect(conflict.body.message).toContain('email');
    expect(conflict.body.message).not.toContain('secret');

    const schemaErr = runCase(
      new Prisma.PrismaClientKnownRequestError('relation missing', {
        code: 'P2021',
        clientVersion: '6.0.0',
      }),
    );
    expect(schemaErr.statusCode).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(schemaErr.body.code).toBe('DATABASE_SCHEMA_ERROR');

    const connErr = runCase(
      new Prisma.PrismaClientKnownRequestError('connection refused', {
        code: 'P1001',
        clientVersion: '6.0.0',
      }),
    );
    expect(connErr.statusCode).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(connErr.body.code).toBe('DATABASE_UNAVAILABLE');

    const unknownErr = runCase(
      new Prisma.PrismaClientUnknownRequestError(
        'connect failed postgresql://user:supersecret@localhost:5432/autonex',
        { clientVersion: '6.0.0' },
      ),
    );
    expect(unknownErr.statusCode).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(unknownErr.body.code).toBe('DATABASE_ERROR');
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('supersecret');

    const validationErr = runCase(
      new Prisma.PrismaClientValidationError('Unknown argument', { clientVersion: '6.0.0' }),
    );
    expect(validationErr.statusCode).toBe(HttpStatus.BAD_REQUEST);
    expect(validationErr.body.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('OnboardingJobsService degrades cleanly when Redis client is not ready', async () => {
    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'REDIS_ENABLED') return true;
        if (key === 'SKIP_REDIS_CONNECT') return false;
        return undefined;
      }),
    } as unknown as ConfigService;

    const addMock = jest.fn();
    const queueMock = {
      client: Promise.resolve({ status: 'reconnecting' }),
      add: addMock,
    } as unknown as Queue<OnboardingWelcomeJobPayload>;

    const service = new OnboardingJobsService(configService, queueMock);
    const result = await service.enqueueWelcomeJob({
      tenantId: 'tenant-1',
      tenantName: 'Spice Route',
      outletId: 'outlet-1',
      ownerUserId: 'user-1',
      ownerEmail: 'owner@example.com',
    });

    expect(result).toEqual({ queued: false });
    expect(addMock).not.toHaveBeenCalled();
  });
});
