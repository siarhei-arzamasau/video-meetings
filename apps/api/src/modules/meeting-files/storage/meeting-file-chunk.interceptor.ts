import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { MEETING_FILE_CHUNK_SIZE_BYTES } from '@repo/shared';
import { raw } from 'express';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';

import type { AuthenticatedRequest } from '../../auth/authenticated-request';
import { CHUNK_LENGTH_MESSAGE } from '../commands/handlers/store-chunk.handler';
import { requireVisibleMeetingBeforeBody } from './visible-meeting-before-body';

/**
 * Reads one chunk's raw body into a `Buffer` — after authentication, never before.
 *
 * **This must not become middleware again.** Middleware runs before guards, so a parser there
 * buffers every `PUT` to a chunk path, up to a whole chunk, before `JwtAuthGuard` can answer
 * 401: an anonymous caller with a made-up path holds 8 MiB of the API's memory per connection.
 * Interceptors run after guards, so the order here is authenticate, resolve the meeting, read.
 *
 * The limit is one chunk, so a longer body is refused before it is buffered. A body that long
 * is the wrong length for every index, so it gets the contract's answer for a chunk of the
 * wrong length rather than a status of its own.
 */
@Injectable()
export class MeetingFileChunkInterceptor implements NestInterceptor {
  /**
   * Any content type, because a chunk is bytes whatever the client labelled it. No inflation:
   * the client never compresses a chunk, and a compressed one would let a few kilobytes on
   * the wire cost a whole chunk of memory.
   */
  private readonly parseChunk = raw({
    type: () => true,
    limit: MEETING_FILE_CHUNK_SIZE_BYTES,
    inflate: false,
  });

  constructor(private readonly queryBus: QueryBus) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();

    await requireVisibleMeetingBeforeBody(this.queryBus, request);
    await this.readChunk(request, http.getResponse<Response>());

    return next.handle();
  }

  private readChunk(request: Request, response: Response): Promise<void> {
    return new Promise((resolve, reject) => {
      this.parseChunk(request, response, (error?: unknown) => {
        if (error === undefined || error === null) {
          resolve();

          return;
        }

        reject(toHttpException(error));
      });
    });
  }
}

/**
 * The parser fails with `http-errors`, which `HttpExceptionFilter` does not recognise and would
 * answer with a 500. Its client errors keep their status; anything else stays a 500.
 */
function toHttpException(error: unknown): unknown {
  const status = statusOf(error);

  if (status === HttpStatus.PAYLOAD_TOO_LARGE) {
    return new BadRequestException(CHUNK_LENGTH_MESSAGE);
  }

  if (status !== undefined && status >= 400 && status < 500 && error instanceof Error) {
    return new HttpException(error.message, status);
  }

  return error;
}

function statusOf(error: unknown): number | undefined {
  const status: unknown = (error as { status?: unknown } | null)?.status;

  return typeof status === 'number' ? status : undefined;
}
