import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler, QueryBus } from '@nestjs/cqrs';

import { MeetingFileUploadRepository } from '../../services/meeting-file-upload.repository';
import { chunkKeyOf, chunkLengthOf } from '../../services/meeting-file-upload.mapper';
import { UPLOAD_NOT_FOUND, requireOwnedUpload } from '../../services/owned-upload';
import { MeetingFileStorage } from '../../storage/meeting-file-storage';
import { StoreChunkCommand } from '../store-chunk.command';

export const CHUNK_INDEX_MESSAGE = 'Chunk index out of range';
export const CHUNK_LENGTH_MESSAGE = 'Chunk length does not match';

/**
 * One chunk, on disk, then acknowledged — in that order, and the order is the whole point.
 *
 * The bytes go to the temp directory first and are moved into place with `putChunk`, so a
 * connection that dies mid-body leaves a temp file rather than a half-written chunk at the
 * key a later `complete` will read. `putChunk` `fsync`s the file and its directory before
 * returning, and only then is the index added to `received_chunks`. A 204 therefore means
 * the bytes survive a power cut, which is what entitles the client to forget them.
 *
 * The length is derived from the session, never believed from the request: a truncated chunk
 * is a 400 rather than a file with a hole in it that only the checksum would catch.
 */
@CommandHandler(StoreChunkCommand)
export class StoreChunkHandler implements ICommandHandler<StoreChunkCommand, void> {
  constructor(
    private readonly queryBus: QueryBus,
    private readonly uploads: MeetingFileUploadRepository,
    private readonly storage: MeetingFileStorage,
  ) {}

  async execute({ userId, meetingId, uploadId, index, body }: StoreChunkCommand): Promise<void> {
    const upload = await requireOwnedUpload(
      this.queryBus,
      this.uploads,
      userId,
      meetingId,
      uploadId,
    );

    if (!Number.isInteger(index) || index < 0 || index >= upload.chunkCount) {
      throw new BadRequestException(CHUNK_INDEX_MESSAGE);
    }

    if (body.length !== chunkLengthOf(upload.size, upload.chunkSize, index)) {
      throw new BadRequestException(CHUNK_LENGTH_MESSAGE);
    }

    const tempPath = path.join(this.storage.tempDir(), `chunk-${randomUUID()}`);

    try {
      await writeFile(tempPath, body);
      await this.storage.putChunk(chunkKeyOf(uploadId, index), tempPath);
    } finally {
      // A no-op once `putChunk` has renamed it; on every other exit this removes it.
      await rm(tempPath, { force: true });
    }

    // The session can lapse between the lookup and here. The chunk is left on disk for the
    // worker's `removeTree` to collect, and the client is told what a resume would tell it.
    if ((await this.uploads.addReceivedChunk(uploadId, index)) === null) {
      throw new NotFoundException(UPLOAD_NOT_FOUND);
    }
  }
}
