import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { GuestJoinStatus, StaffRole } from '@autonex/shared';
import { AllowDuringLockOrSettlement } from '../../common/decorators/allow-during-lock.decorator';
import { AuthenticatedPrincipal, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { OpenTableSessionDto } from './dto/join-session.dto';
import { PlaceStaffOrderDto } from './dto/place-order.dto';
import { OrderingService } from './ordering.service';

@Controller()
export class OrderingController {
  constructor(private readonly orderingService: OrderingService) {}

  @AllowDuringLockOrSettlement()
  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER, StaffRole.WAITER)
  @Get('sessions')
  listFloorSessions(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.orderingService.listFloorSessions(principal);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER, StaffRole.WAITER)
  @Post('sessions/open')
  openTableSession(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() dto: OpenTableSessionDto,
  ) {
    return this.orderingService.openTableSession(principal, dto.tableId);
  }

  @AllowDuringLockOrSettlement()
  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER, StaffRole.WAITER)
  @Post('sessions/:id/rotate-join-code')
  rotateJoinCode(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) sessionId: string,
  ) {
    return this.orderingService.rotateSessionJoinCode(principal, sessionId);
  }

  @AllowDuringLockOrSettlement()
  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER, StaffRole.WAITER)
  @Post('sessions/:id/guests/:guestId/approve')
  approveGuest(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) sessionId: string,
    @Param('guestId', ParseUUIDPipe) guestId: string,
  ) {
    return this.orderingService.updateGuestJoinStatus(
      principal,
      sessionId,
      guestId,
      GuestJoinStatus.APPROVED,
    );
  }

  @AllowDuringLockOrSettlement()
  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER, StaffRole.WAITER)
  @Post('sessions/:id/guests/:guestId/revoke')
  revokeGuest(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) sessionId: string,
    @Param('guestId', ParseUUIDPipe) guestId: string,
  ) {
    return this.orderingService.updateGuestJoinStatus(
      principal,
      sessionId,
      guestId,
      GuestJoinStatus.REVOKED,
    );
  }

  @AllowDuringLockOrSettlement()
  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER, StaffRole.WAITER, StaffRole.KITCHEN)
  @Get('orders/sessions/:sessionId')
  getSessionOrders(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ) {
    return this.orderingService.getSessionOrders(principal, sessionId);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER, StaffRole.WAITER)
  @Post('orders/staff')
  placeStaffOrder(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: PlaceStaffOrderDto,
  ) {
    return this.orderingService.placeStaffOrder(principal, dto, idempotencyKey);
  }
}

