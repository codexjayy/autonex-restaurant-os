import { Module } from '@nestjs/common';
import { OutletsController } from './outlets.controller';
import { RolesController } from './roles.controller';
import { TenancyController } from './tenancy.controller';
import { TenancyService } from './tenancy.service';
import { TenantsController } from './tenants.controller';

@Module({
  controllers: [TenancyController, TenantsController, OutletsController, RolesController],
  providers: [TenancyService],
  exports: [TenancyService],
})
export class TenancyModule {}

