import { Controller, Get, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { TablesService } from './tables.service';

@Public()
@Throttle({ default: { limit: 30, ttl: 60_000 } })
@Controller('public/qr')
export class PublicQrController {
  constructor(private readonly tablesService: TablesService) {}

  @Get(':token')
  resolveQr(@Param('token') token: string) {
    return this.tablesService.resolvePublicQr(token);
  }
}

