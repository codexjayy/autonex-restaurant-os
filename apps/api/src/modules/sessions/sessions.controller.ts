import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { StaffRole } from '@autonex/shared';
import { AllowDuringLockOrSettlement } from '../../common/decorators/allow-during-lock.decorator';
import { AuthenticatedPrincipal, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  CloseSessionDto,
  ModifyOrderItemsDto,
  SettleSessionDto,
} from './dto/session-lifecycle.dto';
import { SessionsService } from './sessions.service';

@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessionsService: SessionsService) {}

  @AllowDuringLockOrSettlement()
  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER, StaffRole.WAITER)
  @Get(':id')
  getSessionSummary(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) sessionId: string,
  ) {
    return this.sessionsService.getSessionSummary(principal, sessionId);
  }

  @AllowDuringLockOrSettlement()
  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER, StaffRole.WAITER)
  @Post(':id/revoke-join-code')
  revokeJoinCode(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) sessionId: string,
  ) {
    return this.sessionsService.revokeJoinCode(principal, sessionId);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER, StaffRole.WAITER)
  @Patch(':id/orders/:orderId/items')
  modifyOrderItems(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) sessionId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: ModifyOrderItemsDto,
  ) {
    return this.sessionsService.modifyOrderItems(principal, sessionId, orderId, dto);
  }

  @AllowDuringLockOrSettlement()
  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER, StaffRole.WAITER)
  @Post(':id/request-bill')
  lockSessionForCheckout(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) sessionId: string,
  ) {
    return this.sessionsService.lockSessionForCheckout(principal, sessionId);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER, StaffRole.WAITER)
  @Post(':id/reopen')
  reopenSession(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) sessionId: string,
  ) {
    return this.sessionsService.reopenSession(principal, sessionId);
  }

  @AllowDuringLockOrSettlement()
  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER)
  @Post(':id/settle')
  markSessionSettled(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) sessionId: string,
    @Body() dto: SettleSessionDto,
  ) {
    return this.sessionsService.markSessionSettled(principal, sessionId, dto);
  }

  @AllowDuringLockOrSettlement()
  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER, StaffRole.WAITER)
  @Post(':id/close')
  closeAndResetSession(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) sessionId: string,
    @Body() dto: CloseSessionDto,
  ) {
    return this.sessionsService.closeAndResetSession(principal, sessionId, dto);
  }
}

