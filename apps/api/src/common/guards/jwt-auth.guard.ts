import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ActorRole, ErrorCode, SYSTEM_ROLE_SUPER_ADMIN, TenantStatus } from '@autonex/shared';
import type { Request } from 'express';
import { TenantContextService } from '../context/tenant-context.service';
import { AuthenticatedPrincipal } from '../decorators/current-user.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

export interface AccessJwtPayload {
  sub: string;
  tenantId?: string;
  outletId?: string;
  membershipId?: string;
  role: ActorRole;
  isSuperAdmin: boolean;
  tenantStatus?: TenantStatus;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly tenantContext: TenantContextService,
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

    const principal: AuthenticatedPrincipal = {
      userId: payload.sub,
      tenantId: payload.tenantId,
      outletId: payload.outletId,
      membershipId: payload.membershipId,
      role: payload.role,
      isSuperAdmin: Boolean(payload.isSuperAdmin),
      tenantStatus: payload.tenantStatus,
    };

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

