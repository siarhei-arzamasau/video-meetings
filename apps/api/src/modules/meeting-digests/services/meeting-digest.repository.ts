import { Injectable } from '@nestjs/common';

import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { MeetingDigestRecord } from './meeting-digest.mapper';

/**
 * The digest row as everybody but the worker touches it: asked for, and read. The writes a
 * worker makes under its lease are `MeetingDigestClaimRepository`'s.
 *
 * The module owns these four tables and reads no other: which recordings are transcribed,
 * and what was said in them, it asks `meeting-files` for over the query bus.
 */
@Injectable()
export class MeetingDigestRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Asks for a generation: makes the meeting's row if there is none, and moves
   * `requested_revision` on if there is. One statement, so two requests that arrive together
   * — two recordings transcribed at once, on two replicas — are two revisions of one row and
   * never a unique violation.
   *
   * **The revision is the whole of the request.** A row that is `GENERATING` stays as it is,
   * lease and claim count included: the generation under way took the revision before this
   * one, so the write that ends it finds the revision moved and leaves the row `QUEUED`
   * instead of `READY`. That is "never two at once, and one more after a change", with no
   * second row and nothing for the worker to be told.
   *
   * Anything else becomes `QUEUED` with a claim count of 0 and no reason: what is asked for
   * is a new generation, not the fourth claim of the last one, and a failure it replaces is
   * no longer what the digest has to say. The stored content is not touched — it stays
   * readable, marked out of date by the read, until a generation replaces it.
   *
   * Raw because Prisma's upsert cannot make an update conditional on the row it finds, and
   * because `@default(uuid())` and `@updatedAt` are the client's: here the database supplies
   * both.
   */
  async request(meetingId: string): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO "meeting_digests" AS d
        (id, meeting_id, status, requested_revision, version, updated_at)
      VALUES
        (gen_random_uuid(), ${meetingId}::uuid, 'QUEUED'::meeting_digest_status, 1, 1, now())
      ON CONFLICT (meeting_id) DO UPDATE
      SET requested_revision = d.requested_revision + 1,
          version = d.version + 1,
          updated_at = now(),
          status = CASE WHEN d.status = 'GENERATING' THEN d.status
                        ELSE 'QUEUED'::meeting_digest_status END,
          attempts = CASE WHEN d.status = 'GENERATING' THEN d.attempts ELSE 0 END,
          failure_reason = CASE WHEN d.status = 'GENERATING' THEN d.failure_reason END,
          leased_until = CASE WHEN d.status = 'GENERATING' THEN d.leased_until END
    `;
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
