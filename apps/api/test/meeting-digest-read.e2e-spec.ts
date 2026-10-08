import { NO_OWNER_LINKS } from '../src/modules/meeting-digests/services/meeting-digest-owner';
import type { PrismaService } from '../src/modules/prisma/prisma.service';
import { useApiSuite } from './utils/api-suite';
import { heldBy, useDigestClaimsSuite } from './utils/digest-claims-suite';
import { READY } from './utils/meeting-digests-table';

const EARLIER = {
  summary: 'The launch moves to April.',
  actionItems: [{ description: 'Rewrite the emails.', ownerName: 'Alice Johnson' }],
  decisions: [{ description: 'Launch on the fifteenth of April.' }],
};
const LATER_SUMMARY = 'The launch moves to May.';
const LATER_ACTION_ITEM = 'Book the venue.';
const CHILD_TABLE = 'meeting_digest_action_items';
const WAIT_STEP_MS = 20;
const WAIT_STEPS = 150;

/**
 * Resolves once some statement is waiting for a lock on `table` — the read, held where it is
 * wanted. Asked of `pg_locks` every few milliseconds, and given up on well inside the five
 * seconds Prisma allows the transaction this is called from.
 */
async function untilAReadWaitsOn(
  prisma: PrismaService,
  table: string,
  stepsLeft = WAIT_STEPS,
): Promise<void> {
  const [row] = await prisma.$queryRawUnsafe<Array<{ waiting: number }>>(
    `SELECT count(*)::int AS waiting FROM pg_locks
     WHERE NOT granted AND relation = '${table}'::regclass`,
  );

  if ((row?.waiting ?? 0) > 0) {
    return;
  }
  if (stepsLeft === 0) {
    throw new Error(`Nothing came to wait on ${table}: the read never reached it`);
  }

  await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));

  return untilAReadWaitsOn(prisma, table, stepsLeft - 1);
}

/**
 * The read of a digest, against the database, with a generation's write landing in the
 * middle of it. `complete` replaces a digest in one transaction so that nobody sees half of
 * one; that only holds if the read is one snapshot too, and the row and its three child
 * tables are four statements.
 */
describe('reading a meeting digest while a generation replaces it', () => {
  const suite = useApiSuite();
  const { digests, claims, claimed, recordingOf } = useDigestClaimsSuite(suite);

  it('answers with one generation whole, never the summary of one over the lists of another', async () => {
    const { meetingId, claim } = await claimed();
    const source = await recordingOf(meetingId);
    await expect(
      claims().complete(heldBy(claim), {
        answer: EARLIER,
        sourceFileIds: [source],
        ownerLinks: NO_OWNER_LINKS,
      }),
    ).resolves.toBe(READY);

    // A second generation's write, by hand so it can be stopped half-way: the child table is
    // locked against readers, the new digest is written, and the commit waits for the read
    // to have taken the row and be standing at that lock.
    const reading = await suite.prisma().$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE "${CHILD_TABLE}" IN ACCESS EXCLUSIVE MODE`);
      await tx.$executeRawUnsafe(
        `UPDATE "meeting_digests" SET summary = $2, version = version + 1
         WHERE meeting_id = $1::uuid`,
        meetingId,
        LATER_SUMMARY,
      );
      await tx.$executeRawUnsafe(
        `UPDATE "${CHILD_TABLE}" SET description = $2
         WHERE digest_id = (SELECT id FROM "meeting_digests" WHERE meeting_id = $1::uuid)`,
        meetingId,
        LATER_ACTION_ITEM,
      );

      // `then` is what starts it: a Prisma promise sends nothing until something waits on it.
      const read = Promise.resolve(digests().findOf(meetingId));
      await untilAReadWaitsOn(suite.prisma(), CHILD_TABLE);

      // In an object, so that the transaction commits rather than wait for the read it blocks.
      return { read };
    });

    const record = await reading.read;

    // Whichever generation the read saw, it saw all of it. Unsnapshotted, this was the
    // earlier summary over the later action item.
    expect({
      summary: record?.summary,
      actionItems: record?.actionItems.map(({ description }) => description),
    }).toEqual({
      summary: EARLIER.summary,
      actionItems: [EARLIER.actionItems[0]?.description],
    });

    // And the write did land: the next read is the later generation, whole.
    await expect(digests().findOf(meetingId)).resolves.toMatchObject({
      summary: LATER_SUMMARY,
      actionItems: [{ description: LATER_ACTION_ITEM }],
    });
  });
});
