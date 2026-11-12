import { Module } from '@nestjs/common';
import { TablesModule } from '../tables/tables.module';
import { PublicSessionsController } from './public-sessions.controller';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

@Module({
  imports: [TablesModule],
  controllers: [SessionsController, PublicSessionsController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}

