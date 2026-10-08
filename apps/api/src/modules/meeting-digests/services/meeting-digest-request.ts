import type { Prisma } from '../../../generated/prisma/client';
import { requestabilityOf } from './meeting-digest-action';
import type { DigestRequestability } from './meeting-digest-action';
import type { DigestStatus } from './meeting-digest-status';
import { requestGeneration } from './meeting-digest-writes';

interface LockedDigest {
  id: string;
  status: DigestStatus | null;
  summary: string | null;
}

/**
 * Asks for a generation because somebody asked — Generate, or Retry — in the caller's
 * transaction, and answers whether it did. The one request that can be refused: a recording
 * that was transcribed asks unconditionally, and "one more after the one under way" is the
 * right answer to it; a person pressing a button while a digest is queued, generating, or
 * current is asking for a second paid request for the same recordings.
 *
 * `transcribedFileIds` are the meeting's transcribed recordings as the caller read them a
 * moment ago. They decide whether what is stored is current; they are not written, and the
 * worker reads the recordings again when it claims the row.
 *
 * **They were read before the lock, and that is left as it is.** A recording deleted
 * between that read and the lock can let through a request for a digest its delete has
 * just made current again. The row then ends exactly where it ends when the same request
 * commits a moment before the same delete: `QUEUED` over content that is current, because
 * a delete moves the version of such a digest and takes no request back. Reading under the
 * lock would move the line between two orders that already end alike, not remove an
 * outcome — and could only be done by asking `meeting-files` from inside this transaction,
 * which is a second connection wanted by every transaction that already holds one: the
 * pool emptied by as many requests at once as it has connections.
 *
 * **The row is locked before anything is decided**, which is what makes the refusal hold
 * between two requests, and against a generation's `complete` — that write takes the same
 * lock before it replaces the content, so the sources read here are of the content the
 * status describes.
 *
 * **A meeting with no row is given an empty one first, so that there is a row to lock.**
 * Without it two requests for such a meeting would both find nothing, and the second would
 * add a revision to the row the first had queued — one more generation than was asked for,
 * if a worker claimed it between them. `ON CONFLICT DO NOTHING` waits for the other
 * transaction instead, and the lock then shows this one what that one wrote. The empty row
 * never outlives the transaction: nothing refuses a row with no status and no content, and
 * the caller has already been refused for a meeting with no recording.
 *
 * What is then written is `requestGeneration`, like every other request: `QUEUED`, a claim
 * count of 0, no reason, the revision and the version moved, and the content left alone.
 */
export async function requestGenerationByHand(
  tx: Prisma.TransactionClient,
  meetingId: string,
  transcribedFileIds: ReadonlyArray<string>,
): Promise<DigestRequestability> {
  const transcribed = new Set(transcribedFileIds);
  const withoutRow = requestabilityOf(null, transcribed);

  // Nothing to generate from: refused before a row is made for a meeting that has no digest.
  if (!withoutRow.allowed) {
    return withoutRow;
  }

  await tx.$executeRaw`
    INSERT INTO "meeting_digests" (id, meeting_id, updated_at)
    VALUES (gen_random_uuid(), ${meetingId}::uuid, now())
    ON CONFLICT (meeting_id) DO NOTHING
  `;

  const [digest] = await tx.$queryRaw<LockedDigest[]>`
    SELECT id, status, summary
    FROM "meeting_digests"
    WHERE meeting_id = ${meetingId}::uuid
    FOR UPDATE
  `;
  const request = digest === undefined ? withoutRow : await decideFor(tx, digest, transcribed);

  if (request.allowed) {
    await requestGeneration(tx, meetingId);
  }

  return request;
}

async function decideFor(
  tx: Prisma.TransactionClient,
  digest: LockedDigest,
  transcribed: ReadonlySet<string>,
): Promise<DigestRequestability> {
  const sources = await tx.meetingDigestSource.findMany({
    where: { digestId: digest.id },
    select: { meetingFileId: true },
  });

  return requestabilityOf({ status: digest.status, summary: digest.summary, sources }, transcribed);
}
