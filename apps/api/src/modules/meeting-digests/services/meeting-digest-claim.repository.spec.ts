import { PrismaService } from '../../prisma/prisma.service';
import { NO_DIGEST_STATUS } from './meeting-digest-claim-writes';
import type { HeldDigest } from './meeting-digest-claim-writes';
import { MeetingDigestClaimRepository } from './meeting-digest-claim.repository';
import {
  DIGEST_ID,
  FIRST_RECORDING_ID,
  SECOND_RECORDING_ID,
} from './meeting-digest-record.fixture';
import { DigestStatus } from './meeting-digest-status';

const LEASE = new Date('2026-10-08T10:00:30.000Z');
const HELD: HeldDigest = { id: DIGEST_ID, lease: LEASE, requestedRevision: 4 };
const { QUEUED, GENERATING, READY, FAILED } = DigestStatus;
/** The row as the caller believes it is: generating, under the lease it holds. */
const CLAIM = { id: DIGEST_ID, status: GENERATING, leasedUntil: LEASE };
const CONTENT = {
  answer: {
    summary: 'The team agreed to ship on Friday.',
    actionItems: [
      { description: 'Send the release notes.', ownerName: 'Grace' },
      { description: 'Book the review room.' },
    ],
    decisions: [{ description: 'Ship on Friday.' }],
  },
  sourceFileIds: [FIRST_RECORDING_ID, SECOND_RECORDING_ID],
};

/**
 * The worker's conditional writes, against a stubbed client: which row each edge may touch
 * and what it sets — the edge table, one case an edge. The two raw statements, the claim and
 * the renewal, are only shown to pass their answer through; their SQL, and every edge again,
 * is run against a real database in `test/meeting-digest-claims.e2e-spec.ts`. What the
 * content rows are replaced with is `meeting-digest-claim-writes.spec.ts`'s.
 */
describe('MeetingDigestClaimRepository', () => {
  const updateMany = jest.fn();
  const queryRaw = jest.fn();
  const children = {
    meetingDigestActionItem: { deleteMany: jest.fn(), createMany: jest.fn() },
    meetingDigestDecision: { deleteMany: jest.fn(), createMany: jest.fn() },
    meetingDigestSource: { deleteMany: jest.fn(), createMany: jest.fn() },
  };
  const client = { meetingDigest: { updateMany }, ...children };
  const repository = new MeetingDigestClaimRepository({
    ...client,
    $queryRaw: queryRaw,
    // The transaction's client is the same stub: what matters here is what was written.
    $transaction: (work: (tx: typeof client) => Promise<unknown>) => work(client),
  } as unknown as PrismaService);

  /** The first write misses on the revision and the second, without it, lands. */
  const anotherRequestWasMade = (): void => {
    updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
  };

  const expectNoContentWritten = (): void => {
    for (const table of Object.values(children)) {
      expect(table.deleteMany).not.toHaveBeenCalled();
      expect(table.createMany).not.toHaveBeenCalled();
    }
  };

  beforeEach(() => {
    updateMany.mockReset().mockResolvedValue({ count: 1 });
    queryRaw.mockReset().mockResolvedValue([]);
    for (const table of Object.values(children)) {
      table.deleteMany.mockReset().mockResolvedValue({ count: 0 });
      table.createMany.mockReset().mockResolvedValue({ count: 0 });
    }
  });

  describe('complete', () => {
    it('generating to ready: only under the lease held, and only for the request it was claimed for', async () => {
      await expect(repository.complete(HELD, CONTENT)).resolves.toBe(READY);

      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(updateMany).toHaveBeenCalledWith({
        where: { ...CLAIM, requestedRevision: 4 },
        data: {
          status: READY,
          leasedUntil: null,
          failureReason: null,
          version: { increment: 1 },
          summary: CONTENT.answer.summary,
          generatedAt: expect.any(Date),
        },
      });
    });

    it('replaces the stored content in the same transaction, from what it was given', async () => {
      await repository.complete(HELD, CONTENT);

      expect(children.meetingDigestSource.createMany).toHaveBeenCalledWith({
        data: [
          { digestId: DIGEST_ID, meetingFileId: FIRST_RECORDING_ID },
          { digestId: DIGEST_ID, meetingFileId: SECOND_RECORDING_ID },
        ],
      });
    });

    it('generating to queued when another request was made: the content kept, the claim count reset', async () => {
      anotherRequestWasMade();

      await expect(repository.complete(HELD, CONTENT)).resolves.toBe(QUEUED);

      expect(updateMany).toHaveBeenLastCalledWith({
        // No revision: whatever it is now, it is not the one this claim answered.
        where: CLAIM,
        data: {
          status: QUEUED,
          attempts: 0,
          leasedUntil: null,
          failureReason: null,
          version: { increment: 1 },
          summary: CONTENT.answer.summary,
          generatedAt: expect.any(Date),
        },
      });
      expect(children.meetingDigestSource.createMany).toHaveBeenCalled();
    });

    it('writes nothing at all when the claim is no longer held', async () => {
      updateMany.mockResolvedValue({ count: 0 });

      await expect(repository.complete(HELD, CONTENT)).resolves.toBeNull();

      expectNoContentWritten();
    });
  });

  describe('fail', () => {
    it('generating to failed: the reason goes in with the status, and the lease comes off', async () => {
      await expect(repository.fail(HELD, 'Nope')).resolves.toBe(FAILED);

      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(updateMany).toHaveBeenCalledWith({
        where: { ...CLAIM, requestedRevision: 4 },
        data: {
          status: FAILED,
          failureReason: 'Nope',
          leasedUntil: null,
          version: { increment: 1 },
        },
      });
      expectNoContentWritten();
    });

    it('generating to queued when another request was made: no reason is stored', async () => {
      anotherRequestWasMade();

      await expect(repository.fail(HELD, 'Nope')).resolves.toBe(QUEUED);

      expect(updateMany).toHaveBeenLastCalledWith({
        where: CLAIM,
        data: {
          status: QUEUED,
          attempts: 0,
          failureReason: null,
          leasedUntil: null,
          version: { increment: 1 },
        },
      });
    });

    it('answers null when the claim is no longer held', async () => {
      updateMany.mockResolvedValue({ count: 0 });

      await expect(repository.fail(HELD, 'Nope')).resolves.toBeNull();
      expect(updateMany).toHaveBeenCalledTimes(2);
    });
  });

  describe('release', () => {
    it('generating to queued, with the claim uncounted', async () => {
      await expect(repository.release(DIGEST_ID, LEASE)).resolves.toBe(true);

      expect(updateMany).toHaveBeenCalledWith({
        where: CLAIM,
        data: {
          status: QUEUED,
          leasedUntil: null,
          attempts: { decrement: 1 },
          version: { increment: 1 },
        },
      });
    });
  });

  describe('clear', () => {
    const cleared = {
      status: null,
      leasedUntil: null,
      attempts: 0,
      failureReason: null,
      version: { increment: 1 },
    };

    it('generating to no status: only for the request it was claimed for, the claim count back at 0', async () => {
      await expect(repository.clear(HELD)).resolves.toBe(NO_DIGEST_STATUS);

      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(updateMany).toHaveBeenCalledWith({
        where: { ...CLAIM, requestedRevision: 4 },
        data: cleared,
      });
    });

    it('generating to queued when another request was made: a recording transcribed since is not forgotten', async () => {
      anotherRequestWasMade();

      await expect(repository.clear(HELD)).resolves.toBe(QUEUED);

      expect(updateMany).toHaveBeenLastCalledWith({
        where: CLAIM,
        data: { ...cleared, status: QUEUED },
      });
    });
  });

  it('release answers false, and clear null, when the claim is no longer held', async () => {
    updateMany.mockResolvedValue({ count: 0 });

    await expect(repository.release(DIGEST_ID, LEASE)).resolves.toBe(false);
    await expect(repository.clear(HELD)).resolves.toBeNull();
  });

  describe('claimNext and renewLease', () => {
    it('answer with the row and the lease their statements returned', async () => {
      const claimed = { id: DIGEST_ID, requestedRevision: 4 };
      const renewed = new Date('2026-10-08T10:01:00.000Z');
      queryRaw.mockResolvedValueOnce([claimed]).mockResolvedValueOnce([{ leasedUntil: renewed }]);

      await expect(repository.claimNext(60)).resolves.toBe(claimed);
      await expect(repository.renewLease(DIGEST_ID, LEASE, 60)).resolves.toBe(renewed);
    });

    it('answer null when nothing was claimable and when the claim is gone', async () => {
      await expect(repository.claimNext(60)).resolves.toBeNull();
      await expect(repository.renewLease(DIGEST_ID, LEASE, 60)).resolves.toBeNull();
    });
  });
});
