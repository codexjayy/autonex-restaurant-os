import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { RealtimeEventsController } from './realtime-events.controller';
import { RealtimeEventsService } from './realtime-events.service';

@Global()
@Module({
  imports: [ConfigModule, JwtModule.register({})],
  controllers: [RealtimeEventsController],
  providers: [RealtimeEventsService],
  exports: [RealtimeEventsService],
})
export class RealtimeEventsModule {}

