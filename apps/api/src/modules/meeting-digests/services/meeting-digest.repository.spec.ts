import { PrismaService } from '../../prisma/prisma.service';
import {
  DIGEST_ID,
  DIGEST_MEETING_ID,
  buildMeetingDigestRecord,
} from './meeting-digest-record.fixture';
import { MeetingDigestRepository } from './meeting-digest.repository';

/**
 * What a stubbed client can show: that the read loads the digest with everything the mapper
 * needs, inside a transaction at an isolation level that gives it one snapshot, and that a
 * request is one statement. What that statement does to a row in each status is
 * `test/meeting-digest-claims.e2e-spec.ts`'s, against a real database, and what the snapshot
 * buys is `test/meeting-digest-read.e2e-spec.ts`'s.
 */
describe('MeetingDigestRepository', () => {
  const findUnique = jest.fn();
  const findActionItems = jest.fn();
  const findDecisions = jest.fn();
  const findSources = jest.fn();
  const executeRaw = jest.fn();
  // The transaction's client and no other: a read that went round it would find no table.
  const tx = {
    meetingDigest: { findUnique },
    meetingDigestActionItem: { findMany: findActionItems },
    meetingDigestDecision: { findMany: findDecisions },
    meetingDigestSource: { findMany: findSources },
  };
  const transaction = jest.fn((work: (client: typeof tx) => Promise<unknown>) => work(tx));
  const repository = new MeetingDigestRepository({
    $transaction: transaction,
    $executeRaw: executeRaw,
  } as unknown as PrismaService);
  const { actionItems, decisions, sources, ...row } = buildMeetingDigestRecord();

  beforeEach(() => {
    findUnique.mockReset().mockResolvedValue(row);
    findActionItems.mockReset().mockResolvedValue(actionItems);
    findDecisions.mockReset().mockResolvedValue(decisions);
    findSources.mockReset().mockResolvedValue(sources);
    executeRaw.mockReset().mockResolvedValue(1);
    transaction.mockClear();
  });

  it("reads the meeting's one digest with its action items, decisions, and source ids", async () => {
    await expect(repository.findOf(DIGEST_MEETING_ID)).resolves.toEqual(buildMeetingDigestRecord());

    expect(findUnique).toHaveBeenCalledWith({ where: { meetingId: DIGEST_MEETING_ID } });
    for (const findMany of [findActionItems, findDecisions]) {
      expect(findMany).toHaveBeenCalledWith({ where: { digestId: DIGEST_ID } });
    }
    expect(findSources).toHaveBeenCalledWith({
      where: { digestId: DIGEST_ID },
      select: { meetingFileId: true },
    });
  });

  it('reads the row and its three tables in one snapshot, not a statement at a time', async () => {
    await repository.findOf(DIGEST_MEETING_ID);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    });
  });

  it('answers null for a meeting nobody asked a digest for, and looks for nothing under it', async () => {
    findUnique.mockResolvedValue(null);

    await expect(repository.findOf(DIGEST_MEETING_ID)).resolves.toBeNull();

    for (const findMany of [findActionItems, findDecisions, findSources]) {
      expect(findMany).not.toHaveBeenCalled();
    }
  });

  it('asks for a generation in one statement, for the meeting it was given', async () => {
    await repository.request(DIGEST_MEETING_ID);

    expect(executeRaw).toHaveBeenCalledTimes(1);
    // A tagged template: the strings first, then the values in order.
    const [statement, ...values] = executeRaw.mock.calls[0] as [
      ReadonlyArray<string>,
      ...unknown[],
    ];
    expect(statement.join('?')).toContain('ON CONFLICT (meeting_id) DO UPDATE');
    expect(values).toEqual([DIGEST_MEETING_ID]);
  });
});
