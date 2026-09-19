import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { finished, pipeline } from 'node:stream/promises';

import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { CommandBus, CommandHandler, ICommandHandler, QueryBus } from '@nestjs/cqrs';
import type { MeetingFile } from '@repo/shared';

import { MeetingFileUploadRepository } from '../../services/meeting-file-upload.repository';
import { chunkKeyOf } from '../../services/meeting-file-upload.mapper';
import type { MeetingFileUploadRecord } from '../../services/meeting-file-upload.mapper';
import { UPLOAD_NOT_FOUND, requireOwnedUpload } from '../../services/owned-upload';
import { MeetingFileStorage } from '../../storage/meeting-file-storage';
import { CompleteUploadCommand } from '../complete-upload.command';
import { UploadMeetingFileCommand } from '../upload-meeting-file.command';

export const INCOMPLETE_MESSAGE = 'The upload is incomplete';
export const COMPLETING_MESSAGE = 'The upload is already being completed';

/**
 * How long one completion holds the session. Long enough to copy a gigabyte on a slow disk
 * and sniff it; short enough that a process which died mid-completion does not lock its
 * client out of a retry for long. Not the worker's lease: that one is sized for steps that
 * take milliseconds.
 */
export const COMPLETION_LEASE_SECONDS = 5 * 60;

/**
 * Assemble, then hand the result to the single-request upload command.
 *
 * Everything that makes a stored file a stored file — the sniff, the `fsync`, the rename, the
 * transaction that enforces the count cap — happens exactly once in the codebase, in
 * `UploadMeetingFileHandler`, and this path goes through it. A `MeetingFile` that arrived in
 * chunks is therefore indistinguishable from one that arrived in a single request, and the
 * type check cannot be skipped by choosing the chunked route.
 *
 * **The session is claimed before a byte is copied.** Completion takes the row's lease — the
 * same `leased_until` the worker uses — in one conditional statement, so of two completions
 * racing for one session exactly one assembles and the other is a 409. Without that, a client
 * whose connection dropped mid-completion and retried, as it is told it may, would have two
 * completions running and two files at the end. The lease also keeps the worker off the
 * chunks while they are being read, should the session expire mid-assembly.
 *
 * Assembly is a stream, never a buffer: a 1 GiB file is copied chunk by chunk into a temp
 * file of its own under `<root>/tmp`, which is on the same filesystem as its destination so
 * the later rename is atomic. Its name is random, not the session id: two completions must
 * never write into — or remove — one another's file, whatever the lease is doing.
 *
 * **Failure before the file exists leaves the session exactly as it was.** A 415 for a type
 * the server will not store, a 409 for a meeting that hit the file cap while the bytes were
 * arriving, a lost connection — none of them removes a chunk, and each releases the lease, so
 * `complete` can be retried without re-sending a gigabyte. **Once the file exists the session
 * is over**, and it is expired before the chunks go: a retry from then on is a 404, never a
 * second file. `purged_at` is set last, so a crash between the two leaves an expired row the
 * worker claims and finishes once the lease lapses.
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

    // Before the claim, so the common "not yet" answer costs no lease and no release.
    requireEveryChunk(upload);

    const claimed = await this.claim(userId, meetingId, uploadId);
    const startedAt = Date.now();
    let file: MeetingFile;

    try {
      const assembled = await this.assemble(claimed);

      // The upload command owns the path from here: it renames it into place or removes it.
      file = await this.commandBus.execute<UploadMeetingFileCommand, MeetingFile>(
        new UploadMeetingFileCommand(userId, meetingId, claimed.name, assembled, claimed.size),
      );
    } catch (error) {
      // Nothing was created, so the session goes back to what it was — chunks in place, no
      // lease — which is what lets the client retry this call rather than the upload.
      await this.uploads.releaseLease(claimed);
      throw error;
    }

    // The file exists, so the session is over whatever happens next. Expired first, before
    // the chunks go, so a retry of this call — or a second completion that was waiting on
    // the lease — answers 404 rather than assembling a second file. Then the tree, then
    // `purged_at`; a crash anywhere below leaves an expired row the worker will finish.
    await this.uploads.expire(uploadId);
    await this.storage.removeTree(uploadId);
    await this.uploads.markPurged(uploadId);

    this.logger.log(
      `Upload ${uploadId} completed as file ${file.id}: ${String(claimed.chunkCount)} chunks, ${String(claimed.size)} bytes in ${String(Date.now() - startedAt)}ms`,
    );

    return file;
  }

  /**
   * Takes the session's lease for this completion, or throws the answer that says why not.
   *
   * A failed claim means one of two things, and they are different answers: the session
   * lapsed since it was read (404, it is over) or another completion holds it (409, it is in
   * progress and this call should not be repeated until that one has answered). A second
   * lookup tells them apart.
   */
  private async claim(
    userId: string,
    meetingId: string,
    uploadId: string,
  ): Promise<MeetingFileUploadRecord> {
    const claimed = await this.uploads.claimForCompletion(uploadId, COMPLETION_LEASE_SECONDS);

    if (claimed !== null) {
      return claimed;
    }

    if ((await this.uploads.findOwned(meetingId, uploadId, userId)) === null) {
      throw new NotFoundException(UPLOAD_NOT_FOUND);
    }

    throw new ConflictException(COMPLETING_MESSAGE);
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
    const destination = path.join(this.storage.tempDir(), `assemble-${randomUUID()}`);
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
