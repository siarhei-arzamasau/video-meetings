import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';

import { AuthModule } from '../auth/auth.module';
import { UploadMeetingFileHandler } from './commands/handlers/upload-meeting-file.handler';
import { MeetingFilesController } from './meeting-files.controller';
import { ContentSniffer } from './services/content-sniffer';
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
  controllers: [MeetingFilesController],
  // `@CommandHandler` registers nothing on its own: a handler missing from this array
  // compiles and only throws when the route is first hit.
  providers: [
    UploadMeetingFileHandler,
    MeetingFilesService,
    MeetingFileRepository,
    MeetingFileStorage,
    MeetingFileUploadInterceptor,
    ContentSniffer,
  ],
})
export class MeetingFilesModule {}
