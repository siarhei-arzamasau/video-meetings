import { PrismaService } from '../../prisma/prisma.service';
import { DigestRequestKind } from './meeting-digest-action';
import {
  DIGEST_ID,
  DIGEST_MEETING_ID,
  FIRST_RECORDING_ID,
  buildMeetingDigestRecord,
} from './meeting-digest-record.fixture';
import { DigestStatus } from './meeting-digest-status';
import { MeetingDigestRepository } from './meeting-digest.repository';

const { QUEUED, GENERATING, FAILED } = DigestStatus;
const FIRST = [FIRST_RECORDING_ID];

/**
 * The two requests no recording makes, as the repository wraps them: each one transaction,
 * and what each answers its caller with. The decision inside is `meeting-digest-request.spec`'s.
 */
describe('MeetingDigestRepository, asking for a generation no recording asked for', () => {
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
    tx.$executeRaw.mockClear();
    findUnique.mockReset().mockResolvedValue(row);
    queryRaw.mockReset().mockResolvedValue([{ id: DIGEST_ID, status: FAILED, summary: null }]);
  });

  describe('requestRetry', () => {
    it('answers the row as the request left it, read inside the transaction that wrote it', async () => {
      await expect(repository.requestRetry(DIGEST_MEETING_ID, FIRST)).resolves.toEqual({
        allowed: true,
        kind: DigestRequestKind.RETRY,
        record: { ...row, actionItems, decisions, sources },
      });

      expect(transaction).toHaveBeenCalledTimes(1);
      expect(findUnique).toHaveBeenCalledWith({ where: { meetingId: DIGEST_MEETING_ID } });
    });

    it('answers a refusal as it is, and reads no row for it', async () => {
      queryRaw.mockResolvedValue([{ id: DIGEST_ID, status: GENERATING, summary: null }]);

      await expect(repository.requestRetry(DIGEST_MEETING_ID, FIRST)).resolves.toEqual({
        allowed: false,
        refusal: 'UNDER_WAY',
      });
      expect(findUnique).not.toHaveBeenCalled();
    });
  });

  describe('requestCatchUp', () => {
    it('answers that it asked for a digest that was owed, in one transaction', async () => {
      queryRaw.mockResolvedValue([{ id: DIGEST_ID, status: null, summary: null }]);

      await expect(repository.requestCatchUp(DIGEST_MEETING_ID, FIRST)).resolves.toBe(true);

      expect(transaction).toHaveBeenCalledTimes(1);
      // The empty row, then the request.
      expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    });

    it('answers that it did not, for a digest that failed and waits for its Retry', async () => {
      await expect(repository.requestCatchUp(DIGEST_MEETING_ID, FIRST)).resolves.toBe(false);

      // The empty row is offered and changes nothing; no request follows it.
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    });
  });
});
