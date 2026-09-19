import { rm } from 'node:fs/promises';

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { Observable, from } from 'rxjs';
import { catchError } from 'rxjs/operators';

import { MeetingFileStorage } from './meeting-file-storage';
import { meetingFileMulterOptions } from './multipart';

export const FILE_FIELD = 'file';
export const SIZE_MESSAGE = 'Files must be 100 MB or smaller.';

/**
 * `FileInterceptor('file')` with two things it cannot do on its own.
 *
 * It needs the injected storage for its temp directory, which the decorator form cannot
 * reach, so the multer interceptor is built here at construction. And once multer has written
 * a temp file, anything that fails later in the chain — the param pipe, the guard's 404 in the
 * handler, the sniff — would leave it behind; the `catchError` removes it. Multer's own size
 * rejection is mapped to the PRD's copy on the way past.
 */
@Injectable()
export class MeetingFileUploadInterceptor implements NestInterceptor {
  private readonly multer: NestInterceptor;

  constructor(storage: MeetingFileStorage) {
    const Multer = FileInterceptor(FILE_FIELD, meetingFileMulterOptions(storage));

    this.multer = new Multer();
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<Request>();

    let stream: Observable<unknown>;

    try {
      stream = await this.multer.intercept(context, next);
    } catch (error) {
      await removeTempFile(request);

      if (error instanceof PayloadTooLargeException) {
        throw new PayloadTooLargeException(SIZE_MESSAGE);
      }

      throw error;
    }

    return stream.pipe(
      catchError((error: unknown) =>
        from(
          removeTempFile(request).then(() => {
            throw error;
          }),
        ),
      ),
    );
  }
}

/** Idempotent, and the handler's own cleanup already removed it on most paths. */
async function removeTempFile(request: Request): Promise<void> {
  const tempPath = request.file?.path;

  if (tempPath !== undefined) {
    await rm(tempPath, { force: true });
  }
}
