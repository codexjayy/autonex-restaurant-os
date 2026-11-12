import { Global, Module } from '@nestjs/common';
import { TenantContextService } from '../context/tenant-context.service';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [TenantContextService, PrismaService],
  exports: [TenantContextService, PrismaService],
})
export class PrismaModule {}

