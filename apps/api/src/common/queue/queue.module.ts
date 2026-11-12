import { BullModule } from '@nestjs/bullmq';
import { DynamicModule, Global, Module, Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ONBOARDING_QUEUE } from './queue.constants';
import { OnboardingJobsProcessor } from './onboarding-jobs.processor';
import { OnboardingJobsService } from './onboarding-jobs.service';
import { RedisHealthService } from './redis-health.service';

@Global()
@Module({})
export class QueueModule {
  static register(): DynamicModule {
    const isTest = process.env.NODE_ENV === 'test';
    const skipRedis = process.env.SKIP_REDIS_CONNECT === 'true';
    const disabledExplicitly = process.env.REDIS_ENABLED === 'false';
    const enableBull = !isTest && !skipRedis && !disabledExplicitly;

    const imports: DynamicModule['imports'] = [ConfigModule];
    const providers: Provider[] = [RedisHealthService, OnboardingJobsService];

    if (enableBull) {
      imports.push(
        BullModule.forRootAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (config: ConfigService) => {
            const url = new URL(config.get<string>('REDIS_URL') ?? 'redis://127.0.0.1:6379');
            return {
              connection: {
                host: url.hostname,
                port: Number(url.port || 6379),
                password: url.password ? decodeURIComponent(url.password) : undefined,
                username: url.username ? decodeURIComponent(url.username) : undefined,
                maxRetriesPerRequest: null,
                enableReadyCheck: false,
                retryStrategy: (times: number) => Math.min(times * 500, 10_000),
              },
            };
          },
        }),
        BullModule.registerQueue({ name: ONBOARDING_QUEUE }),
      );
      providers.push(OnboardingJobsProcessor);
    }

    return {
      module: QueueModule,
      imports,
      providers,
      exports: [RedisHealthService, OnboardingJobsService],
    };
  }
}

