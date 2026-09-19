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
