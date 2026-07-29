import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

export interface ErrorResponseBody {
  statusCode: number;
  message: string | string[];
  /** ISO 8601 timestamp. */
  timestamp: string;
  path: string;
}

/** Normalises every thrown value into one error shape. */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const statusCode =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    if (statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body: ErrorResponseBody = {
      statusCode,
      message: extractMessage(exception, statusCode),
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    response.status(statusCode).json(body);
  }
}

function extractMessage(exception: unknown, statusCode: number): string | string[] {
  if (exception instanceof HttpException) {
    const payload = exception.getResponse();

    if (typeof payload === 'string') {
      return payload;
    }

    if (typeof payload === 'object' && payload !== null && 'message' in payload) {
      return (payload as { message: string | string[] }).message;
    }

    return exception.message;
  }

  // Never leak internals of an unexpected throw to the client.
  return statusCode === HttpStatus.INTERNAL_SERVER_ERROR
    ? 'Internal server error'
    : 'Unexpected error';
}
