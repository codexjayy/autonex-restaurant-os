import { ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { StaffRole, SYSTEM_ROLE_SUPER_ADMIN, TenantStatus } from '@autonex/shared';
import { TenantContextService } from '../src/common/context/tenant-context.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { hashSecret, sha256Hex } from '../src/common/security/crypto.util';
import { AdminService } from '../src/modules/admin/admin.service';
import { AuthService } from '../src/modules/auth/auth.service';

describe('AuthService & AdminService (Phase 1 Flows)', () => {
  const jwtService = new JwtService({});
  const configService = {
    get: (key: string) => {
      const map: Record<string, string | number> = {
        JWT_ACCESS_SECRET: 'test_access_secret_min_32_characters_long_001',
        JWT_REFRESH_SECRET: 'test_refresh_secret_min_32_characters_long_002',
        JWT_ACCESS_TTL: '15m',
        JWT_REFRESH_TTL_DAYS: 7,
      };
      return map[key];
    },
  } as unknown as ConfigService;

  it('registers a new restaurant as PENDING_APPROVAL with OWNER membership and audit log', async () => {
    const createdRefreshTokens: unknown[] = [];
    const createdAudits: unknown[] = [];

    const txMock = {
      tenant: {
        create: jest.fn(async ({ data }) => ({ id: '11111111-1111-4111-8111-111111111111', ...data })),
      },
      outlet: {
        create: jest.fn(async ({ data }) => ({ id: '22222222-2222-4222-8222-222222222222', ...data })),
      },
      user: {
        create: jest.fn(async ({ data }) => ({ id: '33333333-3333-4333-8333-333333333333', ...data })),
      },
      membership: {
        create: jest.fn(async ({ data }) => ({ id: '44444444-4444-4444-8444-444444444444', ...data })),
      },
      auditLog: {
        create: jest.fn(async ({ data }) => {
          createdAudits.push(data);
          return data;
        }),
      },
    };

    const adminDbMock = {
      user: { findFirst: jest.fn(async () => null) },
      refreshToken: {
        create: jest.fn(async ({ data }) => {
          createdRefreshTokens.push(data);
          return data;
        }),
      },
      $transaction: jest.fn(async (cb: (tx: typeof txMock) => Promise<unknown>) => cb(txMock)),
    };

    const prismaMock = {
      runAsSystemAdmin: jest.fn(async (cb: (db: typeof adminDbMock) => Promise<unknown>) =>
        cb(adminDbMock),
      ),
    } as unknown as PrismaService;

    const tenantContext = new TenantContextService();
    const authService = new AuthService(prismaMock, jwtService, configService, tenantContext);

    const res = await tenantContext.run({ requestId: 'req-1', ipAddress: '127.0.0.1' }, () =>
      authService.registerRestaurant({
        restaurantName: 'Gujarat Thali House',
        outletName: 'CG Road Branch',
        ownerName: 'Mahesh Desai',
        email: 'mahesh@thali.in',
        phone: '+919825012345',
        password: 'StrongPassword123!',
        pin: '1234',
        address: 'CG Road, Ahmedabad',
      }),
    );

    expect(res.tenant.status).toBe(TenantStatus.PENDING_APPROVAL);
    expect(res.user.role).toBe(StaffRole.OWNER);
    expect(res.onboardingChecklist.adminApproved).toBe(false);
    expect(res.accessToken).toBeTruthy();
    expect(createdRefreshTokens).toHaveLength(1);
    expect(createdAudits).toHaveLength(1);
  });

  it('rejects duplicate registration phone or email with ConflictException', async () => {
    const adminDbMock = {
      user: { findFirst: jest.fn(async () => ({ id: 'existing-user' })) },
    };
    const prismaMock = {
      runAsSystemAdmin: jest.fn(async (cb: (db: typeof adminDbMock) => Promise<unknown>) =>
        cb(adminDbMock),
      ),
    } as unknown as PrismaService;

    const authService = new AuthService(prismaMock, jwtService, configService, new TenantContextService());

    await expect(
      authService.registerRestaurant({
        restaurantName: 'Test Cafe',
        outletName: 'Main',
        ownerName: 'Owner',
        email: 'dup@cafe.in',
        phone: '+919825012345',
        password: 'StrongPassword123!',
        pin: '1234',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('revokes entire refresh token family when refresh token reuse is detected', async () => {
    const updateManyMock = jest.fn(async () => ({ count: 2 }));
    const adminDbMock = {
      refreshToken: {
        findUnique: jest.fn(async () => ({
          id: 'rt-1',
          familyId: 'fam-123',
          userId: 'user-1',
          tenantId: 'tenant-1',
          revokedAt: new Date('2026-11-11T10:00:00Z'),
          expiresAt: new Date('2026-11-20T10:00:00Z'),
          user: { isActive: true, isSuperAdmin: false, memberships: [] },
        })),
        updateMany: updateManyMock,
      },
    };

    const prismaMock = {
      runAsSystemAdmin: jest.fn(async (cb: (db: typeof adminDbMock) => Promise<unknown>) =>
        cb(adminDbMock),
      ),
    } as unknown as PrismaService;

    const authService = new AuthService(prismaMock, jwtService, configService, new TenantContextService());
    const rawToken = 'reused-refresh-token-value';

    await expect(authService.refresh(rawToken)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(adminDbMock.refreshToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: sha256Hex(rawToken) } }),
    );
    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { familyId: 'fam-123', revokedAt: null } }),
    );
  });

  it('locks staff membership on 5th failed PIN attempt', async () => {
    const updateMock = jest.fn(async () => ({}));
    const adminDbMock = {
      membership: {
        findFirst: jest.fn(async () => ({
          id: 'mem-1',
          tenantId: 'tenant-1',
          outletId: 'outlet-1',
          userId: 'user-1',
          role: StaffRole.WAITER,
          staffPinHash: hashSecret('4321'),
          failedAttempts: 4,
          lockedUntil: null,
          user: { name: 'Waiter 1' },
          tenant: { status: TenantStatus.ACTIVE },
          outlet: { name: 'Main' },
        })),
        update: updateMock,
      },
    };

    const prismaMock = {
      runAsSystemAdmin: jest.fn(async (cb: (db: typeof adminDbMock) => Promise<unknown>) =>
        cb(adminDbMock),
      ),
    } as unknown as PrismaService;

    const authService = new AuthService(prismaMock, jwtService, configService, new TenantContextService());

    await expect(
      authService.staffPinLogin({
        outletId: 'outlet-1',
        phone: '+919825012345',
        pin: '0000',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failedAttempts: 5 }),
      }),
    );
  });

  it('blocks Managers from creating Owner staff accounts', async () => {
    const authService = new AuthService(
      {} as PrismaService,
      jwtService,
      configService,
      new TenantContextService(),
    );

    await expect(
      authService.createStaff(
        {
          userId: 'mgr-1',
          tenantId: '11111111-1111-4111-8111-111111111111',
          outletId: '22222222-2222-4222-8222-222222222222',
          role: StaffRole.MANAGER,
          isSuperAdmin: false,
        },
        { name: 'Rogue Owner', phone: '+919800000001', role: StaffRole.OWNER, pin: '1234' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('approves and suspends restaurants via AdminService with audit logging', async () => {
    const auditCreates: unknown[] = [];
    const revokedTokens: unknown[] = [];

    const txMock = {
      tenant: {
        update: jest.fn(async ({ data }) => ({ id: 'tenant-1', ...data })),
      },
      refreshToken: {
        updateMany: jest.fn(async (args) => {
          revokedTokens.push(args);
          return { count: 1 };
        }),
      },
      auditLog: {
        create: jest.fn(async ({ data }) => {
          auditCreates.push(data);
          return data;
        }),
      },
    };

    const adminDbMock = {
      tenant: {
        findUnique: jest.fn(async () => ({ id: 'tenant-1', status: TenantStatus.PENDING_APPROVAL })),
      },
      $transaction: jest.fn(async (cb: (tx: typeof txMock) => Promise<unknown>) => cb(txMock)),
    };

    const prismaMock = {
      runAsSystemAdmin: jest.fn(async (cb: (db: typeof adminDbMock) => Promise<unknown>) =>
        cb(adminDbMock),
      ),
    } as unknown as PrismaService;

    const adminService = new AdminService(prismaMock, new TenantContextService());
    const adminPrincipal = {
      userId: 'super-admin-1',
      role: SYSTEM_ROLE_SUPER_ADMIN,
      isSuperAdmin: true,
    };

    const approved = await adminService.approveRestaurant(adminPrincipal, 'tenant-1', {
      targetStatus: 'ACTIVE',
      note: 'Verified GST & phone',
    });
    expect(approved.status).toBe(TenantStatus.ACTIVE);

    const suspended = await adminService.suspendRestaurant(adminPrincipal, 'tenant-1', {
      reason: 'Chargeback review',
    });
    expect(suspended.status).toBe(TenantStatus.SUSPENDED);
    expect(revokedTokens).toHaveLength(1);
    expect(auditCreates).toHaveLength(2);
  });
});

