import type { ReadStream } from 'node:fs';

import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import type { MeetingFile } from '@repo/shared';

import { MeetingFileStorage } from '../storage/meeting-file-storage';
import { MeetingFileRepository } from './meeting-file.repository';
import { toMeetingFile } from './meeting-file.mapper';
import type { MeetingFileRecord } from './meeting-file.mapper';
import { FILE_NOT_FOUND, requireVisibleMeeting } from './visible-meeting';

export const THUMBNAIL_NOT_FOUND = 'Thumbnail not found';
export const OBJECT_MISSING = 'The stored file is missing';
export const THUMBNAIL_TYPE = 'image/webp';

/** What the controller needs to stream an object: the headers' inputs and the bytes. */
export interface OpenedFile {
  /** The display name, for `Content-Disposition`. */
  name: string;
  contentType: string;
  /** Bytes, for `Content-Length`. */
  size: number;
  stream: ReadStream;
}

/**
 * The read side: list, lookup, and the two streams. Writes are commands in
 * `commands/handlers/`. Every read resolves the meeting first, so a caller who cannot see the
 * meeting learns nothing about its files — including whether a guessed file id exists.
 */
@Injectable()
export class MeetingFilesService {
  constructor(
    private readonly queryBus: QueryBus,
    private readonly files: MeetingFileRepository,
    private readonly storage: MeetingFileStorage,
  ) {}

  async findAll(userId: string, meetingId: string): Promise<MeetingFile[]> {
    await requireVisibleMeeting(this.queryBus, userId, meetingId);

    const records = await this.files.findAllOf(meetingId);

    return records.map(toMeetingFile);
  }

  async findOne(userId: string, meetingId: string, fileId: string): Promise<MeetingFile> {
    return toMeetingFile(await this.visibleRecord(userId, meetingId, fileId));
  }

  /**
   * The original bytes, in any status but `deleted` (which the lookup already filters): a file
   * whose processing failed is still the user's file.
   */
  async openContent(userId: string, meetingId: string, fileId: string): Promise<OpenedFile> {
    const record = await this.visibleRecord(userId, meetingId, fileId);

    return {
      name: record.name,
      contentType: record.contentType,
      size: record.size,
      stream: await this.openObject(record.storageKey),
    };
  }

  async openThumbnail(userId: string, meetingId: string, fileId: string): Promise<OpenedFile> {
    const record = await this.visibleRecord(userId, meetingId, fileId);

    if (record.thumbnailKey === null) {
      throw new NotFoundException(THUMBNAIL_NOT_FOUND);
    }

    const { size } = await this.statObject(record.thumbnailKey);

    return {
      name: `${record.name}.thumb.webp`,
      contentType: THUMBNAIL_TYPE,
      size,
      stream: await this.openObject(record.thumbnailKey),
    };
  }

  private async visibleRecord(
    userId: string,
    meetingId: string,
    fileId: string,
  ): Promise<MeetingFileRecord> {
    await requireVisibleMeeting(this.queryBus, userId, meetingId);

    const record = await this.files.findOneOf(meetingId, fileId);

    if (record === null) {
      throw new NotFoundException(FILE_NOT_FOUND);
    }

    return record;
  }

  /**
   * Checks the object exists before the stream is opened. A `createReadStream` on a missing
   * path only fails once the response is already being written, which leaves the client with
   * headers and no body; a `stat` up front turns that into an ordinary 500 with an error body.
   */
  private async openObject(key: string): Promise<ReadStream> {
    await this.statObject(key);

    return this.storage.openRead(key);
  }

  private async statObject(key: string): Promise<{ size: number }> {
    try {
      return await this.storage.stat(key);
    } catch (error) {
      throw new InternalServerErrorException(OBJECT_MISSING, { cause: error });
    }
  }
}
