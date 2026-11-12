import { Controller, Get, Headers, Param, Post, Query, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { BillingService } from './billing.service';

@Public()
@Controller('public/qr')
export class PublicBillingController {
  constructor(private readonly billingService: BillingService) {}

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':token/bill')
  generateOrGetCustomerBill(
    @Param('token') rawToken: string,
    @Headers('x-guest-token') guestToken: string | undefined,
  ) {
    return this.billingService.generateOrGetCustomerBill(rawToken, guestToken);
  }

  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @Get(':token/bill')
  getCustomerBill(
    @Param('token') rawToken: string,
    @Headers('x-guest-token') guestToken: string | undefined,
  ) {
    return this.billingService.getCustomerBill(rawToken, guestToken);
  }

  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @Get(':token/receipt.pdf')
  async downloadCustomerReceiptPdf(
    @Param('token') rawToken: string,
    @Headers('x-guest-token') guestHeader: string | undefined,
    @Query('guestToken') guestQuery: string | undefined,
    @Res() res: Response,
  ) {
    const { buffer, filename } = await this.billingService.buildCustomerReceiptPdf(
      rawToken,
      guestHeader || guestQuery,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.send(buffer);
  }
}

