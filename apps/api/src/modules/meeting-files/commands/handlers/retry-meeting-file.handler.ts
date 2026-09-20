import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { CommandHandler, EventBus, ICommandHandler, QueryBus } from '@nestjs/cqrs';
import type { MeetingFile } from '@repo/shared';

import { MeetingFileChangedEvent } from '../../events/meeting-file-changed.event';
import { MeetingFileRepository } from '../../services/meeting-file.repository';
import { toMeetingFile } from '../../services/meeting-file.mapper';
import { FILE_NOT_FOUND, requireVisibleMeeting } from '../../services/visible-meeting';
import { RetryMeetingFileCommand } from '../retry-meeting-file.command';

export const NOT_FAILED_MESSAGE = 'Only a failed file can be retried';

/**
 * The one caller of the state machine's `failed → uploaded` edge.
 *
 * Who may retry: the uploader or the host — the same pair that may delete, for the same
 * reason, and anyone else gets the 404 a guessed id gets rather than a 403.
 *
 * The retry itself is a conditional transition from `failed`, so a row the worker or another
 * retry has already moved answers 409 instead of being dragged backwards. `attempts` returns
 * to 0: a retry is a fresh chance, not a fourth attempt against the worker's cap of three.
 * The worker then claims the row like any other `uploaded` file — nothing here re-runs the
 * pipeline by hand.
 */
@CommandHandler(RetryMeetingFileCommand)
export class RetryMeetingFileHandler implements ICommandHandler<
  RetryMeetingFileCommand,
  MeetingFile
> {
  private readonly logger = new Logger(RetryMeetingFileHandler.name);

  constructor(
    private readonly queryBus: QueryBus,
    private readonly files: MeetingFileRepository,
    private readonly events: EventBus,
  ) {}

  async execute({ userId, meetingId, fileId }: RetryMeetingFileCommand): Promise<MeetingFile> {
    const meeting = await requireVisibleMeeting(this.queryBus, userId, meetingId);
    const file = await this.files.findOneOf(meetingId, fileId);

    if (file === null) {
      throw new NotFoundException(FILE_NOT_FOUND);
    }

    if (userId !== file.uploaderId && userId !== meeting.hostId) {
      throw new NotFoundException(FILE_NOT_FOUND);
    }

    const startedAt = Date.now();
    const patch = {
      attempts: 0,
      failureReason: null,
      processedAt: null,
      // A failed row carries no lease, but clearing it costs nothing and keeps the row's
      // worker columns consistent with a file that has never been claimed.
      leasedUntil: null,
    };

    if (!(await this.files.transition(fileId, 'failed', 'uploaded', patch))) {
      throw new ConflictException(NOT_FAILED_MESSAGE);
    }

    this.logger.log(
      `File ${fileId} of meeting ${meetingId}: failed -> uploaded in ${String(Date.now() - startedAt)}ms (retry)`,
    );

    // The row as the transition just left it, rather than a re-read: a worker may claim it
    // the same millisecond, and answering `processing` would tell the client its retry did
    // something other than what it did.
    const retried = toMeetingFile({ ...file, status: 'uploaded', ...patch });

    // After the transition reported its one row, never before it: the 409 branch above
    // changed nothing and must announce nothing.
    this.events.publish(new MeetingFileChangedEvent(meetingId, retried));

    return retried;
  }
}
