import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { StaffRole } from '@autonex/shared';
import { AllowDuringLockOrSettlement } from '../../common/decorators/allow-during-lock.decorator';
import { AuthenticatedPrincipal, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { KdsOrdersQueryDto, UpdateKdsStatusDto } from './dto/kds.dto';
import { KitchenService } from './kitchen.service';

@AllowDuringLockOrSettlement()
@Controller('kds')
export class KitchenController {
  constructor(private readonly kitchenService: KitchenService) {}

  @Roles(
    StaffRole.OWNER,
    StaffRole.MANAGER,
    StaffRole.CASHIER,
    StaffRole.KITCHEN,
    StaffRole.WAITER,
  )
  @Get('orders')
  getKdsBoard(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query() query: KdsOrdersQueryDto,
  ) {
    return this.kitchenService.getKdsBoard(principal, query);
  }

  @Roles(
    StaffRole.OWNER,
    StaffRole.MANAGER,
    StaffRole.CASHIER,
    StaffRole.KITCHEN,
    StaffRole.WAITER,
  )
  @Get('orders/:orderId')
  getKdsTicket(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.kitchenService.getKdsTicket(principal, orderId);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER, StaffRole.KITCHEN)
  @Post('orders/:orderId/acknowledge')
  acknowledgeOrder(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.kitchenService.acknowledgeOrder(principal, orderId);
  }

  @Roles(
    StaffRole.OWNER,
    StaffRole.MANAGER,
    StaffRole.CASHIER,
    StaffRole.KITCHEN,
    StaffRole.WAITER,
  )
  @Patch('orders/:orderId/status')
  transitionStatus(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: UpdateKdsStatusDto,
  ) {
    return this.kitchenService.transitionOrderStatus(principal, orderId, dto);
  }
}

