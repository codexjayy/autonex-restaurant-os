import { Permissions } from '@autonex/permissions';
import { StaffRole } from '@autonex/shared';
import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { AllowPendingTenant } from '../../common/decorators/allow-pending-tenant.decorator';
import { AuthenticatedPrincipal, CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CreateOutletDto } from './dto/milestone1-tenancy.dto';
import { UpdateOutletDto } from './dto/update-outlet.dto';
import { TenancyService } from './tenancy.service';

@Controller('outlets')
export class OutletsController {
  constructor(private readonly tenancyService: TenancyService) {}

  @AllowPendingTenant()
  @RequirePermissions(Permissions.OUTLET_READ)
  @Get()
  list(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.tenancyService.listOutlets(principal);
  }

  @AllowPendingTenant()
  @Roles(StaffRole.OWNER)
  @RequirePermissions(Permissions.OUTLET_CREATE)
  @Post()
  create(@CurrentUser() principal: AuthenticatedPrincipal, @Body() dto: CreateOutletDto) {
    return this.tenancyService.createOutlet(principal, dto);
  }

  @AllowPendingTenant()
  @RequirePermissions(Permissions.OUTLET_READ)
  @Get(':id')
  getOne(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.tenancyService.getOutletById(principal, id);
  }

  @AllowPendingTenant()
  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @RequirePermissions(Permissions.OUTLET_UPDATE)
  @Patch(':id')
  update(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateOutletDto,
  ) {
    return this.tenancyService.updateOutletById(principal, id, dto);
  }

  @AllowPendingTenant()
  @Roles(StaffRole.OWNER)
  @RequirePermissions(Permissions.OUTLET_CREATE)
  @Delete(':id')
  softDelete(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.tenancyService.softDeleteOutlet(principal, id);
  }
}

