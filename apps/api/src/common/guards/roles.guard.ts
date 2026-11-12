import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ActorRole, ErrorCode, SYSTEM_ROLE_SUPER_ADMIN } from '@autonex/shared';
import { AuthenticatedPrincipal } from '../decorators/current-user.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const requiredRoles = this.reflector.getAllAndOverride<ActorRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const req = context.switchToHttp().getRequest<{ user?: AuthenticatedPrincipal }>();
    const user = req.user;
    if (!user || !requiredRoles.includes(user.role)) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Insufficient role permissions for this resource',
      });
    }

    if (
      requiredRoles.includes(SYSTEM_ROLE_SUPER_ADMIN) &&
      user.role === SYSTEM_ROLE_SUPER_ADMIN &&
      !user.isSuperAdmin
    ) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Super Admin privileges required for this resource',
      });
    }

    return true;
  }
}

