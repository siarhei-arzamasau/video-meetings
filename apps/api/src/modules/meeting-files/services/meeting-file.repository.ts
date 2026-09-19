import { Injectable } from '@nestjs/common';
import type { MeetingFileStatus } from '@repo/shared';

import { PrismaService } from '../../prisma/prisma.service';
import { assertTransition } from './meeting-file-status';
import type { MeetingFileRecord } from './meeting-file.mapper';

/** The columns a status change may set alongside the status itself. */
export interface TransitionPatch {
  checksum?: string | null;
  thumbnailKey?: string | null;
  failureReason?: string | null;
  leasedUntil?: Date | null;
  processedAt?: Date | null;
  deletedAt?: Date | null;
}

/** A row the worker now owns, with the status it had before the claim, for the log line. */
export interface ClaimedFile extends MeetingFileRecord {
  previousStatus: MeetingFileStatus;
}

/** What an upload writes. Everything else takes its default. */
export interface NewMeetingFile {
  id: string;
  meetingId: string;
  uploaderId: string;
  name: string;
  contentType: string;
  size: number;
  storageKey: string;
}

/**
 * Every write to `meeting_files`, so the status guard and the raw SQL live in one place.
 *
 * Reads that the service and the handlers need are here too, filtered the same way: a
 * `deleted` row is invisible to every caller but the worker.
 */
@Injectable()
export class MeetingFileRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Every non-deleted file of a meeting, newest first, `id` descending as the tie-break. */
  findAllOf(meetingId: string): Promise<MeetingFileRecord[]> {
    return this.prisma.meetingFile.findMany({
      where: { meetingId, status: { not: 'deleted' } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  /** One non-deleted file, scoped to its meeting: another meeting's id misses. */
  findOneOf(meetingId: string, fileId: string): Promise<MeetingFileRecord | null> {
    return this.prisma.meetingFile.findFirst({
      where: { id: fileId, meetingId, status: { not: 'deleted' } },
    });
  }

  /**
   * Inserts a file unless the meeting already holds `cap` non-deleted ones, in which case
   * nothing is written and `null` comes back.
   *
   * The meeting row is locked first (`FOR UPDATE`), which serialises concurrent uploads to
   * one meeting: two requests at the edge of the cap cannot both pass the count, because the
   * second one's count waits for the first one's insert to commit. That is the PRD's "enforced
   * in a transaction, not by a read-then-write". The lock is on the meeting, so uploads to
   * different meetings do not wait on each other.
   */
  createWithinCap(data: NewMeetingFile, cap: number): Promise<MeetingFileRecord | null> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "meetings" WHERE id = ${data.meetingId}::uuid FOR UPDATE`;

        const count = await tx.meetingFile.count({
          where: { meetingId: data.meetingId, status: { not: 'deleted' } },
        });

        if (count >= cap) {
          return null;
        }

        return tx.meetingFile.create({ data });
      },
      // Fifty uploads racing for one meeting's lock queue behind each other and behind the
      // connection pool; the defaults (2 s / 5 s) are too tight for that and too tight for
      // nothing else.
      { maxWait: 10_000, timeout: 15_000 },
    );
  }

  /**
   * The optimistic guard every status change goes through: a conditional update on the
   * status the caller believes the row has. Returns whether one row changed — `false` means
   * another writer (a worker, a delete) moved it first, and the caller decides what that means.
   *
   * A worker also passes the `lease` its claim was given. A re-claim after lease expiry keeps
   * the status at `processing`, so status alone cannot tell the current lease holder from the
   * one it replaced; matching `leased_until` too is what makes a stale worker's result the
   * one that is discarded, rather than whichever finishes first.
   */
  async transition(
    id: string,
    from: MeetingFileStatus,
    to: MeetingFileStatus,
    patch: TransitionPatch = {},
    lease?: Date | null,
  ): Promise<boolean> {
    assertTransition(from, to);

    const { count } = await this.prisma.meetingFile.updateMany({
      where: { id, status: from, ...(lease === undefined ? {} : { leasedUntil: lease }) },
      data: { status: to, ...patch },
    });

    return count === 1;
  }

  /**
   * Claims the next row a worker should handle, in one statement.
   *
   * The candidate is picked `FOR UPDATE SKIP LOCKED` and updated in the same statement, so
   * two replicas cannot claim one row, and a worker that dies leaves a row whose lease
   * expires and is reclaimed. Claimable: `uploaded`; `processing` past its lease; `deleted`
   * not yet purged and not leased. A deleted row keeps its status — only the lease and the
   * attempt count move — because `deleted` is terminal and the claim is for the purge.
   *
   * Prisma's query builder cannot express this, which is why it is the one raw statement in
   * the module. The column aliases turn the row into `MeetingFileRecord`; timestamps come
   * back as `Date`s from the driver.
   */
  async claimNext(leaseSeconds: number): Promise<ClaimedFile | null> {
    const rows = await this.prisma.$queryRaw<ClaimedFile[]>`
      WITH candidate AS (
        SELECT id, status AS previous_status
        FROM "meeting_files"
        WHERE status = 'uploaded'
           OR (status = 'processing' AND leased_until < now())
           OR (status = 'deleted' AND purged_at IS NULL
               AND (leased_until IS NULL OR leased_until < now()))
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE "meeting_files" f
      SET status = CASE WHEN f.status = 'deleted' THEN f.status ELSE 'processing'::meeting_file_status END,
          leased_until = now() + make_interval(secs => ${leaseSeconds}),
          attempts = f.attempts + 1
      FROM candidate c
      WHERE f.id = c.id
      RETURNING
        f.id,
        f.meeting_id AS "meetingId",
        f.uploader_id AS "uploaderId",
        f.name,
        f.content_type AS "contentType",
        f.size,
        f.storage_key AS "storageKey",
        f.checksum,
        f.thumbnail_key AS "thumbnailKey",
        f.status,
        f.failure_reason AS "failureReason",
        f.attempts,
        f.leased_until AS "leasedUntil",
        f.created_at AS "createdAt",
        f.processed_at AS "processedAt",
        f.deleted_at AS "deletedAt",
        f.purged_at AS "purgedAt",
        c.previous_status AS "previousStatus"
    `;

    return rows[0] ?? null;
  }

  /** Marks a deleted row's bytes gone and releases its lease. Returns whether the row was still deleted. */
  async markPurged(id: string): Promise<boolean> {
    const { count } = await this.prisma.meetingFile.updateMany({
      where: { id, status: 'deleted' },
      data: { purgedAt: new Date(), leasedUntil: null },
    });

    return count === 1;
  }
}
