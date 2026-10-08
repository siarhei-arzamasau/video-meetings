import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DIGEST_ID,
  DIGEST_MEETING_ID,
  FIRST_RECORDING_ID,
  SECOND_RECORDING_ID,
  buildMeetingDigestRecord,
} from './meeting-digest-record.fixture';
import { requestGenerationByHand } from './meeting-digest-request';
import { DigestStatus } from './meeting-digest-status';
import { MeetingDigestRepository } from './meeting-digest.repository';

const { QUEUED, GENERATING, READY, FAILED } = DigestStatus;
const FIRST = [FIRST_RECORDING_ID];
const SUMMARY = 'The team agreed to ship on Friday.';

/**
 * The conditional request against a stubbed transaction client: what is read in which
 * order, and that a refusal writes nothing. What each statement does to a real row, and
 * that two requests at once are one generation, is `test/meeting-digest-request.e2e-spec.ts`'s.
 */
describe('requestGenerationByHand', () => {
  const statements: string[] = [];
  const executeRaw = jest.fn();
  const queryRaw = jest.fn();
  const findSources = jest.fn();
  const tx = {
    $executeRaw: executeRaw,
    $queryRaw: queryRaw,
    meetingDigestSource: { findMany: findSources },
  } as unknown as Prisma.TransactionClient;

  const stored = (
    status: DigestStatus | null,
    sourceFileIds: string[] = [],
    summary: string | null = sourceFileIds.length === 0 ? null : SUMMARY,
  ): void => {
    queryRaw.mockImplementation(async (strings: ReadonlyArray<string>) => {
      statements.push(strings.join('?'));

      return [{ id: DIGEST_ID, status, summary }];
    });
    findSources.mockImplementation(async () => {
      statements.push('sources');

      return sourceFileIds.map((meetingFileId) => ({ meetingFileId }));
    });
  };

  /** The statements that wrote, in order: the empty row, then — if allowed — the request. */
  const written = (): string[] => statements.filter((text) => text.includes('INSERT'));

  beforeEach(() => {
    statements.length = 0;
    executeRaw.mockReset().mockImplementation(async (strings: ReadonlyArray<string>) => {
      statements.push(strings.join('?'));

      return 1;
    });
    queryRaw.mockReset();
    findSources.mockReset();
    stored(null);
  });

  it('makes sure of a row, locks it, reads its sources, and only then asks', async () => {
    await requestGenerationByHand(tx, DIGEST_MEETING_ID, FIRST);

    expect(statements).toHaveLength(4);
    expect(statements[0]).toContain('ON CONFLICT (meeting_id) DO NOTHING');
    expect(statements[1]).toContain('FOR UPDATE');
    expect(statements[2]).toBe('sources');
    // `requestGeneration`, the statement every other request is.
    expect(statements[3]).toContain('ON CONFLICT (meeting_id) DO UPDATE');
    expect(findSources).toHaveBeenCalledWith({
      where: { digestId: DIGEST_ID },
      select: { meetingFileId: true },
    });
  });

  it.each([
    ['a row with no status', null, [], 'generate'],
    ['a digest that does not cover a recording', READY, [SECOND_RECORDING_ID], 'generate'],
    ['a failed digest', FAILED, [], 'retry'],
  ] as const)('asks for %s, and says what was asked', async (_what, status, sources, action) => {
    stored(status, [...sources]);

    await expect(requestGenerationByHand(tx, DIGEST_MEETING_ID, FIRST)).resolves.toEqual({
      allowed: true,
      action,
    });
    expect(written()).toHaveLength(2);
  });

  it.each([
    ['queued', QUEUED, [], 'UNDER_WAY'],
    ['generating', GENERATING, [], 'UNDER_WAY'],
    ['current', READY, FIRST, 'CURRENT'],
  ] as const)(
    'refuses a digest that is %s, asking for nothing',
    async (_what, status, sources, refusal) => {
      stored(status, [...sources]);

      await expect(requestGenerationByHand(tx, DIGEST_MEETING_ID, FIRST)).resolves.toEqual({
        allowed: false,
        refusal,
      });
      // The empty row is offered to a meeting that already has one, and changes nothing there.
      expect(written()).toHaveLength(1);
      expect(written()[0]).toContain('DO NOTHING');
    },
  );

  it('refuses a meeting with no transcribed recording before it touches the table', async () => {
    await expect(requestGenerationByHand(tx, DIGEST_MEETING_ID, [])).resolves.toEqual({
      allowed: false,
      refusal: 'NO_RECORDING',
    });

    expect(statements).toEqual([]);
  });

  it('asks all the same when the row is gone by the time it is locked', async () => {
    queryRaw.mockResolvedValue([]);

    await expect(requestGenerationByHand(tx, DIGEST_MEETING_ID, FIRST)).resolves.toEqual({
      allowed: true,
      action: 'generate',
    });
    expect(findSources).not.toHaveBeenCalled();
    expect(written()).toHaveLength(2);
  });
});

describe('MeetingDigestRepository.requestByHand', () => {
  const queryRaw = jest.fn();
  const findUnique = jest.fn();
  const { actionItems, decisions, sources, ...row } = buildMeetingDigestRecord({
    status: QUEUED,
    sources: [],
  });
  const tx = {
    $executeRaw: jest.fn(async () => 1),
    $queryRaw: queryRaw,
    meetingDigest: { findUnique },
    meetingDigestActionItem: { findMany: jest.fn(async () => actionItems) },
    meetingDigestDecision: { findMany: jest.fn(async () => decisions) },
    meetingDigestSource: { findMany: jest.fn(async () => sources) },
  };
  const transaction = jest.fn((work: (client: typeof tx) => Promise<unknown>) => work(tx));
  const repository = new MeetingDigestRepository({
    $transaction: transaction,
  } as unknown as PrismaService);

  beforeEach(() => {
    transaction.mockClear();
    findUnique.mockReset().mockResolvedValue(row);
    queryRaw.mockReset().mockResolvedValue([{ id: DIGEST_ID, status: FAILED, summary: null }]);
  });

  it('answers the row as the request left it, read inside the transaction that wrote it', async () => {
    await expect(repository.requestByHand(DIGEST_MEETING_ID, FIRST)).resolves.toEqual({
      allowed: true,
      action: 'retry',
      record: { ...row, actionItems, decisions, sources },
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith({ where: { meetingId: DIGEST_MEETING_ID } });
  });

  it('answers a refusal as it is, and reads no row for it', async () => {
    queryRaw.mockResolvedValue([{ id: DIGEST_ID, status: GENERATING, summary: null }]);

    await expect(repository.requestByHand(DIGEST_MEETING_ID, FIRST)).resolves.toEqual({
      allowed: false,
      refusal: 'UNDER_WAY',
    });
    expect(findUnique).not.toHaveBeenCalled();
  });
});
