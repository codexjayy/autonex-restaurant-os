import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { StaffRole as PrismaStaffRole, TenantStatus as PrismaTenantStatus } from '@prisma/client';
import {
  ActorRole,
  ErrorCode,
  StaffRole,
  SYSTEM_ROLE_SUPER_ADMIN,
  TenantStatus,
} from '@autonex/shared';
import { randomBytes, randomUUID } from 'node:crypto';
import { TenantContextService } from '../../common/context/tenant-context.service';
import { AuthenticatedPrincipal } from '../../common/decorators/current-user.decorator';
import { AccessJwtPayload } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../common/prisma/prisma.service';
import { generateOpaqueToken, hashSecret, sha256Hex, verifySecret } from '../../common/security/crypto.util';
import { CreateStaffDto, UpdateStaffDto } from './dto/create-staff.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterRestaurantDto } from './dto/register-restaurant.dto';
import { StaffPinLoginDto } from './dto/staff-pin-login.dto';

const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private buildSlug(name: string): string {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    const suffix = randomBytes(2).toString('hex');
    return `${base || 'restaurant'}-${suffix}`;
  }

  private async issueTokens(params: {
    userId: string;
    tenantId?: string;
    outletId?: string;
    membershipId?: string;
    role: ActorRole;
    isSuperAdmin: boolean;
    tenantStatus?: TenantStatus;
    familyId?: string;
  }): Promise<TokenPair> {
    const payload: AccessJwtPayload = {
      sub: params.userId,
      tenantId: params.tenantId,
      outletId: params.outletId,
      membershipId: params.membershipId,
      role: params.role,
      isSuperAdmin: params.isSuperAdmin,
      tenantStatus: params.tenantStatus,
    };

    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.configService.get<string>('JWT_ACCESS_TTL') ?? '15m',
    });

    const rawRefreshToken = generateOpaqueToken(48);
    const tokenHash = sha256Hex(rawRefreshToken);
    const refreshDays = Number(this.configService.get<number>('JWT_REFRESH_TTL_DAYS') ?? 7);
    const expiresAt = new Date(Date.now() + refreshDays * 24 * 60 * 60 * 1000);
    const familyId = params.familyId ?? randomUUID();

    await this.prisma.runAsSystemAdmin((db) =>
      db.refreshToken.create({
        data: {
          tenantId: params.tenantId ?? null,
          userId: params.userId,
          familyId,
          tokenHash,
          expiresAt,
        },
      }),
    );

    return { accessToken, refreshToken: rawRefreshToken };
  }

  async registerRestaurant(dto: RegisterRestaurantDto) {
    const emailNormalized = dto.email.trim().toLowerCase();
    const phoneNormalized = dto.phone.trim();
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    const result = await this.prisma.runAsSystemAdmin(async (db) => {
      const existing = await db.user.findFirst({
        where: { OR: [{ email: emailNormalized }, { phone: phoneNormalized }] },
      });
      if (existing) {
        throw new ConflictException({
          code: ErrorCode.CONFLICT,
          message: 'A user with this email or phone is already registered.',
        });
      }

      const passwordHash = hashSecret(dto.password);
      const pinHash = hashSecret(dto.pin);
      const slug = this.buildSlug(dto.restaurantName);

      return db.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
          data: {
            name: dto.restaurantName.trim(),
            slug,
            status: PrismaTenantStatus.PENDING_APPROVAL,
          },
        });

        const outlet = await tx.outlet.create({
          data: {
            tenantId: tenant.id,
            name: dto.outletName.trim(),
            contactPhone: phoneNormalized,
            address: dto.address?.trim() ?? null,
            logoUrl: dto.logoUrl ?? null,
            timezone: dto.timezone?.trim() || 'Asia/Kolkata',
            gstin: dto.gstin?.trim() ?? null,
            gstRateBps: dto.gstRateBps ?? 500,
          },
        });

        const user = await tx.user.create({
          data: {
            name: dto.ownerName.trim(),
            email: emailNormalized,
            phone: phoneNormalized,
            passwordHash,
            isSuperAdmin: false,
            mfaEnabled: false,
          },
        });

        const membership = await tx.membership.create({
          data: {
            tenantId: tenant.id,
            outletId: outlet.id,
            userId: user.id,
            role: PrismaStaffRole.OWNER,
            staffPinHash: pinHash,
          },
        });

        const starterPlan = await tx.plan?.findFirst?.({
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
        });
        if (starterPlan && tx.subscription?.create) {
          const now = new Date();
          const trialEndsAt = new Date(
            now.getTime() + starterPlan.trialDays * 24 * 60 * 60 * 1000,
          );
          const graceEndsAt = new Date(
            trialEndsAt.getTime() + starterPlan.graceDays * 24 * 60 * 60 * 1000,
          );
          await tx.subscription.create({
            data: {
              tenantId: tenant.id,
              planId: starterPlan.id,
              status: 'TRIAL',
              billingCycle: 'MONTHLY',
              startedAt: now,
              currentPeriodStart: now,
              currentPeriodEnd: trialEndsAt,
              trialEndsAt,
              graceEndsAt,
            },
          });
        }

        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            actorUserId: user.id,
            actorRole: StaffRole.OWNER,
            action: 'RESTAURANT_REGISTERED',
            entityType: 'Tenant',
            entityId: tenant.id,
            afterJson: {
              tenantName: tenant.name,
              outletName: outlet.name,
              status: tenant.status,
            },
            ipAddress,
          },
        });

        return { tenant, outlet, user, membership };
      });
    });

    const tokens = await this.issueTokens({
      userId: result.user.id,
      tenantId: result.tenant.id,
      outletId: result.outlet.id,
      membershipId: result.membership.id,
      role: StaffRole.OWNER,
      isSuperAdmin: false,
      tenantStatus: result.tenant.status as unknown as TenantStatus,
    });

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tenant: {
        id: result.tenant.id,
        name: result.tenant.name,
        slug: result.tenant.slug,
        status: result.tenant.status,
      },
      outlet: {
        id: result.outlet.id,
        name: result.outlet.name,
        timezone: result.outlet.timezone,
      },
      user: {
        id: result.user.id,
        name: result.user.name,
        email: result.user.email,
        phone: result.user.phone,
        role: StaffRole.OWNER,
      },
      onboardingChecklist: {
        profileComplete: Boolean(result.outlet.address),
        adminApproved: false,
        menuConfigured: false,
        tablesConfigured: false,
        qrGenerated: false,
        staffAdded: false,
      },
    };
  }

  async login(dto: LoginDto) {
    const identifier = dto.identifier.trim();
    const isEmail = identifier.includes('@');

    const user = await this.prisma.runAsSystemAdmin((db) =>
      db.user.findFirst({
        where: {
          ...(isEmail ? { email: identifier.toLowerCase() } : { phone: identifier }),
          isActive: true,
        },
        include: {
          memberships: {
            where: { isActive: true },
            include: { tenant: true, outlet: true },
          },
        },
      }),
    );

    if (!user || !user.passwordHash || !verifySecret(dto.password, user.passwordHash)) {
      throw new UnauthorizedException({
        code: ErrorCode.INVALID_CREDENTIALS,
        message: 'Invalid email/phone or password.',
      });
    }

    if (user.isSuperAdmin && user.memberships.length === 0) {
      const tokens = await this.issueTokens({
        userId: user.id,
        role: SYSTEM_ROLE_SUPER_ADMIN,
        isSuperAdmin: true,
      });

      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          role: SYSTEM_ROLE_SUPER_ADMIN,
          isSuperAdmin: true,
          mfaEnabled: user.mfaEnabled,
        },
        memberships: [],
      };
    }

    const activeMembership = dto.outletId
      ? user.memberships.find((m) => m.outletId === dto.outletId)
      : user.memberships[0];

    if (!activeMembership) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'No active restaurant membership found for this account.',
      });
    }

    if (activeMembership.tenant.status === PrismaTenantStatus.SUSPENDED) {
      throw new ForbiddenException({
        code: ErrorCode.TENANT_SUSPENDED,
        message: 'Restaurant account is suspended.',
      });
    }

    const tokens = await this.issueTokens({
      userId: user.id,
      tenantId: activeMembership.tenantId,
      outletId: activeMembership.outletId,
      membershipId: activeMembership.id,
      role: activeMembership.role as unknown as StaffRole,
      isSuperAdmin: user.isSuperAdmin,
      tenantStatus: activeMembership.tenant.status as unknown as TenantStatus,
    });

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: activeMembership.role,
        tenantId: activeMembership.tenantId,
        outletId: activeMembership.outletId,
        tenantStatus: activeMembership.tenant.status,
        mfaEnabled: user.mfaEnabled,
      },
      memberships: user.memberships.map((m) => ({
        membershipId: m.id,
        tenantId: m.tenantId,
        tenantName: m.tenant.name,
        tenantStatus: m.tenant.status,
        outletId: m.outletId,
        outletName: m.outlet.name,
        role: m.role,
      })),
    };
  }

  async staffPinLogin(dto: StaffPinLoginDto) {
    const membership = await this.prisma.runAsSystemAdmin((db) =>
      db.membership.findFirst({
        where: {
          outletId: dto.outletId,
          isActive: true,
          user: { phone: dto.phone.trim(), isActive: true },
        },
        include: { user: true, tenant: true, outlet: true },
      }),
    );

    if (!membership) {
      throw new UnauthorizedException({
        code: ErrorCode.INVALID_CREDENTIALS,
        message: 'Invalid outlet, phone, or PIN.',
      });
    }

    if (membership.tenant.status === PrismaTenantStatus.SUSPENDED) {
      throw new ForbiddenException({
        code: ErrorCode.TENANT_SUSPENDED,
        message: 'Restaurant account is suspended.',
      });
    }

    if (membership.lockedUntil && membership.lockedUntil > new Date()) {
      throw new ForbiddenException({
        code: ErrorCode.STAFF_PIN_LOCKED,
        message: 'Staff PIN temporarily locked due to repeated failed attempts.',
      });
    }

    const isPinValid = verifySecret(dto.pin, membership.staffPinHash);
    if (!isPinValid) {
      const nextAttempts = membership.failedAttempts + 1;
      const shouldLock = nextAttempts >= MAX_PIN_ATTEMPTS;

      await this.prisma.runAsSystemAdmin((db) =>
        db.membership.update({
          where: { id: membership.id },
          data: {
            failedAttempts: nextAttempts,
            lockedUntil: shouldLock
              ? new Date(Date.now() + PIN_LOCK_MINUTES * 60 * 1000)
              : null,
          },
        }),
      );

      throw new UnauthorizedException({
        code: shouldLock ? ErrorCode.STAFF_PIN_LOCKED : ErrorCode.INVALID_CREDENTIALS,
        message: shouldLock
          ? 'Too many invalid PIN attempts. Locked for 15 minutes.'
          : 'Invalid outlet, phone, or PIN.',
      });
    }

    if (membership.failedAttempts > 0 || membership.lockedUntil) {
      await this.prisma.runAsSystemAdmin((db) =>
        db.membership.update({
          where: { id: membership.id },
          data: { failedAttempts: 0, lockedUntil: null },
        }),
      );
    }

    const tokens = await this.issueTokens({
      userId: membership.userId,
      tenantId: membership.tenantId,
      outletId: membership.outletId,
      membershipId: membership.id,
      role: membership.role as unknown as StaffRole,
      isSuperAdmin: false,
      tenantStatus: membership.tenant.status as unknown as TenantStatus,
    });

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      membership: {
        id: membership.id,
        tenantId: membership.tenantId,
        outletId: membership.outletId,
        outletName: membership.outlet.name,
        role: membership.role,
        userName: membership.user.name,
      },
    };
  }

  async refresh(rawToken: string) {
    if (!rawToken) {
      throw new UnauthorizedException({
        code: ErrorCode.UNAUTHORIZED,
        message: 'Missing refresh token.',
      });
    }

    const tokenHash = sha256Hex(rawToken);
    const existing = await this.prisma.runAsSystemAdmin((db) =>
      db.refreshToken.findUnique({
        where: { tokenHash },
        include: {
          user: {
            include: {
              memberships: {
                where: { isActive: true },
                include: { tenant: true },
              },
            },
          },
        },
      }),
    );

    if (!existing) {
      throw new UnauthorizedException({
        code: ErrorCode.UNAUTHORIZED,
        message: 'Invalid refresh token.',
      });
    }

    // Reuse detection: revoke entire token family immediately
    if (existing.revokedAt !== null) {
      await this.prisma.runAsSystemAdmin((db) =>
        db.refreshToken.updateMany({
          where: { familyId: existing.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      );
      throw new UnauthorizedException({
        code: ErrorCode.REFRESH_TOKEN_REUSED,
        message: 'Refresh token reuse detected. Please log in again.',
      });
    }

    if (existing.expiresAt <= new Date() || !existing.user.isActive) {
      throw new UnauthorizedException({
        code: ErrorCode.UNAUTHORIZED,
        message: 'Expired refresh token.',
      });
    }

    await this.prisma.runAsSystemAdmin((db) =>
      db.refreshToken.update({
        where: { id: existing.id },
        data: { revokedAt: new Date() },
      }),
    );

    const activeMembership = existing.tenantId
      ? existing.user.memberships.find((m) => m.tenantId === existing.tenantId)
      : undefined;

    if (existing.tenantId && (!activeMembership || activeMembership.tenant.status === PrismaTenantStatus.SUSPENDED)) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Tenant access revoked or suspended.',
      });
    }

    return this.issueTokens({
      userId: existing.userId,
      tenantId: existing.tenantId ?? undefined,
      outletId: activeMembership?.outletId,
      membershipId: activeMembership?.id,
      role: activeMembership
        ? (activeMembership.role as unknown as StaffRole)
        : SYSTEM_ROLE_SUPER_ADMIN,
      isSuperAdmin: existing.user.isSuperAdmin,
      tenantStatus: activeMembership
        ? (activeMembership.tenant.status as unknown as TenantStatus)
        : undefined,
      familyId: existing.familyId,
    });
  }

  async logout(rawToken?: string) {
    if (!rawToken) return { ok: true };
    const tokenHash = sha256Hex(rawToken);
    await this.prisma.runAsSystemAdmin((db) =>
      db.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
    return { ok: true };
  }

  async getMe(principal: AuthenticatedPrincipal) {
    const user = await this.prisma.runAsSystemAdmin((db) =>
      db.user.findUnique({
        where: { id: principal.userId },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          isSuperAdmin: true,
          mfaEnabled: true,
        },
      }),
    );

    if (!user) {
      throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'User not found' });
    }

    return {
      ...user,
      tenantId: principal.tenantId,
      outletId: principal.outletId,
      membershipId: principal.membershipId,
      role: principal.role,
      tenantStatus: principal.tenantStatus,
    };
  }

  async listStaff(principal: AuthenticatedPrincipal) {
    return this.prisma.runInTenantTx(async (tx) => {
      const memberships = await tx.membership.findMany({
        where: { outletId: principal.outletId },
        include: {
          user: { select: { id: true, name: true, phone: true, email: true } },
        },
        orderBy: { createdAt: 'asc' },
      });

      return memberships.map((m) => ({
        membershipId: m.id,
        userId: m.userId,
        name: m.user.name,
        phone: m.user.phone,
        email: m.user.email,
        role: m.role,
        isActive: m.isActive,
        lockedUntil: m.lockedUntil,
      }));
    }, principal.tenantId);
  }

  async createStaff(principal: AuthenticatedPrincipal, dto: CreateStaffDto) {
    if (principal.role === StaffRole.MANAGER && dto.role === StaffRole.OWNER) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Managers cannot create Owner accounts.',
      });
    }
    if (!principal.tenantId || !principal.outletId) {
      throw new ForbiddenException({
        code: ErrorCode.TENANT_CONTEXT_MISSING,
        message: 'Active outlet context required.',
      });
    }

    const phone = dto.phone.trim();
    const pinHash = hashSecret(dto.pin);
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    // Ensure global user exists before entering strict tenant RLS transaction
    const user = await this.prisma.runAsSystemAdmin(async (db) => {
      const existing = await db.user.findUnique({ where: { phone } });
      if (existing) return existing;
      return db.user.create({
        data: {
          name: dto.name.trim(),
          phone,
          isSuperAdmin: false,
        },
      });
    });

    return this.prisma.runInTenantTx(async (tx) => {
      const duplicate = await tx.membership.findFirst({
        where: { outletId: principal.outletId, userId: user.id },
      });
      if (duplicate) {
        throw new ConflictException({
          code: ErrorCode.CONFLICT,
          message: 'This phone number already belongs to a staff member in this outlet.',
        });
      }

      const created = await tx.membership.create({
        data: {
          tenantId: principal.tenantId!,
          outletId: principal.outletId!,
          userId: user.id,
          role: dto.role as unknown as PrismaStaffRole,
          staffPinHash: pinHash,
          isActive: true,
        },
      });

      await tx.auditLog.create({
        data: {
          tenantId: principal.tenantId!,
          actorUserId: principal.userId,
          actorRole: principal.role,
          action: 'STAFF_CREATED',
          entityType: 'Membership',
          entityId: created.id,
          afterJson: { phone, role: created.role },
          ipAddress,
        },
      });

      return {
        membershipId: created.id,
        userId: user.id,
        name: user.name,
        phone: user.phone,
        role: created.role,
        isActive: created.isActive,
      };
    }, principal.tenantId);
  }

  async updateStaff(
    principal: AuthenticatedPrincipal,
    membershipId: string,
    dto: UpdateStaffDto,
  ) {
    if (principal.role === StaffRole.MANAGER && dto.role === StaffRole.OWNER) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Managers cannot promote users to Owner.',
      });
    }
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runInTenantTx(async (tx) => {
      const target = await tx.membership.findFirst({
        where: { id: membershipId, outletId: principal.outletId },
      });
      if (!target) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Staff membership not found.',
        });
      }
      if (principal.role === StaffRole.MANAGER && target.role === PrismaStaffRole.OWNER) {
        throw new ForbiddenException({
          code: ErrorCode.FORBIDDEN,
          message: 'Managers cannot modify Owner accounts.',
        });
      }

      const updated = await tx.membership.update({
        where: { id: target.id },
        data: {
          ...(dto.role ? { role: dto.role as unknown as PrismaStaffRole } : {}),
          ...(dto.pin ? { staffPinHash: hashSecret(dto.pin), failedAttempts: 0, lockedUntil: null } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });

      await tx.auditLog.create({
        data: {
          tenantId: principal.tenantId!,
          actorUserId: principal.userId,
          actorRole: principal.role,
          action: 'STAFF_UPDATED',
          entityType: 'Membership',
          entityId: target.id,
          beforeJson: { role: target.role, isActive: target.isActive },
          afterJson: { role: updated.role, isActive: updated.isActive, pinRotated: Boolean(dto.pin) },
          ipAddress,
        },
      });

      return {
        membershipId: updated.id,
        role: updated.role,
        isActive: updated.isActive,
      };
    }, principal.tenantId);
  }
}

