import { PrismaService } from '../../prisma/prisma.service';
import {
  DIGEST_ID,
  DIGEST_MEETING_ID,
  buildMeetingDigestRecord,
} from './meeting-digest-record.fixture';
import { MeetingDigestRepository } from './meeting-digest.repository';

/**
 * What a stubbed client can show: that the read loads the digest with everything the mapper
 * needs, inside a transaction at an isolation level that gives it one snapshot, that a
 * request is one statement, and that a deleted file is followed inside one transaction.
 * What the request does to a row in each status is `test/meeting-digest-claims.e2e-spec.ts`'s,
 * against a real database; what the snapshot buys is `test/meeting-digest-read.e2e-spec.ts`'s;
 * and what a delete writes is `meeting-digest-writes.spec.ts`'s.
 */
describe('MeetingDigestRepository', () => {
  const findUnique = jest.fn();
  const findActionItems = jest.fn();
  const findDecisions = jest.fn();
  const findSources = jest.fn();
  const executeRaw = jest.fn();
  const queryRaw = jest.fn();
  const updateMany = jest.fn();
  // The transaction's client and no other: a read that went round it would find no table.
  const tx = {
    $queryRaw: queryRaw,
    meetingDigest: { findUnique },
    meetingDigestActionItem: { findMany: findActionItems },
    meetingDigestDecision: { findMany: findDecisions },
    meetingDigestSource: { findMany: findSources },
  };
  const transaction = jest.fn((work: (client: typeof tx) => Promise<unknown>) => work(tx));
  const repository = new MeetingDigestRepository({
    $transaction: transaction,
    $executeRaw: executeRaw,
    meetingDigest: { findUnique, updateMany },
  } as unknown as PrismaService);
  const { actionItems, decisions, sources, ...row } = buildMeetingDigestRecord();

  beforeEach(() => {
    findUnique.mockReset().mockResolvedValue(row);
    findActionItems.mockReset().mockResolvedValue(actionItems);
    findDecisions.mockReset().mockResolvedValue(decisions);
    findSources.mockReset().mockResolvedValue(sources);
    executeRaw.mockReset().mockResolvedValue(1);
    queryRaw.mockReset().mockResolvedValue([]);
    updateMany.mockReset().mockResolvedValue({ count: 1 });
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

  it('moves the version of a digest that has content, and of no other', async () => {
    await expect(repository.noteUncoveredRecording(DIGEST_MEETING_ID)).resolves.toBe(true);

    expect(updateMany).toHaveBeenCalledWith({
      where: { meetingId: DIGEST_MEETING_ID, summary: { not: null } },
      data: { version: { increment: 1 } },
    });

    updateMany.mockResolvedValue({ count: 0 });
    await expect(repository.noteUncoveredRecording(DIGEST_MEETING_ID)).resolves.toBe(false);
  });

  it('reads where every digest stands in one statement, by meeting', async () => {
    const prismaQueryRaw = jest.fn().mockResolvedValue([
      { meetingId: DIGEST_MEETING_ID, status: 'READY', summary: '', sourceFileIds: ['first'] },
      { meetingId: 'meeting-emptied', status: null, summary: null, sourceFileIds: [] },
    ]);
    const reading = new MeetingDigestRepository({
      $queryRaw: prismaQueryRaw,
    } as unknown as PrismaService);

    const standings = await reading.findStandings();

    expect(prismaQueryRaw).toHaveBeenCalledTimes(1);
    // The shape the rule decides by: a summary is stored or it is not, and its text stays put.
    expect([...standings]).toEqual([
      [DIGEST_MEETING_ID, { status: 'READY', summary: '', sources: [{ meetingFileId: 'first' }] }],
      ['meeting-emptied', { status: null, summary: null, sources: [] }],
    ]);
  });

  it("answers a digest's requested revision, and null for a meeting that has none", async () => {
    findUnique.mockResolvedValue({ requestedRevision: 7 });

    await expect(repository.findRevisionOf(DIGEST_MEETING_ID)).resolves.toBe(7);
    expect(findUnique).toHaveBeenCalledWith({
      where: { meetingId: DIGEST_MEETING_ID },
      select: { requestedRevision: true },
    });

    findUnique.mockResolvedValue(null);
    await expect(repository.findRevisionOf(DIGEST_MEETING_ID)).resolves.toBeNull();
  });

  it('follows a deleted file inside one transaction, on that transaction’s client', async () => {
    const outcome = await repository.followDelete({
      meetingId: DIGEST_MEETING_ID,
      requestedRevision: 7,
      transcribedFileIds: [],
      replace: true,
      recordingDeleted: true,
    });

    // No row under the lock: nothing to follow, and nothing read outside the transaction.
    expect(outcome).toBe('UNCHANGED');
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });
});
