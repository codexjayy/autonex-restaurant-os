import { Controller, Headers, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { SessionsService } from './sessions.service';

@Public()
@Controller('public/qr')
export class PublicSessionsController {
  constructor(private readonly sessionsService: SessionsService) {}

  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @Post(':token/request-bill')
  requestBill(
    @Param('token') rawToken: string,
    @Headers('x-guest-token') guestToken: string | undefined,
  ) {
    return this.sessionsService.lockSessionForCheckoutCustomer(rawToken, guestToken);
  }
}

