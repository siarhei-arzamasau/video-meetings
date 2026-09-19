import { Module } from '@nestjs/common';

import { MeetingFileStorage } from './storage/meeting-file-storage';

/**
 * Files attached to meetings: upload, list, download, delete, and the processing worker.
 *
 * Does not import `MeetingsModule`, and that is deliberate: visibility is resolved by
 * dispatching `FindVisibleMeetingQuery`, which the meetings module answers over the bus. The
 * module owns its own table, so `PrismaService` is allowed here.
 */
@Module({
  providers: [MeetingFileStorage],
})
export class MeetingFilesModule {}
