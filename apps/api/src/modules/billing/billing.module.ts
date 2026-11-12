import { Module } from '@nestjs/common';
import { TablesModule } from '../tables/tables.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { PublicBillingController } from './public-billing.controller';
import { ReceiptPdfService } from './receipt-pdf.service';

@Module({
  imports: [TablesModule],
  controllers: [BillingController, PublicBillingController],
  providers: [BillingService, ReceiptPdfService],
  exports: [BillingService, ReceiptPdfService],
})
export class BillingModule {}

