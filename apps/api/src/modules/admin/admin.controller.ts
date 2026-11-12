import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { SYSTEM_ROLE_SUPER_ADMIN } from '@autonex/shared';
import { AuthenticatedPrincipal, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  AddSupportNoteDto,
  AssignSubscriptionDto,
  CreatePlanDto,
  UpdatePlanDto,
  UpdateSupportCaseDto,
} from '../subscriptions/dto/subscriptions.dto';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { SupportCasesService } from '../subscriptions/support-cases.service';
import { AdminService } from './admin.service';
import {
  ListAuditLogsQueryDto,
  ListSupportCasesQueryDto,
  OffboardRestaurantDto,
  OnboardRestaurantDto,
  ReactivateRestaurantDto,
} from './dto/admin-phase7.dto';
import { ApproveTenantDto, SuspendTenantDto } from './dto/approve-tenant.dto';

@Roles(SYSTEM_ROLE_SUPER_ADMIN)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly supportCasesService: SupportCasesService,
  ) {}

  @Get('analytics/overview')
  getPlatformOverview() {
    return this.subscriptionsService.getPlatformOverview();
  }

  @Get('restaurants')
  listRestaurants(@Query('status') status?: string) {
    return this.adminService.listRestaurants(status);
  }

  @Post('restaurants')
  onboardRestaurant(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() dto: OnboardRestaurantDto,
  ) {
    return this.adminService.onboardRestaurant(principal, dto);
  }

  @Get('restaurants/:tenantId')
  getRestaurantDetail(@Param('tenantId', new ParseUUIDPipe()) tenantId: string) {
    return this.adminService.getRestaurantDetail(tenantId);
  }

  @Post('restaurants/:tenantId/approve')
  approveRestaurant(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() dto: ApproveTenantDto,
  ) {
    return this.adminService.approveRestaurant(principal, tenantId, dto);
  }

  @Post('restaurants/:tenantId/suspend')
  suspendRestaurant(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() dto: SuspendTenantDto,
  ) {
    return this.adminService.suspendRestaurant(principal, tenantId, dto);
  }

  @Post('restaurants/:tenantId/reactivate')
  reactivateRestaurant(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() dto: ReactivateRestaurantDto,
  ) {
    return this.adminService.reactivateRestaurant(principal, tenantId, dto);
  }

  @Post('restaurants/:tenantId/offboard')
  offboardRestaurant(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() dto: OffboardRestaurantDto,
  ) {
    return this.adminService.offboardRestaurant(principal, tenantId, dto);
  }

  @Get('plans')
  listPlans() {
    return this.subscriptionsService.listPlans(true);
  }

  @Post('plans')
  createPlan(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() dto: CreatePlanDto,
  ) {
    return this.subscriptionsService.createPlan(principal, dto);
  }

  @Patch('plans/:planId')
  updatePlan(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('planId', new ParseUUIDPipe()) planId: string,
    @Body() dto: UpdatePlanDto,
  ) {
    return this.subscriptionsService.updatePlan(principal, planId, dto);
  }

  @Get('subscriptions')
  listAllSubscriptions() {
    return this.subscriptionsService.listAllSubscriptions();
  }

  @Post('restaurants/:tenantId/subscription')
  assignOrUpdateSubscription(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() dto: AssignSubscriptionDto,
  ) {
    return this.subscriptionsService.assignOrUpdateSubscription(principal, tenantId, dto);
  }

  @Post('subscriptions/sweep')
  runSubscriptionLifecycleSweep() {
    return this.subscriptionsService.sweepExpiredSubscriptions();
  }

  @Get('support-cases')
  listAdminSupportCases(@Query() query: ListSupportCasesQueryDto) {
    return this.supportCasesService.listAdminSupportCases(query);
  }

  @Get('support-cases/:id')
  getAdminSupportCase(@Param('id', new ParseUUIDPipe()) caseId: string) {
    return this.supportCasesService.getAdminSupportCase(caseId);
  }

  @Patch('support-cases/:id')
  updateAdminSupportCase(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) caseId: string,
    @Body() dto: UpdateSupportCaseDto,
  ) {
    return this.supportCasesService.updateAdminSupportCase(principal, caseId, dto);
  }

  @Post('support-cases/:id/notes')
  addAdminSupportNote(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) caseId: string,
    @Body() dto: AddSupportNoteDto,
  ) {
    return this.supportCasesService.addAdminSupportNote(principal, caseId, dto);
  }

  @Get('audit-logs')
  listAuditLogs(@Query() query: ListAuditLogsQueryDto) {
    return this.adminService.listAuditLogs(query);
  }
}
