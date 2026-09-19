import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler, QueryBus } from '@nestjs/cqrs';

import { MeetingFileRepository } from '../../services/meeting-file.repository';
import type { MeetingFileRecord } from '../../services/meeting-file.mapper';
import { FILE_NOT_FOUND, requireVisibleMeeting } from '../../services/visible-meeting';
import { DeleteMeetingFileCommand } from '../delete-meeting-file.command';

export const CHANGED_MESSAGE = 'The file changed while it was being deleted; try again';

/**
 * Who may delete: the uploader or the host. Anyone else gets the same 404 a guessed id gets —
 * never a 403, which would confirm that a file exists at that id.
 *
 * The delete is a conditional transition on the status the file had when it was read. If
 * zero rows changed, the worker moved it meanwhile (`uploaded → processing`, say); the row is
 * re-read once and the transition retried from its new status. A second miss is a 409 rather
 * than a loop.
 */
@CommandHandler(DeleteMeetingFileCommand)
export class DeleteMeetingFileHandler implements ICommandHandler<DeleteMeetingFileCommand, void> {
  private readonly logger = new Logger(DeleteMeetingFileHandler.name);

  constructor(
    private readonly queryBus: QueryBus,
    private readonly files: MeetingFileRepository,
  ) {}

  async execute({ userId, meetingId, fileId }: DeleteMeetingFileCommand): Promise<void> {
    const meeting = await requireVisibleMeeting(this.queryBus, userId, meetingId);
    const file = await this.visibleFile(meetingId, fileId);

    if (userId !== file.uploaderId && userId !== meeting.hostId) {
      throw new NotFoundException(FILE_NOT_FOUND);
    }

    const startedAt = Date.now();

    if (await this.softDelete(file)) {
      this.logger.log(
        `File ${fileId} of meeting ${meetingId}: ${file.status} -> deleted in ${String(Date.now() - startedAt)}ms`,
      );

      return;
    }

    // Another writer moved it. Re-read once: if it is now deleted the lookup misses (404),
    // else retry from where it actually is. Two explicit attempts rather than a loop, so the
    // bound is visible.
    const moved = await this.visibleFile(meetingId, fileId);

    if (await this.softDelete(moved)) {
      this.logger.log(
        `File ${fileId} of meeting ${meetingId}: ${moved.status} -> deleted in ${String(Date.now() - startedAt)}ms (retried)`,
      );

      return;
    }

    throw new ConflictException(CHANGED_MESSAGE);
  }

  private softDelete(file: MeetingFileRecord): Promise<boolean> {
    return this.files.transition(file.id, file.status, 'deleted', {
      deletedAt: new Date(),
      leasedUntil: null,
    });
  }

  private async visibleFile(meetingId: string, fileId: string): Promise<MeetingFileRecord> {
    const file = await this.files.findOneOf(meetingId, fileId);

    if (file === null) {
      throw new NotFoundException(FILE_NOT_FOUND);
    }

    return file;
  }
}
