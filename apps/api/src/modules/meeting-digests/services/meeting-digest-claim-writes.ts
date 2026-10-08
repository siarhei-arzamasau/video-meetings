import type { Prisma } from '../../../generated/prisma/client';
import type { MeetingDigestAnswer } from './meeting-digest-answer';
import { DigestStatus } from './meeting-digest-status';

const { QUEUED, GENERATING, READY, FAILED } = DigestStatus;

/** What a write that ends a claim is conditional on: the row, the lease it holds now, and the request. */
export interface HeldDigest {
  id: string;
  /** The lease the row holds — the claim's, or the last renewal's. */
  lease: Date;
  requestedRevision: number;
}

/** What a generation stores: the answer, and the recordings whose transcripts it was built from. */
export interface DigestContentWrite {
  answer: MeetingDigestAnswer;
  sourceFileIds: ReadonlyArray<string>;
}

/**
 * What `clear` leaves a row with: no status at all. Not a stored status, so not a
 * `DigestStatus` — it is the name of the absence of one, for a caller to be answered with.
 */
export const NO_DIGEST_STATUS = 'NONE';

/** How a claim ends when nobody asked again: its status, and what is written with it. */
export type Settlement =
  | { status: typeof READY; summary: string; generatedAt: Date }
  | { status: typeof FAILED; failureReason: string }
  | { status: typeof NO_DIGEST_STATUS };

/**
 * Ends a claim as `settlement` says if the request it was claimed for is still the latest,
 * and as `QUEUED` if another has been made since. Answers with the status written, or `null`
 * when the claim was no longer the caller's and nothing was.
 *
 * Two conditional statements, the second only when the first matched nothing. The revision
 * only ever rises, so a first write that missed on it is followed by a second that cannot;
 * one that missed on the lease misses again.
 *
 * **Queued instead, a success keeps its content and a failure loses its reason**: the
 * content is a whole digest of the recordings it was built from, while the failure of a
 * generation that is being replaced is nobody's to read.
 *
 * **A claim that found nothing to generate from is conditional on the revision like the
 * other two.** A request made after its transcripts were read is a recording transcribed
 * since, and a write that ignored it would leave that recording with nothing queued and
 * nothing to queue it again.
 */
export async function settle<S extends Settlement>(
  client: Prisma.TransactionClient,
  held: HeldDigest,
  settlement: S,
): Promise<S['status'] | typeof QUEUED | null> {
  const claim = { id: held.id, status: GENERATING, leasedUntil: held.lease };
  const ended = { leasedUntil: null, version: { increment: 1 } };
  const content =
    settlement.status === READY
      ? { summary: settlement.summary, generatedAt: settlement.generatedAt }
      : {};

  const asSettled = await client.meetingDigest.updateMany({
    where: { ...claim, requestedRevision: held.requestedRevision },
    data: { ...ended, ...content, ...settledColumns(settlement) },
  });

  if (asSettled.count === 1) {
    return settlement.status;
  }

  const asQueued = await client.meetingDigest.updateMany({
    where: claim,
    data: { ...ended, ...content, status: QUEUED, attempts: 0, failureReason: null },
  });

  return asQueued.count === 1 ? QUEUED : null;
}

/**
 * The status a settlement writes, and what goes with it. No status takes the claim count
 * with it: the next request starts a generation of its own, as it does after a requeue.
 */
function settledColumns(settlement: Settlement): Prisma.MeetingDigestUpdateManyMutationInput {
  if (settlement.status === NO_DIGEST_STATUS) {
    return { status: null, attempts: 0, failureReason: null };
  }

  return {
    status: settlement.status,
    failureReason: settlement.status === FAILED ? settlement.failureReason : null,
  };
}

/**
 * Puts a generation's action items, decisions, and sources in place of whatever the digest
 * held. Inside the caller's transaction, after the write that ended the claim: a digest is
 * never half the old content and half the new, and never new content under a claim that
 * was lost.
 */
export async function replaceContent(
  tx: Prisma.TransactionClient,
  digestId: string,
  { answer, sourceFileIds }: DigestContentWrite,
): Promise<void> {
  await tx.meetingDigestActionItem.deleteMany({ where: { digestId } });
  await tx.meetingDigestDecision.deleteMany({ where: { digestId } });
  await tx.meetingDigestSource.deleteMany({ where: { digestId } });
  await tx.meetingDigestActionItem.createMany({
    data: answer.actionItems.map(({ description, ownerName }, position) => ({
      digestId,
      position,
      description,
      ownerName: ownerName ?? null,
    })),
  });
  await tx.meetingDigestDecision.createMany({
    data: answer.decisions.map(({ description }, position) => ({
      digestId,
      position,
      description,
    })),
  });
  await tx.meetingDigestSource.createMany({
    data: sourceFileIds.map((meetingFileId) => ({ digestId, meetingFileId })),
  });
}
