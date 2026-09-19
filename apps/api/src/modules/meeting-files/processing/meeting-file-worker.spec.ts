import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { MeetingFileRepository } from '../services/meeting-file.repository';
import type { ClaimedFile } from '../services/meeting-file.repository';
import { MeetingFileStorage } from '../storage/meeting-file-storage';
import { MEETING_FILE_WORKER, MeetingFileWorker, PIPELINE_STEPS } from './meeting-file-worker';
import { StepError } from './step';
import type { ProcessingStep } from './step';

const MEETING_ID = '44444444-4444-4444-8444-444444444444';
const FILE_ID = '55555555-5555-4555-8555-555555555555';
const LEASE = new Date(Date.now() + 60_000);

const CLAIMED: ClaimedFile = {
  id: FILE_ID,
  meetingId: MEETING_ID,
  uploaderId: '11111111-1111-4111-8111-111111111111',
  name: 'deck.pdf',
  contentType: 'application/pdf',
  size: 10,
  storageKey: `${MEETING_ID}/${FILE_ID}`,
  checksum: null,
  thumbnailKey: null,
  status: 'processing',
  previousStatus: 'uploaded',
  failureReason: null,
  attempts: 1,
  leasedUntil: LEASE,
  createdAt: new Date(),
  processedAt: null,
  deletedAt: null,
  purgedAt: null,
};

const noop = (): void => {};

describe('MeetingFileWorker', () => {
  const claimNext = jest.fn();
  const transition = jest.fn();
  const markPurged = jest.fn();
  const remove = jest.fn();
  const first = jest.fn();
  const second = jest.fn();
  const config = {
    MEETING_FILES_WORKER_ENABLED: false,
    MEETING_FILES_LEASE_SECONDS: 30,
    MEETING_FILES_POLL_MS: 100,
  };

  const steps: ProcessingStep[] = [
    { name: 'first', run: first },
    { name: 'second', run: second },
  ];

  let worker: MeetingFileWorker;

  const build = async (overrides: Partial<typeof config> = {}): Promise<MeetingFileWorker> => {
    const values: Record<string, unknown> = { ...config, ...overrides };
    const moduleRef = await Test.createTestingModule({
      providers: [
        MeetingFileWorker,
        { provide: MEETING_FILE_WORKER, useExisting: MeetingFileWorker },
        {
          provide: ConfigService,
          useValue: { get: (key: string, fallback: unknown) => values[key] ?? fallback },
        },
        { provide: MeetingFileRepository, useValue: { claimNext, transition, markPurged } },
        { provide: MeetingFileStorage, useValue: { remove, pathOf: (key: string) => key } },
        { provide: PIPELINE_STEPS, useValue: steps },
      ],
    }).compile();

    return moduleRef.get(MeetingFileWorker);
  };

  beforeEach(async () => {
    claimNext.mockReset().mockResolvedValueOnce(CLAIMED).mockResolvedValue(null);
    transition.mockReset().mockResolvedValue(true);
    markPurged.mockReset().mockResolvedValue(true);
    remove.mockReset().mockResolvedValue(undefined);
    first.mockReset().mockResolvedValue({ checksum: 'abc' });
    second.mockReset().mockResolvedValue({ thumbnailKey: 'thumb' });
    worker = await build();
  });

  it('is reachable under the string token', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        MeetingFileWorker,
        { provide: MEETING_FILE_WORKER, useExisting: MeetingFileWorker },
        {
          provide: ConfigService,
          useValue: { get: (_key: string, fallback: unknown) => fallback },
        },
        { provide: MeetingFileRepository, useValue: {} },
        { provide: MeetingFileStorage, useValue: {} },
      ],
    }).compile();

    expect(moduleRef.get(MEETING_FILE_WORKER)).toBe(moduleRef.get(MeetingFileWorker));
  });

  it('claims with the configured lease, runs the steps in order, and moves the row to ready with their merged patch', async () => {
    await expect(worker.drain()).resolves.toBe(1);

    expect(claimNext).toHaveBeenCalledWith(30);
    expect(first.mock.invocationCallOrder[0]).toBeLessThan(second.mock.invocationCallOrder[0] ?? 0);
    expect(transition).toHaveBeenCalledWith(
      FILE_ID,
      'processing',
      'ready',
      {
        checksum: 'abc',
        thumbnailKey: 'thumb',
        processedAt: expect.any(Date),
        leasedUntil: null,
      },
      // The lease the claim was given: a worker whose lease expired and was reclaimed must
      // not be able to record its result over the current holder's.
      LEASE,
    );
  });

  it('drains until a claim comes back empty and counts the rows it handled', async () => {
    claimNext
      .mockReset()
      .mockResolvedValueOnce(CLAIMED)
      .mockResolvedValueOnce(CLAIMED)
      .mockResolvedValue(null);

    await expect(worker.drain()).resolves.toBe(2);
    expect(claimNext).toHaveBeenCalledTimes(3);
  });

  it("stores a StepError's user message as the failure reason, keeping the earlier step's patch", async () => {
    second.mockRejectedValue(new StepError('The image could not be read'));

    await worker.drain();

    expect(transition).toHaveBeenCalledWith(
      FILE_ID,
      'processing',
      'failed',
      {
        checksum: 'abc',
        failureReason: 'The image could not be read',
        leasedUntil: null,
      },
      LEASE,
    );
  });

  it('stores the generic reason for any other throw, never the error text', async () => {
    first.mockRejectedValue(new Error('ENOENT: /secret/path'));

    await worker.drain();

    expect(transition).toHaveBeenCalledWith(
      FILE_ID,
      'processing',
      'failed',
      {
        failureReason: 'Processing failed. You can still download the file.',
        leasedUntil: null,
      },
      LEASE,
    );
    expect(second).not.toHaveBeenCalled();
  });

  it('fails a row claimed more than MAX_ATTEMPTS times without running it', async () => {
    claimNext
      .mockReset()
      .mockResolvedValueOnce({ ...CLAIMED, attempts: 4 })
      .mockResolvedValue(null);

    await worker.drain();

    expect(first).not.toHaveBeenCalled();
    expect(transition).toHaveBeenCalledWith(
      FILE_ID,
      'processing',
      'failed',
      {
        failureReason: 'Processing failed after repeated attempts',
        leasedUntil: null,
      },
      LEASE,
    );
  });

  it('discards the patch when the ready transition changes no row, removing the thumbnail it wrote', async () => {
    transition.mockResolvedValue(false);

    await expect(worker.drain()).resolves.toBe(1);

    // One attempt, no retry, no second write: the row was deleted or reclaimed mid-run. The
    // thumbnail the preview step wrote is removed, because the purge may already have run
    // before it existed and nothing else will ever see the key.
    expect(transition).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('thumb');
  });

  it('purges a deleted row: removes the object and the derived thumbnail key and marks it purged, with no status change', async () => {
    claimNext
      .mockReset()
      .mockResolvedValueOnce({ ...CLAIMED, status: 'deleted', previousStatus: 'deleted' })
      .mockResolvedValue(null);

    await expect(worker.drain()).resolves.toBe(1);

    expect(remove).toHaveBeenCalledWith(CLAIMED.storageKey);
    // Derived from the storage key, not read from the row: a file deleted mid-processing is
    // purged before the row has a `thumbnailKey`, and the thumbnail written afterwards would
    // otherwise be orphaned.
    expect(remove).toHaveBeenCalledWith(`${CLAIMED.storageKey}.thumb.webp`);
    expect(markPurged).toHaveBeenCalledWith(FILE_ID);
    expect(transition).not.toHaveBeenCalled();
    expect(first).not.toHaveBeenCalled();
  });

  it('gives up on a purge claimed more than MAX_ATTEMPTS times: marks it purged without touching storage', async () => {
    claimNext
      .mockReset()
      .mockResolvedValueOnce({
        ...CLAIMED,
        status: 'deleted',
        previousStatus: 'deleted',
        attempts: 4,
      })
      .mockResolvedValue(null);

    await expect(worker.drain()).resolves.toBe(1);

    // Without this the row is reclaimed every lease for ever when `remove` keeps throwing.
    expect(remove).not.toHaveBeenCalled();
    expect(markPurged).toHaveBeenCalledWith(FILE_ID);
  });

  it('leaves a purge that throws claimable for the next lease', async () => {
    claimNext
      .mockReset()
      .mockResolvedValueOnce({ ...CLAIMED, status: 'deleted', previousStatus: 'deleted' })
      .mockResolvedValue(null);
    remove.mockRejectedValue(new Error('EACCES'));

    await expect(worker.drain()).rejects.toThrow('EACCES');

    expect(markPurged).not.toHaveBeenCalled();
  });

  it('does not start the loop when disabled', () => {
    jest.useFakeTimers();

    try {
      worker.onApplicationBootstrap();
      jest.advanceTimersByTime(1_000);

      expect(claimNext).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('polls when enabled and awaits the in-flight tick on shutdown', async () => {
    let finishTick: (row: ClaimedFile) => void = noop;
    claimNext.mockReset().mockImplementationOnce(
      () =>
        new Promise<ClaimedFile>((resolve) => {
          finishTick = resolve;
        }),
    );
    claimNext.mockResolvedValue(null);
    const enabled = await build({ MEETING_FILES_WORKER_ENABLED: true });

    enabled.onApplicationBootstrap();
    // The first tick is scheduled with no delay; give the timer a turn.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(claimNext).toHaveBeenCalledTimes(1);

    let shutDown = false;
    const shutdown = enabled.onApplicationShutdown().then(() => {
      shutDown = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(shutDown).toBe(false);

    finishTick(CLAIMED);
    await shutdown;

    expect(shutDown).toBe(true);
    // The claimed row was still handled to completion.
    expect(transition).toHaveBeenCalledWith(
      FILE_ID,
      'processing',
      'ready',
      expect.anything(),
      LEASE,
    );
    // And nothing was claimed after the stop.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(claimNext).toHaveBeenCalledTimes(1);
  });
});
