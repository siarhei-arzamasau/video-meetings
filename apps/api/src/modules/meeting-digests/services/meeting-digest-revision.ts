import type { Prisma } from '../../../generated/prisma/client';
import { readMeetingDigestAnswer } from './meeting-digest-answer';

/** A summary and decisions to put in place of a stored digest's. */
export interface MeetingDigestRevision {
  summary: string;
  decisions: ReadonlyArray<string>;
}

export type MeetingDigestRevisionReading =
  | { revision: MeetingDigestRevision }
  | { problem: string };

/**
 * The revision held to the bounds of an answer, by the answer's own guard: trimmed, nothing
 * blank, and no text or list longer than a generation may store. A revision is not Claude's
 * answer, but it is written to the same columns, and what bounds a row must not depend on
 * which way the text came.
 */
export function readMeetingDigestRevision({
  summary,
  decisions,
}: MeetingDigestRevision): MeetingDigestRevisionReading {
  const reading = readMeetingDigestAnswer({
    summary,
    actionItems: [],
    decisions: decisions.map((description) => ({ description })),
  });

  if ('problem' in reading) {
    return reading;
  }

  return {
    revision: {
      summary: reading.answer.summary,
      decisions: reading.answer.decisions.map(({ description }) => description),
    },
  };
}

/**
 * Stores the revision over the content the meeting's digest holds, in the caller's
 * transaction, and answers whether there was content to revise.
 *
 * **Only a digest that has content is revised**, and a meeting with none is left with none:
 * content is served while every recording it was built from is still transcribed, and a
 * summary stored under no recording at all would be one no read ever returns.
 *
 * **The summary and the decisions, and nothing else of the digest.** The action items, the
 * sources, and `generated_at` stay the last generation's — the revision is still attributed
 * to the recordings that generation read, so deleting one of them withdraws it like the
 * rest. The status stays too: a generation that is queued or under way replaces the
 * revision when it lands, as it replaces everything.
 *
 * `version` moves, because what `GET` answers has changed.
 *
 * **The update comes first, and is what locks the row**: a generation's `complete` and a
 * delete's reaction both take that lock before they touch the decisions, so neither can
 * land between this write's two halves.
 */
export async function reviseContent(
  tx: Prisma.TransactionClient,
  meetingId: string,
  { summary, decisions }: MeetingDigestRevision,
): Promise<boolean> {
  const [digest] = await tx.meetingDigest.updateManyAndReturn({
    where: { meetingId, summary: { not: null } },
    data: { summary, version: { increment: 1 } },
    select: { id: true },
  });

  if (digest === undefined) {
    return false;
  }

  await tx.meetingDigestDecision.deleteMany({ where: { digestId: digest.id } });
  await tx.meetingDigestDecision.createMany({
    data: decisions.map((description, position) => ({
      digestId: digest.id,
      position,
      description,
    })),
  });

  return true;
}
