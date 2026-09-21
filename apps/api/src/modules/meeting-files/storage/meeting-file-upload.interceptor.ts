import { rm } from 'node:fs/promises';

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  ParseUUIDPipe,
  PayloadTooLargeException,
  UnauthorizedException,
} from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { FileInterceptor } from '@nestjs/platform-express';
import { MEETING_FILE_SIZE_MESSAGE } from '@repo/shared';
import type { Request } from 'express';
import { Observable, from } from 'rxjs';
import { catchError } from 'rxjs/operators';

import { mapMulterError } from '../../../common/multer-error';
import type { AuthenticatedRequest } from '../../auth/authenticated-request';
import { requireVisibleMeeting } from '../services/visible-meeting';
import { MeetingFileStorage } from './meeting-file-storage';
import { meetingFileMulterOptions } from './multipart';

export const FILE_FIELD = 'file';
export const SIZE_MESSAGE = MEETING_FILE_SIZE_MESSAGE;

const UUID_V4 = new ParseUUIDPipe({ version: '4' });

/**
 * `FileInterceptor('file')` with three things it cannot do on its own.
 *
 * It needs the injected storage for its temp directory, which the decorator form cannot
 * reach, so the multer interceptor is built here at construction.
 *
 * It answers the two cheap rejections before the body is read. Nest runs interceptors before
 * pipes and the handler, so without this the whole multipart body — up to 100 MB — would be
 * written to the temp directory for a meeting id that is not a UUID or a meeting the caller
 * cannot see, and only then rejected and removed; any signed-in account could make the API
 * write 100 MB per request against a guessed id. The handler checks visibility again, because
 * the command has to be safe whatever transport dispatched it; the second read is one indexed
 * query against a 100 MB write saved.
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

    await this.requireVisibleMeeting(request);

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

  /** The same 400 the param pipe would give and the same 404 the handler would, only earlier. */
  private async requireVisibleMeeting(request: AuthenticatedRequest): Promise<void> {
    // The read `@CurrentUser()` performs, with its throw: on a route the guard did not run on,
    // this fails loudly rather than skipping the check.
    const { user } = request;

    if (user === undefined) {
      throw new UnauthorizedException();
    }

    // Express 5 types a param as `string | string[] | undefined`; anything but one string is
    // not a UUID, and the pipe says so with the same 400 it gives the handler.
    const meetingId = await UUID_V4.transform(String(request.params['id'] ?? ''), {
      type: 'param',
      data: 'id',
    });

    await requireVisibleMeeting(this.queryBus, user.id, meetingId);
  }
}

/** Idempotent, and the handler's own cleanup already removed it on most paths. */
async function removeTempFile(request: Request): Promise<void> {
  const tempPath = request.file?.path;

  if (tempPath !== undefined) {
    await rm(tempPath, { force: true });
  }
}
