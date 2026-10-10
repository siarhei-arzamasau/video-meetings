import { Injectable } from '@nestjs/common';

import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DigestRequestKind } from './meeting-digest-action';
import type { DigestRequestability, DigestStanding } from './meeting-digest-action';
import { requestGenerationAs } from './meeting-digest-request';
import { reviseContent } from './meeting-digest-revision';
import type { MeetingDigestRevision } from './meeting-digest-revision';
import { followDelete, requestGeneration } from './meeting-digest-writes';
import type { DigestAfterDelete, RecordingsAfterDelete } from './meeting-digest-writes';
import type { DigestStatus } from './meeting-digest-status';
import type { MeetingDigestRecord } from './meeting-digest.mapper';

/** One digest as `findStandings` reads it: the row, with its sources gathered beside it. */
interface StandingRow {
  meetingId: string;
  status: DigestStatus | null;
  /** Empty for a summary that is stored, `null` for none: its text is not loaded. */
  summary: string | null;
  sourceFileIds: string[];
}

/**
 * What became of a retry somebody asked for: refused, or written — and then the row as that
 * write left it, read before the transaction let anybody else at it.
 */
export type DigestRetryRequest =
  | Extract<DigestRequestability, { allowed: false }>
  | (Extract<DigestRequestability, { allowed: true }> & { record: MeetingDigestRecord | null });

/**
 * The digest row as everybody but the worker touches it: asked for, made to follow a deleted
 * file, revised, and read. The writes a worker makes under its lease are
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
   * Asks for a failed digest to be generated again because somebody asked, unless the digest
   * as it stands is not a failed one — `requestGenerationAs`, as a retry, in one transaction
   * with the read of what it wrote. The row stays locked until that read is done, so what is
   * answered is this request's `QUEUED` and not the `GENERATING` of the worker that claims
   * it next.
   */
  requestRetry(
    meetingId: string,
    transcribedFileIds: ReadonlyArray<string>,
  ): Promise<DigestRetryRequest> {
    return this.prisma.$transaction(async (tx) => {
      const request = await requestGenerationAs(
        tx,
        meetingId,
        transcribedFileIds,
        DigestRequestKind.RETRY,
      );

      return request.allowed ? { ...request, record: await readDigest(tx, meetingId) } : request;
    });
  }

  /**
   * Asks for the generation a meeting is owed, unless its digest as it stands is owed none
   * — `requestGenerationAs`, as the catch-up — and answers whether it asked.
   */
  async requestCatchUp(
    meetingId: string,
    transcribedFileIds: ReadonlyArray<string>,
  ): Promise<boolean> {
    const request = await this.prisma.$transaction((tx) =>
      requestGenerationAs(tx, meetingId, transcribedFileIds, DigestRequestKind.CATCH_UP),
    );

    return request.allowed;
  }

  /**
   * Where every digest stands, by meeting: what the catch-up sets beside every meeting's
   * recordings to pass over the digests that are owed nothing. **A list to skip by, never to
   * decide by** — it is one statement over rows that go on changing, and what it lets
   * through is decided again under the row's lock.
   *
   * Raw for the one thing Prisma cannot select: whether a summary is stored, without its
   * text. The rule asks only that, and the text of every digest is not loaded to be told.
   */
  async findStandings(): Promise<Map<string, DigestStanding>> {
    const rows = await this.prisma.$queryRaw<StandingRow[]>`
      SELECT d.meeting_id AS "meetingId",
             d.status,
             CASE WHEN d.summary IS NULL THEN NULL ELSE '' END AS summary,
             COALESCE(
               array_agg(s.meeting_file_id::text) FILTER (WHERE s.meeting_file_id IS NOT NULL),
               '{}'::text[]
             ) AS "sourceFileIds"
      FROM "meeting_digests" d
      LEFT JOIN "meeting_digest_sources" s ON s.digest_id = d.id
      GROUP BY d.id
    `;

    return new Map(
      rows.map(({ meetingId, status, summary, sourceFileIds }) => [
        meetingId,
        { status, summary, sources: sourceFileIds.map((meetingFileId) => ({ meetingFileId })) },
      ]),
    );
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

  /**
   * Puts a summary and decisions in place of the stored ones, in one transaction, and
   * answers whether the meeting had a digest to revise — `reviseContent`.
   */
  revise(meetingId: string, revision: MeetingDigestRevision): Promise<boolean> {
    return this.prisma.$transaction((tx) => reviseContent(tx, meetingId, revision));
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
    return this.prisma.$transaction((tx) => readDigest(tx, meetingId), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }
}

/**
 * The row and its three tables, read through one transaction's client. What makes the four
 * statements one digest is the caller's: a snapshot for `findOf`, the row's lock for a
 * request that has just written it.
 */
async function readDigest(
  tx: Prisma.TransactionClient,
  meetingId: string,
): Promise<MeetingDigestRecord | null> {
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
}
