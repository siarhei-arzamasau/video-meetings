import type { Prisma } from '../../../generated/prisma/client';
import {
  DIGEST_ID,
  DIGEST_MEETING_ID,
  FIRST_RECORDING_ID,
  SECOND_RECORDING_ID,
} from './meeting-digest-record.fixture';
import { DigestStatus } from './meeting-digest-status';
import { DigestAfterDelete, followDelete } from './meeting-digest-writes';
import type { RecordingsAfterDelete } from './meeting-digest-writes';

const { READY } = DigestStatus;
const { UNCHANGED, CURRENT_AGAIN, REPLACING, CLEARED, WITHDRAWN } = DigestAfterDelete;
const REVISION = 4;

/** What the handler read: by default the second recording was deleted, the first is left. */
const after = (overrides: Partial<RecordingsAfterDelete> = {}): RecordingsAfterDelete => ({
  meetingId: DIGEST_MEETING_ID,
  requestedRevision: REVISION,
  transcribedFileIds: [FIRST_RECORDING_ID],
  replace: true,
  recordingDeleted: true,
  ...overrides,
});

const BOTH = [FIRST_RECORDING_ID, SECOND_RECORDING_ID];
const NO_RECORDING = { transcribedFileIds: [] };

/** The decision written down, against a stubbed transaction client. */
describe('followDelete', () => {
  const queryRaw = jest.fn();
  const executeRaw = jest.fn();
  const update = jest.fn();
  const findSources = jest.fn();
  const children = {
    meetingDigestActionItem: { deleteMany: jest.fn() },
    meetingDigestDecision: { deleteMany: jest.fn() },
    meetingDigestSource: { deleteMany: jest.fn(), findMany: findSources },
  };
  const tx = {
    $queryRaw: queryRaw,
    $executeRaw: executeRaw,
    meetingDigest: { update },
    ...children,
  } as unknown as Prisma.TransactionClient;

  const stored = (status: DigestStatus | null, sourceFileIds: string[]): void => {
    queryRaw.mockResolvedValue([{ id: DIGEST_ID, status, requestedRevision: REVISION }]);
    findSources.mockResolvedValue(sourceFileIds.map((meetingFileId) => ({ meetingFileId })));
  };

  const removedContent = (): void => {
    for (const table of Object.values(children)) {
      expect(table.deleteMany).toHaveBeenCalledWith({ where: { digestId: DIGEST_ID } });
    }
  };

  beforeEach(() => {
    queryRaw.mockReset();
    executeRaw.mockReset().mockResolvedValue(1);
    update.mockReset().mockResolvedValue({});
    findSources.mockReset();
    for (const table of Object.values(children)) {
      table.deleteMany.mockReset().mockResolvedValue({ count: 0 });
    }
    stored(READY, BOTH);
  });

  it('locks the row before it reads what the digest was built from', async () => {
    const order: string[] = [];
    queryRaw.mockImplementation(async () => {
      order.push('lock');

      return [{ id: DIGEST_ID, status: READY, requestedRevision: REVISION }];
    });
    findSources.mockImplementation(async () => {
      order.push('sources');

      return [];
    });

    await followDelete(tx, after());

    expect(order).toEqual(['lock', 'sources']);
    const [statement, meetingId] = queryRaw.mock.calls[0] as [ReadonlyArray<string>, string];
    expect(statement.join('?')).toContain('FOR UPDATE');
    expect(meetingId).toBe(DIGEST_MEETING_ID);
  });

  it('writes nothing for a meeting that has no digest: a delete never makes one', async () => {
    queryRaw.mockResolvedValue([]);

    await expect(followDelete(tx, after())).resolves.toBe(UNCHANGED);

    expect(findSources).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('removes the content and asks for a replacement, the version moved by the request alone', async () => {
    await expect(followDelete(tx, after())).resolves.toBe(REPLACING);

    removedContent();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: DIGEST_ID },
      data: { summary: null, generatedAt: null },
    });
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const [statement, meetingId] = executeRaw.mock.calls[0] as [ReadonlyArray<string>, string];
    expect(statement.join('?')).toContain('ON CONFLICT (meeting_id) DO UPDATE');
    expect(meetingId).toBe(DIGEST_MEETING_ID);
  });

  it('removes the content and the status in one update when nothing is left to generate from', async () => {
    await expect(followDelete(tx, after(NO_RECORDING))).resolves.toBe(CLEARED);

    removedContent();
    expect(executeRaw).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: DIGEST_ID },
      data: {
        summary: null,
        generatedAt: null,
        status: null,
        leasedUntil: null,
        attempts: 0,
        failureReason: null,
        version: { increment: 1 },
      },
    });
  });

  it('removes the content and leaves the status alone when a request was made since', async () => {
    const read = after({ ...NO_RECORDING, requestedRevision: REVISION - 1 });

    await expect(followDelete(tx, read)).resolves.toBe(WITHDRAWN);

    removedContent();
    expect(update).toHaveBeenCalledWith({
      where: { id: DIGEST_ID },
      data: { summary: null, generatedAt: null, version: { increment: 1 } },
    });
  });

  it('moves the version and nothing else for a digest that is current again', async () => {
    stored(READY, [FIRST_RECORDING_ID]);

    await expect(followDelete(tx, after())).resolves.toBe(CURRENT_AGAIN);

    for (const table of Object.values(children)) {
      expect(table.deleteMany).not.toHaveBeenCalled();
    }
    expect(update).toHaveBeenCalledWith({
      where: { id: DIGEST_ID },
      data: { version: { increment: 1 } },
    });
  });

  it('writes nothing when the deleted file changed nothing a client is shown', async () => {
    stored(READY, [FIRST_RECORDING_ID]);

    await expect(followDelete(tx, after({ recordingDeleted: false }))).resolves.toBe(UNCHANGED);

    expect(update).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });
});
