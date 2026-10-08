import type { Prisma } from '../../../generated/prisma/client';
import { NO_DIGEST_STATUS, replaceContent, settle } from './meeting-digest-claim-writes';
import type { HeldDigest } from './meeting-digest-claim-writes';
import {
  DIGEST_ID,
  FIRST_RECORDING_ID,
  SECOND_RECORDING_ID,
} from './meeting-digest-record.fixture';
import { DigestStatus } from './meeting-digest-status';

const LEASE = new Date('2026-10-08T10:00:30.000Z');
const HELD: HeldDigest = { id: DIGEST_ID, lease: LEASE, requestedRevision: 4 };
const { QUEUED, GENERATING } = DigestStatus;

/**
 * The two halves of a write that ends a claim, against a stubbed transaction client: what
 * the content rows are replaced with, and that no settlement — the one that leaves no
 * status included — is written without the revision the claim took.
 */
describe('the writes that end a digest claim', () => {
  const updateMany = jest.fn();
  const children = {
    meetingDigestActionItem: { deleteMany: jest.fn(), createMany: jest.fn() },
    meetingDigestDecision: { deleteMany: jest.fn(), createMany: jest.fn() },
    meetingDigestSource: { deleteMany: jest.fn(), createMany: jest.fn() },
  };
  const tx = { meetingDigest: { updateMany }, ...children } as unknown as Prisma.TransactionClient;

  beforeEach(() => {
    updateMany.mockReset().mockResolvedValue({ count: 1 });
    for (const table of Object.values(children)) {
      table.deleteMany.mockReset().mockResolvedValue({ count: 0 });
      table.createMany.mockReset().mockResolvedValue({ count: 0 });
    }
  });

  describe('replaceContent', () => {
    it('replaces the action items, decisions, and sources whole, each in the order given', async () => {
      await replaceContent(tx, DIGEST_ID, {
        answer: {
          summary: 'The team agreed to ship on Friday.',
          actionItems: [
            { description: 'Send the release notes.', ownerName: 'Grace' },
            { description: 'Book the review room.' },
          ],
          decisions: [{ description: 'Ship on Friday.' }],
        },
        sourceFileIds: [FIRST_RECORDING_ID, SECOND_RECORDING_ID],
      });

      for (const table of Object.values(children)) {
        expect(table.deleteMany).toHaveBeenCalledWith({ where: { digestId: DIGEST_ID } });
      }
      expect(children.meetingDigestActionItem.createMany).toHaveBeenCalledWith({
        data: [
          {
            digestId: DIGEST_ID,
            position: 0,
            description: 'Send the release notes.',
            ownerName: 'Grace',
          },
          // Nobody was named: stored as no name, which is what "Unassigned" is read from.
          {
            digestId: DIGEST_ID,
            position: 1,
            description: 'Book the review room.',
            ownerName: null,
          },
        ],
      });
      expect(children.meetingDigestDecision.createMany).toHaveBeenCalledWith({
        data: [{ digestId: DIGEST_ID, position: 0, description: 'Ship on Friday.' }],
      });
      expect(children.meetingDigestSource.createMany).toHaveBeenCalledWith({
        data: [
          { digestId: DIGEST_ID, meetingFileId: FIRST_RECORDING_ID },
          { digestId: DIGEST_ID, meetingFileId: SECOND_RECORDING_ID },
        ],
      });
    });
  });

  describe('settle', () => {
    const settlements = [
      { status: DigestStatus.READY, summary: 'Shipped.', generatedAt: new Date(0) },
      { status: DigestStatus.FAILED, failureReason: 'Nope' },
      { status: NO_DIGEST_STATUS },
    ] as const;

    it.each(settlements)(
      'writes $status only for the request the claim took, and queues the row otherwise',
      async (settlement) => {
        updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

        await expect(settle(tx, HELD, settlement)).resolves.toBe(QUEUED);

        const [[asSettled], [asQueued]] = updateMany.mock.calls as [
          [Prisma.MeetingDigestUpdateManyArgs],
          [Prisma.MeetingDigestUpdateManyArgs],
        ];
        expect(asSettled.where).toEqual({
          id: DIGEST_ID,
          status: GENERATING,
          leasedUntil: LEASE,
          requestedRevision: 4,
        });
        expect(asQueued.where).toEqual({ id: DIGEST_ID, status: GENERATING, leasedUntil: LEASE });
        expect(asQueued.data).toMatchObject({ status: QUEUED, attempts: 0, failureReason: null });
      },
    );
  });
});
