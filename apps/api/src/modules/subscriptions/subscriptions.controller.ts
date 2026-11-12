import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { StaffRole } from '@autonex/shared';
import { AllowDuringLockOrSettlement } from '../../common/decorators/allow-during-lock.decorator';
import { AllowPendingTenant } from '../../common/decorators/allow-pending-tenant.decorator';
import { AuthenticatedPrincipal, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AddSupportNoteDto, CreateSupportCaseDto } from './dto/subscriptions.dto';
import { SubscriptionsService } from './subscriptions.service';
import { SupportCasesService } from './support-cases.service';

@AllowPendingTenant()
@AllowDuringLockOrSettlement()
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(
    private readonly subscriptionsService: SubscriptionsService,
    private readonly supportCasesService: SupportCasesService,
  ) {}

  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER)
  @Get('current')
  getCurrentSubscription(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.subscriptionsService.getOwnerCurrentSubscription(principal);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER, StaffRole.WAITER)
  @Get('plans')
  listAvailablePlans() {
    return this.subscriptionsService.listPlans(false);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER)
  @Get('daily-summary')
  getDailySummary(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.subscriptionsService.getOwnerDailySummary(principal);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @Get('support-cases')
  listTenantSupportCases(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.supportCasesService.listTenantSupportCases(principal);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @Get('support-cases/:id')
  getTenantSupportCase(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) caseId: string,
  ) {
    return this.supportCasesService.getTenantSupportCase(principal, caseId);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @Post('support-cases')
  createTenantSupportCase(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() dto: CreateSupportCaseDto,
  ) {
    return this.supportCasesService.createTenantSupportCase(principal, dto);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @Post('support-cases/:id/notes')
  addTenantSupportNote(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) caseId: string,
    @Body() dto: AddSupportNoteDto,
  ) {
    return this.supportCasesService.addTenantSupportNote(principal, caseId, dto);
  }
}

