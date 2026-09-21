import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';

import { AuthModule } from '../auth/auth.module';
import { AbortUploadHandler } from './commands/handlers/abort-upload.handler';
import { CompleteUploadHandler } from './commands/handlers/complete-upload.handler';
import { CreateUploadHandler } from './commands/handlers/create-upload.handler';
import { DeleteMeetingFileHandler } from './commands/handlers/delete-meeting-file.handler';
import { RetryMeetingFileHandler } from './commands/handlers/retry-meeting-file.handler';
import { StoreChunkHandler } from './commands/handlers/store-chunk.handler';
import { UploadMeetingFileHandler } from './commands/handlers/upload-meeting-file.handler';
import { MeetingFileUploadsController } from './meeting-file-uploads.controller';
import { MeetingFilesController } from './meeting-files.controller';
import {
  MEETING_FILE_WORKER,
  MeetingFileWorker,
  PIPELINE_STEPS,
} from './processing/meeting-file-worker';
import { buildPipeline } from './processing/pipeline';
import { TranscribeStep } from './processing/steps/transcribe.step';
import { HttpTranscriptionProvider } from './processing/transcription/http-transcription.provider';
import { TRANSCRIPTION_PROVIDER } from './processing/transcription/transcription-provider';
import { ContentSniffer } from './services/content-sniffer';
import { MeetingFileEventsService } from './services/meeting-file-events.service';
import { MeetingFileUploadRepository } from './services/meeting-file-upload.repository';
import { MeetingFileUploadsService } from './services/meeting-file-uploads.service';
import { MeetingFileRepository } from './services/meeting-file.repository';
import { MeetingFilesService } from './services/meeting-files.service';
import { MeetingFileChunkInterceptor } from './storage/meeting-file-chunk.interceptor';
import { MeetingFileStorage } from './storage/meeting-file-storage';
import { MeetingFileUploadInterceptor } from './storage/meeting-file-upload.interceptor';
import { VisibleMeetingGuard } from './visible-meeting.guard';

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
    RetryMeetingFileHandler,
    CreateUploadHandler,
    StoreChunkHandler,
    CompleteUploadHandler,
    AbortUploadHandler,
    MeetingFilesService,
    MeetingFileEventsService,
    MeetingFileUploadsService,
    MeetingFileRepository,
    MeetingFileUploadRepository,
    MeetingFileStorage,
    MeetingFileUploadInterceptor,
    MeetingFileChunkInterceptor,
    VisibleMeetingGuard,
    ContentSniffer,
    TranscribeStep,
    // The port's one implementation. A deployment swaps vendors through
    // TRANSCRIPTION_API_URL; swapping *protocols* is this one line.
    { provide: TRANSCRIPTION_PROVIDER, useClass: HttpTranscriptionProvider },
    // The step list the worker runs. A provider rather than the module-level `PIPELINE`,
    // because the transcription step has dependencies and `pipeline.ts` cannot `new` it.
    {
      provide: PIPELINE_STEPS,
      useFactory: (transcribe: TranscribeStep) => buildPipeline(transcribe),
      inject: [TranscribeStep],
    },
    MeetingFileWorker,
    // Also under a string token, so the e2e spec can `app.get('MEETING_FILE_WORKER')` and
    // call `drain()` without importing anything from this module — which is what lets that
    // spec compile, and fail, before the worker exists.
    { provide: MEETING_FILE_WORKER, useExisting: MeetingFileWorker },
  ],
})
export class MeetingFilesModule {}
