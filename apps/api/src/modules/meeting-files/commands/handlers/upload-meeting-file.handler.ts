import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';

import {
  BadRequestException,
  ConflictException,
  Logger,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler, QueryBus } from '@nestjs/cqrs';
import type { MeetingFile } from '@repo/shared';
import { MAX_MEETING_FILES } from '@repo/shared';

import { ContentSniffer } from '../../services/content-sniffer';
import { MeetingFileRepository } from '../../services/meeting-file.repository';
import { normaliseFileName, storageKeyOf, toMeetingFile } from '../../services/meeting-file.mapper';
import { requireVisibleMeeting } from '../../services/visible-meeting';
import { MeetingFileStorage } from '../../storage/meeting-file-storage';
import { UploadMeetingFileCommand } from '../upload-meeting-file.command';

export const EMPTY_FILE_MESSAGE = 'The file is empty';
export const BAD_NAME_MESSAGE =
  'The file name must be 1–255 characters and contain no path separators';
export const TYPE_MESSAGE = 'That file type is not supported.';
export const COUNT_MESSAGE = `This meeting already has ${String(MAX_MEETING_FILES)} files.`;

/**
 * Bytes first, then one transaction.
 *
 * Validate → sniff → `put` (fsync + rename to `<meetingId>/<fileId>`) → insert inside a
 * transaction that locks the meeting row and counts. The record therefore never points at
 * bytes that are not there, and if the insert fails — the count cap, a lost connection — the
 * renamed object is removed before the error goes out, so bytes never outlive a failed
 * record. The temp file is removed on every exit that did not rename it.
 */
@CommandHandler(UploadMeetingFileCommand)
export class UploadMeetingFileHandler implements ICommandHandler<
  UploadMeetingFileCommand,
  MeetingFile
> {
  private readonly logger = new Logger(UploadMeetingFileHandler.name);

  constructor(
    private readonly queryBus: QueryBus,
    private readonly files: MeetingFileRepository,
    private readonly storage: MeetingFileStorage,
    private readonly sniffer: ContentSniffer,
  ) {}

  async execute(command: UploadMeetingFileCommand): Promise<MeetingFile> {
    try {
      return await this.upload(command);
    } finally {
      // A no-op once `put` has renamed it; on every other exit this is what removes it.
      await rm(command.tempPath, { force: true });
    }
  }

  private async upload({
    userId,
    meetingId,
    originalName,
    tempPath,
    size,
  }: UploadMeetingFileCommand): Promise<MeetingFile> {
    // Visibility first, before the bytes are looked at: a stranger learns nothing, not even
    // that the file would have been rejected.
    await requireVisibleMeeting(this.queryBus, userId, meetingId);

    const name = normaliseFileName(originalName);

    if (name === null) {
      throw new BadRequestException(BAD_NAME_MESSAGE);
    }

    if (size === 0) {
      throw new BadRequestException(EMPTY_FILE_MESSAGE);
    }

    const contentType = await this.sniffer.sniff(tempPath, name);

    if (contentType === null) {
      throw new UnsupportedMediaTypeException(TYPE_MESSAGE);
    }

    const fileId = randomUUID();
    const storageKey = storageKeyOf(meetingId, fileId);

    await this.storage.put(storageKey, tempPath);

    try {
      const record = await this.files.createWithinCap(
        { id: fileId, meetingId, uploaderId: userId, name, contentType, size, storageKey },
        MAX_MEETING_FILES,
      );

      if (record === null) {
        throw new ConflictException(COUNT_MESSAGE);
      }

      this.logger.log(
        `Stored file ${fileId} (${contentType}, ${String(size)} bytes) for meeting ${meetingId}`,
      );

      return toMeetingFile(record);
    } catch (error) {
      // The record was not written, so the bytes must not stay either.
      await this.storage.remove(storageKey);
      throw error;
    }
  }
}
