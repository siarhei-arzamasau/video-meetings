import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';

import { AuthModule } from '../auth/auth.module';
import { MeetingFilesController } from './meeting-files.controller';
import { MeetingFileRepository } from './services/meeting-file.repository';
import { MeetingFilesService } from './services/meeting-files.service';
import { MeetingFileStorage } from './storage/meeting-file-storage';

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
  providers: [MeetingFilesService, MeetingFileRepository, MeetingFileStorage],
})
export class MeetingFilesModule {}
