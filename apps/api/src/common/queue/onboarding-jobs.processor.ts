import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { ONBOARDING_QUEUE, OnboardingWelcomeJobPayload } from './queue.constants';

@Processor(ONBOARDING_QUEUE)
export class OnboardingJobsProcessor extends WorkerHost {
  private readonly logger = new Logger(OnboardingJobsProcessor.name);

  async process(job: Job<OnboardingWelcomeJobPayload>): Promise<{ processed: true }> {
    this.logger.log(
      `Processed onboarding job id=${job.id ?? 'none'} name=${job.name} tenantId=${job.data.tenantId}`,
    );
    return { processed: true };
  }
}
