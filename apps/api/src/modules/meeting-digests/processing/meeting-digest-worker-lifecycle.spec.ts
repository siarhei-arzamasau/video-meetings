import { Logger } from '@nestjs/common';

import { deferred } from '../../claude-agent/services/claude-agent-process.fixture';
import type { GeneratedMeetingDigest } from '../services/meeting-digest-generator';
import type { MeetingDigestWorker } from './meeting-digest-worker';
import {
  CLAIMED,
  GENERATED,
  HELD,
  buildDigestWorker,
  digestWorkerDoubles,
  resetDigestWorkerDoubles,
  untilHungUp,
} from './meeting-digest-worker.fixture';

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('MeetingDigestWorker: polling and shutdown', () => {
  const doubles = digestWorkerDoubles();
  const { claimNext, complete, fail, release, generate } = doubles;
  const started: MeetingDigestWorker[] = [];

  const build = async (values: Record<string, unknown> = {}): Promise<MeetingDigestWorker> => {
    const { worker } = await buildDigestWorker(doubles, values);

    started.push(worker);

    return worker;
  };

  /** A generation that answers only when told to, and rejects the moment it is hung up on. */
  const slowGeneration = (): { answer: () => void; signal: () => AbortSignal | undefined } => {
    const seen: { resolve?: (generated: GeneratedMeetingDigest) => void; signal?: AbortSignal } =
      {};

    generate.mockImplementation((transcripts: ReadonlyArray<string>, signal: AbortSignal) => {
      seen.signal = signal;

      return Promise.race([
        untilHungUp(transcripts, signal),
        new Promise<GeneratedMeetingDigest>((resolve) => {
          seen.resolve = resolve;
        }),
      ]);
    });

    return { answer: () => seen.resolve?.(GENERATED), signal: () => seen.signal };
  };

  beforeAll(() => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(() => resetDigestWorkerDoubles(doubles));

  afterEach(async () => {
    await Promise.all(started.splice(0).map((worker) => worker.onModuleDestroy()));
  });

  describe('polling', () => {
    it('claims nothing while the digest is off, however often it is asked', async () => {
      const worker = await build({ MEETING_DIGEST_ENABLED: false });

      await expect(worker.tick()).resolves.toBe(false);
      await expect(worker.drain()).resolves.toBe(0);

      expect(claimNext).not.toHaveBeenCalled();
    });

    it('asks for the setting on every tick, so a queued digest waits for it to come back', async () => {
      const values: Record<string, unknown> = { MEETING_DIGEST_ENABLED: false };
      const worker = await build(values);

      await expect(worker.drain()).resolves.toBe(0);
      values['MEETING_DIGEST_ENABLED'] = true;
      await expect(worker.drain()).resolves.toBe(1);

      expect(complete).toHaveBeenCalledTimes(1);
    });

    it.each([
      // The e2e suite runs like this, and drains the worker by hand instead.
      ['the worker flag is off', { MEETING_FILES_WORKER_ENABLED: false }],
      [
        'the digest is switched off',
        { MEETING_FILES_WORKER_ENABLED: true, MEETING_DIGEST_ENABLED: false },
      ],
    ])('does not poll on its own while %s', async (_label, values) => {
      const worker = await build(values);

      worker.onApplicationBootstrap();
      await settle(80);

      expect(claimNext).not.toHaveBeenCalled();
    });

    it('polls in a loop of its own once both are on, and keeps asking after an empty claim', async () => {
      const worker = await build({ MEETING_FILES_WORKER_ENABLED: true });

      worker.onApplicationBootstrap();
      await settle(120);

      expect(complete).toHaveBeenCalledTimes(1);
      expect(claimNext.mock.calls.length).toBeGreaterThan(2);
    });
  });

  describe('drain', () => {
    it('waits for a request an event started before it looks for work', async () => {
      const { worker, pending } = await buildDigestWorker(doubles);
      started.push(worker);
      const request = deferred();
      pending.track(request.promise);

      const drained = worker.drain();
      await settle(20);
      expect(claimNext).not.toHaveBeenCalled();

      request.resolve();
      await expect(drained).resolves.toBe(1);
    });
  });

  describe('shutdown', () => {
    it('hangs up on Claude and hands the claim back, uncounted and unfailed', async () => {
      const worker = await build();
      const generation = slowGeneration();
      const drained = worker.drain();
      await settle(20);

      await worker.onModuleDestroy();

      // The shutdown waited for the claim to be given back before it returned.
      expect(release).toHaveBeenCalledWith(CLAIMED.id, CLAIMED.leasedUntil);
      expect(generation.signal()?.aborted).toBe(true);
      expect(fail).not.toHaveBeenCalled();
      await expect(drained).resolves.toBe(1);
    });

    it('claims nothing more once it has begun, so the row it released is left for another process', async () => {
      const worker = await build();
      claimNext.mockReset().mockResolvedValue(CLAIMED);
      slowGeneration();
      const drained = worker.drain();
      await settle(20);

      await worker.onModuleDestroy();

      await expect(drained).resolves.toBe(1);
      expect(claimNext).toHaveBeenCalledTimes(1);
      await expect(worker.tick()).resolves.toBe(false);
    });

    it('still stores a digest that arrived as the shutdown began', async () => {
      const worker = await build();
      const generation = slowGeneration();
      const drained = worker.drain();
      await settle(20);

      generation.answer();
      await worker.onModuleDestroy();
      await drained;

      expect(release).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalledWith(HELD, expect.anything());
    });
  });
});
