import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ActorRole, ErrorCode, SYSTEM_ROLE_SUPER_ADMIN, TenantStatus } from '@autonex/shared';
import type { Request } from 'express';
import type { JwtStrategy } from '../../modules/auth/strategies/jwt.strategy';
import { TenantContextService } from '../context/tenant-context.service';
import { AuthenticatedPrincipal } from '../decorators/current-user.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

export interface AccessJwtPayload {
  sub: string;
  tenantId?: string;
  outletId?: string;
  membershipId?: string;
  role: ActorRole;
  isSuperAdmin: boolean;
  tenantStatus?: TenantStatus;
  iat?: number;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly tenantContext: TenantContextService,
    @Optional() private readonly jwtStrategy?: JwtStrategy,
    @Optional() @Inject(PrismaService) private readonly prisma?: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: AuthenticatedPrincipal }>();
    const authHeader = req.header('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        code: ErrorCode.UNAUTHORIZED,
        message: 'Missing bearer access token',
      });
    }

    const token = authHeader.slice('Bearer '.length).trim();
    let payload: AccessJwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<AccessJwtPayload>(token, {
        secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
      });
    } catch {
      throw new UnauthorizedException({
        code: ErrorCode.UNAUTHORIZED,
        message: 'Invalid or expired access token',
      });
    }

    // Never trust client-supplied x-tenant-id header for tenant users
    const headerTenantId = req.header('x-tenant-id');
    if (
      headerTenantId &&
      payload.role !== SYSTEM_ROLE_SUPER_ADMIN &&
      headerTenantId !== payload.tenantId
    ) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Cross-tenant header override rejected',
      });
    }

    const principal: AuthenticatedPrincipal = this.jwtStrategy
      ? (this.jwtStrategy.validate(payload) as AuthenticatedPrincipal)
      : {
          userId: payload.sub,
          tenantId: payload.tenantId,
          outletId: payload.outletId,
          membershipId: payload.membershipId,
          role: payload.role,
          isSuperAdmin: Boolean(payload.isSuperAdmin),
          tenantStatus: payload.tenantStatus,
        };

    // Keep tenantStatus and Super Admin authorization synchronized with live DB state
    if (this.prisma?.runAsSystemAdmin) {
      if (principal.isSuperAdmin || principal.role === SYSTEM_ROLE_SUPER_ADMIN) {
        const liveAdmin = await this.prisma.runAsSystemAdmin((db) =>
          db.user?.findUnique?.({
            where: { id: principal.userId },
            select: {
              isSuperAdmin: true,
              isActive: true,
              deletedAt: true,
              passwordChangedAt: true,
            },
          }),
        );
        if (liveAdmin !== undefined) {
          if (!liveAdmin || liveAdmin.deletedAt || !liveAdmin.isActive || !liveAdmin.isSuperAdmin) {
            throw new UnauthorizedException({
              code: ErrorCode.UNAUTHORIZED,
              message: 'Super Admin session is no longer active.',
            });
          }
          if (
            liveAdmin.passwordChangedAt &&
            typeof payload.iat === 'number' &&
            Math.floor(liveAdmin.passwordChangedAt.getTime() / 1000) > payload.iat
          ) {
            throw new UnauthorizedException({
              code: ErrorCode.UNAUTHORIZED,
              message: 'Session invalidated after password change. Please sign in again.',
            });
          }
        }
      } else if (principal.tenantId) {
        const liveTenant = await this.prisma.runAsSystemAdmin((db) =>
          db.tenant?.findUnique?.({
            where: { id: principal.tenantId },
            select: { status: true },
          }),
        );
        if (liveTenant?.status) {
          principal.tenantStatus = liveTenant.status as TenantStatus;
        }
      }
    }

    req.user = principal;
    this.tenantContext.update({
      userId: principal.userId,
      tenantId: principal.tenantId,
      outletId: principal.outletId,
      membershipId: principal.membershipId,
      role: principal.role,
      isSuperAdmin: principal.isSuperAdmin,
      tenantStatus: principal.tenantStatus,
    });

    return true;
  }
}

