import { createParamDecorator, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ErrorCode, type ActorRole, type TenantStatus } from '@autonex/shared';

export interface AuthenticatedPrincipal {
  userId: string;
  tenantId?: string;
  outletId?: string;
  membershipId?: string;
  role: ActorRole;
  isSuperAdmin: boolean;
  tenantStatus?: TenantStatus;
}

export interface OutletScopedPrincipal extends AuthenticatedPrincipal {
  tenantId: string;
  outletId: string;
}

export function requireOutletContext(principal: AuthenticatedPrincipal): OutletScopedPrincipal {
  if (!principal.tenantId || !principal.outletId) {
    throw new ForbiddenException({
      code: ErrorCode.TENANT_CONTEXT_MISSING,
      message: 'Tenant or outlet context missing from principal',
    });
  }
  return {
    ...principal,
    tenantId: principal.tenantId,
    outletId: principal.outletId,
  };
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedPrincipal => {
    const request = ctx.switchToHttp().getRequest<{ user: AuthenticatedPrincipal }>();
    return request.user;
  },
);

