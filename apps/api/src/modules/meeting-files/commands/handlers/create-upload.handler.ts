import {
  BadRequestException,
  ConflictException,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CommandHandler, ICommandHandler, QueryBus } from '@nestjs/cqrs';
import type { MeetingFileUpload } from '@repo/shared';
import {
  MAX_CHUNKED_MEETING_FILE_SIZE_BYTES,
  MAX_MEETING_FILES,
  MEETING_FILE_CHUNKED_SIZE_MESSAGE,
  MEETING_FILE_CHUNK_SIZE_BYTES,
} from '@repo/shared';

import { UploadCapReached } from '../../services/meeting-file-upload-caps';
import { MeetingFileUploadRepository } from '../../services/meeting-file-upload.repository';
import {
  type MeetingFileUploadRecord,
  chunkCountOf,
  toMeetingFileUpload,
} from '../../services/meeting-file-upload.mapper';
import { normaliseFileName } from '../../services/meeting-file.mapper';
import { requireVisibleMeeting } from '../../services/visible-meeting';
import { BAD_NAME_MESSAGE, COUNT_MESSAGE } from './upload-meeting-file.handler';
import { CreateUploadCommand } from '../create-upload.command';

export const SIZE_POSITIVE_MESSAGE = 'The file size must be a positive number of bytes';
export const CHUNKED_SIZE_MESSAGE = MEETING_FILE_CHUNKED_SIZE_MESSAGE;

/**
 * Unpurged sessions one user may hold across every meeting. The web client sends one file at a
 * time, so this is headroom for abandoned sessions, not for parallel uploads. It is what bounds
 * the disk one account can fill with chunks it never completes: without it, sessions count
 * against no cap at all until `complete`, and an uploader need never call that.
 */
export const MAX_OPEN_UPLOADS_PER_UPLOADER = 5;
export const OPEN_UPLOADS_MESSAGE = `You already have ${String(MAX_OPEN_UPLOADS_PER_UPLOADER)} unfinished uploads. Finish or cancel one, or try again once they expire.`;

/** Hours a session stays open. Validated in `env.validation.ts`; restated as the fallback. */
const DEFAULT_TTL_HOURS = 24;

/**
 * Opens a session: validate everything that can be judged from the declaration alone, then
 * write one row. No chunk directory is created here — the first chunk's `putChunk` makes it —
 * so an abandoned session that never sent a byte costs a row and nothing on disk.
 *
 * The name rule and the file-count message are Phase 1's, imported rather than restated: a
 * client must not be able to tell the two upload paths apart by the words they reject with.
 * The size rules are this path's own, because this is the path with a different cap.
 */
@CommandHandler(CreateUploadCommand)
export class CreateUploadHandler implements ICommandHandler<
  CreateUploadCommand,
  MeetingFileUpload
> {
  private readonly logger = new Logger(CreateUploadHandler.name);
  private readonly ttlHours: number;

  constructor(
    config: ConfigService,
    private readonly queryBus: QueryBus,
    private readonly uploads: MeetingFileUploadRepository,
  ) {
    this.ttlHours = config.get<number>('MEETING_FILE_UPLOAD_TTL_HOURS', DEFAULT_TTL_HOURS);
  }

  async execute({
    userId,
    meetingId,
    originalName,
    size,
  }: CreateUploadCommand): Promise<MeetingFileUpload> {
    await requireVisibleMeeting(this.queryBus, userId, meetingId);

    const name = normaliseFileName(originalName);

    if (name === null) {
      throw new BadRequestException(BAD_NAME_MESSAGE);
    }

    if (!Number.isInteger(size) || size <= 0) {
      throw new BadRequestException(SIZE_POSITIVE_MESSAGE);
    }

    if (size > MAX_CHUNKED_MEETING_FILE_SIZE_BYTES) {
      throw new PayloadTooLargeException(CHUNKED_SIZE_MESSAGE);
    }

    const record = await this.openSession(userId, meetingId, name, size);

    this.logger.log(
      `Opened upload ${record.id} for meeting ${meetingId}: ${String(size)} bytes in ${String(record.chunkCount)} chunks`,
    );

    return toMeetingFileUpload(record);
  }

  /** Writes the session, turning either cap the repository refused on into its 409. */
  private async openSession(
    userId: string,
    meetingId: string,
    name: string,
    size: number,
  ): Promise<MeetingFileUploadRecord> {
    const chunkSize = MEETING_FILE_CHUNK_SIZE_BYTES;
    const record = await this.uploads.createWithinCap(
      {
        meetingId,
        uploaderId: userId,
        name,
        size,
        chunkSize,
        chunkCount: chunkCountOf(size, chunkSize),
        expiresAt: new Date(Date.now() + this.ttlHours * 60 * 60 * 1_000),
      },
      { meetingFiles: MAX_MEETING_FILES, openUploadsPerUploader: MAX_OPEN_UPLOADS_PER_UPLOADER },
    );

    if (record === UploadCapReached.MEETING_FILES) {
      throw new ConflictException(COUNT_MESSAGE);
    }

    if (record === UploadCapReached.OPEN_UPLOADS) {
      throw new ConflictException(OPEN_UPLOADS_MESSAGE);
    }

    return record;
  }
}
