import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { MeetingFileUploadRepository } from '../services/meeting-file-upload.repository';
import type { MeetingFileUploadRecord } from '../services/meeting-file-upload.mapper';
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
  transcriptKey: null,
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

const UPLOAD_ID = '66666666-6666-4666-8666-666666666666';

/** An expired session the worker has just claimed: its lease set, its attempt counted. */
const EXPIRED_UPLOAD: MeetingFileUploadRecord = {
  id: UPLOAD_ID,
  meetingId: MEETING_ID,
  uploaderId: '11111111-1111-4111-8111-111111111111',
  name: 'recording.mp4',
  size: 20,
  chunkSize: 8,
  chunkCount: 3,
  receivedChunks: [0, 1],
  attempts: 1,
  leasedUntil: LEASE,
  createdAt: new Date(),
  expiresAt: new Date(Date.now() - 1_000),
  purgedAt: null,
};

const noop = (): void => {};

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('MeetingFileWorker', () => {
  const claimNext = jest.fn();
  const transition = jest.fn();
  const markPurged = jest.fn();
  const renewLease = jest.fn();
  const claimExpired = jest.fn();
  const markUploadPurged = jest.fn();
  const removeTree = jest.fn();
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
        {
          provide: MeetingFileRepository,
          useValue: { claimNext, transition, markPurged, renewLease },
        },
        {
          provide: MeetingFileUploadRepository,
          useValue: { claimExpired, markPurged: markUploadPurged },
        },
        {
          provide: MeetingFileStorage,
          useValue: { remove, removeTree, pathOf: (key: string) => key },
        },
        { provide: PIPELINE_STEPS, useValue: steps },
      ],
    }).compile();

    return moduleRef.get(MeetingFileWorker);
  };

  beforeEach(async () => {
    claimNext.mockReset().mockResolvedValueOnce(CLAIMED).mockResolvedValue(null);
    transition.mockReset().mockResolvedValue(true);
    markPurged.mockReset().mockResolvedValue(true);
    renewLease.mockReset().mockResolvedValue(new Date(Date.now() + 30_000));
    claimExpired.mockReset().mockResolvedValue(null);
    markUploadPurged.mockReset().mockResolvedValue(true);
    removeTree.mockReset().mockResolvedValue(undefined);
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
        { provide: MeetingFileUploadRepository, useValue: {} },
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

  describe('expired upload sessions', () => {
    it('removes the chunk tree and only then marks the session purged', async () => {
      claimNext.mockReset().mockResolvedValue(null);
      claimExpired.mockResolvedValueOnce(EXPIRED_UPLOAD).mockResolvedValue(null);
      const order: string[] = [];
      removeTree.mockImplementation(() => {
        order.push('removeTree');

        return Promise.resolve();
      });
      markUploadPurged.mockImplementation(() => {
        order.push('markPurged');

        return Promise.resolve(true);
      });

      await expect(worker.drain()).resolves.toBe(1);

      expect(removeTree).toHaveBeenCalledWith(UPLOAD_ID);
      expect(order).toEqual(['removeTree', 'markPurged']);
    });

    it('counts sessions in drain() alongside files', async () => {
      claimExpired.mockResolvedValueOnce(EXPIRED_UPLOAD).mockResolvedValue(null);

      // One file (the default claim) and one session.
      await expect(worker.drain()).resolves.toBe(2);
    });

    it('looks for a session only once no file is claimable', async () => {
      claimExpired.mockResolvedValue(null);

      await worker.drain();

      // The file claim that returned a row did not also go looking for a session.
      expect(claimExpired).toHaveBeenCalledTimes(1);
      expect(claimNext).toHaveBeenCalledTimes(2);
    });

    it('gives up after MAX_ATTEMPTS claims, marking it purged with the directory logged', async () => {
      claimNext.mockReset().mockResolvedValue(null);
      claimExpired
        .mockResolvedValueOnce({ ...EXPIRED_UPLOAD, attempts: 4 })
        .mockResolvedValue(null);

      await expect(worker.drain()).resolves.toBe(1);

      expect(removeTree).not.toHaveBeenCalled();
      expect(markUploadPurged).toHaveBeenCalledWith(UPLOAD_ID);
    });

    it('leaves the row unpurged when the removal throws, so the lease brings it back', async () => {
      claimNext.mockReset().mockResolvedValue(null);
      claimExpired.mockResolvedValueOnce(EXPIRED_UPLOAD).mockResolvedValue(null);
      removeTree.mockRejectedValue(new Error('EACCES'));

      await expect(worker.drain()).rejects.toThrow('EACCES');

      expect(markUploadPurged).not.toHaveBeenCalled();
    });
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
  describe('the lease heartbeat', () => {
    /** A step that stays in flight until the test releases it. */
    const slowStep = (): { release: (patch: object) => void } => {
      let release: (patch: object) => void = noop;
      second.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = (patch: object) => resolve(patch);
          }),
      );

      return { release: (patch: object) => release(patch) };
    };

    it('renews the lease while a step runs, and records the result against the renewed one', async () => {
      // A three second lease beats every second; the step outlasts two of them.
      const renewed = new Date(Date.now() + 3_000);
      renewLease.mockResolvedValue(renewed);
      const slow = await build({ MEETING_FILES_LEASE_SECONDS: 3 });
      const step = slowStep();

      const drained = slow.drain();
      await settle(1_200);

      expect(renewLease).toHaveBeenCalledWith(FILE_ID, LEASE, 3);

      step.release({ thumbnailKey: 'thumb' });
      await drained;

      // The transition matches the lease the heartbeat left behind, not the claim's: a
      // conditional update on the old value would miss the worker's own row.
      expect(transition).toHaveBeenCalledWith(
        FILE_ID,
        'processing',
        'ready',
        expect.objectContaining({ thumbnailKey: 'thumb' }),
        renewed,
      );
    });

    it('chains renewals, each one conditional on the lease the previous one set', async () => {
      const afterFirstBeat = new Date(Date.now() + 3_000);
      const afterSecondBeat = new Date(Date.now() + 6_000);
      renewLease.mockResolvedValueOnce(afterFirstBeat).mockResolvedValueOnce(afterSecondBeat);
      const slow = await build({ MEETING_FILES_LEASE_SECONDS: 3 });
      const step = slowStep();

      const drained = slow.drain();
      await settle(2_200);
      step.release({});
      await drained;

      expect(renewLease.mock.calls[0]).toEqual([FILE_ID, LEASE, 3]);
      expect(renewLease.mock.calls[1]).toEqual([FILE_ID, afterFirstBeat, 3]);
    });

    it('discards the result when a renewal reports the row is no longer ours', async () => {
      // Zero rows: the file was deleted, or its lease lapsed and another worker took it.
      renewLease.mockResolvedValue(null);
      transition.mockResolvedValue(false);
      const slow = await build({ MEETING_FILES_LEASE_SECONDS: 3 });
      const step = slowStep();

      const drained = slow.drain();
      await settle(1_200);
      step.release({ thumbnailKey: 'thumb', transcriptKey: 'transcript' });
      await drained;

      // `null` is passed deliberately: it matches no row, so the result cannot be written
      // over whatever the current holder is doing.
      expect(transition).toHaveBeenCalledWith(
        FILE_ID,
        'processing',
        'ready',
        expect.anything(),
        null,
      );
      // And the bytes the steps wrote are removed, exactly as for a lost race at the end.
      expect(remove).toHaveBeenCalledWith('thumb');
      expect(remove).toHaveBeenCalledWith('transcript');
    });

    it('keeps the lease it has when a renewal throws, and lets the transition decide', async () => {
      renewLease.mockRejectedValue(new Error('connection lost'));
      const slow = await build({ MEETING_FILES_LEASE_SECONDS: 3 });
      const step = slowStep();

      const drained = slow.drain();
      await settle(1_200);
      step.release({});
      await drained;

      // A failed renewal is not a lost lease: the claim's own value is still the best guess,
      // and the conditional update at the end is the real check.
      expect(transition).toHaveBeenCalledWith(
        FILE_ID,
        'processing',
        'ready',
        expect.anything(),
        LEASE,
      );
    });

    it('does not renew for a step that finishes well inside the lease', async () => {
      await worker.drain();

      expect(renewLease).not.toHaveBeenCalled();
    });
  });
});
