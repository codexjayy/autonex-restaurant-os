import { ConsoleLogger, Injectable } from '@nestjs/common';

@Injectable()
export class StructuredLoggerService extends ConsoleLogger {
  private writeJson(level: string, message: unknown, context?: string, meta?: Record<string, unknown>): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      context: context ?? this.context ?? 'App',
      message: typeof message === 'string' ? message : JSON.stringify(message),
      ...(meta ?? {}),
    };
    const serialized = JSON.stringify(entry);
    if (level === 'error') {
      process.stderr.write(`${serialized}\n`);
    } else {
      process.stdout.write(`${serialized}\n`);
    }
  }

  override log(message: unknown, context?: string): void {
    this.writeJson('info', message, context);
  }

  override warn(message: unknown, context?: string): void {
    this.writeJson('warn', message, context);
  }

  override error(message: unknown, stack?: string, context?: string): void {
    this.writeJson('error', message, context, stack ? { stack } : undefined);
  }

  override debug(message: unknown, context?: string): void {
    if (process.env.NODE_ENV !== 'production') {
      this.writeJson('debug', message, context);
    }
  }
}

