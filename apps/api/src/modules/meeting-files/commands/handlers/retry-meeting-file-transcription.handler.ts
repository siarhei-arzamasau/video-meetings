import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { CommandHandler, EventBus, ICommandHandler, QueryBus } from '@nestjs/cqrs';
import type { MeetingFile } from '@repo/shared';
import { isMeetingFileTranscriptionTimeLimitReason } from '@repo/shared';

import { MeetingFileChangedEvent } from '../../events/meeting-file-changed.event';
import { TranscriptionStatus } from '../../services/meeting-file-transcription-status';
import { MeetingFileTranscriptionRepository } from '../../services/meeting-file-transcription.repository';
import { MeetingFileRepository } from '../../services/meeting-file.repository';
import { toMeetingFile } from '../../services/meeting-file.mapper';
import type { MeetingFileRecord } from '../../services/meeting-file.mapper';
import { FILE_NOT_FOUND, requireVisibleMeeting } from '../../services/visible-meeting';
import { RetryMeetingFileTranscriptionCommand } from '../retry-meeting-file-transcription.command';

export const TRANSCRIPTION_NOT_FAILED_MESSAGE = 'Only a failed transcription can be retried';
export const TRANSCRIPTION_TIME_LIMIT_MESSAGE =
  'A transcription that outran the time limit cannot be retried';

const { FAILED, QUEUED } = TranscriptionStatus;

/**
 * The one caller of the transcription state machine's `FAILED → QUEUED` edge.
 *
 * Who may retry: the uploader or the host — the pair that may delete the file or retry its
 * processing, for the same reason, and anyone else gets the 404 a guessed id gets rather
 * than a 403.
 *
 * The retry itself is the repository's conditional write from `FAILED`, so a transcription
 * that was never failed, has none at all, or has already been moved by another retry answers
 * 409 instead of being dragged backwards. `transcriptionAttempts` returns to 0: a retry is a
 * fresh chance, not one more claim against the worker's cap of three. The transcription
 * worker then claims the row like any other queued one — nothing here calls the provider.
 *
 * The file is `ready` before and after, and its own columns are not touched. The setting is
 * not asked about either: with transcription switched off the row is queued all the same and
 * waits for the setting to come back, as every queued row does.
 */
@CommandHandler(RetryMeetingFileTranscriptionCommand)
export class RetryMeetingFileTranscriptionHandler implements ICommandHandler<
  RetryMeetingFileTranscriptionCommand,
  MeetingFile
> {
  private readonly logger = new Logger(RetryMeetingFileTranscriptionHandler.name);

  constructor(
    private readonly queryBus: QueryBus,
    private readonly files: MeetingFileRepository,
    private readonly transcriptions: MeetingFileTranscriptionRepository,
    private readonly events: EventBus,
  ) {}

  async execute({
    userId,
    meetingId,
    fileId,
  }: RetryMeetingFileTranscriptionCommand): Promise<MeetingFile> {
    const file = await this.requireManageableFile(userId, meetingId, fileId);

    if (isOutOfTime(file)) {
      throw new ConflictException(TRANSCRIPTION_TIME_LIMIT_MESSAGE);
    }

    const startedAt = Date.now();
    const patch = { transcriptionAttempts: 0, transcriptionFailureReason: null };

    // The lease is `null`: a failed transcription holds none, and the write matches on that.
    if (!(await this.transcriptions.transition(fileId, FAILED, QUEUED, patch, null))) {
      throw new ConflictException(TRANSCRIPTION_NOT_FAILED_MESSAGE);
    }

    this.logger.log(
      `File ${fileId} of meeting ${meetingId}: transcription ${FAILED} -> ${QUEUED} in ${String(Date.now() - startedAt)}ms (retry)`,
    );

    // The row as the write just left it, rather than a re-read: the worker may claim it the
    // same millisecond, and answering `transcribing` would tell the client its retry did
    // something other than what it did.
    const retried = toMeetingFile({
      ...file,
      ...patch,
      transcriptionStatus: QUEUED,
      transcriptionLeasedUntil: null,
    });

    // After the write reported its one row, never before it: the 409 branch above changed
    // nothing and must announce nothing.
    this.events.publish(new MeetingFileChangedEvent(meetingId, retried));

    return retried;
  }

  /**
   * The gate, in the order its answers are owed: a meeting the caller cannot see, then a file
   * that is missing or deleted, then a caller who is neither its uploader nor the host.
   */
  private async requireManageableFile(
    userId: string,
    meetingId: string,
    fileId: string,
  ): Promise<MeetingFileRecord> {
    const meeting = await requireVisibleMeeting(this.queryBus, userId, meetingId);
    const file = await this.files.findOneOf(meetingId, fileId);

    if (file === null) {
      throw new NotFoundException(FILE_NOT_FOUND);
    }

    if (userId !== file.uploaderId && userId !== meeting.hostId) {
      throw new NotFoundException(FILE_NOT_FOUND);
    }

    return file;
  }
}

/**
 * A transcription that failed because it outran the time limit: the one failure this route
 * refuses. Retried, the same recording meets the same limit, while Whisper is still finishing
 * the run that was hung up on. Product's call, 2026-10-08; the row offers no Retry for it.
 */
function isOutOfTime(file: MeetingFileRecord): boolean {
  return (
    file.transcriptionStatus === FAILED &&
    isMeetingFileTranscriptionTimeLimitReason(file.transcriptionFailureReason)
  );
}
