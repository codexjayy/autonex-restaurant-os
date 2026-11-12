import { Permissions } from '@autonex/permissions';
import { Controller, Get } from '@nestjs/common';
import { AllowPendingTenant } from '../../common/decorators/allow-pending-tenant.decorator';
import { AuthenticatedPrincipal, CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { TenancyService } from './tenancy.service';

@Controller('roles')
export class RolesController {
  constructor(private readonly tenancyService: TenancyService) {}

  @AllowPendingTenant()
  @RequirePermissions(Permissions.ROLE_READ)
  @Get()
  listRoles(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.tenancyService.listRoles(principal);
  }
}

