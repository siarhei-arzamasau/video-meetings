import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { finished, pipeline } from 'node:stream/promises';

import { ConflictException, Logger } from '@nestjs/common';
import { CommandBus, CommandHandler, ICommandHandler, QueryBus } from '@nestjs/cqrs';
import type { MeetingFile } from '@repo/shared';

import { MeetingFileUploadRepository } from '../../services/meeting-file-upload.repository';
import { chunkKeyOf } from '../../services/meeting-file-upload.mapper';
import type { MeetingFileUploadRecord } from '../../services/meeting-file-upload.mapper';
import { requireOwnedUpload } from '../../services/owned-upload';
import { MeetingFileStorage } from '../../storage/meeting-file-storage';
import { CompleteUploadCommand } from '../complete-upload.command';
import { UploadMeetingFileCommand } from '../upload-meeting-file.command';

export const INCOMPLETE_MESSAGE = 'The upload is incomplete';

/**
 * Assemble, then hand the result to the single-request upload command.
 *
 * Everything that makes a stored file a stored file — the sniff, the `fsync`, the rename, the
 * transaction that enforces the count cap — happens exactly once in the codebase, in
 * `UploadMeetingFileHandler`, and this path goes through it. A `MeetingFile` that arrived in
 * chunks is therefore indistinguishable from one that arrived in a single request, and the
 * type check cannot be skipped by choosing the chunked route.
 *
 * Assembly is a stream, never a buffer: a 1 GiB file is copied chunk by chunk into
 * `<root>/tmp/<uploadId>`, which is on the same filesystem as its destination so the later
 * rename is atomic.
 *
 * **Failure leaves the session exactly as it was.** A 415 for a type the server will not
 * store, a 409 for a meeting that hit the file cap while the bytes were arriving, a lost
 * connection — none of them removes a chunk, so `complete` can be retried without re-sending
 * a gigabyte. Only success purges, and only after the chunks are gone: `purged_at` is set
 * last, so a crash between the two leaves a row the worker will claim and finish.
 */
@CommandHandler(CompleteUploadCommand)
export class CompleteUploadHandler implements ICommandHandler<CompleteUploadCommand, MeetingFile> {
  private readonly logger = new Logger(CompleteUploadHandler.name);

  constructor(
    private readonly queryBus: QueryBus,
    private readonly commandBus: CommandBus,
    private readonly uploads: MeetingFileUploadRepository,
    private readonly storage: MeetingFileStorage,
  ) {}

  async execute({ userId, meetingId, uploadId }: CompleteUploadCommand): Promise<MeetingFile> {
    const upload = await requireOwnedUpload(
      this.queryBus,
      this.uploads,
      userId,
      meetingId,
      uploadId,
    );

    requireEveryChunk(upload);

    const startedAt = Date.now();
    const assembled = await this.assemble(upload);

    // The upload command owns the path from here: it renames it into place or removes it.
    const file = await this.commandBus.execute<UploadMeetingFileCommand, MeetingFile>(
      new UploadMeetingFileCommand(userId, meetingId, upload.name, assembled, upload.size),
    );

    await this.storage.removeTree(uploadId);
    await this.uploads.markPurged(uploadId);

    this.logger.log(
      `Upload ${uploadId} completed as file ${file.id}: ${String(upload.chunkCount)} chunks, ${String(upload.size)} bytes in ${String(Date.now() - startedAt)}ms`,
    );

    return file;
  }

  /**
   * Concatenates the chunks in index order into one temp file and returns its path.
   *
   * The size is checked against the session's afterwards, not trusted: every chunk was the
   * right length when it was acknowledged, but a chunk that lost bytes to a crash between then
   * and now would otherwise produce a record whose `size` is a lie. That is the same answer as
   * a missing chunk, because it is the same situation — the bytes the client sent are not all
   * here.
   */
  private async assemble(upload: MeetingFileUploadRecord): Promise<string> {
    const destination = path.join(this.storage.tempDir(), upload.id);
    const output = createWriteStream(destination);

    try {
      // A reduce rather than a loop with an await in it: the copies must happen in index
      // order, one after another, which is exactly what the workspace's no-await-in-loop rule
      // steers away from. `MeetingFileWorker.runSteps` takes the same shape for the same reason.
      await indexes(upload.chunkCount).reduce(async (previous, index) => {
        await previous;
        await pipeline(this.storage.openRead(chunkKeyOf(upload.id, index)), output, {
          end: false,
        });
      }, Promise.resolve());

      output.end();
      await finished(output);

      if (output.bytesWritten !== upload.size) {
        throw new ConflictException(INCOMPLETE_MESSAGE);
      }
    } catch (error) {
      output.destroy();
      await rm(destination, { force: true });
      throw error;
    }

    return destination;
  }
}

/** `[0, 1, …, count - 1]` — the chunk indexes of a session, in the order they concatenate. */
function indexes(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

/** Every index from 0 to `chunkCount - 1`, or the 409 that tells the client to send the rest. */
function requireEveryChunk(upload: MeetingFileUploadRecord): void {
  const received = new Set(upload.receivedChunks);

  if (indexes(upload.chunkCount).some((index) => !received.has(index))) {
    throw new ConflictException(INCOMPLETE_MESSAGE);
  }
}
