import { Permissions } from '@autonex/permissions';
import { StaffRole } from '@autonex/shared';
import { Body, Controller, Get, Patch } from '@nestjs/common';
import { AllowPendingTenant } from '../../common/decorators/allow-pending-tenant.decorator';
import { AuthenticatedPrincipal, CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { UpdateTenantDto } from './dto/milestone1-tenancy.dto';
import { TenancyService } from './tenancy.service';

@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenancyService: TenancyService) {}

  @AllowPendingTenant()
  @RequirePermissions(Permissions.TENANT_READ)
  @Get('current')
  getCurrent(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.tenancyService.getCurrentTenant(principal);
  }

  @AllowPendingTenant()
  @Roles(StaffRole.OWNER)
  @RequirePermissions(Permissions.TENANT_UPDATE)
  @Patch('current')
  updateCurrent(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() dto: UpdateTenantDto,
  ) {
    return this.tenancyService.updateCurrentTenant(principal, dto);
  }
}

