import { ConflictException, ForbiddenException, HttpException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { StaffRole, SYSTEM_ROLE_SUPER_ADMIN, TenantStatus } from '@autonex/shared';
import { TenantContextService } from '../src/common/context/tenant-context.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { hashPassword, hashSecret, sha256Hex } from '../src/common/security/crypto.util';
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

  it('authenticates Super Admin via normalized 10-digit phone and blocks non-Super-Admin accounts', async () => {
    const passwordHash = await hashPassword('SuperSecret99!');
    const auditCreates: Array<{ action: string }> = [];
    let lastWhere: unknown = null;

    const superAdminUser = {
      id: 'sa-1',
      name: 'Platform Admin',
      email: 'admin@autonex.in',
      phone: '+919999999999',
      passwordHash,
      isActive: true,
      isSuperAdmin: true,
      deletedAt: null,
      failedLoginAttempts: 0,
      lockedUntil: null,
      memberships: [],
    };

    const ownerUser = {
      id: 'owner-1',
      name: 'Cafe Owner',
      email: 'owner@cafe.in',
      phone: '+919825000001',
      passwordHash,
      isActive: true,
      isSuperAdmin: false,
      deletedAt: null,
      failedLoginAttempts: 0,
      lockedUntil: null,
      memberships: [],
    };

    const adminDbMock = {
      user: {
        findFirst: jest.fn(async ({ where }) => {
          lastWhere = where;
          const serialized = JSON.stringify(where);
          if (serialized.includes('+919999999999')) return superAdminUser;
          if (serialized.includes('owner@cafe.in')) return ownerUser;
          return null;
        }),
        update: jest.fn(async ({ data }) => ({ ...superAdminUser, ...data })),
      },
      refreshToken: {
        create: jest.fn(async ({ data }) => data),
      },
      auditLog: {
        create: jest.fn(async ({ data }) => {
          auditCreates.push(data);
          return data;
        }),
      },
    };

    const prismaMock = {
      runAsSystemAdmin: jest.fn(async (cb: (db: typeof adminDbMock) => Promise<unknown>) =>
        cb(adminDbMock),
      ),
    } as unknown as PrismaService;

    const authService = new AuthService(prismaMock, jwtService, configService, new TenantContextService());

    const res = await authService.superAdminLogin({
      identifier: '9999999999',
      password: 'SuperSecret99!',
    });

    expect(JSON.stringify(lastWhere)).toContain('+919999999999');
    expect(res.user.isSuperAdmin).toBe(true);
    expect(res.user.role).toBe(SYSTEM_ROLE_SUPER_ADMIN);
    expect(auditCreates.some((a) => a.action === 'SUPER_ADMIN_LOGIN_SUCCESS')).toBe(true);

    await expect(
      authService.superAdminLogin({
        identifier: 'owner@cafe.in',
        password: 'SuperSecret99!',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(auditCreates.some((a) => a.action === 'SUPER_ADMIN_LOGIN_DENIED')).toBe(true);
  });

  it('locks Super Admin after 5 failed password attempts and rejects attempts while locked', async () => {
    const passwordHash = await hashPassword('CorrectPass99!');
    const auditCreates: Array<{ action: string }> = [];
    const userUpdates: Array<{ failedLoginAttempts?: number; lockedUntil?: Date | null }> = [];
    let lockedUntilState: Date | null = null;

    const adminDbMock = {
      user: {
        findFirst: jest.fn(async () => ({
          id: 'sa-lock-1',
          name: 'Platform Admin',
          email: 'admin@autonex.in',
          phone: '+919999999999',
          passwordHash,
          isActive: true,
          isSuperAdmin: true,
          deletedAt: null,
          failedLoginAttempts: 4,
          lockedUntil: lockedUntilState,
          memberships: [],
        })),
        update: jest.fn(async ({ data }) => {
          userUpdates.push(data);
          if (data.lockedUntil) lockedUntilState = data.lockedUntil;
          return data;
        }),
      },
      auditLog: {
        create: jest.fn(async ({ data }) => {
          auditCreates.push(data);
          return data;
        }),
      },
    };

    const prismaMock = {
      runAsSystemAdmin: jest.fn(async (cb: (db: typeof adminDbMock) => Promise<unknown>) =>
        cb(adminDbMock),
      ),
    } as unknown as PrismaService;

    const authService = new AuthService(prismaMock, jwtService, configService, new TenantContextService());

    await expect(
      authService.superAdminLogin({
        identifier: 'admin@autonex.in',
        password: 'WrongPassword1!',
      }),
    ).rejects.toBeInstanceOf(HttpException);

    expect(userUpdates[0]?.failedLoginAttempts).toBe(5);
    expect(userUpdates[0]?.lockedUntil).toBeInstanceOf(Date);
    expect(auditCreates.some((a) => a.action === 'SUPER_ADMIN_LOGIN_LOCKED')).toBe(true);

    // Subsequent valid password attempt while locked must still fail cleanly with 423
    await expect(
      authService.superAdminLogin({
        identifier: 'admin@autonex.in',
        password: 'CorrectPass99!',
      }),
    ).rejects.toBeInstanceOf(HttpException);
    expect(auditCreates.some((a) => a.action === 'SUPER_ADMIN_LOGIN_BLOCKED_LOCKED')).toBe(true);
  });

  it('issues and consumes one-time Super Admin password reset tokens and avoids duplicate bootstrap admins', async () => {
    const oldHash = await hashPassword('OldPassword123!');
    const updatedUsers: Array<{ passwordHash?: string; failedLoginAttempts?: number }> = [];
    const revokedTokens: unknown[] = [];
    const auditCreates: Array<{ action: string }> = [];
    const resetRecords: Array<{ id: string; userId: string; tokenHash: string; expiresAt: Date; usedAt: Date | null }> = [];

    const txMock = {
      user: {
        update: jest.fn(async ({ data }) => {
          updatedUsers.push(data);
          return data;
        }),
      },
      passwordResetToken: {
        update: jest.fn(async ({ where, data }) => {
          const rec = resetRecords.find((r) => r.id === where.id);
          if (rec) rec.usedAt = data.usedAt;
          return rec;
        }),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
      refreshToken: {
        updateMany: jest.fn(async (args) => {
          revokedTokens.push(args);
          return { count: 2 };
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
      user: {
        count: jest.fn(async () => 1),
        create: jest.fn(),
        findFirst: jest.fn(async () => ({
          id: 'sa-1',
          name: 'Platform Admin',
          email: 'admin@autonex.in',
          phone: '+919999999999',
          passwordHash: oldHash,
          isActive: true,
          isSuperAdmin: true,
          deletedAt: null,
          memberships: [],
        })),
      },
      passwordResetToken: {
        updateMany: jest.fn(async () => ({ count: 0 })),
        create: jest.fn(async ({ data }) => {
          const rec = { id: 'prt-1', ...data, usedAt: null };
          resetRecords.push(rec);
          return rec;
        }),
        findUnique: jest.fn(async ({ where }) => {
          const rec = resetRecords.find((r) => r.tokenHash === where.tokenHash);
          if (!rec) return null;
          return {
            ...rec,
            user: {
              id: 'sa-1',
              isActive: true,
              isSuperAdmin: true,
              deletedAt: null,
            },
          };
        }),
      },
      auditLog: {
        create: jest.fn(async ({ data }) => {
          auditCreates.push(data);
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

    const authService = new AuthService(prismaMock, jwtService, configService, new TenantContextService());

    // Idempotent bootstrap does not create duplicate super admins when count > 0
    await authService.ensureInitialSuperAdminFromEnv();
    expect(adminDbMock.user.create).not.toHaveBeenCalled();

    const reqRes = await authService.requestSuperAdminPasswordReset({
      identifier: 'admin@autonex.in',
    });
    expect(reqRes.ok).toBe(true);
    expect(resetRecords).toHaveLength(1);
    expect(auditCreates.some((a) => a.action === 'SUPER_ADMIN_PASSWORD_RESET_REQUESTED')).toBe(true);

    // Seed a known raw token hash to verify consumption
    const rawToken = 'reset_token_value_min_32_characters_secure_001';
    resetRecords[0]!.tokenHash = sha256Hex(rawToken);

    const resetRes = await authService.resetSuperAdminPassword({
      token: rawToken,
      newPassword: 'BrandNewPassword123!',
    });
    expect(resetRes.ok).toBe(true);
    expect(updatedUsers[0]?.failedLoginAttempts).toBe(0);
    expect(updatedUsers[0]?.passwordHash).toContain('$argon2id$');
    expect(revokedTokens).toHaveLength(1);
    expect(auditCreates.some((a) => a.action === 'SUPER_ADMIN_PASSWORD_RESET_COMPLETED')).toBe(true);
  });

  it('flags requiresPasswordChange for initial dev Super Admin credentials in dev and blocks them in production', async () => {
    const devHash = await hashPassword('demo123');
    const devUser = {
      id: 'sa-dev-1',
      name: 'Platform Admin',
      email: 'demo@autonex.com',
      phone: '+919999999999',
      passwordHash: devHash,
      passwordChangedAt: null,
      isActive: true,
      isSuperAdmin: true,
      deletedAt: null,
      failedLoginAttempts: 0,
      lockedUntil: null,
      memberships: [],
    };

    const adminDbMock = {
      user: {
        findFirst: jest.fn(async () => devUser),
        update: jest.fn(async ({ data }) => ({ ...devUser, ...data })),
      },
      refreshToken: { create: jest.fn(async ({ data }) => data) },
      auditLog: { create: jest.fn(async ({ data }) => data) },
    };

    const prismaMock = {
      runAsSystemAdmin: jest.fn(async (cb: (db: typeof adminDbMock) => Promise<unknown>) =>
        cb(adminDbMock),
      ),
    } as unknown as PrismaService;

    const devAuth = new AuthService(prismaMock, jwtService, configService, new TenantContextService());
    const devRes = await devAuth.superAdminLogin({ identifier: 'demo@autonex.com', password: 'demo123' });
    expect((devRes.user as { requiresPasswordChange?: boolean }).requiresPasswordChange).toBe(true);

    const prodConfigService = {
      get: (key: string) =>
        key === 'NODE_ENV' ? 'production' : (configService as unknown as { get: (k: string) => unknown }).get(key),
    } as unknown as ConfigService;

    const prodAuth = new AuthService(prismaMock, jwtService, prodConfigService, new TenantContextService());
    await expect(
      prodAuth.superAdminLogin({ identifier: 'demo@autonex.com', password: 'demo123' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

