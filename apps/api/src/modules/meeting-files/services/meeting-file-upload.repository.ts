import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import type { MeetingFileUploadRecord } from './meeting-file-upload.mapper';

/** What creating a session writes. Everything else takes its default. */
export interface NewMeetingFileUpload {
  meetingId: string;
  uploaderId: string;
  name: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  expiresAt: Date;
}

/**
 * Every read and write of `meeting_file_uploads`, so the raw SQL lives in one place — the
 * same arrangement `MeetingFileRepository` has for files.
 *
 * A session is live when it has not expired and has not been purged. Every lookup here says
 * so, so an expired session is invisible to its owner the moment it lapses, whether or not
 * the worker has got round to removing its chunks.
 */
@Injectable()
export class MeetingFileUploadRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Opens a session unless the meeting already holds `cap` non-deleted files, in which case
   * nothing is written and `null` comes back.
   *
   * The count is of files, not sessions, and the meeting row is locked first for the reason
   * `MeetingFileRepository.createWithinCap` gives. Checking here is courtesy — it fails a
   * doomed upload before a gigabyte is sent rather than after — and `complete` checks again,
   * which is where the cap is actually enforced.
   */
  createWithinCap(
    data: NewMeetingFileUpload,
    cap: number,
  ): Promise<MeetingFileUploadRecord | null> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "meetings" WHERE id = ${data.meetingId}::uuid FOR UPDATE`;

        const count = await tx.meetingFile.count({
          where: { meetingId: data.meetingId, status: { not: 'deleted' } },
        });

        if (count >= cap) {
          return null;
        }

        return tx.meetingFileUpload.create({ data: { ...data, receivedChunks: [] } });
      },
      { maxWait: 10_000, timeout: 15_000 },
    );
  }

  /**
   * The live session with this id, of this meeting, belonging to this user. Every one of the
   * four conditions misses the same way, which is what makes "expired", "someone else's", and
   * "never existed" one 404.
   */
  findOwned(
    meetingId: string,
    uploadId: string,
    uploaderId: string,
  ): Promise<MeetingFileUploadRecord | null> {
    return this.prisma.meetingFileUpload.findFirst({
      where: {
        id: uploadId,
        meetingId,
        uploaderId,
        purgedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
  }

  /**
   * Records that the chunk at `index` is on disk, and returns the whole set as it now stands,
   * or `null` if the session lapsed while the bytes were being written.
   *
   * One statement, because two chunks of one session arrive concurrently: a read-then-write
   * would let the later write drop the earlier one's index. `DISTINCT` makes a resend leave
   * one entry and `ORDER BY` keeps the column in the ascending order the contract promises.
   */
  async addReceivedChunk(id: string, index: number): Promise<number[] | null> {
    const rows = await this.prisma.$queryRaw<Array<{ receivedChunks: number[] }>>`
      UPDATE "meeting_file_uploads"
      SET received_chunks = (
        SELECT coalesce(array_agg(DISTINCT c ORDER BY c), ARRAY[]::int[])
        FROM unnest(received_chunks || ${index}::int) AS c
      )
      WHERE id = ${id}::uuid AND purged_at IS NULL AND expires_at > now()
      RETURNING received_chunks AS "receivedChunks"
    `;

    return rows[0]?.receivedChunks ?? null;
  }
}
