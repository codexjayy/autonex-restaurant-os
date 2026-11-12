import { Module } from '@nestjs/common';
import { TablesModule } from '../tables/tables.module';
import { OrderingController } from './ordering.controller';
import { OrderingService } from './ordering.service';
import { PublicOrderingController } from './public-ordering.controller';

@Module({
  imports: [TablesModule],
  controllers: [OrderingController, PublicOrderingController],
  providers: [OrderingService],
  exports: [OrderingService],
})
export class OrderingModule {}

