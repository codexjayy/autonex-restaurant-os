import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import {
  ONBOARDING_JOB_WELCOME,
  ONBOARDING_QUEUE,
  OnboardingWelcomeJobPayload,
} from './queue.constants';

@Injectable()
export class OnboardingJobsService {
  private readonly logger = new Logger(OnboardingJobsService.name);

  constructor(
    private readonly configService: ConfigService,
    @Optional()
    @InjectQueue(ONBOARDING_QUEUE)
    private readonly onboardingQueue?: Queue<OnboardingWelcomeJobPayload>,
  ) {}

  async enqueueWelcomeJob(
    payload: OnboardingWelcomeJobPayload,
  ): Promise<{ queued: boolean; jobId?: string }> {
    const enabled =
      Boolean(this.configService.get<boolean>('REDIS_ENABLED')) &&
      !this.configService.get<boolean>('SKIP_REDIS_CONNECT');

    if (!enabled || !this.onboardingQueue) {
      this.logger.log(
        `Onboarding job skipped (Redis queue disabled) tenantId=${payload.tenantId} outletId=${payload.outletId}`,
      );
      return { queued: false };
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const enqueuePromise = (async (): Promise<{ queued: boolean; jobId?: string }> => {
        const client = await this.onboardingQueue!.client;
        if (client && client.status !== 'ready') {
          this.logger.warn(
            `Onboarding job skipped (Redis status=${client.status}) tenantId=${payload.tenantId}`,
          );
          return { queued: false };
        }

        const job = await this.onboardingQueue!.add(ONBOARDING_JOB_WELCOME, payload, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: 100,
          removeOnFail: 200,
        });
        return { queued: true, jobId: job.id };
      })();
      enqueuePromise.catch(() => undefined);

      return await Promise.race([
        enqueuePromise,
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('Redis enqueue timed out')), 1000);
          timeoutHandle.unref?.();
        }),
      ]);
    } catch (error) {
      this.logger.warn(
        `Failed to enqueue onboarding welcome job for tenant=${payload.tenantId}: ${
          error instanceof Error ? error.message : 'unknown'
        }`,
      );
      return { queued: false };
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}
