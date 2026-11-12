import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { TenantContextService } from './tenant-context.service';

@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(private readonly tenantContext: TenantContextService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const rawHeaderId = req.header('x-request-id');
    const requestId =
      typeof rawHeaderId === 'string' && rawHeaderId.trim().length > 0
        ? rawHeaderId.trim().slice(0, 64)
        : randomUUID();

    res.setHeader('x-request-id', requestId);

    const forwardedFor = req.header('x-forwarded-for');
    const ipAddress =
      typeof forwardedFor === 'string' && forwardedFor.length > 0
        ? forwardedFor.split(',')[0]?.trim()
        : req.ip;

    this.tenantContext.run({ requestId, ipAddress }, () => {
      next();
    });
  }
}

