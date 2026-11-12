import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { KitchenController } from './kitchen.controller';
import { KitchenGateway } from './kitchen.gateway';
import { KitchenService } from './kitchen.service';
import { OutboxRelayService } from './outbox-relay.service';

@Module({
  imports: [AuthModule],
  controllers: [KitchenController],
  providers: [KitchenService, KitchenGateway, OutboxRelayService],
  exports: [KitchenService, KitchenGateway, OutboxRelayService],
})
export class KitchenModule {}

