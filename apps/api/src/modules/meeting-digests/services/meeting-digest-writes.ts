import type { Prisma } from '../../../generated/prisma/client';
import { DigestStatus } from './meeting-digest-status';

/**
 * Asks for a generation: makes the meeting's row if there is none, and moves
 * `requested_revision` on if there is. One statement, so two requests that arrive together —
 * two recordings transcribed at once, on two replicas — are two revisions of one row and
 * never a unique violation.
 *
 * **The revision is the whole of the request.** A row that is `GENERATING` stays as it is,
 * lease and claim count included: the generation under way took the revision before this
 * one, so the write that ends it finds the revision moved and leaves the row `QUEUED`
 * instead of `READY`. That is "never two at once, and one more after a change", with no
 * second row and nothing for the worker to be told.
 *
 * Anything else becomes `QUEUED` with a claim count of 0 and no reason: what is asked for is
 * a new generation, not the fourth claim of the last one, and a failure it replaces is no
 * longer what the digest has to say. The stored content is not touched — it stays readable,
 * marked out of date by the read, until a generation replaces it.
 *
 * Raw because Prisma's upsert cannot make an update conditional on the row it finds, and
 * because `@default(uuid())` and `@updatedAt` are the client's: here the database supplies
 * both.
 */
export async function requestGeneration(
  client: Prisma.TransactionClient,
  meetingId: string,
): Promise<void> {
  await client.$executeRaw`
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

/** What whoever reacts to a deleted file had read before it decided anything. */
export interface RecordingsAfterDelete {
  meetingId: string;
  /** `requested_revision` as it stood **before** the recordings below were read. */
  requestedRevision: number;
  /** The meeting's transcribed recordings now: the deleted file is not among them. */
  transcribedFileIds: ReadonlyArray<string>;
  /** Whether a digest that lost its content is generated again — the setting. */
  replace: boolean;
  /**
   * A recording was deleted that may have been transcribed, so `outOfDate` may have changed.
   * Whether it had been is not asked: the delete's event can carry "transcribing" for a
   * recording that was transcribed by the time it was deleted.
   */
  recordingDeleted: boolean;
}

/** What a deleted file made of the meeting's digest. Everything but `UNCHANGED` is a write. */
export const DigestAfterDelete = {
  /** Nothing a client is shown depended on the file. */
  UNCHANGED: 'UNCHANGED',
  /** The digest was not built from it, and no longer has a recording it does not cover. */
  CURRENT_AGAIN: 'CURRENT_AGAIN',
  /** Its content is removed, and a generation from the recordings left is asked for. */
  REPLACING: 'REPLACING',
  /** Its content is removed, or its last recording is gone: no status. */
  CLEARED: 'CLEARED',
  /** Its content is removed, and its status is a later request's to decide. */
  WITHDRAWN: 'WITHDRAWN',
} as const;

export type DigestAfterDelete = (typeof DigestAfterDelete)[keyof typeof DigestAfterDelete];

const { UNCHANGED, CURRENT_AGAIN, REPLACING, CLEARED, WITHDRAWN } = DigestAfterDelete;

interface LockedDigest {
  id: string;
  status: DigestStatus | null;
  requestedRevision: number;
}

/**
 * Decides what a deleted file does to a digest, from the row as it is now and the recordings
 * it was built from. Pure: `followDelete` reads, asks this, and writes.
 *
 * - **Content one of whose recordings is gone is removed**, whichever file the event named:
 *   the question is whether every source is still transcribed, so a delete whose event was
 *   never handled is caught up with by the next one.
 * - **Then a replacement is asked for** — when there is a recording left to build it from
 *   and the digest is switched on — **or the status is cleared**: with the setting off
 *   nothing will be generated, and a status with nothing under it describes no digest.
 * - **With no transcribed recording left there is no digest at all**, whatever the row said:
 *   queued, generating, failed. A generation under way finds its claim gone.
 * - **A clear gives way to a request made since the caller looked.** A recording
 *   transcribed after the recordings were read is not among them, and its request must not
 *   be undone by a decision taken without it.
 * - **A recording the digest was not built from takes the out-of-date mark with it** when it
 *   was the only one: nothing stored changes, and what `GET` answers does.
 */
export function digestAfterDelete(
  digest: Pick<LockedDigest, 'status' | 'requestedRevision'>,
  sourceFileIds: ReadonlyArray<string>,
  after: RecordingsAfterDelete,
): DigestAfterDelete {
  const transcribed = new Set(after.transcribedFileIds);
  const sources = new Set(sourceFileIds);
  const withdrawn = sourceFileIds.some((fileId) => !transcribed.has(fileId));

  if (withdrawn && transcribed.size > 0 && after.replace) {
    return REPLACING;
  }

  if (withdrawn || transcribed.size === 0) {
    const askedForSince = digest.requestedRevision !== after.requestedRevision;

    if (digest.status !== null && !askedForSince) {
      return CLEARED;
    }

    return withdrawn ? WITHDRAWN : UNCHANGED;
  }

  const coversEveryRecording = after.transcribedFileIds.every((fileId) => sources.has(fileId));

  return after.recordingDeleted && sources.size > 0 && coversEveryRecording
    ? CURRENT_AGAIN
    : UNCHANGED;
}

/**
 * Makes a meeting's digest follow a deleted file, in the caller's transaction, and answers
 * with what it did. A meeting with no digest row is `UNCHANGED`: a delete never makes one.
 *
 * **The row is locked first**, which is what orders this against a generation's `complete`
 * — that write takes the same lock before it replaces the content. Without it, this could
 * read the sources of the old content, remove them, and blank the summary of the new one
 * that landed in between.
 *
 * `version` moves once, whatever was written: by the request when a replacement is asked
 * for, and by the one update otherwise.
 */
export async function followDelete(
  tx: Prisma.TransactionClient,
  after: RecordingsAfterDelete,
): Promise<DigestAfterDelete> {
  const [digest] = await tx.$queryRaw<LockedDigest[]>`
    SELECT id, status, requested_revision AS "requestedRevision"
    FROM "meeting_digests"
    WHERE meeting_id = ${after.meetingId}::uuid
    FOR UPDATE
  `;

  if (digest === undefined) {
    return UNCHANGED;
  }

  const sources = await tx.meetingDigestSource.findMany({
    where: { digestId: digest.id },
    select: { meetingFileId: true },
  });
  const outcome = digestAfterDelete(
    digest,
    sources.map(({ meetingFileId }) => meetingFileId),
    after,
  );

  if (outcome !== UNCHANGED) {
    await writeOutcome(tx, digest.id, after.meetingId, outcome);
  }

  return outcome;
}

/** What each outcome that is a write writes. `CURRENT_AGAIN` is the version and nothing else. */
async function writeOutcome(
  tx: Prisma.TransactionClient,
  digestId: string,
  meetingId: string,
  outcome: Exclude<DigestAfterDelete, typeof UNCHANGED>,
): Promise<void> {
  const content = outcome === CURRENT_AGAIN ? {} : await removeContent(tx, digestId);

  if (outcome === REPLACING) {
    await tx.meetingDigest.update({ where: { id: digestId }, data: content });
    await requestGeneration(tx, meetingId);

    return;
  }

  const status =
    outcome === CLEARED
      ? { status: null, leasedUntil: null, attempts: 0, failureReason: null }
      : {};

  await tx.meetingDigest.update({
    where: { id: digestId },
    data: { ...content, ...status, version: { increment: 1 } },
  });
}

/**
 * Removes what a generation stored under a digest, and answers with the columns that leave
 * the row with it. The rows go, rather than staying to be withheld by the read: what a
 * deleted recording said is not kept in a table nobody is shown.
 */
async function removeContent(
  tx: Prisma.TransactionClient,
  digestId: string,
): Promise<{ summary: null; generatedAt: null }> {
  await tx.meetingDigestActionItem.deleteMany({ where: { digestId } });
  await tx.meetingDigestDecision.deleteMany({ where: { digestId } });
  await tx.meetingDigestSource.deleteMany({ where: { digestId } });

  return { summary: null, generatedAt: null };
}
