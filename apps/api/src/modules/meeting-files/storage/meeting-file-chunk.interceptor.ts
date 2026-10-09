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
import { raw } from 'express';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';

import type { AuthenticatedRequest } from '../../auth/authenticated-request';
import {
  CHUNK_INDEX_MESSAGE,
  CHUNK_LENGTH_MESSAGE,
} from '../commands/handlers/store-chunk.handler';
import { chunkLengthOf, parseChunkIndex } from '../services/meeting-file-upload.mapper';
import type { MeetingFileUploadRecord } from '../services/meeting-file-upload.mapper';
import { MeetingFileUploadRepository } from '../services/meeting-file-upload.repository';
import { requireOwnedUploadBeforeBody } from './owned-upload-before-body';

/**
 * Reads one chunk's raw body into a `Buffer` — after authentication and after the session the
 * chunk is for has been found, never before.
 *
 * **This must not become middleware again.** Middleware runs before guards, so a parser there
 * buffers every `PUT` to a chunk path, up to a whole chunk, before `JwtAuthGuard` can answer
 * 401: an anonymous caller with a made-up path holds 8 MiB of the API's memory per connection.
 * Interceptors run after guards, so the order here is authenticate, resolve the meeting,
 * resolve the session, read.
 *
 * **The session is resolved here and not left to the handler**, which resolves it again. Read
 * first, a signed-in account held the same 8 MiB per connection against a meeting of its own
 * and a session id it made up. What is left is what a session entitles its owner to: one
 * chunk of that session per connection, for as long as the connection is allowed to stall.
 *
 * The limit is the length this chunk has to have, so a longer body is refused before it is
 * buffered and gets the contract's answer for a chunk of the wrong length rather than a status
 * of its own. A shorter one is read — it is smaller than the limit — and refused by the
 * handler.
 */
@Injectable()
export class MeetingFileChunkInterceptor implements NestInterceptor {
  constructor(
    private readonly queryBus: QueryBus,
    private readonly uploads: MeetingFileUploadRepository,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();

    const upload = await requireOwnedUploadBeforeBody(this.queryBus, this.uploads, request);
    const chunkLength = expectedChunkLength(upload, request.params['index']);

    await readChunk(request, http.getResponse<Response>(), chunkLength);

    return next.handle();
  }
}

/**
 * How long the chunk this path names has to be, or the contract's 400 for a path that names no
 * chunk of the session — the answer the controller and the handler give, only before the body.
 */
function expectedChunkLength(upload: MeetingFileUploadRecord, segment: unknown): number {
  const index = typeof segment === 'string' ? parseChunkIndex(segment) : null;

  if (index === null || index >= upload.chunkCount) {
    throw new BadRequestException(CHUNK_INDEX_MESSAGE);
  }

  return chunkLengthOf(upload.size, upload.chunkSize, index);
}

/**
 * Any content type, because a chunk is bytes whatever the client labelled it. No inflation:
 * the client never compresses a chunk, and a compressed one would let a few kilobytes on the
 * wire cost a whole chunk of memory.
 */
function readChunk(request: Request, response: Response, chunkLength: number): Promise<void> {
  const parseChunk = raw({ type: () => true, limit: chunkLength, inflate: false });

  return new Promise((resolve, reject) => {
    parseChunk(request, response, (error?: unknown) => {
      if (error === undefined || error === null) {
        resolve();

        return;
      }

      reject(toHttpException(error));
    });
  });
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
