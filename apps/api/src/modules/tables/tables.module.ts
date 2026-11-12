import { Module } from '@nestjs/common';
import { PublicQrController } from './public-qr.controller';
import { QrPdfService } from './qr-pdf.service';
import { TablesController } from './tables.controller';
import { TablesService } from './tables.service';

@Module({
  controllers: [TablesController, PublicQrController],
  providers: [TablesService, QrPdfService],
  exports: [TablesService, QrPdfService],
})
export class TablesModule {}

