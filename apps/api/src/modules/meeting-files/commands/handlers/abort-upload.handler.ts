import { Logger, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler, QueryBus } from '@nestjs/cqrs';

import { MeetingFileUploadRepository } from '../../services/meeting-file-upload.repository';
import { UPLOAD_NOT_FOUND, requireOwnedUpload } from '../../services/owned-upload';
import { AbortUploadCommand } from '../abort-upload.command';

/**
 * Abort is expiry, brought forward.
 *
 * Setting `expires_at` to now makes the session invisible to every lookup immediately — a
 * second `DELETE` is a 404, as is a chunk sent afterwards — and leaves the chunk tree to the
 * worker, which already removes expired sessions. One removal path, claimed under a lease, so
 * a client that aborts and disconnects cannot leave bytes nobody will collect.
 */
@CommandHandler(AbortUploadCommand)
export class AbortUploadHandler implements ICommandHandler<AbortUploadCommand, void> {
  private readonly logger = new Logger(AbortUploadHandler.name);

  constructor(
    private readonly queryBus: QueryBus,
    private readonly uploads: MeetingFileUploadRepository,
  ) {}

  async execute({ userId, meetingId, uploadId }: AbortUploadCommand): Promise<void> {
    await requireOwnedUpload(this.queryBus, this.uploads, userId, meetingId, uploadId);

    // Conditional on the session still being live, so two aborts at once yield one 204 and
    // one 404 rather than both claiming to have done it.
    if (!(await this.uploads.expire(uploadId))) {
      throw new NotFoundException(UPLOAD_NOT_FOUND);
    }

    this.logger.log(`Upload ${uploadId} of meeting ${meetingId}: aborted`);
  }
}
