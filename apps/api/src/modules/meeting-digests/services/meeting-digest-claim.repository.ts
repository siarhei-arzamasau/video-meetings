import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { NO_DIGEST_STATUS, replaceContent, settle } from './meeting-digest-claim-writes';
import type { DigestContentWrite, HeldDigest } from './meeting-digest-claim-writes';
import { DigestStatus } from './meeting-digest-status';

const { QUEUED, GENERATING, READY, FAILED } = DigestStatus;

/** A digest row the worker now owns, with the request it was claimed for. */
export interface ClaimedDigest {
  id: string;
  meetingId: string;
  /** Claims, this one included. */
  attempts: number;
  leasedUntil: Date;
  /** `requested_revision` as the claim found it: what the generation is an answer to. */
  requestedRevision: number;
  /** `QUEUED`, or `GENERATING` when this claim took over one whose lease had lapsed. */
  previousStatus: DigestStatus;
}

/**
 * Every write the digest worker makes, each conditional on the row still being `GENERATING`
 * under the lease the caller holds. A write that changes nothing lost its claim — the lease
 * lapsed and another worker took the row — and the caller discards what it produced.
 *
 * **A claim that ends is final only if nobody asked again meanwhile.** `complete`, `fail`,
 * and `clear` write `READY`, `FAILED`, or no status when `requested_revision` is still what
 * the claim took, and `QUEUED` — with a claim count of 0, since the next generation is a new
 * one — when a request moved it. Each answers with what it wrote, so the caller can say
 * which. `release` needs no such condition: it queues the row either way.
 */
@Injectable()
export class MeetingDigestClaimRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Claims the next digest to generate, in one statement.
   *
   * Claimable: a row that is `QUEUED`, or `GENERATING` past its lease — the claim of a worker
   * that died. Picked `FOR UPDATE SKIP LOCKED` and updated in the same statement, so two
   * replicas cannot be handed one meeting; and since a meeting has one row, a meeting never
   * has two generations. Longest-waiting first.
   *
   * Raw for the reason the file claims are: Prisma cannot express `SKIP LOCKED`, and the new
   * lease has to be the database's `now()`, returned by the statement that set it.
   */
  async claimNext(leaseSeconds: number): Promise<ClaimedDigest | null> {
    const rows = await this.prisma.$queryRaw<ClaimedDigest[]>`
      WITH candidate AS (
        SELECT id, status AS previous_status
        FROM "meeting_digests"
        WHERE status = 'QUEUED' OR (status = 'GENERATING' AND leased_until < now())
        ORDER BY updated_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE "meeting_digests" d
      SET status = 'GENERATING',
          leased_until = now() + make_interval(secs => ${leaseSeconds}),
          attempts = d.attempts + 1,
          version = d.version + 1,
          updated_at = now()
      FROM candidate c
      WHERE d.id = c.id
      RETURNING
        d.id,
        d.meeting_id AS "meetingId",
        d.attempts,
        d.leased_until AS "leasedUntil",
        d.requested_revision AS "requestedRevision",
        c.previous_status AS "previousStatus"
    `;

    return rows[0] ?? null;
  }

  /**
   * Extends the lease of a generation this worker still holds, and answers with the lease
   * the row now has — or `null` when the claim is gone. The signature is `LeaseRenewer`'s.
   *
   * **`version` is left alone**: a renewal changes nothing a client is shown.
   */
  async renewLease(id: string, lease: Date | null, leaseSeconds: number): Promise<Date | null> {
    const rows = await this.prisma.$queryRaw<Array<{ leasedUntil: Date }>>`
      UPDATE "meeting_digests"
      SET leased_until = now() + make_interval(secs => ${leaseSeconds}),
          updated_at = now()
      WHERE id = ${id}::uuid
        AND status = 'GENERATING'
        AND leased_until IS NOT DISTINCT FROM ${lease}::timestamptz
      RETURNING leased_until AS "leasedUntil"
    `;

    return rows[0]?.leasedUntil ?? null;
  }

  /**
   * Stores a generation's answer: the summary on the row, and the action items, decisions,
   * and sources in place of whatever was there — in one transaction with the write that ends
   * the claim, so a digest is never half the old content and half the new.
   *
   * **The content is stored even when the row goes back to `QUEUED`.** It is a whole digest
   * of the recordings it names as its sources; the read marks it out of date until the
   * generation that was asked for meanwhile replaces it, which is the PRD's "stays readable,
   * marked as being updated".
   */
  complete(held: HeldDigest, content: DigestContentWrite): Promise<DigestStatus | null> {
    return this.prisma.$transaction(async (tx) => {
      const settledAs = await settle(tx, held, {
        status: READY,
        summary: content.answer.summary,
        generatedAt: new Date(),
      });

      if (settledAs === null) {
        return null;
      }

      await replaceContent(tx, held.id, content);

      return settledAs;
    });
  }

  /**
   * Ends a claim without a digest. `reason` is fixed copy the caller chose, and is stored
   * only if the row ends `FAILED`: a generation that was asked for again meanwhile is queued
   * instead, and the failure of the one it replaces is nobody's to read. The stored content
   * is not touched either way.
   */
  fail(held: HeldDigest, reason: string): Promise<DigestStatus | null> {
    return settle(this.prisma, held, { status: FAILED, failureReason: reason });
  }

  /**
   * `GENERATING → QUEUED`, with the claim uncounted: what a graceful shutdown does with the
   * generation it was in the middle of. A deploy must never be what uses up a digest's three
   * claims. A crash decrements nothing, so those still count.
   */
  async release(id: string, lease: Date): Promise<boolean> {
    const { count } = await this.prisma.meetingDigest.updateMany({
      where: { id, status: GENERATING, leasedUntil: lease },
      data: {
        status: QUEUED,
        leasedUntil: null,
        attempts: { decrement: 1 },
        version: { increment: 1 },
      },
    });

    return count === 1;
  }

  /**
   * `GENERATING →` no status: the claim found no transcribed recording to generate from —
   * the last one was deleted after the generation was asked for. Not a failure, and nothing
   * to try again: the meeting has no digest, as one that never had a recording has none.
   *
   * **Unless a request was made meanwhile**, in which case the row is `QUEUED` like any
   * other claim that was overtaken: a recording was transcribed after this claim looked, and
   * the request it made changed nothing but the revision because the row was `GENERATING`.
   * Answers with which it wrote, or `null` when the claim was no longer the caller's.
   */
  clear(held: HeldDigest): Promise<typeof NO_DIGEST_STATUS | typeof QUEUED | null> {
    return settle(this.prisma, held, { status: NO_DIGEST_STATUS });
  }
}
