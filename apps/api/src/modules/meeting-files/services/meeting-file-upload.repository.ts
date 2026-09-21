import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import type { MeetingFileUploadRecord } from './meeting-file-upload.mapper';
import { UploadCapReached, type UploadCaps } from './meeting-file-upload-caps';

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
   * Opens a session unless one of the two caps is already reached, in which case nothing is
   * written and the cap that refused it comes back.
   *
   * The meeting's count is of files, not sessions, and the meeting row is locked first for the
   * reason `MeetingFileRepository.createWithinCap` gives. Checking it here is courtesy — it
   * fails a doomed upload before a gigabyte is sent rather than after — and `complete` checks
   * again, which is where that cap is actually enforced.
   *
   * The uploader's count is of sessions that still hold chunks on disk — aborted and expired
   * ones included until the worker has purged them — so abort-and-reopen cannot outrun the
   * worker. It is enforced here and nowhere else, which is why the user row is locked too:
   * two sessions opened at once on two meetings lock different meeting rows. Meeting before
   * user, always, and `NO KEY UPDATE` so the lock does not hold up rows that reference the user.
   */
  createWithinCap(
    data: NewMeetingFileUpload,
    caps: UploadCaps,
  ): Promise<MeetingFileUploadRecord | UploadCapReached> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "meetings" WHERE id = ${data.meetingId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${data.uploaderId}::uuid FOR NO KEY UPDATE`;

        const fileCount = await tx.meetingFile.count({
          where: { meetingId: data.meetingId, status: { not: 'deleted' } },
        });

        if (fileCount >= caps.meetingFiles) {
          return UploadCapReached.MEETING_FILES;
        }

        const openUploadCount = await tx.meetingFileUpload.count({
          where: { uploaderId: data.uploaderId, purgedAt: null },
        });

        if (openUploadCount >= caps.openUploadsPerUploader) {
          return UploadCapReached.OPEN_UPLOADS;
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
   * Brings a live session's expiry forward to now, which is the whole of abort. Returns
   * whether this call was the one that did it, so a second abort can answer 404.
   */
  async expire(id: string): Promise<boolean> {
    const { count } = await this.prisma.meetingFileUpload.updateMany({
      where: { id, purgedAt: null, expiresAt: { gt: new Date() } },
      data: { expiresAt: new Date() },
    });

    return count === 1;
  }

  /**
   * Marks a session's chunks gone and releases its lease. Called after `removeTree`, never
   * before: the row is what says there is still something to remove.
   */
  async markPurged(id: string): Promise<boolean> {
    const { count } = await this.prisma.meetingFileUpload.updateMany({
      where: { id, purgedAt: null },
      data: { purgedAt: new Date(), leasedUntil: null },
    });

    return count === 1;
  }

  /**
   * Claims the next expired, unpurged session for removal, in one statement and under a
   * lease, exactly as `MeetingFileRepository.claimNext` claims a file.
   *
   * `FOR UPDATE SKIP LOCKED` is why two replicas cannot claim one session, and the lease is
   * why a worker that dies mid-removal leaves a row another worker reclaims rather than a
   * chunk tree nobody will ever collect. `attempts` is the bound on that retrying.
   */
  async claimExpired(leaseSeconds: number): Promise<MeetingFileUploadRecord | null> {
    const rows = await this.prisma.$queryRaw<MeetingFileUploadRecord[]>`
      WITH candidate AS (
        SELECT id
        FROM "meeting_file_uploads"
        WHERE expires_at <= now()
          AND purged_at IS NULL
          AND (leased_until IS NULL OR leased_until < now())
        ORDER BY expires_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE "meeting_file_uploads" u
      SET leased_until = now() + make_interval(secs => ${leaseSeconds}),
          attempts = u.attempts + 1
      FROM candidate c
      WHERE u.id = c.id
      RETURNING
        u.id,
        u.meeting_id AS "meetingId",
        u.uploader_id AS "uploaderId",
        u.name,
        u.size,
        u.chunk_size AS "chunkSize",
        u.chunk_count AS "chunkCount",
        u.received_chunks AS "receivedChunks",
        u.attempts,
        u.leased_until AS "leasedUntil",
        u.created_at AS "createdAt",
        u.expires_at AS "expiresAt",
        u.purged_at AS "purgedAt"
    `;

    return rows[0] ?? null;
  }

  /**
   * Claims a live session for one completion, under a lease, in one statement — or `null`
   * when it is not live or another completion already holds it.
   *
   * The same `leased_until` the worker takes before removing an expired session's chunks, and
   * for the same reason: two completions racing for one session must not both assemble it,
   * and the worker must not collect a tree that is being read. `attempts` is left alone — it
   * counts the worker's purge claims, and a completion is not one of those.
   */
  async claimForCompletion(
    id: string,
    leaseSeconds: number,
  ): Promise<MeetingFileUploadRecord | null> {
    const rows = await this.prisma.$queryRaw<MeetingFileUploadRecord[]>`
      UPDATE "meeting_file_uploads" u
      SET leased_until = now() + make_interval(secs => ${leaseSeconds})
      WHERE u.id = ${id}::uuid
        AND u.purged_at IS NULL
        AND u.expires_at > now()
        AND (u.leased_until IS NULL OR u.leased_until < now())
      RETURNING
        u.id,
        u.meeting_id AS "meetingId",
        u.uploader_id AS "uploaderId",
        u.name,
        u.size,
        u.chunk_size AS "chunkSize",
        u.chunk_count AS "chunkCount",
        u.received_chunks AS "receivedChunks",
        u.attempts,
        u.leased_until AS "leasedUntil",
        u.created_at AS "createdAt",
        u.expires_at AS "expiresAt",
        u.purged_at AS "purgedAt"
    `;

    return rows[0] ?? null;
  }

  /**
   * Gives back the lease a completion was given and did not use — a failure before the file
   * existed — so a retry can claim the session at once instead of waiting the lease out.
   *
   * Conditional on the lease being the one this caller holds: a loser whose lease lapsed and
   * went to a later completion must not release that one's.
   */
  async releaseLease({
    id,
    leasedUntil,
  }: Pick<MeetingFileUploadRecord, 'id' | 'leasedUntil'>): Promise<void> {
    if (leasedUntil === null) {
      return;
    }

    await this.prisma.meetingFileUpload.updateMany({
      where: { id, leasedUntil },
      data: { leasedUntil: null },
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
