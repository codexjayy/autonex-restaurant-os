import { Body, Controller, Headers, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import {
  CreateRazorpayOrderDto,
  ReportPaymentFailureDto,
  VerifyRazorpayPaymentDto,
} from './dto/payments.dto';
import { PaymentsService } from './payments.service';

@Public()
@Controller('public/qr')
export class PublicPaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':token/payments/razorpay/order')
  createCustomerRazorpayOrder(
    @Param('token') rawToken: string,
    @Headers('x-guest-token') guestToken: string | undefined,
    @Body() dto: CreateRazorpayOrderDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.paymentsService.createCustomerRazorpayOrder(
      rawToken,
      guestToken,
      dto,
      idempotencyKey,
    );
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':token/payments/razorpay/verify')
  verifyCustomerRazorpayPayment(
    @Param('token') rawToken: string,
    @Headers('x-guest-token') guestToken: string | undefined,
    @Body() dto: VerifyRazorpayPaymentDto,
  ) {
    return this.paymentsService.verifyCustomerRazorpayPayment(
      rawToken,
      guestToken,
      dto,
    );
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':token/payments/razorpay/fail')
  reportCustomerPaymentFailure(
    @Param('token') rawToken: string,
    @Headers('x-guest-token') guestToken: string | undefined,
    @Body() dto: ReportPaymentFailureDto,
  ) {
    return this.paymentsService.reportCustomerPaymentFailure(
      rawToken,
      guestToken,
      dto,
    );
  }
}

