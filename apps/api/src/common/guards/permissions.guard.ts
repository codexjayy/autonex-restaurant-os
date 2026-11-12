import { hasAllPermissions, type Permission } from '@autonex/permissions';
import { ErrorCode } from '@autonex/shared';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';
import type { AuthenticatedPrincipal } from '@autonex/types';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const requiredPermissions = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedPrincipal }>();
    if (!req.user) {
      throw new UnauthorizedException({
        code: ErrorCode.UNAUTHORIZED,
        message: 'Authentication required',
      });
    }

    if (req.user.isSuperAdmin) {
      return true;
    }

    if (!hasAllPermissions(req.user.role, requiredPermissions)) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Insufficient permissions for this action',
      });
    }

    return true;
  }
}
