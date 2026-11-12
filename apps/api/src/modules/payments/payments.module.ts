import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { TablesModule } from '../tables/tables.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PublicPaymentsController } from './public-payments.controller';
import { RazorpayClientService } from './razorpay-client.service';
import { ReconciliationService } from './reconciliation.service';
import { WebhooksController } from './webhooks.controller';

@Module({
  imports: [TablesModule, BillingModule],
  controllers: [PaymentsController, PublicPaymentsController, WebhooksController],
  providers: [PaymentsService, RazorpayClientService, ReconciliationService],
  exports: [PaymentsService, RazorpayClientService, ReconciliationService],
})
export class PaymentsModule {}

