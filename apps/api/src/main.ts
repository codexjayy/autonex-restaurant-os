import 'reflect-metadata';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { StructuredLoggerService } from './common/logging/structured-logger.service';

async function bootstrap(): Promise<void> {
  const logger = new StructuredLoggerService('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger,
    rawBody: true,
  });

  const config = app.get(ConfigService);
  const port = Number(config.get<number>('API_PORT') ?? 4000);
  const corsOrigin = config.get<string>('CORS_ORIGIN') ?? 'http://localhost:3000';
  const storageDriver = config.get<'local' | 's3'>('S3_STORAGE_DRIVER') ?? 'local';
  const localUploadDir = path.resolve(config.get<string>('LOCAL_UPLOAD_DIR') ?? './uploads');

  app.setGlobalPrefix('api/v1');
  app.use(
    helmet({
      // Allow Next.js frontend on :3000 to render local WebP menu images served by API in dev
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(cookieParser());
  app.enableCors({
    origin: corsOrigin.split(',').map((o) => o.trim()),
    credentials: true,
  });

  if (storageDriver === 'local') {
    mkdirSync(localUploadDir, { recursive: true });
    app.useStaticAssets(localUploadDir, { prefix: '/uploads/' });
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.listen(port, '0.0.0.0');
  logger.log(`AutoNex API listening on port ${port}`, 'Bootstrap');
}

bootstrap().catch((err) => {
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});

