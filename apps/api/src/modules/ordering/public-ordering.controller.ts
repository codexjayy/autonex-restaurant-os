import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { JoinSessionDto } from './dto/join-session.dto';
import { PlaceCustomerOrderDto } from './dto/place-order.dto';
import { OrderingService } from './ordering.service';

@Public()
@Controller('public/qr')
export class PublicOrderingController {
  constructor(private readonly orderingService: OrderingService) {}

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':token/join')
  joinSession(@Param('token') token: string, @Body() dto: JoinSessionDto) {
    return this.orderingService.joinSessionViaQr(token, dto);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get(':token/session')
  getSessionState(
    @Param('token') token: string,
    @Headers('x-guest-token') guestToken?: string,
  ) {
    return this.orderingService.getCustomerSessionState(token, guestToken);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':token/orders')
  placeOrder(
    @Param('token') token: string,
    @Headers('x-guest-token') guestToken: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: PlaceCustomerOrderDto,
  ) {
    return this.orderingService.placeCustomerOrder(token, guestToken, dto, idempotencyKey);
  }
}

