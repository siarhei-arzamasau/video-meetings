import { rm } from 'node:fs/promises';

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
} from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { FileInterceptor } from '@nestjs/platform-express';
import { MEETING_FILE_SIZE_MESSAGE } from '@repo/shared';
import type { Request } from 'express';
import { Observable, from } from 'rxjs';
import { catchError } from 'rxjs/operators';

import { mapMulterError } from '../../../common/multer-error';
import type { AuthenticatedRequest } from '../../auth/authenticated-request';
import { MeetingFileStorage } from './meeting-file-storage';
import { meetingFileMulterOptions } from './multipart';
import { requireVisibleMeetingBeforeBody } from './visible-meeting-before-body';

export const FILE_FIELD = 'file';
export const SIZE_MESSAGE = MEETING_FILE_SIZE_MESSAGE;

/**
 * `FileInterceptor('file')` with three things it cannot do on its own.
 *
 * It needs the injected storage for its temp directory, which the decorator form cannot
 * reach, so the multer interceptor is built here at construction.
 *
 * It answers the cheap rejections before the body is read (`requireVisibleMeetingBeforeBody`):
 * without them the whole multipart body — up to 100 MB — would be written to the temp
 * directory for a meeting id that is not a UUID or a meeting the caller cannot see, and only
 * then rejected and removed.
 *
 * And once multer has written a temp file, anything that fails later in the chain — the
 * param pipe, the sniff — would leave it behind; the `catchError` removes it. Multer's own
 * size rejection is mapped to the PRD's copy on the way past, and every multer rejection goes
 * through `mapMulterError` first: Nest 11 recognises them by messages multer 2.4.0 changed, and
 * one it does not recognise would otherwise answer 500.
 */
@Injectable()
export class MeetingFileUploadInterceptor implements NestInterceptor {
  private readonly multer: NestInterceptor;

  constructor(
    storage: MeetingFileStorage,
    private readonly queryBus: QueryBus,
  ) {
    const Multer = FileInterceptor(FILE_FIELD, meetingFileMulterOptions(storage));

    this.multer = new Multer();
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    await requireVisibleMeetingBeforeBody(this.queryBus, request);

    let stream: Observable<unknown>;

    try {
      stream = await this.multer.intercept(context, next);
    } catch (error) {
      await removeTempFile(request);

      const rejection = mapMulterError(error);

      if (rejection instanceof PayloadTooLargeException) {
        throw new PayloadTooLargeException(SIZE_MESSAGE);
      }

      throw rejection;
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
