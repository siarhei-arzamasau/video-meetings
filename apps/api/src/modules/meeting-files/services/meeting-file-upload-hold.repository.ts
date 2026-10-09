import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * How long one hold may last. It lasts as long as a chunk takes to reach the disk — written,
 * `fsync`ed, renamed — so the default five seconds of an interactive transaction is a slow
 * disk away from failing an upload, and a minute is a disk that is not going to answer.
 */
const HOLD_TRANSACTION = { maxWait: 10_000, timeout: 60_000 };

/**
 * Keeps a live upload session from ending while something is being written into it.
 *
 * A session is ended by a write to its row — an abort, a completion, the worker's claim of an
 * expired one — and the worker then removes the session's tree and marks it purged. A chunk
 * that was still on its way to the disk when that happened was renamed into a tree nobody
 * would look at again: the purge had been and gone, and `purged_at` keeps the row from ever
 * being claimed a second time. Up to a chunk of disk, for good, each time an upload was
 * cancelled with a request in flight.
 *
 * `whileLive` closes that by holding the row `FOR SHARE` for as long as the write takes.
 * Everything that ends a session has to write the row, so it waits; the worker's claim skips a
 * locked row and takes it on a later tick. Whatever ends the session therefore does so after
 * the chunk is in place, and the purge that follows removes it with the rest. `FOR SHARE` and
 * not a stronger lock, so two chunks of one session are still written side by side.
 *
 * Kept apart from `MeetingFileUploadRepository`, which is where the rest of this table's SQL
 * lives, because that file is at its size limit.
 */
@Injectable()
export class MeetingFileUploadHoldRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs `write` while the session is held, and answers whether it ran: `false`, having run
   * nothing, for a session that is no longer live.
   *
   * "Live" is by the database's clock, the one every claim reads. `write` must not touch
   * this row through another connection — that statement would wait for this hold to end,
   * and the hold for it.
   */
  whileLive(uploadId: string, write: () => Promise<void>): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const live = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "meeting_file_uploads"
        WHERE id = ${uploadId}::uuid AND purged_at IS NULL AND expires_at > now()
        FOR SHARE
      `;

      if (live.length === 0) {
        return false;
      }

      await write();

      return true;
    }, HOLD_TRANSACTION);
  }
}
