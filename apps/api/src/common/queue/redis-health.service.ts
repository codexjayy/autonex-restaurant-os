import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export interface RedisStatusReport {
  enabled: boolean;
  status: 'connected' | 'disabled' | 'disconnected';
}

@Injectable()
export class RedisHealthService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisHealthService.name);
  private client: Redis | null = null;
  private loggedConnectionError = false;

  constructor(private readonly configService: ConfigService) {}

  private get isEnabled(): boolean {
    const enabled = this.configService.get<boolean>('REDIS_ENABLED');
    const skip = this.configService.get<boolean>('SKIP_REDIS_CONNECT');
    return Boolean(enabled) && !skip;
  }

  private getOrCreateClient(): Redis | null {
    if (!this.isEnabled) return null;
    if (this.client) return this.client;

    const redisUrl = this.configService.get<string>('REDIS_URL') ?? 'redis://127.0.0.1:6379';
    const client = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 1000,
      retryStrategy: () => null,
    });
    client.on('error', (err) => {
      if (!this.loggedConnectionError) {
        this.loggedConnectionError = true;
        this.logger.warn(
          `Redis health client unavailable: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      }
    });
    this.client = client;
    return this.client;
  }

  async checkStatus(): Promise<RedisStatusReport> {
    if (!this.isEnabled) {
      return { enabled: false, status: 'disabled' };
    }
    const client = this.getOrCreateClient();
    if (!client) {
      return { enabled: false, status: 'disabled' };
    }

    try {
      if (client.status === 'wait') {
        await client.connect();
      }
      const pong = await client.ping();
      return {
        enabled: true,
        status: pong === 'PONG' ? 'connected' : 'disconnected',
      };
    } catch {
      return { enabled: true, status: 'disconnected' };
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      try {
        await this.client.quit();
      } catch {
        this.client.disconnect();
      }
      this.client = null;
    }
  }
}
