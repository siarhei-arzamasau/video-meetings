import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { MEETING_FILE_CHUNK_SIZE_BYTES } from '@repo/shared';
import { raw } from 'express';
import type { NextFunction, Request, Response } from 'express';

import { AuthModule } from '../auth/auth.module';
import { CreateUploadHandler } from './commands/handlers/create-upload.handler';
import { DeleteMeetingFileHandler } from './commands/handlers/delete-meeting-file.handler';
import { StoreChunkHandler } from './commands/handlers/store-chunk.handler';
import { UploadMeetingFileHandler } from './commands/handlers/upload-meeting-file.handler';
import { MeetingFileUploadsController } from './meeting-file-uploads.controller';
import { MeetingFilesController } from './meeting-files.controller';
import { MEETING_FILE_WORKER, MeetingFileWorker } from './processing/meeting-file-worker';
import { ContentSniffer } from './services/content-sniffer';
import { MeetingFileUploadRepository } from './services/meeting-file-upload.repository';
import { MeetingFileUploadsService } from './services/meeting-file-uploads.service';
import { MeetingFileRepository } from './services/meeting-file.repository';
import { MeetingFilesService } from './services/meeting-files.service';
import { MeetingFileStorage } from './storage/meeting-file-storage';
import { MeetingFileUploadInterceptor } from './storage/meeting-file-upload.interceptor';

/**
 * Files attached to meetings: upload, list, download, delete, and the processing worker.
 *
 * Does not import `MeetingsModule`, and that is deliberate: visibility is resolved by
 * dispatching `FindVisibleMeetingQuery`, which the meetings module answers over the bus. The
 * module owns its own table, so `PrismaService` is allowed here.
 */
@Module({
  // Imported per module rather than registered globally, so a module's `imports` states
  // what it actually needs. `AuthModule` is for the guard.
  imports: [CqrsModule, AuthModule],
  // The uploads controller first: `files/uploads/...` must be matched as a session, never as
  // a file id by the routes one segment shorter.
  controllers: [MeetingFileUploadsController, MeetingFilesController],
  // `@CommandHandler` registers nothing on its own: a handler missing from this array
  // compiles and only throws when the route is first hit.
  providers: [
    UploadMeetingFileHandler,
    DeleteMeetingFileHandler,
    CreateUploadHandler,
    StoreChunkHandler,
    MeetingFilesService,
    MeetingFileUploadsService,
    MeetingFileRepository,
    MeetingFileUploadRepository,
    MeetingFileStorage,
    MeetingFileUploadInterceptor,
    ContentSniffer,
    MeetingFileWorker,
    // Also under a string token, so the e2e spec can `app.get('MEETING_FILE_WORKER')` and
    // call `drain()` without importing anything from this module — which is what lets that
    // spec compile, and fail, before the worker exists.
    { provide: MEETING_FILE_WORKER, useExisting: MeetingFileWorker },
  ],
})
export class MeetingFilesModule implements NestModule {
  /**
   * The chunk body is raw bytes, not JSON, so the route needs its own parser with a limit of
   * one chunk — a body over it is rejected before it is buffered, which is the whole reason
   * the limit is here and not a length check in the handler.
   *
   * Scoped to the controller rather than to a path string, so it cannot drift from the route
   * or miss the global `api` prefix, and applied only to `PUT`: the sibling `POST` on the
   * same controller takes JSON and must keep the global body parser's output.
   */
  configure(consumer: MiddlewareConsumer): void {
    const chunk = raw({ type: () => true, limit: MEETING_FILE_CHUNK_SIZE_BYTES });

    consumer
      .apply((request: Request, response: Response, next: NextFunction) => {
        if (request.method !== 'PUT') {
          next();

          return;
        }

        chunk(request, response, next);
      })
      .forRoutes(MeetingFileUploadsController);
  }
}
