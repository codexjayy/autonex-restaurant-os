import { Body, Controller, Get, Patch } from '@nestjs/common';
import { StaffRole } from '@autonex/shared';
import { AllowPendingTenant } from '../../common/decorators/allow-pending-tenant.decorator';
import { AuthenticatedPrincipal, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { UpdateOutletDto } from './dto/update-outlet.dto';
import { TenancyService } from './tenancy.service';

@Controller('outlet')
export class TenancyController {
  constructor(private readonly tenancyService: TenancyService) {}

  @AllowPendingTenant()
  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER)
  @Get('profile')
  getProfile(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.tenancyService.getOutletProfile(principal);
  }

  @AllowPendingTenant()
  @Roles(StaffRole.OWNER)
  @Patch('profile')
  updateProfile(@CurrentUser() principal: AuthenticatedPrincipal, @Body() dto: UpdateOutletDto) {
    return this.tenancyService.updateOutletProfile(principal, dto);
  }

  @AllowPendingTenant()
  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @Get('onboarding')
  getOnboarding(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.tenancyService.getOnboardingChecklist(principal);
  }
}

