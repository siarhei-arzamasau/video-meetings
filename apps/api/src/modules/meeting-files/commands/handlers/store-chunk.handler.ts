import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler, QueryBus } from '@nestjs/cqrs';

import { describeError } from '../../../../common/error-message';
import { MeetingFileUploadHoldRepository } from '../../services/meeting-file-upload-hold.repository';
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
 *
 * **The move into place happens while the session is held live** (`whileLive`). An abort or
 * an expiry that arrives during it waits, so the purge it leads to finds the chunk and removes
 * it. Moved unheld, a chunk could land in a tree the worker had already removed and marked
 * purged, where nothing would ever look again.
 *
 * **A hold has a time limit, and a move that outlives it finishes unheld.** So a hold that
 * fails is followed up: once the move has settled, the tree of a session that has ended is
 * removed here, because the purge may already have been.
 */
@CommandHandler(StoreChunkCommand)
export class StoreChunkHandler implements ICommandHandler<StoreChunkCommand, void> {
  private readonly logger = new Logger(StoreChunkHandler.name);

  constructor(
    private readonly queryBus: QueryBus,
    private readonly uploads: MeetingFileUploadRepository,
    private readonly holds: MeetingFileUploadHoldRepository,
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

    const isStored = await this.store(uploadId, index, body);

    // The session can end between the lookup and the move, in which case nothing was stored,
    // or between the move and here. That chunk is on disk, and what ended the session waited
    // for it, so the purge that follows removes it. Either way the client is told what a
    // resume would tell it.
    if (!isStored || (await this.uploads.addReceivedChunk(uploadId, index)) === null) {
      throw new NotFoundException(UPLOAD_NOT_FOUND);
    }
  }

  /**
   * The chunk, moved into place under the session's hold: `false`, with nothing moved, for a
   * session that has already ended.
   */
  private async store(uploadId: string, index: number, body: Buffer): Promise<boolean> {
    const tempPath = path.join(this.storage.tempDir(), `chunk-${randomUUID()}`);
    const move: { started?: Promise<void> } = {};

    try {
      await writeFile(tempPath, body);

      return await this.holds.whileLive(uploadId, () => {
        move.started = this.storage.putChunk(chunkKeyOf(uploadId, index), tempPath);

        return move.started;
      });
    } catch (error) {
      await this.removeWhatOutlivedTheHold(uploadId, move.started);

      throw error;
    } finally {
      // A no-op once `putChunk` has renamed it; on every other exit this removes it.
      await rm(tempPath, { force: true });
    }
  }

  /**
   * What is owed after a hold that failed with a move under way. The hold may have run out of
   * time while the move carried on, and a session that ended in that gap has been purged
   * already — so a chunk, or the directory made for it, landing afterwards is one nothing
   * would remove. The move is waited for first, because what it leaves is what has to be
   * judged; then a session that is no longer live loses its tree, and a live one keeps its
   * chunk, which its own purge will find.
   *
   * It never throws: the failure that brought the handler here is the one to report.
   */
  private async removeWhatOutlivedTheHold(
    uploadId: string,
    move: Promise<void> | undefined,
  ): Promise<void> {
    if (move === undefined) {
      return;
    }

    await move.catch(() => undefined);

    try {
      if (!(await this.holds.isLive(uploadId))) {
        await this.storage.removeTree(uploadId);
      }
    } catch (error) {
      this.logger.error(
        `Upload ${uploadId}: could not check what a chunk left behind after its hold failed`,
        describeError(error),
      );
    }
  }
}
