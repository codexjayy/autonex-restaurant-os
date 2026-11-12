import { Module } from '@nestjs/common';
import { MediaService } from './media.service';
import { MenusController } from './menus.controller';
import { MenusService } from './menus.service';

@Module({
  controllers: [MenusController],
  providers: [MenusService, MediaService],
  exports: [MenusService, MediaService],
})
export class MenusModule {}

