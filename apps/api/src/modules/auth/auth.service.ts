import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  InvitationStatus as PrismaInvitationStatus,
  StaffRole as PrismaStaffRole,
  TenantStatus as PrismaTenantStatus,
} from '@prisma/client';
import { getPermissionsForRole } from '@autonex/permissions';
import {
  ActorRole,
  ErrorCode,
  InvitationStatus,
  StaffRole,
  SYSTEM_ROLE_SUPER_ADMIN,
  TenantStatus,
} from '@autonex/shared';
import { randomBytes, randomUUID } from 'node:crypto';
import { TenantContextService } from '../../common/context/tenant-context.service';
import { AuthenticatedPrincipal } from '../../common/decorators/current-user.decorator';
import { AccessJwtPayload } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OnboardingJobsService } from '../../common/queue/onboarding-jobs.service';
import {
  generateOpaqueToken,
  hashPassword,
  hashSecret,
  needsRehash,
  safeEqualStrings,
  sha256Hex,
  verifyPassword,
  verifySecret,
} from '../../common/security/crypto.util';
import { CreateStaffDto, UpdateStaffDto } from './dto/create-staff.dto';
import { LoginDto } from './dto/login.dto';
import {
  AcceptInvitationDto,
  CreateInvitationDto,
  UpdateProfileDto,
} from './dto/milestone1-auth.dto';
import { RegisterRestaurantDto } from './dto/register-restaurant.dto';
import { StaffPinLoginDto } from './dto/staff-pin-login.dto';
import {
  ChangePasswordDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  SuperAdminSetupDto,
} from './dto/super-admin-auth.dto';

const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCK_MINUTES = 15;
const PASSWORD_RESET_TTL_MINUTES = 15;
const INVITATION_TTL_DAYS = 7;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly tenantContext: TenantContextService,
    @Optional() private readonly onboardingJobs?: OnboardingJobsService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) {
      return;
    }
    try {
      await this.ensureInitialSuperAdminFromEnv();
    } catch (err) {
      this.logger.warn(
        `Super Admin bootstrap skipped on startup: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private normalizePhone(rawPhone: string): string {
    const cleaned = rawPhone.trim().replace(/[\s()-]/g, '');
    if (cleaned.startsWith('+')) return cleaned;
    if (/^[6-9]\d{9}$/.test(cleaned)) return `+91${cleaned}`;
    if (/^\d{10,15}$/.test(cleaned)) return `+${cleaned}`;
    return cleaned;
  }

  private buildPhoneLookupCandidates(rawPhone: string): string[] {
    const trimmed = rawPhone.trim();
    const cleaned = trimmed.replace(/[\s()-]/g, '');
    const candidates = new Set<string>();
    if (trimmed) candidates.add(trimmed);
    if (cleaned) candidates.add(cleaned);
    if (/^[6-9]\d{9}$/.test(cleaned)) {
      candidates.add(`+91${cleaned}`);
      candidates.add(`91${cleaned}`);
    } else if (/^91[6-9]\d{9}$/.test(cleaned)) {
      candidates.add(`+${cleaned}`);
      candidates.add(cleaned.slice(2));
    } else if (/^\+91[6-9]\d{9}$/.test(cleaned)) {
      candidates.add(cleaned.slice(3));
      candidates.add(cleaned.slice(1));
    } else if (/^\d{10,15}$/.test(cleaned)) {
      candidates.add(`+${cleaned}`);
    }
    return Array.from(candidates);
  }

  private async recordAuthAudit(params: {
    actorUserId: string;
    actorRole: string;
    action: string;
    tenantId?: string | null;
    entityId?: string | null;
    afterJson?: Record<string, unknown>;
    ipAddress?: string | null;
  }) {
    try {
      await this.prisma.runAsSystemAdmin((db) =>
        db.auditLog?.create?.({
          data: {
            tenantId: params.tenantId ?? null,
            actorUserId: params.actorUserId,
            actorRole: params.actorRole,
            action: params.action,
            entityType: 'User',
            entityId: params.entityId ?? params.actorUserId,
            afterJson: (params.afterJson ?? {}) as unknown as never,
            ipAddress: params.ipAddress ?? null,
          },
        }),
      );
    } catch {
      // Do not fail auth flow if mocked unit DB omits auditLog
    }
  }

  /**
   * Idempotently initializes the very first SUPER_ADMIN from environment variables
   * only when no active Super Admin account exists yet (never creates duplicates).
   */
  async ensureInitialSuperAdminFromEnv(): Promise<void> {
    if (!this.prisma?.runAsSystemAdmin) return;

    const email = (this.configService?.get<string>('SUPER_ADMIN_EMAIL') ?? '').trim().toLowerCase();
    const rawPhone = (this.configService?.get<string>('SUPER_ADMIN_PHONE') ?? '+919999999999').trim();
    const name = (this.configService?.get<string>('SUPER_ADMIN_NAME') ?? 'Platform Admin').trim();
    const password = this.configService?.get<string>('SUPER_ADMIN_PASSWORD') ?? '';

    const isProd = this.configService?.get<string>('NODE_ENV') === 'production';
    const minLen = isProd ? 10 : 6;
    if (!email || !password || password.length < minLen) {
      return;
    }
    if (isProd && password === 'demo123') {
      this.logger.warn(
        'Refusing to bootstrap Super Admin with development default password in production.',
      );
      return;
    }

    const phone = this.normalizePhone(rawPhone);

    await this.prisma.runAsSystemAdmin(async (db) => {
      const existingCount = await db.user?.count?.({
        where: { isSuperAdmin: true, deletedAt: null },
      });
      if ((existingCount ?? 0) > 0) {
        return;
      }

      const passwordHash = await hashPassword(password);
      const existingByContact = await db.user?.findFirst?.({
        where: { OR: [{ email }, { phone }] },
      });

      const adminUser = existingByContact
        ? await db.user.update({
            where: { id: existingByContact.id },
            data: {
              name,
              email,
              phone,
              passwordHash,
              isSuperAdmin: true,
              isActive: true,
              deletedAt: null,
              failedLoginAttempts: 0,
              lockedUntil: null,
            },
          })
        : await db.user.create({
            data: {
              name,
              email,
              phone,
              passwordHash,
              isSuperAdmin: true,
              isActive: true,
            },
          });

      await db.auditLog?.create?.({
        data: {
          tenantId: null,
          actorUserId: adminUser.id,
          actorRole: SYSTEM_ROLE_SUPER_ADMIN,
          action: 'SUPER_ADMIN_BOOTSTRAPPED',
          entityType: 'User',
          entityId: adminUser.id,
          afterJson: { email, phone },
        },
      });
      this.logger.log(`Initialized initial Super Admin account (${email})`);
    });
  }

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
    ipAddress?: string;
    userAgent?: string;
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

    await this.prisma.runAsSystemAdmin(async (db) => {
      await db.refreshToken.create({
        data: {
          tenantId: params.tenantId ?? null,
          userId: params.userId,
          familyId,
          tokenHash,
          expiresAt,
        },
      });
      const existingSession = await db.session?.findFirst?.({
        where: { familyId },
      });
      if (existingSession) {
        await db.session?.update?.({
          where: { id: existingSession.id },
          data: {
            lastActiveAt: new Date(),
            expiresAt,
            outletId: params.outletId ?? existingSession.outletId,
          },
        });
      } else {
        await db.session?.create?.({
          data: {
            tenantId: params.tenantId ?? null,
            outletId: params.outletId ?? null,
            userId: params.userId,
            familyId,
            expiresAt,
            ipAddress: params.ipAddress ?? null,
            userAgent: params.userAgent ? params.userAgent.slice(0, 300) : null,
          },
        });
      }
    });

    return { accessToken, refreshToken: rawRefreshToken };
  }

  async registerRestaurant(dto: RegisterRestaurantDto, meta?: RequestMeta) {
    const emailNormalized = dto.email.trim().toLowerCase();
    const phoneNormalized = dto.phone.trim();
    const ipAddress = meta?.ipAddress ?? this.tenantContext.get()?.ipAddress ?? null;

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

        await tx.tenantSettings?.create?.({
          data: {
            tenantId: tenant.id,
            currency: dto.currency?.trim() || 'INR',
            locale: dto.locale?.trim() || 'en-IN',
            defaultTimezone: dto.timezone?.trim() || 'Asia/Kolkata',
            onboardingCompleted: false,
            onboardingStep: 1,
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

        await tx.outletSettings?.create?.({
          data: {
            tenantId: tenant.id,
            outletId: outlet.id,
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

        const ownerRole = await tx.role?.findFirst?.({
          where: { tenantId: null, code: PrismaStaffRole.OWNER },
        });

        const membership = await tx.membership.create({
          data: {
            tenantId: tenant.id,
            outletId: outlet.id,
            userId: user.id,
            role: PrismaStaffRole.OWNER,
            ...(ownerRole ? { roleId: ownerRole.id } : {}),
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
      ipAddress: ipAddress ?? undefined,
      userAgent: meta?.userAgent,
    });

    await this.onboardingJobs?.enqueueWelcomeJob({
      tenantId: result.tenant.id,
      tenantName: result.tenant.name,
      outletId: result.outlet.id,
      ownerUserId: result.user.id,
      ownerEmail: result.user.email,
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
        permissions: getPermissionsForRole(StaffRole.OWNER),
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

  private async findActiveUserByIdentifier(identifier: string) {
    const trimmed = identifier.trim();
    const isEmail = trimmed.includes('@');
    const phoneCandidates = isEmail ? [] : this.buildPhoneLookupCandidates(trimmed);

    return this.prisma.runAsSystemAdmin((db) =>
      db.user.findFirst({
        where: {
          ...(isEmail ? { email: trimmed.toLowerCase() } : { phone: { in: phoneCandidates } }),
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
  }

  private async authenticatePasswordLogin(
    dto: LoginDto,
    meta?: RequestMeta,
    options: { requireSuperAdmin?: boolean } = {},
  ) {
    const user = await this.findActiveUserByIdentifier(dto.identifier);

    if (!user || user.deletedAt || !user.passwordHash) {
      throw new UnauthorizedException({
        code: ErrorCode.INVALID_CREDENTIALS,
        message: 'Invalid email/phone or password.',
      });
    }

    const now = new Date();
    if (user.lockedUntil && user.lockedUntil > now) {
      const remainingMinutes = Math.max(
        1,
        Math.ceil((user.lockedUntil.getTime() - now.getTime()) / (60 * 1000)),
      );
      await this.recordAuthAudit({
        actorUserId: user.id,
        actorRole: user.isSuperAdmin ? SYSTEM_ROLE_SUPER_ADMIN : StaffRole.OWNER,
        action: user.isSuperAdmin ? 'SUPER_ADMIN_LOGIN_BLOCKED_LOCKED' : 'USER_LOGIN_BLOCKED_LOCKED',
        afterJson: {
          lockedUntil: user.lockedUntil.toISOString(),
          portal: options.requireSuperAdmin ? 'SUPER_ADMIN' : 'STANDARD',
        },
        ipAddress: meta?.ipAddress,
      });
      throw new ForbiddenException({
        code: ErrorCode.ACCOUNT_LOCKED,
        message: `Account temporarily locked due to repeated failed login attempts. Try again in ${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'} or reset your password.`,
      });
    }

    const validPassword = await verifyPassword(dto.password, user.passwordHash);
    if (!validPassword) {
      const nextAttempts = (user.failedLoginAttempts ?? 0) + 1;
      const shouldLock = nextAttempts >= MAX_LOGIN_ATTEMPTS;
      const lockedUntil = shouldLock
        ? new Date(now.getTime() + LOGIN_LOCK_MINUTES * 60 * 1000)
        : null;

      await this.prisma.runAsSystemAdmin((db) =>
        db.user?.update?.({
          where: { id: user.id },
          data: {
            failedLoginAttempts: nextAttempts,
            lockedUntil,
          },
        }),
      );

      await this.recordAuthAudit({
        actorUserId: user.id,
        actorRole: user.isSuperAdmin ? SYSTEM_ROLE_SUPER_ADMIN : StaffRole.OWNER,
        action: shouldLock
          ? user.isSuperAdmin
            ? 'SUPER_ADMIN_LOGIN_LOCKED'
            : 'USER_LOGIN_LOCKED'
          : user.isSuperAdmin
            ? 'SUPER_ADMIN_LOGIN_FAILED'
            : 'USER_LOGIN_FAILED',
        afterJson: {
          attempts: nextAttempts,
          lockedUntil: lockedUntil?.toISOString() ?? null,
          portal: options.requireSuperAdmin ? 'SUPER_ADMIN' : 'STANDARD',
        },
        ipAddress: meta?.ipAddress,
      });

      if (shouldLock) {
        throw new ForbiddenException({
          code: ErrorCode.ACCOUNT_LOCKED,
          message: `Too many failed login attempts. Account locked for ${LOGIN_LOCK_MINUTES} minutes.`,
        });
      }

      throw new UnauthorizedException({
        code: ErrorCode.INVALID_CREDENTIALS,
        message: `Invalid email/phone or password. ${MAX_LOGIN_ATTEMPTS - nextAttempts} attempt(s) remaining before temporary lock.`,
      });
    }

    const activeMemberships = (user.memberships ?? []).filter(
      (m) => !m.deletedAt && !m.outlet?.deletedAt && !m.tenant?.deletedAt,
    );

    if (options.requireSuperAdmin && !user.isSuperAdmin) {
      const deniedRole = activeMemberships[0]?.role ?? 'USER';
      await this.recordAuthAudit({
        actorUserId: user.id,
        actorRole: deniedRole,
        tenantId: activeMemberships[0]?.tenantId ?? null,
        action: 'SUPER_ADMIN_LOGIN_DENIED',
        afterJson: {
          identifier: dto.identifier.trim(),
          role: deniedRole,
        },
        ipAddress: meta?.ipAddress,
      });
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Access denied. Only AutoNex Super Administrators may sign in here.',
      });
    }

    const updateData: Record<string, unknown> = {
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: now,
    };
    if (needsRehash(user.passwordHash)) {
      updateData.passwordHash = await hashPassword(dto.password);
    }
    await this.prisma.runAsSystemAdmin((db) =>
      db.user?.update?.({
        where: { id: user.id },
        data: updateData as never,
      }),
    );

    if (user.isSuperAdmin && (options.requireSuperAdmin || activeMemberships.length === 0)) {
      const isProd = this.configService?.get<string>('NODE_ENV') === 'production';
      const requiresPasswordChange = !user.passwordChangedAt || dto.password.length < 10;

      if (isProd && (dto.password === 'demo123' || requiresPasswordChange)) {
        throw new ForbiddenException({
          code: ErrorCode.FORBIDDEN,
          message:
            'Initial development credentials cannot be used in production. Complete a strong password reset before signing in.',
        });
      }

      const tokens = await this.issueTokens({
        userId: user.id,
        role: SYSTEM_ROLE_SUPER_ADMIN,
        isSuperAdmin: true,
        ipAddress: meta?.ipAddress,
        userAgent: meta?.userAgent,
      });

      await this.recordAuthAudit({
        actorUserId: user.id,
        actorRole: SYSTEM_ROLE_SUPER_ADMIN,
        action: 'SUPER_ADMIN_LOGIN_SUCCESS',
        afterJson: {
          email: user.email,
          phone: user.phone,
          portal: options.requireSuperAdmin ? 'SUPER_ADMIN' : 'STANDARD',
          requiresPasswordChange,
        },
        ipAddress: meta?.ipAddress,
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
          requiresPasswordChange,
          mfaEnabled: user.mfaEnabled,
          permissions: getPermissionsForRole(SYSTEM_ROLE_SUPER_ADMIN),
        },
        memberships: [],
      };
    }

    const activeMembership = dto.outletId
      ? activeMemberships.find((m) => m.outletId === dto.outletId)
      : activeMemberships[0];

    if (!activeMembership) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'No active restaurant membership found for this account.',
      });
    }

    if (activeMembership.tenant.status === PrismaTenantStatus.REJECTED) {
      throw new ForbiddenException({
        code: ErrorCode.TENANT_REJECTED,
        message: 'Your restaurant registration has been rejected by AutoNex admin.',
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
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });

    await this.recordAuthAudit({
      actorUserId: user.id,
      actorRole: activeMembership.role,
      tenantId: activeMembership.tenantId,
      action: 'USER_LOGIN_SUCCESS',
      afterJson: { outletId: activeMembership.outletId },
      ipAddress: meta?.ipAddress,
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
        permissions: getPermissionsForRole(activeMembership.role as unknown as StaffRole),
      },
      memberships: activeMemberships.map((m) => ({
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

  async login(dto: LoginDto, meta?: RequestMeta) {
    return this.authenticatePasswordLogin(dto, meta, { requireSuperAdmin: false });
  }

  async superAdminLogin(dto: LoginDto, meta?: RequestMeta) {
    return this.authenticatePasswordLogin(dto, meta, { requireSuperAdmin: true });
  }

  async getSuperAdminSetupStatus() {
    const count = await this.prisma.runAsSystemAdmin(
      (db) =>
        db.user?.count?.({
          where: { isSuperAdmin: true, isActive: true, deletedAt: null },
        }) ?? Promise.resolve(0),
    );
    const requiresSetupToken = Boolean(
      this.configService?.get<string>('SUPER_ADMIN_SETUP_TOKEN')?.trim(),
    );
    return {
      initialized: count > 0,
      requiresSetupToken,
    };
  }

  async setupInitialSuperAdmin(dto: SuperAdminSetupDto, meta?: RequestMeta) {
    const configuredSetupToken = this.configService?.get<string>('SUPER_ADMIN_SETUP_TOKEN')?.trim();
    if (configuredSetupToken) {
      if (!dto.setupToken || !safeEqualStrings(dto.setupToken.trim(), configuredSetupToken)) {
        throw new ForbiddenException({
          code: ErrorCode.FORBIDDEN,
          message: 'Invalid or missing Super Admin setup token.',
        });
      }
    }

    const emailNormalized = dto.email.trim().toLowerCase();
    const phoneNormalized = this.normalizePhone(dto.phone);
    const passwordHash = await hashPassword(dto.password);

    const adminUser = await this.prisma.runAsSystemAdmin(async (db) => {
      const existingAdmins = await db.user.count({
        where: { isSuperAdmin: true, deletedAt: null },
      });
      if (existingAdmins > 0) {
        throw new ConflictException({
          code: ErrorCode.CONFLICT,
          message: 'Super Admin account is already initialized. Please sign in or use password reset.',
        });
      }

      const collision = await db.user.findFirst({
        where: { OR: [{ email: emailNormalized }, { phone: phoneNormalized }] },
      });
      if (collision) {
        throw new ConflictException({
          code: ErrorCode.CONFLICT,
          message: 'A user account with this email or phone already exists.',
        });
      }

      return db.user.create({
        data: {
          name: dto.name.trim(),
          email: emailNormalized,
          phone: phoneNormalized,
          passwordHash,
          isSuperAdmin: true,
          isActive: true,
        },
      });
    });

    await this.recordAuthAudit({
      actorUserId: adminUser.id,
      actorRole: SYSTEM_ROLE_SUPER_ADMIN,
      action: 'SUPER_ADMIN_SETUP_INITIALIZED',
      afterJson: { email: adminUser.email, phone: adminUser.phone },
      ipAddress: meta?.ipAddress,
    });

    const tokens = await this.issueTokens({
      userId: adminUser.id,
      role: SYSTEM_ROLE_SUPER_ADMIN,
      isSuperAdmin: true,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: adminUser.id,
        name: adminUser.name,
        email: adminUser.email,
        phone: adminUser.phone,
        role: SYSTEM_ROLE_SUPER_ADMIN,
        isSuperAdmin: true,
        mfaEnabled: adminUser.mfaEnabled,
        permissions: getPermissionsForRole(SYSTEM_ROLE_SUPER_ADMIN),
      },
    };
  }

  async requestSuperAdminPasswordReset(dto: ForgotPasswordDto, meta?: RequestMeta) {
    const user = await this.findActiveUserByIdentifier(dto.identifier);

    if (user && !user.deletedAt && user.isSuperAdmin) {
      const rawToken = generateOpaqueToken(24);
      const tokenHash = sha256Hex(rawToken);
      const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60 * 1000);
      const now = new Date();

      await this.prisma.runAsSystemAdmin(async (db) => {
        await db.passwordResetToken?.updateMany?.({
          where: { userId: user.id, usedAt: null },
          data: { usedAt: now },
        });
        await db.passwordResetToken?.create?.({
          data: {
            userId: user.id,
            tokenHash,
            expiresAt,
            ipAddress: meta?.ipAddress ?? null,
          },
        });
      });

      await this.recordAuthAudit({
        actorUserId: user.id,
        actorRole: SYSTEM_ROLE_SUPER_ADMIN,
        action: 'SUPER_ADMIN_PASSWORD_RESET_REQUESTED',
        afterJson: { expiresAt: expiresAt.toISOString() },
        ipAddress: meta?.ipAddress,
      });

      const appUrl =
        this.configService?.get<string>('APP_URL')?.replace(/\/+$/, '') || 'http://localhost:3000';
      if (process.env.NODE_ENV !== 'production') {
        this.logger.warn(
          `[SuperAdminReset] Reset token generated for ${user.email ?? user.phone}. Visit ${appUrl}/super-admin/reset-password?token=${rawToken}`,
        );
      }
    }

    return {
      ok: true,
      message:
        'If a matching active Super Admin account exists, password reset instructions have been dispatched.',
    };
  }

  async resetSuperAdminPassword(dto: ResetPasswordDto, meta?: RequestMeta) {
    const tokenHash = sha256Hex(dto.token.trim());
    const now = new Date();

    const resetRow = await this.prisma.runAsSystemAdmin((db) =>
      db.passwordResetToken?.findUnique?.({
        where: { tokenHash },
        include: { user: true },
      }),
    );

    if (
      !resetRow ||
      resetRow.usedAt ||
      resetRow.expiresAt <= now ||
      !resetRow.user ||
      resetRow.user.deletedAt ||
      !resetRow.user.isActive ||
      !resetRow.user.isSuperAdmin
    ) {
      throw new BadRequestException({
        code: ErrorCode.INVALID_RESET_TOKEN,
        message: 'Invalid or expired password reset token.',
      });
    }

    const newHash = await hashPassword(dto.newPassword);

    await this.prisma.runAsSystemAdmin((db) =>
      db.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: resetRow.userId },
          data: {
            passwordHash: newHash,
            passwordChangedAt: now,
            failedLoginAttempts: 0,
            lockedUntil: null,
          },
        });
        await tx.passwordResetToken.update({
          where: { id: resetRow.id },
          data: { usedAt: now },
        });
        await tx.refreshToken.updateMany({
          where: { userId: resetRow.userId, revokedAt: null },
          data: { revokedAt: now },
        });
        await tx.session?.updateMany?.({
          where: { userId: resetRow.userId, revokedAt: null },
          data: { revokedAt: now },
        });
        await tx.auditLog.create({
          data: {
            tenantId: null,
            actorUserId: resetRow.userId,
            actorRole: SYSTEM_ROLE_SUPER_ADMIN,
            action: 'SUPER_ADMIN_PASSWORD_RESET_COMPLETED',
            entityType: 'User',
            entityId: resetRow.userId,
            afterJson: { email: resetRow.user.email },
            ipAddress: meta?.ipAddress ?? null,
          },
        });
      }),
    );

    return {
      ok: true,
      message: 'Super Admin password updated successfully. Please sign in with your new password.',
    };
  }

  async changeSuperAdminPassword(
    principal: AuthenticatedPrincipal,
    dto: ChangePasswordDto,
    meta?: RequestMeta,
  ) {
    if (!principal.isSuperAdmin) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Super Admin privileges required.',
      });
    }

    const user = await this.prisma.runAsSystemAdmin((db) =>
      db.user.findUnique({ where: { id: principal.userId } }),
    );
    if (!user || user.deletedAt || !user.isActive || !user.passwordHash) {
      throw new UnauthorizedException({
        code: ErrorCode.UNAUTHORIZED,
        message: 'Super Admin account not found or inactive.',
      });
    }

    const matches = await verifyPassword(dto.currentPassword, user.passwordHash);
    if (!matches) {
      await this.recordAuthAudit({
        actorUserId: user.id,
        actorRole: SYSTEM_ROLE_SUPER_ADMIN,
        action: 'SUPER_ADMIN_PASSWORD_CHANGE_FAILED',
        afterJson: { reason: 'Incorrect current password' },
        ipAddress: meta?.ipAddress,
      });
      throw new UnauthorizedException({
        code: ErrorCode.INVALID_CREDENTIALS,
        message: 'Current password is incorrect.',
      });
    }

    const now = new Date();
    const newHash = await hashPassword(dto.newPassword);

    await this.prisma.runAsSystemAdmin((db) =>
      db.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: {
            passwordHash: newHash,
            passwordChangedAt: now,
            failedLoginAttempts: 0,
            lockedUntil: null,
          },
        });
        await tx.refreshToken.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: now },
        });
        await tx.session?.updateMany?.({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: now },
        });
        await tx.auditLog.create({
          data: {
            tenantId: null,
            actorUserId: user.id,
            actorRole: SYSTEM_ROLE_SUPER_ADMIN,
            action: 'SUPER_ADMIN_PASSWORD_CHANGED',
            entityType: 'User',
            entityId: user.id,
            afterJson: { email: user.email },
            ipAddress: meta?.ipAddress ?? null,
          },
        });
      }),
    );

    return {
      ok: true,
      message: 'Password updated successfully.',
    };
  }

  async staffPinLogin(dto: StaffPinLoginDto, meta?: RequestMeta) {
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

    if (membership.tenant.status === PrismaTenantStatus.REJECTED) {
      throw new ForbiddenException({
        code: ErrorCode.TENANT_REJECTED,
        message: 'Your restaurant registration has been rejected by AutoNex admin.',
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
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
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

  async refresh(rawToken: string, meta?: RequestMeta) {
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

    // Reuse detection: revoke entire token family and active user sessions immediately
    if (existing.revokedAt !== null) {
      await this.prisma.runAsSystemAdmin(async (db) => {
        await db.refreshToken.updateMany({
          where: { familyId: existing.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await db.session?.updateMany?.({
          where: { familyId: existing.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      });
      throw new UnauthorizedException({
        code: ErrorCode.REFRESH_TOKEN_REUSED,
        message: 'Refresh token reuse detected. Please log in again.',
      });
    }

    if (existing.expiresAt <= new Date() || !existing.user.isActive || existing.user.deletedAt) {
      throw new UnauthorizedException({
        code: ErrorCode.UNAUTHORIZED,
        message: 'Expired refresh token.',
      });
    }

    await this.prisma.runAsSystemAdmin(async (db) => {
      await db.refreshToken.update({
        where: { id: existing.id },
        data: { revokedAt: new Date() },
      });
    });

    const activeMembership = existing.tenantId
      ? existing.user.memberships.find((m) => m.tenantId === existing.tenantId && !m.deletedAt)
      : undefined;

    if (existing.tenantId && activeMembership?.tenant.status === PrismaTenantStatus.REJECTED) {
      throw new ForbiddenException({
        code: ErrorCode.TENANT_REJECTED,
        message: 'Restaurant registration has been rejected.',
      });
    }

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
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
  }

  async logout(rawToken?: string, principal?: AuthenticatedPrincipal, meta?: RequestMeta) {
    if (rawToken) {
      const tokenHash = sha256Hex(rawToken);
      let loggedUserId = principal?.userId;
      let loggedTenantId = principal?.tenantId ?? null;
      let isSuperAdmin = Boolean(principal?.isSuperAdmin);

      await this.prisma.runAsSystemAdmin(async (db) => {
        const tokenRow = await db.refreshToken.findUnique({ where: { tokenHash } });
        await db.refreshToken.updateMany({
          where: { tokenHash, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        if (tokenRow) {
          loggedUserId = loggedUserId ?? tokenRow.userId;
          loggedTenantId = loggedTenantId ?? tokenRow.tenantId ?? null;
          await db.session?.updateMany?.({
            where: { familyId: tokenRow.familyId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          if (!principal && tokenRow.userId) {
            const u = await db.user?.findUnique?.({
              where: { id: tokenRow.userId },
              select: { isSuperAdmin: true },
            });
            isSuperAdmin = Boolean(u?.isSuperAdmin);
          }
        }
      });

      if (loggedUserId) {
        await this.recordAuthAudit({
          actorUserId: loggedUserId,
          actorRole: isSuperAdmin ? SYSTEM_ROLE_SUPER_ADMIN : (principal?.role ?? StaffRole.OWNER),
          tenantId: loggedTenantId,
          action: isSuperAdmin ? 'SUPER_ADMIN_LOGOUT' : 'USER_LOGOUT',
          ipAddress: meta?.ipAddress,
        });
      }
      return { ok: true };
    }

    if (principal?.userId) {
      await this.prisma.runAsSystemAdmin(async (db) => {
        await db.session?.updateMany?.({
          where: { userId: principal.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      });
      await this.recordAuthAudit({
        actorUserId: principal.userId,
        actorRole: principal.isSuperAdmin ? SYSTEM_ROLE_SUPER_ADMIN : principal.role,
        tenantId: principal.tenantId ?? null,
        action: principal.isSuperAdmin ? 'SUPER_ADMIN_LOGOUT' : 'USER_LOGOUT',
        ipAddress: meta?.ipAddress,
      });
    }
    return { ok: true };
  }

  async getMe(principal: AuthenticatedPrincipal) {
    return this.getUserMe(principal);
  }

  async getUserMe(principal: AuthenticatedPrincipal) {
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
          passwordChangedAt: true,
          deletedAt: true,
          memberships: {
            where: { isActive: true },
            include: { tenant: true, outlet: true },
            orderBy: { createdAt: 'asc' },
          },
        },
      }),
    );

    if (!user || user.deletedAt) {
      throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'User not found' });
    }

    const activeMemberships = (user.memberships ?? []).filter(
      (m) => !m.deletedAt && !m.outlet?.deletedAt && !m.tenant?.deletedAt,
    );
    const currentMembership = principal.tenantId
      ? activeMemberships.find((m) => m.tenantId === principal.tenantId)
      : undefined;

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      isSuperAdmin: user.isSuperAdmin,
      requiresPasswordChange: Boolean(user.isSuperAdmin && !user.passwordChangedAt),
      mfaEnabled: user.mfaEnabled,
      tenantId: principal.tenantId,
      outletId: principal.outletId,
      membershipId: principal.membershipId,
      role: principal.role,
      tenantStatus: currentMembership?.tenant?.status ?? principal.tenantStatus,
      permissions: getPermissionsForRole(principal.role),
      memberships: activeMemberships.map((m) => ({
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

  async updateUserMe(principal: AuthenticatedPrincipal, dto: UpdateProfileDto) {
    const emailNormalized = dto.email?.trim().toLowerCase();
    const updatedUser = await this.prisma.runAsSystemAdmin(async (db) => {
      if (emailNormalized) {
        const collision = await db.user.findFirst({
          where: { email: emailNormalized, NOT: { id: principal.userId } },
        });
        if (collision) {
          throw new ConflictException({
            code: ErrorCode.CONFLICT,
            message: 'Email address is already in use by another account.',
          });
        }
      }
      return db.user.update({
        where: { id: principal.userId },
        data: {
          ...(dto.name ? { name: dto.name.trim() } : {}),
          ...(emailNormalized ? { email: emailNormalized } : {}),
        },
      });
    });

    if (principal.tenantId) {
      const ipAddress = this.tenantContext.get()?.ipAddress ?? null;
      await this.prisma.runInTenantTx(async (tx) => {
        await tx.auditLog.create({
          data: {
            tenantId: principal.tenantId!,
            actorUserId: principal.userId,
            actorRole: principal.role,
            action: 'USER_PROFILE_UPDATED',
            entityType: 'User',
            entityId: updatedUser.id,
            afterJson: { name: updatedUser.name, email: updatedUser.email },
            ipAddress,
          },
        });
      }, principal.tenantId);
    }

    return this.getUserMe(principal);
  }

  async switchOutlet(principal: AuthenticatedPrincipal, outletId: string, meta?: RequestMeta) {
    if (!principal.tenantId) {
      throw new ForbiddenException({
        code: ErrorCode.TENANT_CONTEXT_MISSING,
        message: 'Tenant context is required to switch outlets.',
      });
    }

    const membership = await this.prisma.runAsSystemAdmin((db) =>
      db.membership.findFirst({
        where: {
          userId: principal.userId,
          tenantId: principal.tenantId,
          outletId,
          isActive: true,
        },
        include: { tenant: true, outlet: true },
      }),
    );

    if (
      !membership ||
      membership.deletedAt ||
      membership.outlet?.deletedAt ||
      membership.tenant?.deletedAt
    ) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'No active membership in requested outlet.',
      });
    }

    if (membership.tenant.status === PrismaTenantStatus.REJECTED) {
      throw new ForbiddenException({
        code: ErrorCode.TENANT_REJECTED,
        message: 'Your restaurant registration has been rejected by AutoNex admin.',
      });
    }

    if (membership.tenant.status === PrismaTenantStatus.SUSPENDED) {
      throw new ForbiddenException({
        code: ErrorCode.TENANT_SUSPENDED,
        message: 'Restaurant account is suspended.',
      });
    }

    const tokens = await this.issueTokens({
      userId: principal.userId,
      tenantId: membership.tenantId,
      outletId: membership.outletId,
      membershipId: membership.id,
      role: membership.role as unknown as StaffRole,
      isSuperAdmin: principal.isSuperAdmin,
      tenantStatus: membership.tenant.status as unknown as TenantStatus,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      outlet: {
        id: membership.outlet.id,
        name: membership.outlet.name,
        timezone: membership.outlet.timezone,
      },
      role: membership.role,
      permissions: getPermissionsForRole(membership.role as unknown as StaffRole),
    };
  }

  async listSessions(principal: AuthenticatedPrincipal) {
    const sessions = await this.prisma.runAsSystemAdmin((db) =>
      db.session?.findMany?.({
        where: {
          userId: principal.userId,
          ...(principal.tenantId ? { tenantId: principal.tenantId } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }) ?? Promise.resolve([]),
    );

    return sessions.map((s) => ({
      id: s.id,
      ipAddress: s.ipAddress,
      userAgent: s.userAgent,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      revokedAt: s.revokedAt,
      isActive: s.revokedAt === null && s.expiresAt > new Date(),
    }));
  }

  async revokeSession(principal: AuthenticatedPrincipal, sessionId: string) {
    const session = await this.prisma.runAsSystemAdmin(async (db) => {
      const target = await db.session?.findFirst?.({
        where: {
          id: sessionId,
          userId: principal.userId,
          ...(principal.tenantId ? { tenantId: principal.tenantId } : {}),
        },
      });
      if (!target) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Session not found.',
        });
      }
      const revokedAt = new Date();
      await db.session?.update?.({
        where: { id: target.id },
        data: { revokedAt },
      });
      await db.refreshToken.updateMany({
        where: { familyId: target.familyId, revokedAt: null },
        data: { revokedAt },
      });
      return { id: target.id, revokedAt };
    });

    return session;
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

      const staffRoleRow = await tx.role?.findFirst?.({
        where: { tenantId: null, code: dto.role as unknown as PrismaStaffRole },
      });

      const created = await tx.membership.create({
        data: {
          tenantId: principal.tenantId!,
          outletId: principal.outletId!,
          userId: user.id,
          role: dto.role as unknown as PrismaStaffRole,
          ...(staffRoleRow ? { roleId: staffRoleRow.id } : {}),
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

  async listInvitations(principal: AuthenticatedPrincipal) {
    return this.prisma.runInTenantTx(async (tx) => {
      const invitations = await tx.invitation.findMany({
        where: principal.outletId ? { outletId: principal.outletId } : undefined,
        orderBy: { createdAt: 'desc' },
        take: 50,
      });

      return invitations.map((inv) => ({
        id: inv.id,
        tenantId: inv.tenantId,
        outletId: inv.outletId,
        email: inv.email,
        phone: inv.phone,
        name: inv.name,
        role: inv.role,
        status: inv.status,
        expiresAt: inv.expiresAt,
        acceptedAt: inv.acceptedAt,
        revokedAt: inv.revokedAt,
        createdAt: inv.createdAt,
      }));
    }, principal.tenantId);
  }

  async createInvitation(principal: AuthenticatedPrincipal, dto: CreateInvitationDto) {
    if (principal.role === StaffRole.MANAGER && dto.role === StaffRole.OWNER) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Managers cannot invite Owner accounts.',
      });
    }
    if (!principal.tenantId) {
      throw new ForbiddenException({
        code: ErrorCode.TENANT_CONTEXT_MISSING,
        message: 'Tenant context required.',
      });
    }

    const targetOutletId = dto.outletId ?? principal.outletId;
    if (!targetOutletId) {
      throw new ForbiddenException({
        code: ErrorCode.TENANT_CONTEXT_MISSING,
        message: 'Outlet context required to send an invitation.',
      });
    }

    const rawToken = generateOpaqueToken(32);
    const tokenHash = sha256Hex(rawToken);
    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;

    return this.prisma.runInTenantTx(async (tx) => {
      const outlet = await tx.outlet.findFirst({
        where: { id: targetOutletId, deletedAt: null },
      });
      if (!outlet) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Target outlet not found in this tenant.',
        });
      }

      const invitation = await tx.invitation.create({
        data: {
          tenantId: principal.tenantId!,
          outletId: outlet.id,
          invitedByUserId: principal.userId,
          email: dto.email?.trim().toLowerCase() ?? null,
          phone: dto.phone.trim(),
          name: dto.name.trim(),
          role: dto.role as unknown as PrismaStaffRole,
          status: PrismaInvitationStatus.PENDING,
          tokenHash,
          expiresAt,
        },
      });

      await tx.auditLog.create({
        data: {
          tenantId: principal.tenantId!,
          actorUserId: principal.userId,
          actorRole: principal.role,
          action: 'STAFF_INVITATION_CREATED',
          entityType: 'Invitation',
          entityId: invitation.id,
          afterJson: {
            outletId: invitation.outletId,
            phone: invitation.phone,
            role: invitation.role,
          },
          ipAddress,
        },
      });

      return {
        invitation: {
          id: invitation.id,
          tenantId: invitation.tenantId,
          outletId: invitation.outletId,
          email: invitation.email,
          phone: invitation.phone,
          name: invitation.name,
          role: invitation.role,
          status: invitation.status,
          expiresAt: invitation.expiresAt,
          createdAt: invitation.createdAt,
        },
        inviteToken: rawToken,
      };
    }, principal.tenantId);
  }

  async revokeInvitation(principal: AuthenticatedPrincipal, invitationId: string) {
    const ipAddress = this.tenantContext.get()?.ipAddress ?? null;
    return this.prisma.runInTenantTx(async (tx) => {
      const existing = await tx.invitation.findFirst({
        where: { id: invitationId },
      });
      if (!existing) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Invitation not found.',
        });
      }
      if (existing.status !== PrismaInvitationStatus.PENDING) {
        throw new ConflictException({
          code: ErrorCode.CONFLICT,
          message: 'Only pending invitations can be revoked.',
        });
      }

      const updated = await tx.invitation.update({
        where: { id: existing.id },
        data: {
          status: PrismaInvitationStatus.REVOKED,
          revokedAt: new Date(),
        },
      });

      await tx.auditLog.create({
        data: {
          tenantId: principal.tenantId!,
          actorUserId: principal.userId,
          actorRole: principal.role,
          action: 'STAFF_INVITATION_REVOKED',
          entityType: 'Invitation',
          entityId: updated.id,
          ipAddress,
        },
      });

      return {
        id: updated.id,
        status: updated.status as unknown as InvitationStatus,
        revokedAt: updated.revokedAt,
      };
    }, principal.tenantId);
  }

  async acceptInvitation(dto: AcceptInvitationDto, meta?: RequestMeta) {
    const tokenHash = sha256Hex(dto.token);
    const pinHash = hashSecret(dto.pin);
    const passwordHash = dto.password ? hashSecret(dto.password) : undefined;

    const accepted = await this.prisma.runAsSystemAdmin(async (db) => {
      const invitation = await db.invitation.findUnique({
        where: { tokenHash },
        include: { tenant: true, outlet: true },
      });

      if (!invitation || invitation.status !== PrismaInvitationStatus.PENDING) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Invitation is invalid or no longer pending.',
        });
      }

      if (invitation.expiresAt <= new Date()) {
        await db.invitation.update({
          where: { id: invitation.id },
          data: { status: PrismaInvitationStatus.EXPIRED },
        });
        throw new ConflictException({
          code: ErrorCode.CONFLICT,
          message: 'Invitation has expired.',
        });
      }

      if (
        invitation.tenant.status === PrismaTenantStatus.SUSPENDED ||
        invitation.tenant.status === PrismaTenantStatus.REJECTED ||
        invitation.outlet.deletedAt
      ) {
        throw new ForbiddenException({
          code: ErrorCode.FORBIDDEN,
          message: 'Restaurant or outlet is no longer active.',
        });
      }

      return db.$transaction(async (tx) => {
        let user = await tx.user.findUnique({ where: { phone: invitation.phone } });
        if (!user) {
          user = await tx.user.create({
            data: {
              name: dto.name?.trim() || invitation.name,
              phone: invitation.phone,
              email: invitation.email,
              ...(passwordHash ? { passwordHash } : {}),
              isSuperAdmin: false,
            },
          });
        } else if (passwordHash && !user.passwordHash) {
          user = await tx.user.update({
            where: { id: user.id },
            data: { passwordHash },
          });
        }

        const roleRow = await tx.role?.findFirst?.({
          where: { tenantId: null, code: invitation.role },
        });

        const existingMembership = await tx.membership.findFirst({
          where: { outletId: invitation.outletId, userId: user.id },
        });

        const membership = existingMembership
          ? await tx.membership.update({
              where: { id: existingMembership.id },
              data: {
                role: invitation.role,
                ...(roleRow ? { roleId: roleRow.id } : {}),
                staffPinHash: pinHash,
                isActive: true,
                deletedAt: null,
                failedAttempts: 0,
                lockedUntil: null,
              },
            })
          : await tx.membership.create({
              data: {
                tenantId: invitation.tenantId,
                outletId: invitation.outletId,
                userId: user.id,
                role: invitation.role,
                ...(roleRow ? { roleId: roleRow.id } : {}),
                staffPinHash: pinHash,
                isActive: true,
              },
            });

        await tx.invitation.update({
          where: { id: invitation.id },
          data: {
            status: PrismaInvitationStatus.ACCEPTED,
            acceptedAt: new Date(),
          },
        });

        await tx.auditLog.create({
          data: {
            tenantId: invitation.tenantId,
            actorUserId: user.id,
            actorRole: invitation.role,
            action: 'STAFF_INVITATION_ACCEPTED',
            entityType: 'Invitation',
            entityId: invitation.id,
            afterJson: { outletId: invitation.outletId, role: invitation.role },
            ipAddress: meta?.ipAddress ?? null,
          },
        });

        return { invitation, user, membership };
      });
    });

    const tokens = await this.issueTokens({
      userId: accepted.user.id,
      tenantId: accepted.invitation.tenantId,
      outletId: accepted.invitation.outletId,
      membershipId: accepted.membership.id,
      role: accepted.membership.role as unknown as StaffRole,
      isSuperAdmin: accepted.user.isSuperAdmin,
      tenantStatus: accepted.invitation.tenant.status as unknown as TenantStatus,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: accepted.user.id,
        name: accepted.user.name,
        phone: accepted.user.phone,
        email: accepted.user.email,
        role: accepted.membership.role,
        tenantId: accepted.invitation.tenantId,
        outletId: accepted.invitation.outletId,
      },
    };
  }
}

