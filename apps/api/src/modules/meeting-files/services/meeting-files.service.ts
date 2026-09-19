import { Injectable, NotFoundException } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import type { MeetingFile } from '@repo/shared';

import { MeetingFileRepository } from './meeting-file.repository';
import { toMeetingFile } from './meeting-file.mapper';
import { FILE_NOT_FOUND, requireVisibleMeeting } from './visible-meeting';

/**
 * The read side: list and lookup. Writes are commands in `commands/handlers/`. Every read
 * resolves the meeting first, so a caller who cannot see the meeting learns nothing about
 * its files — including whether a guessed file id exists.
 */
@Injectable()
export class MeetingFilesService {
  constructor(
    private readonly queryBus: QueryBus,
    private readonly files: MeetingFileRepository,
  ) {}

  async findAll(userId: string, meetingId: string): Promise<MeetingFile[]> {
    await requireVisibleMeeting(this.queryBus, userId, meetingId);

    const records = await this.files.findAllOf(meetingId);

    return records.map(toMeetingFile);
  }

  async findOne(userId: string, meetingId: string, fileId: string): Promise<MeetingFile> {
    await requireVisibleMeeting(this.queryBus, userId, meetingId);

    const record = await this.files.findOneOf(meetingId, fileId);

    if (record === null) {
      throw new NotFoundException(FILE_NOT_FOUND);
    }

    return toMeetingFile(record);
  }
}
