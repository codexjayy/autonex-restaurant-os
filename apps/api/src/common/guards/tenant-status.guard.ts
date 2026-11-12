import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  DiningSessionStatus,
  ErrorCode,
  SYSTEM_ROLE_SUPER_ADMIN,
  TenantStatus,
} from '@autonex/shared';
import { ALLOW_DURING_LOCK_KEY } from '../decorators/allow-during-lock.decorator';
import { ALLOW_PENDING_TENANT_KEY } from '../decorators/allow-pending-tenant.decorator';
import { AuthenticatedPrincipal } from '../decorators/current-user.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TenantStatusGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Optional() @Inject(PrismaService) private readonly prisma?: PrismaService,
  ) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<{
      user?: AuthenticatedPrincipal;
      method?: string;
    }>();
    const user = req.user;
    if (!user) return false;

    // Platform Super Admin operates across tenants via AdminModule
    if (user.role === SYSTEM_ROLE_SUPER_ADMIN && user.isSuperAdmin) {
      return true;
    }

    if (!user.tenantId) {
      throw new ForbiddenException({
        code: ErrorCode.TENANT_CONTEXT_MISSING,
        message: 'Tenant context missing from principal',
      });
    }

    const allowDuringLock = this.reflector.getAllAndOverride<boolean>(ALLOW_DURING_LOCK_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (user.tenantStatus === TenantStatus.REJECTED) {
      throw new ForbiddenException({
        code: ErrorCode.TENANT_REJECTED,
        message: 'Restaurant registration has been rejected. Operations and login are disabled.',
      });
    }

    if (user.tenantStatus === TenantStatus.SUSPENDED) {
      if (allowDuringLock && this.prisma) {
        return this.checkOpenSessionDrainAllowance(user.tenantId);
      }
      throw new ForbiddenException({
        code: ErrorCode.TENANT_SUSPENDED,
        message: 'Restaurant account is suspended. Contact AutoNex support.',
      });
    }

    const allowPending = this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_TENANT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (user.tenantStatus === TenantStatus.PENDING_APPROVAL && !allowPending) {
      throw new ForbiddenException({
        code: ErrorCode.TENANT_NOT_APPROVED,
        message: 'Restaurant registration is awaiting admin approval.',
      });
    }

    if (user.tenantStatus === TenantStatus.LOCKED) {
      const method = (req.method ?? '').toUpperCase();
      const isReadOnlyRequest = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
      if (!isReadOnlyRequest && !allowDuringLock && !allowPending) {
        throw new ForbiddenException({
          code: ErrorCode.SUBSCRIPTION_LOCKED,
          message:
            'Restaurant account is in read-only mode (subscription expired or pending suspension). Only open table settlement, KDS completion, billing export, and plan renewal are allowed.',
        });
      }
    }

    return true;
  }

  private async checkOpenSessionDrainAllowance(tenantId: string): Promise<boolean> {
    if (!this.prisma) {
      throw new ForbiddenException({
        code: ErrorCode.TENANT_SUSPENDED,
        message: 'Restaurant account is suspended. Contact AutoNex support.',
      });
    }

    const activeOpenSessions = await this.prisma.runInTenantTx((tx) =>
      tx.diningSession.count({
        where: {
          tenantId,
          status: {
            in: [
              DiningSessionStatus.ACTIVE,
              DiningSessionStatus.BILL_REQUESTED,
              DiningSessionStatus.SETTLED,
            ],
          },
        },
      }),
    );

    if (activeOpenSessions > 0) {
      return true;
    }

    throw new ForbiddenException({
      code: ErrorCode.TENANT_SUSPENDED,
      message: 'Restaurant account is suspended. Contact AutoNex support.',
    });
  }
}

