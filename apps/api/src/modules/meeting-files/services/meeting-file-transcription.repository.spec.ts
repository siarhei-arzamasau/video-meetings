import { PrismaService } from '../../prisma/prisma.service';
import { TranscriptionStatus } from './meeting-file-transcription-status';
import { MeetingFileTranscriptionRepository } from './meeting-file-transcription.repository';

const FILE_ID = '55555555-5555-4555-8555-555555555555';
const LEASE = new Date('2026-10-07T10:00:30.000Z');
const { QUEUED, TRANSCRIBING, TRANSCRIBED, FAILED } = TranscriptionStatus;

/**
 * The repository's conditional writes, against a stubbed client: which rows each edge may
 * touch and what it sets. The two raw statements — the claim and the renewal — are only
 * shown to pass their answer through here; their SQL is raced against a real database in
 * `test/meeting-file-transcription-claims.e2e-spec.ts` and run by every transcription e2e spec.
 */
describe('MeetingFileTranscriptionRepository', () => {
  const updateMany = jest.fn();
  const count = jest.fn();
  const findMany = jest.fn();
  const queryRaw = jest.fn();
  const repository = new MeetingFileTranscriptionRepository({
    meetingFile: { updateMany, count, findMany },
    $queryRaw: queryRaw,
  } as unknown as PrismaService);

  beforeEach(() => {
    updateMany.mockReset().mockResolvedValue({ count: 1 });
    count.mockReset().mockResolvedValue(1);
    findMany.mockReset().mockResolvedValue([]);
    queryRaw.mockReset().mockResolvedValue([]);
  });

  describe('transition', () => {
    it('transcribing to transcribed: only a ready file, only under the lease it was given', async () => {
      await expect(
        repository.transition(FILE_ID, TRANSCRIBING, TRANSCRIBED, { transcriptKey: 'key' }, LEASE),
      ).resolves.toBe(true);

      expect(updateMany).toHaveBeenCalledWith({
        where: {
          id: FILE_ID,
          status: 'ready',
          transcriptionStatus: TRANSCRIBING,
          transcriptionLeasedUntil: LEASE,
        },
        data: {
          transcriptionStatus: TRANSCRIBED,
          transcriptionLeasedUntil: null,
          transcriptKey: 'key',
        },
      });
    });

    it('transcribing to failed: the reason goes in with the status, and the lease comes off', async () => {
      await repository.transition(
        FILE_ID,
        TRANSCRIBING,
        FAILED,
        { transcriptionFailureReason: 'Nope' },
        LEASE,
      );

      expect(updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ status: 'ready', transcriptionLeasedUntil: LEASE }),
        data: {
          transcriptionStatus: FAILED,
          transcriptionLeasedUntil: null,
          transcriptionFailureReason: 'Nope',
        },
      });
    });

    it('failed to queued: matched on holding no lease, with the count and the reason the retry resets', async () => {
      await expect(
        repository.transition(
          FILE_ID,
          FAILED,
          QUEUED,
          { transcriptionAttempts: 0, transcriptionFailureReason: null },
          null,
        ),
      ).resolves.toBe(true);

      expect(updateMany).toHaveBeenCalledWith({
        where: {
          id: FILE_ID,
          status: 'ready',
          transcriptionStatus: FAILED,
          transcriptionLeasedUntil: null,
        },
        data: {
          transcriptionStatus: QUEUED,
          transcriptionLeasedUntil: null,
          transcriptionAttempts: 0,
          transcriptionFailureReason: null,
        },
      });
    });

    it('answers false when no row matched — deleted, reclaimed, or already moved', async () => {
      updateMany.mockResolvedValue({ count: 0 });

      await expect(
        repository.transition(FILE_ID, TRANSCRIBING, TRANSCRIBED, {}, LEASE),
      ).resolves.toBe(false);
    });

    it.each([
      [QUEUED, TRANSCRIBED],
      [QUEUED, FAILED],
      [TRANSCRIBED, QUEUED],
      [TRANSCRIBED, FAILED],
      [FAILED, TRANSCRIBING],
      [FAILED, TRANSCRIBED],
    ] as const)('refuses %s to %s before it reaches the database', async (from, to) => {
      await expect(repository.transition(FILE_ID, from, to, {}, LEASE)).rejects.toThrow(
        `A transcription cannot move from ${from} to ${to}`,
      );

      expect(updateMany).not.toHaveBeenCalled();
    });

    it('leaves the release to `release`, which is the edge that gives the claim back', async () => {
      await expect(repository.transition(FILE_ID, TRANSCRIBING, QUEUED, {}, LEASE)).rejects.toThrow(
        'release',
      );

      expect(updateMany).not.toHaveBeenCalled();
    });
  });

  describe('release', () => {
    it('transcribing to queued, with the claim it is handing back uncounted', async () => {
      await expect(repository.release(FILE_ID, LEASE)).resolves.toBe(true);

      expect(updateMany).toHaveBeenCalledWith({
        where: {
          id: FILE_ID,
          status: 'ready',
          transcriptionStatus: TRANSCRIBING,
          transcriptionLeasedUntil: LEASE,
        },
        data: {
          transcriptionStatus: QUEUED,
          transcriptionLeasedUntil: null,
          transcriptionAttempts: { decrement: 1 },
        },
      });
    });

    it('answers false for a claim that was no longer this worker’s to give back', async () => {
      updateMany.mockResolvedValue({ count: 0 });

      await expect(repository.release(FILE_ID, LEASE)).resolves.toBe(false);
    });
  });

  describe('isFileReady', () => {
    it('says a file that is still ready is, whatever its transcription has become', async () => {
      await expect(repository.isFileReady(FILE_ID)).resolves.toBe(true);

      expect(count).toHaveBeenCalledWith({ where: { id: FILE_ID, status: 'ready' } });
    });

    it('says a file that was deleted is not', async () => {
      count.mockResolvedValue(0);

      await expect(repository.isFileReady(FILE_ID)).resolves.toBe(false);
    });
  });

  describe('findTranscribedOf', () => {
    const MEETING_ID = '44444444-4444-4444-8444-444444444444';

    it("reads a meeting's ready, transcribed recordings in upload order", async () => {
      const recording = { id: FILE_ID, uploaderId: 'uploader', transcriptKey: 'key' };
      findMany.mockResolvedValue([recording]);

      await expect(repository.findTranscribedOf(MEETING_ID)).resolves.toEqual([recording]);

      expect(findMany).toHaveBeenCalledWith({
        // `ready` is what leaves a deleted recording out: a delete changes the file's status
        // and nothing of its transcription's.
        where: { meetingId: MEETING_ID, status: 'ready', transcriptionStatus: TRANSCRIBED },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, uploaderId: true, transcriptKey: true },
      });
    });

    it('leaves out a row with no transcript key, which has no transcript to read', async () => {
      findMany.mockResolvedValue([{ id: FILE_ID, uploaderId: 'uploader', transcriptKey: null }]);

      await expect(repository.findTranscribedOf(MEETING_ID)).resolves.toEqual([]);
    });
  });

  describe('claimNext', () => {
    it('answers with the row the statement returned', async () => {
      const claimed = { id: FILE_ID, transcriptionStatus: TRANSCRIBING };
      queryRaw.mockResolvedValue([claimed]);

      await expect(repository.claimNext(60)).resolves.toBe(claimed);
    });

    it('answers null when nothing was claimable', async () => {
      await expect(repository.claimNext(60)).resolves.toBeNull();
    });
  });

  describe('renewLease', () => {
    it('answers with the lease the row now holds', async () => {
      const renewed = new Date('2026-10-07T10:01:00.000Z');
      queryRaw.mockResolvedValue([{ leasedUntil: renewed }]);

      await expect(repository.renewLease(FILE_ID, LEASE, 60)).resolves.toBe(renewed);
    });

    it('answers null when the claim is gone', async () => {
      await expect(repository.renewLease(FILE_ID, LEASE, 60)).resolves.toBeNull();
    });
  });
});
