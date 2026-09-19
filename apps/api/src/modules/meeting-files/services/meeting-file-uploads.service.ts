import { Injectable } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import type { MeetingFileUpload } from '@repo/shared';

import { MeetingFileUploadRepository } from './meeting-file-upload.repository';
import { toMeetingFileUpload } from './meeting-file-upload.mapper';
import { requireOwnedUpload } from './owned-upload';

/**
 * The read side of chunked upload: one lookup, which is what a client calls to learn which
 * chunks it still owes. Writes are commands in `commands/handlers/`, as for files.
 */
@Injectable()
export class MeetingFileUploadsService {
  constructor(
    private readonly queryBus: QueryBus,
    private readonly uploads: MeetingFileUploadRepository,
  ) {}

  async findOne(userId: string, meetingId: string, uploadId: string): Promise<MeetingFileUpload> {
    const upload = await requireOwnedUpload(
      this.queryBus,
      this.uploads,
      userId,
      meetingId,
      uploadId,
    );

    return toMeetingFileUpload(upload);
  }
}
