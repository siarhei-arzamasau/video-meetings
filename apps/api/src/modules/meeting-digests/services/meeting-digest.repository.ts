import { Injectable } from '@nestjs/common';

import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { followDelete, requestGeneration } from './meeting-digest-writes';
import type { DigestAfterDelete, RecordingsAfterDelete } from './meeting-digest-writes';
import type { MeetingDigestRecord } from './meeting-digest.mapper';

/**
 * The digest row as everybody but the worker touches it: asked for, made to follow a deleted
 * file, and read. The writes a worker makes under its lease are
 * `MeetingDigestClaimRepository`'s; what each write here does is in `meeting-digest-writes`.
 *
 * The module owns these four tables and reads no other: which recordings are transcribed,
 * and what was said in them, it asks `meeting-files` for over the query bus.
 */
@Injectable()
export class MeetingDigestRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Asks for a generation — `requestGeneration`, which says what that does to each status. */
  async request(meetingId: string): Promise<void> {
    await requestGeneration(this.prisma, meetingId);
  }

  /**
   * Moves the version of a digest that has content, and answers whether there was one. For a
   * recording transcribed while nothing is asked for: no row changes, but the stored digest
   * no longer covers every recording, so what `GET` answers has — and a client keeps the
   * higher version, which this has to give the new answer.
   */
  async noteUncoveredRecording(meetingId: string): Promise<boolean> {
    const { count } = await this.prisma.meetingDigest.updateMany({
      where: { meetingId, summary: { not: null } },
      data: { version: { increment: 1 } },
    });

    return count === 1;
  }

  /**
   * `requested_revision` of the meeting's digest, or `null` for a meeting that has none —
   * which for a deleted file is the whole answer: there is nothing to follow it.
   */
  async findRevisionOf(meetingId: string): Promise<number | null> {
    const digest = await this.prisma.meetingDigest.findUnique({
      where: { meetingId },
      select: { requestedRevision: true },
    });

    return digest?.requestedRevision ?? null;
  }

  /** Makes the digest follow a deleted file, in one transaction — `followDelete`. */
  followDelete(after: RecordingsAfterDelete): Promise<DigestAfterDelete> {
    return this.prisma.$transaction((tx) => followDelete(tx, after));
  }

  /**
   * The meeting's digest with what the last successful generation stored under it, or `null`
   * for a meeting nobody ever asked a digest for. The lists come back in whatever order the
   * database gives; the mapper orders them by `position`.
   *
   * **One snapshot, which is what the transaction is for.** The row and its three tables are
   * four statements, and at PostgreSQL's default isolation each sees whatever had committed
   * when it began. A generation's `complete` committing between two of them gave a read the
   * earlier summary over the later action items, under the earlier version: the
   * half-and-half digest that `complete`'s own transaction exists to prevent, on the reading
   * side. `REPEATABLE READ` takes its snapshot at the first statement and keeps it; a
   * transaction that only reads never fails to serialise, so there is nothing to retry.
   *
   * **Four awaited reads rather than one `include`**: inside a transaction Prisma sends an
   * include's statements to the one connection together, which `pg` deprecates and will
   * refuse from version 9.
   */
  findOf(meetingId: string): Promise<MeetingDigestRecord | null> {
    return this.prisma.$transaction(
      async (tx) => {
        const digest = await tx.meetingDigest.findUnique({ where: { meetingId } });

        if (digest === null) {
          return null;
        }

        const ofDigest = { where: { digestId: digest.id } };
        const actionItems = await tx.meetingDigestActionItem.findMany(ofDigest);
        const decisions = await tx.meetingDigestDecision.findMany(ofDigest);
        const sources = await tx.meetingDigestSource.findMany({
          ...ofDigest,
          select: { meetingFileId: true },
        });

        return { ...digest, actionItems, decisions, sources };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
