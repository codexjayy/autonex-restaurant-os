import { Module } from '@nestjs/common';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';
import { SupportCasesService } from './support-cases.service';

@Module({
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService, SupportCasesService],
  exports: [SubscriptionsService, SupportCasesService],
})
export class SubscriptionsModule {}

