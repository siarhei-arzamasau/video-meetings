import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import {
  TranscriptionStatus,
  assertTranscriptionTransition,
} from './meeting-file-transcription-status';
import type { MeetingFileRecord } from './meeting-file.mapper';

/** The columns a transcription's change of status may set alongside the status itself. */
export interface TranscriptionPatch {
  transcriptKey?: string | null;
  transcriptionFailureReason?: string | null;
  /** Only the retry sets this, back to 0; every other writer leaves the claim count alone. */
  transcriptionAttempts?: number;
}

/** What `write` may set: a patch, or the one decrement — `release`'s — in place of a count. */
type TranscriptionWrite = Omit<TranscriptionPatch, 'transcriptionAttempts'> & {
  transcriptionAttempts?: number | { decrement: number };
};

/** A row the transcription worker now owns, with the status it had before the claim. */
export interface ClaimedTranscription extends MeetingFileRecord {
  /** `QUEUED`, or `TRANSCRIBING` when this claim took over one whose lease had lapsed. */
  previousTranscriptionStatus: TranscriptionStatus;
}

/**
 * Every write to a transcription's status once it has one, so the edge guard, the "file must
 * still be `ready`" condition, and the raw SQL live in one place. Getting a status in the
 * first place is `MeetingFileRepository`'s: it is a column of the `processing → ready` write.
 *
 * The same table as the file, with a lease and a claim count of its own
 * (`transcription_leased_until`, `transcription_attempts`). The file's `leased_until` and
 * `attempts` cannot be shared: the purge claims on them and a delete resets them.
 *
 * **Every write here requires `status = 'ready'`.** That one condition is what makes a delete
 * mid-transcription safe without the delete knowing anything about transcription: the row
 * stops being `ready`, the next renewal finds nothing, and the result has nowhere to land.
 */
@Injectable()
export class MeetingFileTranscriptionRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Claims the next recording to transcribe, in one statement.
   *
   * Claimable: a `ready` file whose transcription is `QUEUED`, or `TRANSCRIBING` past its
   * lease — the claim of a worker that died. The candidate is picked `FOR UPDATE SKIP LOCKED`
   * and updated in the same statement, so two replicas cannot be handed one recording.
   *
   * Raw for the reason `MeetingFileRepository.claimNext` is, and with the same obligation:
   * **every column of `MeetingFileRecord` is listed**, because the worker's events are built
   * from this row and a column left out is `undefined`, not `null`.
   */
  async claimNext(leaseSeconds: number): Promise<ClaimedTranscription | null> {
    const rows = await this.prisma.$queryRaw<ClaimedTranscription[]>`
      WITH candidate AS (
        SELECT id, transcription_status AS previous_transcription_status
        FROM "meeting_files"
        WHERE status = 'ready'
          AND (transcription_status = 'QUEUED'
               OR (transcription_status = 'TRANSCRIBING' AND transcription_leased_until < now()))
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE "meeting_files" f
      SET transcription_status = 'TRANSCRIBING',
          transcription_leased_until = now() + make_interval(secs => ${leaseSeconds}),
          transcription_attempts = f.transcription_attempts + 1
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
        f.transcript_key AS "transcriptKey",
        f.status,
        f.failure_reason AS "failureReason",
        f.attempts,
        f.leased_until AS "leasedUntil",
        f.created_at AS "createdAt",
        f.processed_at AS "processedAt",
        f.deleted_at AS "deletedAt",
        f.purged_at AS "purgedAt",
        f.transcription_status AS "transcriptionStatus",
        f.transcription_failure_reason AS "transcriptionFailureReason",
        f.transcription_attempts AS "transcriptionAttempts",
        f.transcription_leased_until AS "transcriptionLeasedUntil",
        c.previous_transcription_status AS "previousTranscriptionStatus"
    `;

    return rows[0] ?? null;
  }

  /**
   * Extends the lease of a transcription this worker still holds, and answers with the lease
   * the row now has — or `null` when it is no longer ours: the file was deleted, or the lease
   * lapsed and another worker took the claim. The signature is `LeaseRenewer`'s, so the
   * heartbeat the file worker uses drives this one unchanged.
   *
   * Raw so the new lease is the database's `now()` and comes back in the same statement.
   */
  async renewLease(id: string, lease: Date | null, leaseSeconds: number): Promise<Date | null> {
    const rows = await this.prisma.$queryRaw<Array<{ leasedUntil: Date }>>`
      UPDATE "meeting_files"
      SET transcription_leased_until = now() + make_interval(secs => ${leaseSeconds})
      WHERE id = ${id}::uuid
        AND status = 'ready'
        AND transcription_status = 'TRANSCRIBING'
        AND transcription_leased_until IS NOT DISTINCT FROM ${lease}::timestamptz
      RETURNING transcription_leased_until AS "leasedUntil"
    `;

    return rows[0]?.leasedUntil ?? null;
  }

  /**
   * Moves a transcription along one edge, if the row is still where the caller believes it
   * is: the file `ready`, the transcription in `from`, and the lease the one given — `null`
   * for a row that holds none. Returns whether one row changed; `false` means the file was
   * deleted or the claim reclaimed, and the caller discards what it produced — or, for the
   * retry, that the transcription is not failed, which is its 409.
   *
   * The lease comes off on every edge, since none of them ends in `TRANSCRIBING`.
   */
  async transition(
    id: string,
    from: TranscriptionStatus,
    to: TranscriptionStatus,
    patch: TranscriptionPatch,
    lease: Date | null,
  ): Promise<boolean> {
    if (from === TranscriptionStatus.TRANSCRIBING && to === TranscriptionStatus.QUEUED) {
      throw new Error('Handing a transcription claim back is `release`, which uncounts it');
    }

    return this.write(id, from, to, patch, lease);
  }

  /**
   * `TRANSCRIBING → QUEUED`, with the claim uncounted: what a graceful shutdown does with the
   * transcription it was in the middle of. Its own method because of the decrement — a deploy
   * is expected to land on a transcription that runs for minutes, and must never be what
   * uses up a recording's three claims. A crash decrements nothing, so those still count.
   */
  release(id: string, lease: Date | null): Promise<boolean> {
    return this.write(
      id,
      TranscriptionStatus.TRANSCRIBING,
      TranscriptionStatus.QUEUED,
      { transcriptionAttempts: { decrement: 1 } },
      lease,
    );
  }

  private async write(
    id: string,
    from: TranscriptionStatus,
    to: TranscriptionStatus,
    patch: TranscriptionWrite,
    lease: Date | null,
  ): Promise<boolean> {
    assertTranscriptionTransition(from, to);

    const { count } = await this.prisma.meetingFile.updateMany({
      where: { id, status: 'ready', transcriptionStatus: from, transcriptionLeasedUntil: lease },
      data: { transcriptionStatus: to, transcriptionLeasedUntil: null, ...patch },
    });

    return count === 1;
  }
}
