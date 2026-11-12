import { Controller, Get, Optional } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisHealthService } from '../../common/queue/redis-health.service';

@Controller('health')
export class HealthController {
  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly redisHealth?: RedisHealthService,
  ) {}

  @Public()
  @Get()
  async check() {
    let database: 'connected' | 'disconnected' | 'unknown' = 'unknown';
    if (this.prisma) {
      try {
        await this.prisma.adminClient.$queryRaw`SELECT 1`;
        database = 'connected';
      } catch {
        database = 'disconnected';
      }
    }

    const redis = this.redisHealth
      ? await this.redisHealth.checkStatus()
      : { enabled: false, status: 'disabled' as const };

    return {
      status: 'ok',
      service: 'autonex-api',
      timestamp: new Date().toISOString(),
      dependencies: {
        database,
        redis: redis.status,
      },
    };
  }
}

