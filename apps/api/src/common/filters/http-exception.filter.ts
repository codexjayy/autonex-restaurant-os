import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ErrorCode } from '@autonex/shared';
import type { Response } from 'express';
import { TenantContextService } from '../context/tenant-context.service';
import { StructuredLoggerService } from '../logging/structured-logger.service';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly logger: StructuredLoggerService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const requestId = this.tenantContext.getRequestId();
    const tenantId = this.tenantContext.get()?.tenantId;

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let code: string = ErrorCode.INTERNAL_ERROR;
    let message = 'An unexpected internal error occurred';
    let details: unknown;

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const body = exception.getResponse();

      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object') {
        const record = body as Record<string, unknown>;
        if (typeof record.code === 'string') code = record.code;
        else if (statusCode === HttpStatus.BAD_REQUEST) code = ErrorCode.VALIDATION_ERROR;
        else if (statusCode === HttpStatus.UNAUTHORIZED) code = ErrorCode.UNAUTHORIZED;
        else if (statusCode === HttpStatus.FORBIDDEN) code = ErrorCode.FORBIDDEN;
        else if (statusCode === HttpStatus.NOT_FOUND) code = ErrorCode.NOT_FOUND;
        else if (statusCode === HttpStatus.CONFLICT) code = ErrorCode.CONFLICT;

        if (Array.isArray(record.message)) {
          message = 'Validation failed';
          details = record.message;
        } else if (typeof record.message === 'string') {
          message = record.message;
        }
        if (record.details !== undefined) {
          details = record.details;
        }
      }
    } else if (exception instanceof Error) {
      this.logger.error(
        `Unhandled error [requestId=${requestId}${tenantId ? ` tenantId=${tenantId}` : ''}]: ${exception.message}`,
        exception.stack,
        'HttpExceptionFilter',
      );
    }

    res.status(statusCode).json({
      statusCode,
      code,
      message,
      ...(details !== undefined ? { details } : {}),
      requestId,
      timestamp: new Date().toISOString(),
    });
  }
}

