import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
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

  private sanitizeText(value?: string): string | undefined {
    if (!value) return undefined;
    return value.replace(/(postgres(?:ql)?|redis):\/\/[^\s"'`]+/gi, '[REDACTED_URL]');
  }

  private mapPrismaKnownError(exception: Prisma.PrismaClientKnownRequestError): {
    statusCode: number;
    code: string;
    message: string;
    shouldLog: boolean;
  } {
    switch (exception.code) {
      case 'P2002': {
        const target = Array.isArray(exception.meta?.target)
          ? exception.meta.target.join(', ')
          : undefined;
        return {
          statusCode: HttpStatus.CONFLICT,
          code: ErrorCode.CONFLICT,
          message: target
            ? `A record with the same ${target} already exists.`
            : 'A record with these unique details already exists.',
          shouldLog: false,
        };
      }
      case 'P2000':
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          code: ErrorCode.VALIDATION_ERROR,
          message: 'One or more fields exceed the maximum allowed length.',
          shouldLog: false,
        };
      case 'P2003':
      case 'P2011':
      case 'P2012':
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          code: ErrorCode.VALIDATION_ERROR,
          message: 'Invalid or missing referenced database field.',
          shouldLog: false,
        };
      case 'P2025':
        return {
          statusCode: HttpStatus.NOT_FOUND,
          code: ErrorCode.NOT_FOUND,
          message: 'Requested record was not found.',
          shouldLog: false,
        };
      case 'P2021':
      case 'P2022':
        return {
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          code: 'DATABASE_SCHEMA_ERROR',
          message: 'Database schema is missing or out of date. Run Prisma migrations.',
          shouldLog: true,
        };
      case 'P1000':
      case 'P1001':
      case 'P1002':
      case 'P1003':
      case 'P1010':
      case 'P1017':
        return {
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          code: 'DATABASE_UNAVAILABLE',
          message: 'Database connection unavailable. Verify PostgreSQL configuration and status.',
          shouldLog: true,
        };
      default:
        return {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          code: ErrorCode.INTERNAL_ERROR,
          message: 'An unexpected internal error occurred',
          shouldLog: true,
        };
    }
  }

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
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = this.mapPrismaKnownError(exception);
      statusCode = mapped.statusCode;
      code = mapped.code;
      message = mapped.message;
      if (mapped.shouldLog) {
        this.logger.error(
          `Prisma error ${exception.code} [requestId=${requestId}${tenantId ? ` tenantId=${tenantId}` : ''}]`,
          this.sanitizeText(exception.stack),
          'HttpExceptionFilter',
        );
      }
    } else if (exception instanceof Prisma.PrismaClientInitializationError) {
      statusCode = HttpStatus.SERVICE_UNAVAILABLE;
      code = 'DATABASE_UNAVAILABLE';
      message = 'Database connection unavailable. Verify PostgreSQL configuration and status.';
      this.logger.error(
        `Prisma initialization error (${exception.errorCode ?? 'INIT'}) [requestId=${requestId}]`,
        undefined,
        'HttpExceptionFilter',
      );
    } else if (exception instanceof Prisma.PrismaClientUnknownRequestError) {
      statusCode = HttpStatus.SERVICE_UNAVAILABLE;
      code = 'DATABASE_ERROR';
      message = 'Database operation failed unexpectedly.';
      this.logger.error(
        `Prisma unknown request error [requestId=${requestId}${tenantId ? ` tenantId=${tenantId}` : ''}]: ${this.sanitizeText(exception.message) ?? 'unknown'}`,
        this.sanitizeText(exception.stack),
        'HttpExceptionFilter',
      );
    } else if (exception instanceof Prisma.PrismaClientValidationError) {
      statusCode = HttpStatus.BAD_REQUEST;
      code = ErrorCode.VALIDATION_ERROR;
      message = 'Invalid request data for database operation.';
      this.logger.warn(
        `Prisma validation error [requestId=${requestId}${tenantId ? ` tenantId=${tenantId}` : ''}]`,
        'HttpExceptionFilter',
      );
    } else if (exception instanceof Error) {
      this.logger.error(
        `Unhandled error [requestId=${requestId}${tenantId ? ` tenantId=${tenantId}` : ''}]: ${this.sanitizeText(exception.message) ?? 'unknown'}`,
        this.sanitizeText(exception.stack),
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

