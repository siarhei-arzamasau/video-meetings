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
   */
  async transition(
    id: string,
    from: MeetingFileStatus,
    to: MeetingFileStatus,
    patch: TransitionPatch = {},
  ): Promise<boolean> {
    assertTransition(from, to);

    const { count } = await this.prisma.meetingFile.updateMany({
      where: { id, status: from },
      data: { status: to, ...patch },
    });

    return count === 1;
  }
}
